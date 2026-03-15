-- Phase 3C: Notification preferences and queue tables

-- Notification preferences (one row per user)
CREATE TABLE IF NOT EXISTS notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  deadline_reminders integer[] NOT NULL DEFAULT '{30,14,7,3,1}',
  task_reminders integer[] NOT NULL DEFAULT '{1}',
  weekly_digest boolean NOT NULL DEFAULT true,
  digest_day integer NOT NULL DEFAULT 1, -- 0=Sun, 1=Mon
  realtime_matches boolean NOT NULL DEFAULT false,
  email_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_prefs_user ON notification_preferences(user_id);

-- Auto-seed notification preferences for new users
CREATE OR REPLACE FUNCTION handle_new_user_notifications()
RETURNS trigger AS $$
BEGIN
  INSERT INTO notification_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created_notifications') THEN
    CREATE TRIGGER on_auth_user_created_notifications
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION handle_new_user_notifications();
  END IF;
END
$$;

-- Notification queue
CREATE TABLE IF NOT EXISTS notification_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  type text NOT NULL, -- deadline_reminder, task_reminder, task_assignment, task_completed, weekly_digest, new_match
  payload jsonb NOT NULL DEFAULT '{}',
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_queue_pending ON notification_queue(scheduled_for)
  WHERE sent_at IS NULL AND retry_count < 3;
CREATE INDEX idx_notification_queue_user ON notification_queue(user_id);

-- RLS
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notification preferences"
  ON notification_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notification preferences"
  ON notification_preferences FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own notification preferences"
  ON notification_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own notifications"
  ON notification_queue FOR SELECT USING (auth.uid() = user_id);
