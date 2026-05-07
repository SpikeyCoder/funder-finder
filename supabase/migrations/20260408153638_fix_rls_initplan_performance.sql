-- Fix 4: Optimize RLS policies on project_saved_funders to use (select auth.uid())
-- This prevents re-evaluation of auth.uid() for each row

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own project saved funders" ON public.project_saved_funders;
DROP POLICY IF EXISTS "Users can insert into own project saved funders" ON public.project_saved_funders;
DROP POLICY IF EXISTS "Users can update own project saved funders" ON public.project_saved_funders;
DROP POLICY IF EXISTS "Users can delete own project saved funders" ON public.project_saved_funders;

-- Recreate with (select auth.uid()) for performance
CREATE POLICY "Users can view own project saved funders"
  ON public.project_saved_funders FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_saved_funders.project_id
    AND projects.user_id = (select auth.uid())
  ));

CREATE POLICY "Users can insert into own project saved funders"
  ON public.project_saved_funders FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_saved_funders.project_id
    AND projects.user_id = (select auth.uid())
  ));

CREATE POLICY "Users can update own project saved funders"
  ON public.project_saved_funders FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_saved_funders.project_id
    AND projects.user_id = (select auth.uid())
  ));

CREATE POLICY "Users can delete own project saved funders"
  ON public.project_saved_funders FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_saved_funders.project_id
    AND projects.user_id = (select auth.uid())
  ));
