-- WA-2026-05-23-01: Revoke EXECUTE on retention-purge functions from `authenticated`.
--
-- Pen-test finding 2026-05-23 (Armstrong HoldCo): the SECURITY DEFINER
-- retention-purge functions added in 20260515000000_retention_purge_jobs.sql
-- were granted EXECUTE to the `authenticated` role for "manual-trigger
-- debugging", but no application code calls them. As written, any
-- authenticated user could call them via PostgREST RPC and force-delete
-- audit logs, grant drafts, or training-signal events for every tenant.
--
-- The pg_cron schedules execute as the cron job owner (postgres), which
-- already owns the functions and does not need a public grant.
--
-- This migration restores the locked-down posture established by
-- 20260501173730_harden_security_definer_functions_*.sql.

REVOKE EXECUTE ON FUNCTION public.purge_expired_access_log()         FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_expired_grant_drafts()       FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_expired_search_signal_events() FROM authenticated;

-- Belt-and-braces: ensure anon and public can't execute either (no-op if
-- already revoked by the original migration, included for clarity).
REVOKE EXECUTE ON FUNCTION public.purge_expired_access_log()         FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_expired_grant_drafts()       FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_expired_search_signal_events() FROM anon, PUBLIC;

COMMENT ON FUNCTION public.purge_expired_access_log() IS
  'Deletes access_log rows older than 12 months. SECURITY DEFINER; invoked by pg_cron only. EXECUTE intentionally revoked from anon/authenticated (WA-2026-05-23-01).';
COMMENT ON FUNCTION public.purge_expired_grant_drafts() IS
  'Soft-deletes grant_drafts older than 12 months. SECURITY DEFINER; invoked by pg_cron only. EXECUTE intentionally revoked from anon/authenticated (WA-2026-05-23-01).';
COMMENT ON FUNCTION public.purge_expired_search_signal_events() IS
  'Deletes search_signal_events older than 24 months. SECURITY DEFINER; invoked by pg_cron only. EXECUTE intentionally revoked from anon/authenticated (WA-2026-05-23-01).';
