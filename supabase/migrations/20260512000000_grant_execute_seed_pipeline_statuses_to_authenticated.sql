-- Bug fix: Tracker tab returns 0 grants and Track button does nothing.
-- Root cause: tracked-grants edge function calls seed_pipeline_statuses RPC
-- via the user-scoped (authenticated) Supabase client, but EXECUTE on this
-- function was only granted to service_role and postgres. The RPC call
-- raised permission denied, the edge function caught it and returned 500,
-- and the frontend treated 500 as "no grants" / "no-op".
--
-- Fix: grant EXECUTE on seed_pipeline_statuses to authenticated. The
-- function is SECURITY DEFINER with a fixed search_path so it remains safe
-- to expose to authenticated callers; it only inserts seed rows for the
-- caller's own user_id when none exist.

GRANT EXECUTE ON FUNCTION public.seed_pipeline_statuses(uuid) TO authenticated;
