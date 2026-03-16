-- =============================================================================
-- Supabase Security & Performance Advisor Fixes (comprehensive, idempotent)
-- Addresses ALL Security Advisor + Performance Advisor warnings.
-- Safe to re-run — uses CREATE OR REPLACE, IF NOT EXISTS, DO blocks.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 1: Fix SECURITY DEFINER functions (add SET search_path = 'public')
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


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 2: Enable RLS on ALL public tables (including those created outside
--            migrations like projects and project_matches)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Core browse tables (public data — need public read policies)
ALTER TABLE public.funders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foundation_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foundation_grants ENABLE ROW LEVEL SECURITY;

-- Tables created outside migrations (via Supabase dashboard)
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

-- Conditional tables (may or may not exist)
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
-- SECTION 3: RLS policies for browse tables (public read access)
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'funders' AND policyname = 'public_read_funders') THEN
    CREATE POLICY public_read_funders ON public.funders FOR SELECT USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'foundation_filings' AND policyname = 'public_read_filings') THEN
    CREATE POLICY public_read_filings ON public.foundation_filings FOR SELECT USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'foundation_grants' AND policyname = 'public_read_grants') THEN
    CREATE POLICY public_read_grants ON public.foundation_grants FOR SELECT USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'foundation_history_features') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'foundation_history_features' AND policyname = 'public_read_history_features') THEN
      CREATE POLICY public_read_history_features ON public.foundation_history_features FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'search_cache') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'search_cache' AND policyname = 'public_read_search_cache') THEN
      CREATE POLICY public_read_search_cache ON public.search_cache FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'recipient_organizations') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'recipient_organizations' AND policyname = 'public_read_recipients') THEN
      CREATE POLICY public_read_recipients ON public.recipient_organizations FOR SELECT USING (true);
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 4: RLS policies for projects (user-scoped)
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'projects') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'projects' AND policyname = 'projects_select_own') THEN
      CREATE POLICY projects_select_own ON public.projects FOR SELECT USING (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'projects' AND policyname = 'projects_insert_own') THEN
      CREATE POLICY projects_insert_own ON public.projects FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'projects' AND policyname = 'projects_update_own') THEN
      CREATE POLICY projects_update_own ON public.projects FOR UPDATE USING (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'projects' AND policyname = 'projects_delete_own') THEN
      CREATE POLICY projects_delete_own ON public.projects FOR DELETE USING (auth.uid() = user_id);
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 5: RLS policies for project_matches (user-scoped via project owner)
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'project_matches') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_matches' AND policyname = 'matches_select_own') THEN
      CREATE POLICY matches_select_own ON public.project_matches FOR SELECT
        USING (auth.uid() = (SELECT p.user_id FROM projects p WHERE p.id = project_id));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_matches' AND policyname = 'matches_insert_own') THEN
      CREATE POLICY matches_insert_own ON public.project_matches FOR INSERT
        WITH CHECK (auth.uid() = (SELECT p.user_id FROM projects p WHERE p.id = project_id));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_matches' AND policyname = 'matches_update_own') THEN
      CREATE POLICY matches_update_own ON public.project_matches FOR UPDATE
        USING (auth.uid() = (SELECT p.user_id FROM projects p WHERE p.id = project_id));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_matches' AND policyname = 'matches_delete_own') THEN
      CREATE POLICY matches_delete_own ON public.project_matches FOR DELETE
        USING (auth.uid() = (SELECT p.user_id FROM projects p WHERE p.id = project_id));
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 6: Drop overly permissive calendar_feeds policy
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Public can read by token" ON calendar_feeds;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 7: Add missing RLS policies for incomplete tables
-- ═══════════════════════════════════════════════════════════════════════════════

-- notification_preferences: missing DELETE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'notification_preferences' AND policyname = 'Users can delete own notification preferences') THEN
    CREATE POLICY "Users can delete own notification preferences"
      ON notification_preferences FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- project_access: missing INSERT (project owner manages access)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_access' AND policyname = 'project_access_insert') THEN
    CREATE POLICY project_access_insert ON public.project_access FOR INSERT
      WITH CHECK (auth.uid() = (SELECT p.user_id FROM projects p WHERE p.id = project_id));
  END IF;
END $$;

-- project_access: missing DELETE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_access' AND policyname = 'project_access_delete') THEN
    CREATE POLICY project_access_delete ON public.project_access FOR DELETE
      USING (auth.uid() = (SELECT p.user_id FROM projects p WHERE p.id = project_id));
  END IF;
END $$;

-- application_knowledge_base: missing UPDATE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'application_knowledge_base' AND policyname = 'kb_update') THEN
    CREATE POLICY kb_update ON public.application_knowledge_base FOR UPDATE USING (user_id = auth.uid());
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 8: Performance — ALL missing FK indexes (comprehensive)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Previously identified indexes
CREATE INDEX IF NOT EXISTS idx_foundation_filings_foundation
  ON public.foundation_filings (foundation_id);

CREATE INDEX IF NOT EXISTS idx_foundation_grants_filing
  ON public.foundation_grants (filing_id);

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

-- Additional missing FK indexes (newly identified)
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
