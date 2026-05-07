-- Fix 3: Revoke anon/authenticated access to mv_funder_search_index
-- This materialized view should only be accessed by service_role (edge functions)
REVOKE SELECT ON public.mv_funder_search_index FROM anon;
REVOKE SELECT ON public.mv_funder_search_index FROM authenticated;
