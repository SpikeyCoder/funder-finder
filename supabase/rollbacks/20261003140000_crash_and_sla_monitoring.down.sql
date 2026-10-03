-- Rollback for 20261003140000_crash_and_sla_monitoring.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never applies it.
-- Unschedules both jobs, deletes the sweep's run history (not the purge
-- job's: that's retention evidence), and drops the
-- functions and tables (with the crash reports, vitals and SLA checks in them;
-- Trello cards already opened stay). Also undeploy monitor-report and
-- monitor-sweep, and remove this PR's rows from
-- compliance/retention-and-deletion.md and compliance/monitoring-and-alerting.md.
-- The frontend keeps sending reports until it's rolled back too; with the
-- function undeployed they fail silently.
--
-- Apply manually: psql "$DATABASE_URL" -f supabase/rollbacks/20261003140000_crash_and_sla_monitoring.down.sql

BEGIN;

DO $$
DECLARE
  v_sweep bigint;
  v_purge bigint;
BEGIN
  SELECT jobid INTO v_sweep FROM cron.job WHERE jobname = 'monitor-sweep';
  SELECT jobid INTO v_purge FROM cron.job WHERE jobname = 'purge-monitoring';
  IF v_sweep IS NOT NULL THEN PERFORM cron.unschedule(v_sweep); END IF;
  IF v_purge IS NOT NULL THEN PERFORM cron.unschedule(v_purge); END IF;
  -- The sweep's run history only: the purge job's is retention evidence.
  DELETE FROM cron.job_run_details
   WHERE jobid = v_sweep OR command = 'SELECT public.invoke_monitor_sweep()';
END $$;

DROP FUNCTION IF EXISTS public.invoke_monitor_sweep();
DROP FUNCTION IF EXISTS public.purge_monitoring();
DROP FUNCTION IF EXISTS public.monitor_vitals_breaches(integer);
DROP FUNCTION IF EXISTS public.record_vitals(jsonb);
DROP FUNCTION IF EXISTS public.record_client_crash(text, text, text, text, text, text, text, text, text);

DROP TABLE IF EXISTS public.monitor_alerts;
DROP TABLE IF EXISTS public.monitor_sla_checks;
DROP TABLE IF EXISTS public.monitor_vitals;
DROP TABLE IF EXISTS public.monitor_crashes;

COMMIT;
