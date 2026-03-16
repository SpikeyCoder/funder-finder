-- =============================================================================
-- Supabase Security & Performance Advisor Fixes
-- Applied via Supabase MCP apply_migration (4 batches)
-- Resolves ALL security + performance warnings except unused_index (INFO)
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. SECURITY: Fix ALL functions with mutable search_path
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION seed_pipeline_statuses()
RETURNS trigger AS $$
BEGIN
  INSERT INTO pipeline_statuses (user_id, name, color, sort_order, is_terminal)
  VALUES
    (NEW.id, 'Researching',       '#6366f1', 0, false),
    (NEW.id, 'Prospecting',       '#8b5cf6', 1, false),
    (NEW.id, 'Planned',           '#3b82f6', 2, false),
    (NEW.id, 'LOI Submitted',     '#06b6d4', 3, false),
    (NEW.id, 'Application Sent',  '#10b981', 4, false),
    (NEW.id, 'Under Review',      '#f59e0b', 5, false),
    (NEW.id, 'Awarded',           '#22c55e', 6, true),
    (NEW.id, 'Declined',          '#ef4444', 7, true)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

CREATE OR REPLACE FUNCTION handle_new_user_pipeline()
RETURNS trigger AS $$
BEGIN
  PERFORM seed_pipeline_statuses();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

CREATE OR REPLACE FUNCTION handle_new_user_notifications()
RETURNS trigger AS $$
BEGIN
  INSERT INTO notification_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

CREATE OR REPLACE FUNCTION record_grant_status_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.status_id IS DISTINCT FROM NEW.status_id THEN
    INSERT INTO grant_status_history (tracked_grant_id, from_status_id, to_status_id, changed_by)
    VALUES (NEW.id, OLD.status_id, NEW.status_id, auth.uid());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

CREATE OR REPLACE FUNCTION public.track_deadline_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $function$
BEGIN
  IF OLD.deadline IS DISTINCT FROM NEW.deadline THEN
    NEW.previous_deadline = OLD.deadline;
  END IF;
  RETURN NEW;
END;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Enable RLS on all public tables
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.funders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foundation_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foundation_grants ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'projects') THEN
    EXECUTE 'ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'project_matches') THEN
    EXECUTE 'ALTER TABLE public.project_matches ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'foundation_history_features') THEN
    EXECUTE 'ALTER TABLE public.foundation_history_features ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'search_cache') THEN
    EXECUTE 'ALTER TABLE public.search_cache ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'recipient_organizations') THEN
    EXECUTE 'ALTER TABLE public.recipient_organizations ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Drop overly permissive calendar_feeds policy
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Public can read by token" ON calendar_feeds;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Fix auth_rls_initplan: Rewrite policies to use (select auth.uid())
--    This prevents per-row re-evaluation of auth.uid()
-- ═══════════════════════════════════════════════════════════════════════════════

-- bookmarked_passages
DROP POLICY IF EXISTS bookmarks_select ON public.bookmarked_passages;
CREATE POLICY bookmarks_select ON public.bookmarked_passages FOR SELECT
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS bookmarks_insert ON public.bookmarked_passages;
CREATE POLICY bookmarks_insert ON public.bookmarked_passages FOR INSERT
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS bookmarks_update ON public.bookmarked_passages;
CREATE POLICY bookmarks_update ON public.bookmarked_passages FOR UPDATE
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS bookmarks_delete ON public.bookmarked_passages;
CREATE POLICY bookmarks_delete ON public.bookmarked_passages FOR DELETE
  USING (user_id = (select auth.uid()));

-- shareable_links
DROP POLICY IF EXISTS shareable_links_select ON public.shareable_links;
CREATE POLICY shareable_links_select ON public.shareable_links FOR SELECT
  USING (created_by = (select auth.uid()));

DROP POLICY IF EXISTS shareable_links_insert ON public.shareable_links;
CREATE POLICY shareable_links_insert ON public.shareable_links FOR INSERT
  WITH CHECK (created_by = (select auth.uid()));

DROP POLICY IF EXISTS shareable_links_update ON public.shareable_links;
CREATE POLICY shareable_links_update ON public.shareable_links FOR UPDATE
  USING (created_by = (select auth.uid()));

