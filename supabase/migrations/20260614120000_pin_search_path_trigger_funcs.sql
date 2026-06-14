-- FM-2026-06-13-01: harden remaining public trigger / seed functions against
-- search_path hijacking.
--
-- Finding: Supabase security advisor (lint 0011 / function_search_path_mutable)
-- flags four SECURITY DEFINER functions declared in older migrations that ship
-- without an explicit `search_path` setting:
--
--   * public.seed_pipeline_statuses(uuid)
--   * public.handle_new_user_pipeline()
--   * public.handle_new_user_notifications()
--   * public.record_grant_status_change()
--
-- Because their search_path is implicit, a role that can create objects in
-- a schema earlier on the session search_path could shadow `pipeline_statuses`,
-- `notification_preferences`, `grant_status_history`, or `tracked_grants` with
-- a malicious view/function and influence what these functions write.
--
-- All four remain on the access posture list reviewed by Armstrong HoldCo
-- pen-tests (`seed_pipeline_statuses` is in the intentional-access allowlist).
-- This migration pins their search_path only -- it does NOT change their
-- SECURITY DEFINER status, EXECUTE grants, or function bodies.
--
-- Same defense-in-depth pattern as chaos_tester WA-2026-06-13-01
-- (`prune_old_reports`, 2026-06-13).
--
-- CWE-426 (Untrusted Search Path). OWASP A05:2021 Security Misconfiguration.
-- Verification:
--   SELECT proname, proconfig FROM pg_proc
--    WHERE proname IN ('seed_pipeline_statuses', 'handle_new_user_pipeline',
--                      'handle_new_user_notifications', 'record_grant_status_change');
--   -- Each row's proconfig should contain {search_path=public, pg_temp}.

ALTER FUNCTION public.seed_pipeline_statuses(uuid)         SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user_pipeline()           SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user_notifications()      SET search_path = public, pg_temp;
ALTER FUNCTION public.record_grant_status_change()         SET search_path = public, pg_temp;
