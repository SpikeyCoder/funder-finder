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
-- page cache; a run reads from disk only what was evicted since the last one
-- (~30 ms for the four name indexes while cached). The run's duration in
-- cron.job_run_details (end_time - start_time) shows whether it had to.
--
-- The tables themselves (~310 MB) aren't warmed: on this instance they'd
-- compete with everything else for the page cache.
--
-- pg_prewarm isn't in shared_preload_libraries, so its autoprewarm worker
-- (reload after a restart) isn't available; the schedule covers that too,
-- within 5 minutes of a restart.
--
-- Indexes (sizes and use from pg_stat_user_indexes and EXPLAIN):
--   idx_funders_name_trgm              58 MB  trigram candidate sets
--   idx_funders_lower_name             16 MB  exact and prefix sets
--   idx_recipient_org_name_trgm2       37 MB  trigram candidate sets
--   idx_recipient_org_lower_name       20 MB  exact and prefix sets
--   idx_foundation_filings_foundation  17 MB  the per-funder "has 990-PF filings" EXISTS probe
--   funders_pkey                       21 MB  joining candidates back; EIN search
--   recipient_organizations_pkey       18 MB  joining candidates back
--   idx_recipient_org_ein              14 MB  EIN search
-- Not idx_recipient_org_name_trgm (name_normalized), which search doesn't use.
-- An index that no longer exists is skipped with a WARNING in the Postgres
-- log, so a rename shows up there instead of silently warming nothing.
--
-- Also purges pg_cron's run history (cron.job_run_details), which nothing
-- purged: this job adds 288 rows a day.
-- ─────────────────────────────────────────────────────────────────────────────

-- Its functions are owned by supabase_admin, which grants EXECUTE to PUBLIC
-- (as for every extension here); postgres can't revoke that grant. That's
-- acceptable: the API exposes only the public and graphql_public schemas (a
-- call with Content-Profile: extensions gets PGRST106), and pg_prewarm checks
-- SELECT on the relation it's given, which for an index means its owner.
CREATE EXTENSION IF NOT EXISTS pg_prewarm WITH SCHEMA extensions;
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
    ELSE
      v_blocks := v_blocks + extensions.pg_prewarm(v_rel, 'read');
    END IF;
  END LOOP;
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

-- ── pg_cron run history ─────────────────────────────────────────────────────
-- 30 days is enough to see how recent runs went; older rows have no use.
-- Daily at 10:40 UTC, after the other 10:xx purge jobs.

CREATE OR REPLACE FUNCTION public.purge_cron_run_details()
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM cron.job_run_details WHERE end_time < now() - interval '30 days';
$$;

REVOKE EXECUTE ON FUNCTION public.purge_cron_run_details() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-cron-run-details';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

SELECT cron.schedule(
  'purge-cron-run-details',
  '40 10 * * *',
  $$SELECT public.purge_cron_run_details()$$
);

-- Warm them now rather than at the next tick.
SELECT public.prewarm_search_indexes();
