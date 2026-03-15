-- Phase 3A: Migrate data from project_saved_funders to tracked_grants
-- This migration copies existing saved funders into the new tracked_grants table
-- The old table is kept as project_saved_funders_deprecated for 30 days

-- Step 1: Migrate rows from project_saved_funders to tracked_grants
-- Map the text status to the user's pipeline_statuses
INSERT INTO tracked_grants (project_id, user_id, funder_ein, funder_name, notes, source, is_external, added_at, status_id)
SELECT
  psf.project_id,
  p.user_id,
  psf.funder_ein,
  psf.funder_name,
  psf.notes,
  COALESCE(psf.source, 'search'),
  false,
  psf.added_at,
  -- Map old text status to pipeline_statuses id
  COALESCE(
    (SELECT ps.id FROM pipeline_statuses ps
     WHERE ps.user_id = p.user_id
     AND ps.slug = CASE
       WHEN psf.status = 'applied' THEN 'application_submitted'
       WHEN psf.status = 'awarded' THEN 'awarded'
       WHEN psf.status = 'passed' THEN 'rejected'
       ELSE 'researching'
     END
     LIMIT 1),
    -- Fallback: get the first status (researching) for the user
    (SELECT ps.id FROM pipeline_statuses ps
     WHERE ps.user_id = p.user_id
     AND ps.slug = 'researching'
     LIMIT 1)
  )
FROM project_saved_funders psf
JOIN projects p ON p.id = psf.project_id
WHERE EXISTS (
  -- Only migrate if the user has pipeline statuses (seeded)
  SELECT 1 FROM pipeline_statuses ps WHERE ps.user_id = p.user_id
)
AND NOT EXISTS (
  -- Skip if already migrated (idempotent)
  SELECT 1 FROM tracked_grants tg
  WHERE tg.project_id = psf.project_id
  AND tg.funder_ein = psf.funder_ein
);

-- Step 2: Rename old table (keep for safety)
ALTER TABLE IF EXISTS project_saved_funders RENAME TO project_saved_funders_deprecated;
