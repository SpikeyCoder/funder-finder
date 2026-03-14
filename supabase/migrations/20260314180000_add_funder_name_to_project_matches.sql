-- Add funder_name column to project_matches for display purposes
ALTER TABLE project_matches ADD COLUMN IF NOT EXISTS funder_name text;
