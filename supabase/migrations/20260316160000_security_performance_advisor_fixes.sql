-- =============================================================================
-- Supabase Security & Performance Advisor Fixes (idempotent, re-runnable)
-- Run each numbered section separately in the Supabase SQL Editor if needed.
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
-- SECTION 2: Enable RLS on all public tables
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.funders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foundation_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foundation_grants ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 3: Public read policies for browse data tables
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


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 4: Enable RLS on conditional tables (may or may not exist)
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'foundation_history_features') THEN
    EXECUTE 'ALTER TABLE public.foundation_history_features ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'foundation_history_features' AND policyname = 'public_read_history_features') THEN
      CREATE POLICY public_read_history_features ON public.foundation_history_features FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'search_cache') THEN
    EXECUTE 'ALTER TABLE public.search_cache ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'search_cache' AND policyname = 'public_read_search_cache') THEN
      CREATE POLICY public_read_search_cache ON public.search_cache FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'recipient_organizations') THEN
    EXECUTE 'ALTER TABLE public.recipient_organizations ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'recipient_organizations' AND policyname = 'public_read_recipients') THEN
      CREATE POLICY public_read_recipients ON public.recipient_organizations FOR SELECT USING (true);
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 5: Drop overly permissive calendar_feeds policy
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Public can read by token" ON calendar_feeds;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 6: Add missing RLS policies for incomplete tables
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
-- SECTION 7: Performance — missing FK indexes
-- ═══════════════════════════════════════════════════════════════════════════════

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
