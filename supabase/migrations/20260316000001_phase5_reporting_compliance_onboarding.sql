-- Phase 5: Reporting, Compliance, AI Knowledge Base, Onboarding
-- Creates compliance_requirements, application_knowledge_base, bookmarked_passages, onboarding_progress

-- 5B: Compliance requirements for awarded grants
CREATE TABLE IF NOT EXISTS public.compliance_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_grant_id uuid NOT NULL REFERENCES public.tracked_grants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'narrative_report' CHECK (type IN (
    'narrative_report', 'financial_report', 'progress_report',
    'site_visit', 'audit', 'final_report', 'other'
  )),
  title text NOT NULL,
  description text,
  due_date date,
  status text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'in_progress', 'submitted', 'approved', 'overdue')),
  assignee_email text,
  assignee_user_id uuid REFERENCES auth.users(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_grant ON public.compliance_requirements(tracked_grant_id);
CREATE INDEX IF NOT EXISTS idx_compliance_user ON public.compliance_requirements(user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_due ON public.compliance_requirements(due_date) WHERE status NOT IN ('submitted', 'approved');

-- 5C: Application knowledge base for AI writing
CREATE TABLE IF NOT EXISTS public.application_knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  title text NOT NULL,
  source_type text NOT NULL DEFAULT 'upload' CHECK (source_type IN ('upload', 'manual', 'ai_generated')),
  content text NOT NULL,
  sections jsonb DEFAULT '[]'::jsonb,
  file_name text,
  file_type text,
  embedding_status text DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'processing', 'complete', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_user ON public.application_knowledge_base(user_id);

-- 5C: Bookmarked passages from knowledge base
CREATE TABLE IF NOT EXISTS public.bookmarked_passages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kb_entry_id uuid NOT NULL REFERENCES public.application_knowledge_base(id) ON DELETE CASCADE,
  passage_text text NOT NULL,
  section_index integer,
  rating integer CHECK (rating BETWEEN 1 AND 5),
  tags text[] DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON public.bookmarked_passages(user_id);

-- 5D: Onboarding progress tracking
CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  current_step integer NOT NULL DEFAULT 1,
  completed_steps integer[] DEFAULT '{}',
  skipped boolean NOT NULL DEFAULT false,
  profile_complete boolean NOT NULL DEFAULT false,
  first_project_id uuid REFERENCES public.projects(id),
  first_match_saved boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_user ON public.onboarding_progress(user_id);

-- RLS policies
ALTER TABLE public.compliance_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.application_knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookmarked_passages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY compliance_select ON public.compliance_requirements FOR SELECT USING (user_id = auth.uid());
CREATE POLICY compliance_insert ON public.compliance_requirements FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY compliance_update ON public.compliance_requirements FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY compliance_delete ON public.compliance_requirements FOR DELETE USING (user_id = auth.uid());

CREATE POLICY kb_select ON public.application_knowledge_base FOR SELECT USING (user_id = auth.uid());
CREATE POLICY kb_insert ON public.application_knowledge_base FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY kb_update ON public.application_knowledge_base FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY kb_delete ON public.application_knowledge_base FOR DELETE USING (user_id = auth.uid());

CREATE POLICY bookmarks_select ON public.bookmarked_passages FOR SELECT USING (user_id = auth.uid());
CREATE POLICY bookmarks_insert ON public.bookmarked_passages FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY bookmarks_delete ON public.bookmarked_passages FOR DELETE USING (user_id = auth.uid());

CREATE POLICY onboarding_select ON public.onboarding_progress FOR SELECT USING (user_id = auth.uid());
CREATE POLICY onboarding_insert ON public.onboarding_progress FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY onboarding_update ON public.onboarding_progress FOR UPDATE USING (user_id = auth.uid());