DROP POLICY IF EXISTS shareable_links_delete ON public.shareable_links;
CREATE POLICY shareable_links_delete ON public.shareable_links FOR DELETE
  USING (created_by = (select auth.uid()));

-- onboarding_progress
DROP POLICY IF EXISTS onboarding_select ON public.onboarding_progress;
CREATE POLICY onboarding_select ON public.onboarding_progress FOR SELECT
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS onboarding_insert ON public.onboarding_progress;
CREATE POLICY onboarding_insert ON public.onboarding_progress FOR INSERT
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS onboarding_update ON public.onboarding_progress;
CREATE POLICY onboarding_update ON public.onboarding_progress FOR UPDATE
  USING (user_id = (select auth.uid()));

-- org_members
DROP POLICY IF EXISTS org_members_select ON public.org_members;
CREATE POLICY org_members_select ON public.org_members FOR SELECT
  USING ((user_id = (select auth.uid())) OR (invited_by = (select auth.uid())));

DROP POLICY IF EXISTS org_members_insert ON public.org_members;
CREATE POLICY org_members_insert ON public.org_members FOR INSERT
  WITH CHECK (invited_by = (select auth.uid()));

DROP POLICY IF EXISTS org_members_update ON public.org_members;
CREATE POLICY org_members_update ON public.org_members FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM org_members om
    WHERE om.user_id = (select auth.uid()) AND om.role = 'admin'
  ));

-- invitations
DROP POLICY IF EXISTS invitations_select ON public.invitations;
CREATE POLICY invitations_select ON public.invitations FOR SELECT
  USING (invited_by = (select auth.uid()));

DROP POLICY IF EXISTS invitations_insert ON public.invitations;
CREATE POLICY invitations_insert ON public.invitations FOR INSERT
  WITH CHECK (invited_by = (select auth.uid()));

DROP POLICY IF EXISTS invitations_update ON public.invitations;
CREATE POLICY invitations_update ON public.invitations FOR UPDATE
  USING (invited_by = (select auth.uid()));

-- project_access
DROP POLICY IF EXISTS project_access_select ON public.project_access;
CREATE POLICY project_access_select ON public.project_access FOR SELECT
  USING ((user_id = (select auth.uid())) OR (granted_by = (select auth.uid())));

DROP POLICY IF EXISTS project_access_insert ON public.project_access;
CREATE POLICY project_access_insert ON public.project_access FOR INSERT
  WITH CHECK ((select auth.uid()) = (SELECT p.user_id FROM projects p WHERE p.id = project_id));

DROP POLICY IF EXISTS project_access_delete ON public.project_access;
CREATE POLICY project_access_delete ON public.project_access FOR DELETE
  USING ((select auth.uid()) = (SELECT p.user_id FROM projects p WHERE p.id = project_id));

-- access_log
DROP POLICY IF EXISTS access_log_select ON public.access_log;
CREATE POLICY access_log_select ON public.access_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM shareable_links sl
    WHERE sl.id = access_log.link_id AND sl.created_by = (select auth.uid())
  ));

-- compliance_requirements
DROP POLICY IF EXISTS compliance_select ON public.compliance_requirements;
CREATE POLICY compliance_select ON public.compliance_requirements FOR SELECT
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS compliance_insert ON public.compliance_requirements;
CREATE POLICY compliance_insert ON public.compliance_requirements FOR INSERT
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS compliance_update ON public.compliance_requirements;
CREATE POLICY compliance_update ON public.compliance_requirements FOR UPDATE
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS compliance_delete ON public.compliance_requirements;
CREATE POLICY compliance_delete ON public.compliance_requirements FOR DELETE
  USING (user_id = (select auth.uid()));

-- application_knowledge_base
DROP POLICY IF EXISTS kb_select ON public.application_knowledge_base;
CREATE POLICY kb_select ON public.application_knowledge_base FOR SELECT
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS kb_insert ON public.application_knowledge_base;
CREATE POLICY kb_insert ON public.application_knowledge_base FOR INSERT
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS kb_update ON public.application_knowledge_base;
CREATE POLICY kb_update ON public.application_knowledge_base FOR UPDATE
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS kb_delete ON public.application_knowledge_base;
CREATE POLICY kb_delete ON public.application_knowledge_base FOR DELETE
  USING (user_id = (select auth.uid()));

