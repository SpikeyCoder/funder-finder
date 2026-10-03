-- Rollback for 20261003120000_prewarm_search_indexes.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never applies it.
-- Unschedules both jobs and drops their functions and the pg_prewarm
-- extension. pg_prewarm wasn't installed before this migration (checked
-- 2026-10-03) and nothing else uses it. Pages already cached stay cached until
-- evicted; pg_cron run history already purged stays purged.
--
-- Apply manually: psql "$DATABASE_URL" -f supabase/rollbacks/20261003120000_prewarm_search_indexes.down.sql

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'prewarm-search-indexes';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
  v_job_id := NULL;
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-cron-run-details';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

DROP FUNCTION IF EXISTS public.prewarm_search_indexes();
DROP FUNCTION IF EXISTS public.purge_cron_run_details();

DROP EXTENSION IF EXISTS pg_prewarm;
