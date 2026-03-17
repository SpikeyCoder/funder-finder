-- Add storage_path and tracked_grant_id columns to application_knowledge_base
-- for linking reference documents to specific grants and Supabase Storage files
ALTER TABLE public.application_knowledge_base
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS tracked_grant_id uuid REFERENCES public.tracked_grants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kb_tracked_grant_id ON public.application_knowledge_base(tracked_grant_id);
CREATE INDEX IF NOT EXISTS idx_kb_project_user ON public.application_knowledge_base(project_id, user_id);
