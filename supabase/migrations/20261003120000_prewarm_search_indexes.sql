-- FM-2026-10-03-01: keep the search_organizations indexes in memory.
-- ─────────────────────────────────────────────────────────────────────────────
-- After 20261002120000, a warm search takes well under a second, but a search
-- whose index pages have been evicted reads them from disk and can exceed the
-- anon role's 3 s statement_timeout ("Search failed", 502). Seen right after
-- deploy: "community foundation" failed at 3.3 s cold, then took 0.5–1 s
-- end to end on every repeat.
--
-- Search touches ~500 MB (the indexes below plus the funders and
-- recipient_organizations tables), more than shared_buffers (320 MB), so
-- eviction is routine. This job re-reads the indexes search uses every
-- 5 minutes with pg_prewarm's 'read' mode, which loads them into the OS page
-- cache rather than shared_buffers: it doesn't push ~200 MB of other data out
-- of shared_buffers, and a read from the page cache is a memory copy, not a
-- disk read. Each run touches every page, so they stay recently used in the
-- page cache; a run reads from disk only what was evicted since the last one.
-- The run's duration in cron.job_run_details (end_time - start_time) shows
-- whether it had to: ~45 ms when cached, ~0.85 s when half was cold (measured
-- on production).
--
-- The tables themselves (~310 MB) aren't warmed: on this instance they'd
-- compete with everything else for the page cache.
--
-- pg_prewarm isn't in shared_preload_libraries, so its autoprewarm worker
-- (reload after a restart) isn't available; the schedule covers that too,
-- within 5 minutes of a restart. The first run is the first tick after this
-- migration, not the migration itself, so a deploy doesn't wait on the reads.
--
-- Indexes (sizes and use from pg_stat_user_indexes and EXPLAIN, 2026-10-03):
--   idx_funders_name_trgm              58 MB  trigram candidate sets
--   idx_funders_lower_name             16 MB  exact and prefix sets
--   idx_recipient_org_name_trgm2       37 MB  trigram candidate sets
--   idx_recipient_org_lower_name       20 MB  exact and prefix sets
--   idx_foundation_filings_foundation  17 MB  the per-funder "has 990-PF filings" EXISTS probe
--   funders_pkey                       21 MB  joining candidates back; EIN search
--   recipient_organizations_pkey       18 MB  joining candidates back
--   idx_recipient_org_ein              14 MB  EIN search
-- Not idx_recipient_org_name_trgm (name_normalized), which search doesn't use.
-- An index that no longer exists, or that pg_prewarm fails on, is skipped with
-- a WARNING in the Postgres log (so a rename shows up there instead of
-- silently warming nothing) and the rest are still warmed. If none can be
-- warmed, the run fails, so it shows as failed in cron.job_run_details.
--
-- Locks: a run holds AccessShareLock on these indexes until it returns. That
-- conflicts only with DDL on these tables, not with the batch loads'
-- INSERT/UPDATE.
--
-- The job adds 288 rows a day to cron.job_run_details, which nothing purges;
-- a daily job keeps 30 days of this job's history. Other jobs' history (the
-- purge-* jobs' run history is retention evidence) is left alone.
-- ─────────────────────────────────────────────────────────────────────────────

-- Its functions are owned by supabase_admin, which grants EXECUTE to PUBLIC
-- (as for every extension here); postgres can't revoke that grant. That's
-- acceptable: the API exposes only the public and graphql_public schemas (a
-- call with Content-Profile: extensions gets PGRST106), and pg_prewarm checks
-- SELECT on the relation it's given.
CREATE EXTENSION IF NOT EXISTS pg_prewarm WITH SCHEMA extensions;

-- Exists in production but wasn't in source control; declared here (a no-op
-- there) like 20261002120000's indexes, since search and this job use it.
CREATE INDEX IF NOT EXISTS idx_recipient_org_ein
  ON public.recipient_organizations (ein) WHERE ein IS NOT NULL;

-- IF NOT EXISTS keeps an install in another schema; the function below names
-- extensions.pg_prewarm, so say so plainly rather than fail obscurely.
DO $$
BEGIN
  IF (SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_prewarm') <> 'extensions' THEN
    RAISE EXCEPTION 'pg_prewarm must be in schema extensions (run: ALTER EXTENSION pg_prewarm SET SCHEMA extensions)';
  END IF;
END $$;

-- Returns the number of blocks read (for a manual call; pg_cron records only
-- the command tag). Runs as the job's owner, postgres, which owns these
-- indexes.
CREATE OR REPLACE FUNCTION public.prewarm_search_indexes()
RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_name text;
  v_rel regclass;
  v_blocks bigint := 0;
  v_warmed integer := 0;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'public.idx_funders_name_trgm',
    'public.idx_funders_lower_name',
    'public.idx_recipient_org_name_trgm2',
    'public.idx_recipient_org_lower_name',
    'public.idx_foundation_filings_foundation',
    'public.funders_pkey',
    'public.recipient_organizations_pkey',
    'public.idx_recipient_org_ein'
  ] LOOP
    v_rel := to_regclass(v_name);
    IF v_rel IS NULL THEN
      RAISE WARNING 'prewarm_search_indexes: index % does not exist; update this list', v_name;
      CONTINUE;
    END IF;
    BEGIN
      v_blocks := v_blocks + extensions.pg_prewarm(v_rel, 'read');
      v_warmed := v_warmed + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'prewarm_search_indexes: could not warm %: %', v_name, SQLERRM;
    END;
  END LOOP;
  IF v_warmed = 0 THEN
    RAISE EXCEPTION 'prewarm_search_indexes: no index could be warmed (see the warnings above)';
  END IF;
  RETURN v_blocks;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prewarm_search_indexes() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'prewarm-search-indexes';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

SELECT cron.schedule(
  'prewarm-search-indexes',
  '*/5 * * * *',
  $$SELECT public.prewarm_search_indexes()$$
);

-- ── This job's run history ──────────────────────────────────────────────────
-- 30 days is enough to see how recent runs went. A run interrupted by a
-- restart may have no timestamps at all (marked failed before it started);
-- such a row carries nothing but "server restarted" and goes at the next
-- purge. Logs its row count, like the other purge_* functions.
-- Daily at 10:40 UTC, after the other 10:xx purge jobs.

CREATE OR REPLACE FUNCTION public.purge_prewarm_run_details()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM cron.job_run_details d
   USING cron.job j
   WHERE j.jobid = d.jobid
     AND j.jobname = 'prewarm-search-indexes'
     AND (coalesce(d.end_time, d.start_time) < now() - interval '30 days'
          OR (d.start_time IS NULL AND d.end_time IS NULL AND d.status = 'failed'));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE LOG 'purge_prewarm_run_details: deleted % rows', v_deleted;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_prewarm_run_details() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-prewarm-run-details';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

SELECT cron.schedule(
  'purge-prewarm-run-details',
  '40 10 * * *',
  $$SELECT public.purge_prewarm_run_details()$$
);
