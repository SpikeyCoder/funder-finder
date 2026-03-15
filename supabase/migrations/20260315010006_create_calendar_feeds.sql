-- Phase 3D: Calendar feeds for .ics subscription

CREATE TABLE IF NOT EXISTS calendar_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  include_tasks boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_accessed timestamptz
);

CREATE INDEX idx_calendar_feeds_token ON calendar_feeds(token);
CREATE INDEX idx_calendar_feeds_user ON calendar_feeds(user_id);

-- RLS
ALTER TABLE calendar_feeds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own calendar feeds"
  ON calendar_feeds FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own calendar feeds"
  ON calendar_feeds FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own calendar feeds"
  ON calendar_feeds FOR DELETE USING (auth.uid() = user_id);

-- Allow public access by token (for .ics feed endpoint)
CREATE POLICY "Public can read by token"
  ON calendar_feeds FOR SELECT USING (true);
