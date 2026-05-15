-- Migration: retention purge jobs
-- Pen-test 2026-05-15 finding FM-2026-05-15-01.
--
-- compliance/retention-and-deletion.md documents a 12-month / 24-month
-- retention floor for `access_log`, `grant_drafts`, and
-- `search_signal_events`, with the deletion mechanism described as
-- "Scheduled Postgres job (planned)". The job was never scheduled, so the
-- documented retention floor was unenforced; rows could accumulate
-- indefinitely. SOC 2 P4 (Privacy — retention and disposal) and C1
-- (Confidentiality) are audit-blocking until enforcement matches policy.
--
-- This migration adds three pg_cron jobs that DELETE expired rows daily
-- at 03:15 America/Los_Angeles (10:15 UTC for the entire year — pg_cron
-- expects UTC and the site has no business-hours dependency on the job).
-- Each function is SECURITY DEFINER + search_path-pinned per the project
-- hardening pattern (see 20260408153620_fix_function_search_path_mutable.sql).
--
-- Idempotency: each job is wrapped in a JOB-NAME-UNSCHEDULE-THEN-SCHEDULE
-- pair so re-running the migration replaces an existing schedule rather
-- than erroring.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- access_log: 12-month retention (per retention-and-deletion.md)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_access_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  WITH d AS (
    DELETE FROM public.access_log
    WHERE accessed_at < now() - interval '12 months'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM d;
  RAISE LOG 'purge_expired_access_log: deleted % rows', v_deleted;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_expired_access_log() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- grant_drafts: 12 months after last edit (per retention-and-deletion.md)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_grant_drafts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  WITH d AS (
    DELETE FROM public.grant_drafts
    WHERE updated_at < now() - interval '12 months'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM d;
  RAISE LOG 'purge_expired_grant_drafts: deleted % rows', v_deleted;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_expired_grant_drafts() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- search_signal_events: 24-month retention (per retention-and-deletion.md)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_search_signal_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_deleted integer;
  v_ts_col text;
BEGIN
  -- The search_signal_events table tracks search/result events. The
  -- canonical "row created" timestamp is `created_at`; older snapshots
  -- of the table used `event_ts`. Detect which is present to keep the
  -- migration safe across schema variants.
  SELECT column_name INTO v_ts_col
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'search_signal_events'
    AND column_name IN ('created_at', 'event_ts', 'occurred_at')
  ORDER BY array_position(ARRAY['created_at', 'occurred_at', 'event_ts'], column_name)
  LIMIT 1;

  IF v_ts_col IS NULL THEN
    RAISE LOG 'purge_expired_search_signal_events: no timestamp column found, skipping';
    RETURN 0;
  END IF;

  EXECUTE format(
    'WITH d AS (DELETE FROM public.search_signal_events WHERE %I < now() - interval ''24 months'' RETURNING 1) SELECT count(*) FROM d',
    v_ts_col
  ) INTO v_deleted;
  RAISE LOG 'purge_expired_search_signal_events: deleted % rows (ts column %)', v_deleted, v_ts_col;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_expired_search_signal_events() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Schedule (or re-schedule) the three jobs.
-- 03:15 America/Los_Angeles ≈ 10:15 UTC year-round (pg_cron is UTC-only).
-- Daily cadence is overkill for steady-state row volumes but keeps the
-- backlog from compounding if a single run fails.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_job_id bigint;
BEGIN
  -- access_log
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-access-log';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;

  -- grant_drafts
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-grant-drafts';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;

  -- search_signal_events
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-search-signal-events';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

SELECT cron.schedule(
  'purge-access-log',
  '15 10 * * *',
  $$SELECT public.purge_expired_access_log()$$
);

SELECT cron.schedule(
  'purge-grant-drafts',
  '20 10 * * *',
  $$SELECT public.purge_expired_grant_drafts()$$
);

SELECT cron.schedule(
  'purge-search-signal-events',
  '25 10 * * *',
  $$SELECT public.purge_expired_search_signal_events()$$
);

-- Grant execute to authenticated only for manual-trigger debugging
-- (e.g. DSR-driven early purge). Service role can call it directly.
GRANT EXECUTE ON FUNCTION public.purge_expired_access_log() TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_grant_drafts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_search_signal_events() TO authenticated;

COMMENT ON FUNCTION public.purge_expired_access_log() IS
  'FM-2026-05-15-01: enforce 12-month retention on shareable-link access_log.';
COMMENT ON FUNCTION public.purge_expired_grant_drafts() IS
  'FM-2026-05-15-01: enforce 12-month retention on grant_drafts (last-edit-based).';
COMMENT ON FUNCTION public.purge_expired_search_signal_events() IS
  'FM-2026-05-15-01: enforce 24-month retention on search_signal_events corpus.';
