-- Table to track data import history
CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_platform text NOT NULL CHECK (source_platform IN ('instrumentl', 'candid', 'grantstation', 'generic_csv')),
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  total_rows integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  conflict_strategy text NOT NULL DEFAULT 'skip' CHECK (conflict_strategy IN ('skip', 'overwrite', 'keep_both')),
  import_target text NOT NULL DEFAULT 'saved_funders' CHECK (import_target IN ('saved_funders', 'tracked_grants', 'both')),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  error_details jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Enable RLS
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

-- Users can only see their own imports
CREATE POLICY "Users can view own imports" ON import_jobs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own imports" ON import_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own imports" ON import_jobs
  FOR UPDATE USING (auth.uid() = user_id);

-- Index for efficient lookups
CREATE INDEX idx_import_jobs_user_id ON import_jobs(user_id);
CREATE INDEX idx_import_jobs_status ON import_jobs(status);
