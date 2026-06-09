-- FM-IC-NTF-002: Persist team / activity notification preferences.
--
-- The Settings → Notifications tab rendered a "Team notifications" group
-- (incl. "Funder deadline changed") as static, always-checked checkboxes that
-- were never persisted. This adds a JSONB column so each toggle — most notably
-- the funder deadline-change alert backing FM-IC-NTF-002 — is saved per user
-- and can be honored by the process-notifications / send-reminders schedulers.

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS team_notifications jsonb NOT NULL DEFAULT jsonb_build_object(
    'task_assigned', true,
    'status_changed', true,
    'compliance_deadline', true,
    'team_member_joined', true,
    'deadline_changed', true
  );

COMMENT ON COLUMN public.notification_preferences.team_notifications IS
  'Per-event team/activity email toggles. Keys: task_assigned, status_changed, compliance_deadline, team_member_joined, deadline_changed (FM-IC-NTF-002).';
