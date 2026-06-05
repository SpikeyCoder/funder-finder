-- FM-IC-NTF-001: Email when new matching grants/funders are found
--
-- The "New match alerts" toggle (notification_preferences.realtime_matches)
-- and the new_match notification *type* already existed, but nothing ever
-- queued a new_match notification, so users had to pull /matches manually.
--
-- This migration adds a small ledger table that records which (project, funder)
-- pairs a user has already been alerted about. The process-notifications
-- scheduler uses it to send a single digest email per project covering only
-- funders the user has NOT yet seen. The ledger is keyed by funder_ein so it is
-- robust to project_matches being deleted + re-inserted on every recompute.

CREATE TABLE IF NOT EXISTS public.project_match_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  funder_ein text NOT NULL,
  match_score integer,
  notified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, funder_ein)
);

CREATE INDEX IF NOT EXISTS idx_project_match_notifications_project
  ON public.project_match_notifications(project_id);

ALTER TABLE public.project_match_notifications ENABLE ROW LEVEL SECURITY;

-- Users can read the alert ledger for projects they own. Inserts happen via the
-- service-role scheduler, which bypasses RLS, so no INSERT policy is required.
DROP POLICY IF EXISTS "Users can view own match notifications" ON public.project_match_notifications;
CREATE POLICY "Users can view own match notifications"
  ON public.project_match_notifications FOR SELECT
  USING (
    (SELECT auth.uid()) = (
      SELECT p.user_id FROM public.projects p WHERE p.id = project_id
    )
  );
