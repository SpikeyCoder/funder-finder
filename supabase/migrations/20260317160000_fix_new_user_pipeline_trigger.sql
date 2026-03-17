-- Fix the broken seed_pipeline_statuses() trigger function that was causing
-- "Database error saving new user" on OAuth signup.
--
-- Root cause: security migration rewrote seed_pipeline_statuses() as a trigger
-- function using NEW.id, but handle_new_user_pipeline() calls it via PERFORM
-- where NEW is not available. Also missing the required `slug` column.
--
-- Fix: Rewrite handle_new_user_pipeline() to do the insert directly using NEW.id
-- (which IS available since it's the actual trigger function), and include all
-- required columns including slug.

-- Drop the broken no-arg trigger version of seed_pipeline_statuses
-- (Keep the original seed_pipeline_statuses(uuid) version for manual use)
DROP FUNCTION IF EXISTS seed_pipeline_statuses() CASCADE;

-- Rewrite the trigger function to insert directly
CREATE OR REPLACE FUNCTION handle_new_user_pipeline()
RETURNS trigger AS $$
BEGIN
  -- Only seed if user has no statuses yet
  IF NOT EXISTS (SELECT 1 FROM pipeline_statuses WHERE user_id = NEW.id) THEN
    INSERT INTO pipeline_statuses (user_id, name, slug, color, sort_order, is_default, is_terminal) VALUES
      (NEW.id, 'Researching',           'researching',           '#6366f1', 0, true, false),
      (NEW.id, 'Prospecting',           'prospecting',           '#8b5cf6', 1, true, false),
      (NEW.id, 'Planned',               'planned',               '#3b82f6', 2, true, false),
      (NEW.id, 'LOI Submitted',         'loi_submitted',         '#06b6d4', 3, true, false),
      (NEW.id, 'Application Submitted', 'application_submitted', '#10b981', 4, true, false),
      (NEW.id, 'Under Review',          'under_review',          '#f59e0b', 5, true, false),
      (NEW.id, 'Awarded',               'awarded',               '#22c55e', 6, true, true),
      (NEW.id, 'Declined',              'declined',              '#ef4444', 7, true, true)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

-- Re-create the trigger (in case CASCADE dropped it)
DROP TRIGGER IF EXISTS on_auth_user_created_pipeline ON auth.users;
CREATE TRIGGER on_auth_user_created_pipeline
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user_pipeline();
