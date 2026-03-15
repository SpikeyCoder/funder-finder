-- Performance fixes and Supabase advisor recommendations

-- 1. Add missing indexes on frequently queried columns

-- project_matches: speed up lookups by project and score sorting
CREATE INDEX IF NOT EXISTS idx_project_matches_project_score
  ON project_matches(project_id, match_score DESC);

-- projects: speed up user dashboard queries
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

-- foundation_grants: frequently filtered by funder + year
CREATE INDEX IF NOT EXISTS idx_foundation_grants_funder_year
  ON foundation_grants(foundation_id, grant_year DESC);

-- funders: speed up EIN lookups (primary lookup pattern)
CREATE INDEX IF NOT EXISTS idx_funders_ein ON funders(foundation_ein);

-- recipient_organizations: speed up name search (basic btree on name)
CREATE INDEX IF NOT EXISTS idx_recipient_orgs_name
  ON recipient_organizations (name);

-- 2. Optimize RLS policies - add indexes that support RLS checks
-- (auth.uid() checks benefit from user_id indexes already created above)

-- 3. Add composite indexes for common JOIN patterns
CREATE INDEX IF NOT EXISTS idx_foundation_grants_grantee_ein_year
  ON foundation_grants(grantee_ein, grant_year DESC)
  WHERE grantee_ein IS NOT NULL;

-- 4. Vacuum analyze on heavily updated tables (advisory, run manually)
-- ANALYZE projects;
-- ANALYZE project_matches;
-- ANALYZE foundation_grants;
-- ANALYZE funders;

-- 5. Add statement timeout to prevent long-running queries
-- ALTER DATABASE postgres SET statement_timeout = '30s';
-- (Commented out - should be set in Supabase dashboard, not migration)

-- 6. Seed pipeline statuses for existing users who don't have them yet
INSERT INTO pipeline_statuses (user_id, name, slug, color, sort_order, is_default, is_terminal)
SELECT u.id, s.name, s.slug, s.color, s.sort_order, true, s.is_terminal
FROM auth.users u
CROSS JOIN (VALUES
  ('Researching',          'researching',          '#95A5A6', 0, false),
  ('Planned',              'planned',              '#3498DB', 1, false),
  ('LOI Submitted',        'loi_submitted',        '#9B59B6', 2, false),
  ('Application Submitted','application_submitted', '#2ECC71', 3, false),
  ('Under Review',         'under_review',         '#F39C12', 4, false),
  ('Awarded',              'awarded',              '#27AE60', 5, true),
  ('Rejected',             'rejected',             '#E74C3C', 6, true),
  ('On Hold',              'on_hold',              '#BDC3C7', 7, false)
) AS s(name, slug, color, sort_order, is_terminal)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_statuses ps WHERE ps.user_id = u.id
);

-- 7. Seed notification preferences for existing users
INSERT INTO notification_preferences (user_id)
SELECT id FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM notification_preferences np WHERE np.user_id = u.id
)
ON CONFLICT (user_id) DO NOTHING;
