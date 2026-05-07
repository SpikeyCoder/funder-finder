-- Phase 1: RLS Foundation for Service-Role-Key Migration
-- Prepares public reference tables and user-scoped tables for user-authenticated access
-- Makes migrations idempotent with IF NOT EXISTS checks

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Public Reference Tables: READ-only for authenticated users
--    These are IRS 990-PF public filings and reference data
-- ═══════════════════════════════════════════════════════════════════════════════

-- foundation_grants: Raw grant data from IRS 990-PF (public record)
-- Enable RLS if not already enabled
ALTER TABLE IF EXISTS public.foundation_grants ENABLE ROW LEVEL SECURITY;

-- Add public SELECT policy (authenticated users can read)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'foundation_grants'
    AND policyname = 'foundation_grants_public_select'
  ) THEN
    CREATE POLICY foundation_grants_public_select ON public.foundation_grants
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- Restrict write access to service role only
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'foundation_grants'
    AND policyname = 'foundation_grants_service_write'
  ) THEN
    CREATE POLICY foundation_grants_service_write ON public.foundation_grants
      FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- recipient_organizations: Nonprofit organization reference data (public record)
-- Enable RLS if not already enabled
ALTER TABLE IF EXISTS public.recipient_organizations ENABLE ROW LEVEL SECURITY;

-- Add public SELECT policy (authenticated users can read)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'recipient_organizations'
    AND policyname = 'recipient_organizations_public_select'
  ) THEN
    CREATE POLICY recipient_organizations_public_select ON public.recipient_organizations
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- Restrict write access to service role only
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'recipient_organizations'
    AND policyname = 'recipient_organizations_service_write'
  ) THEN
    CREATE POLICY recipient_organizations_service_write ON public.recipient_organizations
      FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- foundation_filings: Filing metadata (public record)
-- Enable RLS if not already enabled
ALTER TABLE IF EXISTS public.foundation_filings ENABLE ROW LEVEL SECURITY;

-- Add public SELECT policy
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'foundation_filings'
    AND policyname = 'foundation_filings_public_select'
  ) THEN
    CREATE POLICY foundation_filings_public_select ON public.foundation_filings
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- Restrict write access to service role only
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'foundation_filings'
    AND policyname = 'foundation_filings_service_write'
  ) THEN
    CREATE POLICY foundation_filings_service_write ON public.foundation_filings
      FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. User-Scoped Tables: User can only access their own data
-- ═══════════════════════════════════════════════════════════════════════════════

-- onboarding_progress: User's onboarding state
-- Enable RLS if not already enabled
ALTER TABLE IF EXISTS public.onboarding_progress ENABLE ROW LEVEL SECURITY;

-- User can SELECT their own onboarding progress
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'onboarding_progress'
    AND policyname = 'onboarding_progress_user_select'
  ) THEN
    CREATE POLICY onboarding_progress_user_select ON public.onboarding_progress
      FOR SELECT
      USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- User can INSERT their own onboarding progress
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'onboarding_progress'
    AND policyname = 'onboarding_progress_user_insert'
  ) THEN
    CREATE POLICY onboarding_progress_user_insert ON public.onboarding_progress
      FOR INSERT
      WITH CHECK (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- User can UPDATE their own onboarding progress
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'onboarding_progress'
    AND policyname = 'onboarding_progress_user_update'
  ) THEN
    CREATE POLICY onboarding_progress_user_update ON public.onboarding_progress
      FOR UPDATE
      USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- User can DELETE their own onboarding progress
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'onboarding_progress'
    AND policyname = 'onboarding_progress_user_delete'
  ) THEN
    CREATE POLICY onboarding_progress_user_delete ON public.onboarding_progress
      FOR DELETE
      USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- application_knowledge_base: User's knowledge base entries
-- Enable RLS if not already enabled
ALTER TABLE IF EXISTS public.application_knowledge_base ENABLE ROW LEVEL SECURITY;

-- User can SELECT their own KB entries
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'application_knowledge_base'
    AND policyname = 'application_knowledge_base_user_select'
  ) THEN
    CREATE POLICY application_knowledge_base_user_select ON public.application_knowledge_base
      FOR SELECT
      USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- User can INSERT their own KB entries
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'application_knowledge_base'
    AND policyname = 'application_knowledge_base_user_insert'
  ) THEN
    CREATE POLICY application_knowledge_base_user_insert ON public.application_knowledge_base
      FOR INSERT
      WITH CHECK (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- User can UPDATE their own KB entries
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'application_knowledge_base'
    AND policyname = 'application_knowledge_base_user_update'
  ) THEN
    CREATE POLICY application_knowledge_base_user_update ON public.application_knowledge_base
      FOR UPDATE
      USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- User can DELETE their own KB entries
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'application_knowledge_base'
    AND policyname = 'application_knowledge_base_user_delete'
  ) THEN
    CREATE POLICY application_knowledge_base_user_delete ON public.application_knowledge_base
      FOR DELETE
      USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

-- grant_status_history: User's grant status changes
-- Enable RLS if not already enabled
ALTER TABLE IF EXISTS public.grant_status_history ENABLE ROW LEVEL SECURITY;

-- User can SELECT their own grant status history
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'grant_status_history'
    AND policyname = 'grant_status_history_user_select'
  ) THEN
    CREATE POLICY grant_status_history_user_select ON public.grant_status_history
      FOR SELECT
      USING (changed_by = (SELECT auth.uid()));
  END IF;
END $$;

-- User can INSERT their own grant status history
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'grant_status_history'
    AND policyname = 'grant_status_history_user_insert'
  ) THEN
    CREATE POLICY grant_status_history_user_insert ON public.grant_status_history
      FOR INSERT
      WITH CHECK (changed_by = (SELECT auth.uid()));
  END IF;
END $$;

-- User can UPDATE their own grant status history (for corrections if needed)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'grant_status_history'
    AND policyname = 'grant_status_history_user_update'
  ) THEN
    CREATE POLICY grant_status_history_user_update ON public.grant_status_history
      FOR UPDATE
      USING (changed_by = (SELECT auth.uid()));
  END IF;
END $$;

-- User can DELETE their own grant status history
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'grant_status_history'
    AND policyname = 'grant_status_history_user_delete'
  ) THEN
    CREATE POLICY grant_status_history_user_delete ON public.grant_status_history
      FOR DELETE
      USING (changed_by = (SELECT auth.uid()));
  END IF;
END $$;
