-- =====================================================================
-- 1. Drop the broad SELECT policy on bug-screenshots that enables LIST.
--    Public buckets allow individual object URL reads without an RLS
--    policy. The INSERT policy "Restricted upload to bug screenshots"
--    is unchanged, so BugReportButton.tsx uploads continue to work.
-- =====================================================================
DROP POLICY IF EXISTS "Public read access for bug screenshots"
  ON storage.objects;

-- =====================================================================
-- 2. Revoke EXECUTE on SECURITY DEFINER trigger functions.
--    These are invoked by Postgres triggers / event triggers, never
--    via REST RPC. Revocation removes the unintended REST surface
--    while leaving the trigger path intact (triggers run as table owner).
-- =====================================================================
REVOKE EXECUTE ON FUNCTION public.auto_track_saved_funder()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.auto_untrack_removed_funder()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_notifications()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_pipeline()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.record_grant_status_change()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.schedule_deadline_reminders()
  FROM anon, authenticated, public;

-- =====================================================================
-- 3. Revoke EXECUTE on data-access SECURITY DEFINER functions.
--    Verified safe: these are only called by Edge Functions using the
--    service-role key (which bypasses EXECUTE checks), never directly
--    from the React SPA. grep across src/ for these names returns 0.
-- =====================================================================
REVOKE EXECUTE ON FUNCTION public.check_permission(uuid, uuid, text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.compute_funder_peers(text, integer)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.compute_recipient_peers(text, integer)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_funder_data_quality(text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_funder_geo_distribution(text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_funder_giving_trends(text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_funder_grantee_loyalty(text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_funder_top_recipients(text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_recipient_profile(uuid, text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_recipient_top_funders(text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.get_recipient_yearly_trends(text)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.seed_pipeline_statuses(uuid)
  FROM anon, authenticated, public;
