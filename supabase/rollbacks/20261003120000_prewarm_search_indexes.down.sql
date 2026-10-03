-- Rollback for 20261003120000_prewarm_search_indexes.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never applies it.
-- Unschedules both jobs and drops their functions and the pg_prewarm
-- extension. pg_prewarm wasn't installed before this migration (checked
-- 2026-10-03) and nothing else uses it. Pages already cached stay cached until
-- evicted.
--
-- Left in place: idx_recipient_org_ein. It existed in production before this
-- migration (which only declares it) and search uses it.
--
-- Also remove the `cron.job_run_details` row from
-- compliance/retention-and-deletion.md, so the policy doesn't name a purge job
-- that no longer exists. (Keep the rest of that PR's doc changes: the
-- rate_limit_hits row and the verification query describe jobs that stay.)
--
-- Apply manually: psql "$DATABASE_URL" -f supabase/rollbacks/20261003120000_prewarm_search_indexes.down.sql

DO $$
DECLARE
  v_job_id bigint;
  v_purge_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'prewarm-search-indexes';
  SELECT jobid INTO v_purge_id FROM cron.job WHERE jobname = 'purge-prewarm-run-details';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
  IF v_purge_id IS NOT NULL THEN PERFORM cron.unschedule(v_purge_id); END IF;
  -- Then its run history (matched as the purge does); nothing would purge it
  -- once the purge job is gone.
  DELETE FROM cron.job_run_details
   WHERE jobid = v_job_id OR command = 'SELECT public.prewarm_search_indexes()';
END $$;

DROP FUNCTION IF EXISTS public.prewarm_search_indexes();
DROP FUNCTION IF EXISTS public.purge_prewarm_run_details();

DROP EXTENSION IF EXISTS pg_prewarm;
