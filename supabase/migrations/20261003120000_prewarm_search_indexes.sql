-- FM-2026-10-03-01: keep the search_organizations indexes in memory.
-- ─────────────────────────────────────────────────────────────────────────────
-- After 20261002120000, a warm search takes well under a second, but a search
-- whose index pages have been evicted reads them from disk and can exceed the
-- anon role's 3 s statement_timeout ("Search failed", 502). Seen right after
-- deploy: "community foundation" failed at 3.3 s cold, then took 0.5–1 s
-- end to end on every repeat.
--
-- Search touches ~480 MB (131 MB of the indexes below plus the two tables),
-- more than shared_buffers (320 MB), so eviction is routine. This job re-reads
-- the four indexes search uses every 5 minutes with pg_prewarm's 'read' mode,
-- which loads them into the OS page cache rather than shared_buffers: it
-- doesn't push 131 MB of other data out of shared_buffers, and a read from the
-- page cache is a memory copy, not a disk read. While the indexes are cached a
-- run takes ~0.6 s; when they've been evicted it reads at most 131 MB.
--
-- pg_prewarm isn't in shared_preload_libraries, so its autoprewarm worker
-- (reload after a restart) isn't available; the schedule covers that too,
-- within 5 minutes of a restart.
--
-- Indexes (from pg_stat_user_indexes, all used by search_organizations):
--   idx_funders_name_trgm         58 MB  gin (name gin_trgm_ops)
--   idx_funders_lower_name        16 MB  btree (lower(btrim(name)) text_pattern_ops)
--   idx_recipient_org_name_trgm2  37 MB  gin (name gin_trgm_ops)
--   idx_recipient_org_lower_name  20 MB  btree (lower(btrim(name)) text_pattern_ops)
-- Not idx_recipient_org_name_trgm (name_normalized), which search doesn't use.
-- A missing index is skipped (to_regclass), so the job keeps working if one is
-- renamed or a rollback drops it.
-- ─────────────────────────────────────────────────────────────────────────────

-- Its functions are owned by supabase_admin, which grants EXECUTE to PUBLIC
-- (as for every extension here); postgres can't revoke that grant. That's
-- acceptable: the API exposes only the public and graphql_public schemas (a
-- call with Content-Profile: extensions gets PGRST106), and pg_prewarm only
-- loads relations the caller can already SELECT.
CREATE EXTENSION IF NOT EXISTS pg_prewarm WITH SCHEMA extensions;

-- Returns the number of blocks read, so a run's cost shows in
-- cron.job_run_details.
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
    'public.idx_recipient_org_lower_name'
  ] LOOP
    v_rel := to_regclass(v_name);
    IF v_rel IS NOT NULL THEN
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

-- Warm them now rather than at the next tick.
SELECT public.prewarm_search_indexes();
