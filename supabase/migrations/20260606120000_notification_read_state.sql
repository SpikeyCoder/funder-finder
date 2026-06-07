-- =====================================================================
-- FM-IC-NTF-002: in-app notification read-state
--
-- The deadline-change alert pipeline (check-deadlines -> notification_queue
-- -> process-notifications email) is already in place. This migration adds
-- the read-state needed to surface those same alerts INSIDE the app (the
-- in-app bell), so users see "this funder moved a deadline" without relying
-- on email alone — the user-facing path the usability audit flagged.
--
--   read_at timestamptz — when the user dismissed/opened the alert in-app.
--                         NULL = unread (drives the bell's unread badge).
--
-- notification_queue already has an RLS SELECT policy scoped to
-- auth.uid() = user_id (see 20260315010005_create_notification_system.sql),
-- so the bell can read the user's own rows. We add a matching UPDATE policy
-- so a user can mark only their OWN notifications read.
-- =====================================================================

ALTER TABLE public.notification_queue
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

COMMENT ON COLUMN public.notification_queue.read_at IS
  'When the user opened/dismissed this notification in the in-app bell. NULL = unread (FM-IC-NTF-002).';

-- Fast unread lookups for the bell badge, scoped per user.
CREATE INDEX IF NOT EXISTS idx_notification_queue_user_unread
  ON public.notification_queue (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Let a user mark their own notifications read. The USING + WITH CHECK pair
-- ensures rows can neither be re-assigned to another user nor updated on
-- another user's behalf. (Idempotent: drop-then-create.)
DROP POLICY IF EXISTS "Users can update own notifications" ON public.notification_queue;
CREATE POLICY "Users can update own notifications"
  ON public.notification_queue FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