-- notification_preferences (DELETE policy)
DROP POLICY IF EXISTS "Users can delete own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users can delete own notification preferences"
  ON public.notification_preferences FOR DELETE
  USING ((select auth.uid()) = user_id);

-- project_matches (UPDATE policy — only one without a dashboard equivalent)
DROP POLICY IF EXISTS matches_update_own ON public.project_matches;
CREATE POLICY matches_update_own ON public.project_matches FOR UPDATE
  USING ((select auth.uid()) = (SELECT p.user_id FROM projects p WHERE p.id = project_id));


-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Drop duplicate policies (dashboard already created equivalents)
-- ═══════════════════════════════════════════════════════════════════════════════

-- projects: dashboard has "Users can view/create/update/delete own projects"
DROP POLICY IF EXISTS projects_select_own ON public.projects;
DROP POLICY IF EXISTS projects_insert_own ON public.projects;
DROP POLICY IF EXISTS projects_update_own ON public.projects;
DROP POLICY IF EXISTS projects_delete_own ON public.projects;

-- project_matches: dashboard has "Users can view/insert/delete own project matches"
DROP POLICY IF EXISTS matches_select_own ON public.project_matches;
DROP POLICY IF EXISTS matches_insert_own ON public.project_matches;
DROP POLICY IF EXISTS matches_delete_own ON public.project_matches;

-- browse tables: dashboard already has "Allow public read access"
DROP POLICY IF EXISTS public_read_funders ON public.funders;
DROP POLICY IF EXISTS public_read_filings ON public.foundation_filings;
DROP POLICY IF EXISTS public_read_grants ON public.foundation_grants;
DROP POLICY IF EXISTS public_read_history_features ON public.foundation_history_features;
DROP POLICY IF EXISTS public_read_recipients ON public.recipient_organizations;
DROP POLICY IF EXISTS public_read_search_cache ON public.search_cache;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Fix duplicate index + add missing FK index
-- ═══════════════════════════════════════════════════════════════════════════════

-- foundation_grants has identical idx_foundation_grants_filing and idx_foundation_grants_filing_id
DROP INDEX IF EXISTS idx_foundation_grants_filing;

-- project_access.user_id needs single-column index (composite doesn't cover FK)
CREATE INDEX IF NOT EXISTS idx_project_access_user
  ON public.project_access (user_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Performance: All FK indexes (previously applied, kept for reference)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_foundation_filings_foundation
  ON public.foundation_filings (foundation_id);

CREATE INDEX IF NOT EXISTS idx_grant_status_history_to_status
  ON public.grant_status_history (to_status_id);

CREATE INDEX IF NOT EXISTS idx_compliance_requirements_project
  ON public.compliance_requirements (project_id);

CREATE INDEX IF NOT EXISTS idx_bookmarked_passages_kb_entry
  ON public.bookmarked_passages (kb_entry_id);

CREATE INDEX IF NOT EXISTS idx_project_access_project_user
  ON public.project_access (project_id, user_id);

CREATE INDEX IF NOT EXISTS idx_shareable_links_project
  ON public.shareable_links (project_id);

CREATE INDEX IF NOT EXISTS idx_grant_status_history_from_status
  ON public.grant_status_history (from_status_id);

CREATE INDEX IF NOT EXISTS idx_grant_status_history_changed_by
  ON public.grant_status_history (changed_by);

CREATE INDEX IF NOT EXISTS idx_compliance_requirements_assignee
  ON public.compliance_requirements (assignee_user_id)
  WHERE assignee_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_project
  ON public.application_knowledge_base (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_onboarding_first_project
  ON public.onboarding_progress (first_project_id)
  WHERE first_project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_org_members_invited_by
  ON public.org_members (invited_by)
  WHERE invited_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invitations_invited_by
  ON public.invitations (invited_by);

CREATE INDEX IF NOT EXISTS idx_project_access_granted_by
  ON public.project_access (granted_by)
  WHERE granted_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shareable_links_created_by
  ON public.shareable_links (created_by);

CREATE INDEX IF NOT EXISTS idx_access_log_user
  ON public.access_log (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_feeds_project
  ON public.calendar_feeds (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_search_signal_events_user
  ON public.search_signal_events (user_id)
  WHERE user_id IS NOT NULL;
