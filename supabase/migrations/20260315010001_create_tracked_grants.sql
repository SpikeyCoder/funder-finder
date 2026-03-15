-- Phase 3A: Create tracked_grants table (replaces project_saved_funders)
-- Full grant lifecycle tracking with configurable status pipeline

CREATE TABLE IF NOT EXISTS tracked_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  funder_ein text,
  funder_name text NOT NULL,
  grant_title text,
  status_id uuid NOT NULL REFERENCES pipeline_statuses(id),
  amount numeric(12,2),
  deadline date,
  grant_url text,
  notes text,
  source text NOT NULL DEFAULT 'manual',
  is_external boolean NOT NULL DEFAULT false,
  awarded_amount numeric(12,2),
  awarded_date date,
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_tracked_grants_project ON tracked_grants(project_id);
CREATE INDEX idx_tracked_grants_user ON tracked_grants(user_id);
CREATE INDEX idx_tracked_grants_status ON tracked_grants(status_id);
CREATE INDEX idx_tracked_grants_deadline ON tracked_grants(deadline) WHERE deadline IS NOT NULL;
CREATE INDEX idx_tracked_grants_funder_ein ON tracked_grants(funder_ein) WHERE funder_ein IS NOT NULL;

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_tracked_grants_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tracked_grants_updated_at
  BEFORE UPDATE ON tracked_grants
  FOR EACH ROW EXECUTE FUNCTION update_tracked_grants_timestamp();

-- RLS
ALTER TABLE tracked_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tracked grants"
  ON tracked_grants FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tracked grants"
  ON tracked_grants FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tracked grants"
  ON tracked_grants FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tracked grants"
  ON tracked_grants FOR DELETE
  USING (auth.uid() = user_id);
