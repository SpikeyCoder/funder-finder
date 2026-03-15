-- Phase 3A: Create pipeline_statuses table for configurable grant status pipelines
-- Each user gets default statuses seeded via trigger on first use

CREATE TABLE IF NOT EXISTS pipeline_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  color text NOT NULL DEFAULT '#95A5A6',
  sort_order integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_pipeline_statuses_user ON pipeline_statuses(user_id, sort_order);
CREATE UNIQUE INDEX idx_pipeline_statuses_user_slug ON pipeline_statuses(user_id, slug);

-- RLS
ALTER TABLE pipeline_statuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own statuses"
  ON pipeline_statuses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own statuses"
  ON pipeline_statuses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own statuses"
  ON pipeline_statuses FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own non-default statuses"
  ON pipeline_statuses FOR DELETE
  USING (auth.uid() = user_id AND is_default = false);

-- Function to seed default statuses for a user
CREATE OR REPLACE FUNCTION seed_pipeline_statuses(p_user_id uuid)
RETURNS void AS $$
BEGIN
  -- Only seed if user has no statuses yet
  IF NOT EXISTS (SELECT 1 FROM pipeline_statuses WHERE user_id = p_user_id) THEN
    INSERT INTO pipeline_statuses (user_id, name, slug, color, sort_order, is_default, is_terminal) VALUES
      (p_user_id, 'Researching',          'researching',          '#95A5A6', 0, true, false),
      (p_user_id, 'Planned',              'planned',              '#3498DB', 1, true, false),
      (p_user_id, 'LOI Submitted',        'loi_submitted',        '#9B59B6', 2, true, false),
      (p_user_id, 'Application Submitted','application_submitted', '#2ECC71', 3, true, false),
      (p_user_id, 'Under Review',         'under_review',         '#F39C12', 4, true, false),
      (p_user_id, 'Awarded',              'awarded',              '#27AE60', 5, true, true),
      (p_user_id, 'Rejected',             'rejected',             '#E74C3C', 6, true, true),
      (p_user_id, 'On Hold',              'on_hold',              '#BDC3C7', 7, true, false);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Auto-seed statuses when a new user signs up
CREATE OR REPLACE FUNCTION handle_new_user_pipeline()
RETURNS trigger AS $$
BEGIN
  PERFORM seed_pipeline_statuses(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only create trigger if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created_pipeline') THEN
    CREATE TRIGGER on_auth_user_created_pipeline
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION handle_new_user_pipeline();
  END IF;
END
$$;
