-- Enable RLS on funders and search_cache tables
-- Previously these tables had no RLS, exposing all data via PostgREST
--
-- ─────────────────────────────────────────────────────────────────────────────
-- OBSOLETE ON THIS PROJECT (annotated 2026-07-28, FM-2026-07-28-01)
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration was never applied (one of 13 repo migrations that never reached
-- production), but its goal was reached by another route: RLS is already enabled
-- on both tables, and both already carry policies.
--
-- Live state on tgtotjvdubhjxzybmdex as of 2026-07-28:
--
--   funders       RLS on, 1 policy
--                   "Allow public read access"  SELECT  TO public  USING (true)
--   search_cache  RLS on, 3 policies
--                   "Users can view own search cache"
--                                               SELECT  TO public  USING (true)
--                   "Authenticated users can insert search cache"  INSERT
--                   "Authenticated users can delete search cache"  DELETE
--
-- Applying this file on top of that state would add four MORE permissive
-- policies that change no effective access:
--   * funders_anon_select               duplicates "Allow public read access"
--   * search_cache_authenticated_select duplicates "Users can view own search
--     cache", which despite its name is already USING (true)
--   * both *_service_write policies are inert — RLS is on with no permissive
--     write policy, so anon/authenticated writes are ALREADY denied, and
--     service_role bypasses RLS entirely
-- Postgres ORs permissive policies, so the only real effect is duplicates, which
-- trip the "multiple permissive policies" performance advisor and make the
-- access model harder to reason about.
--
-- Guard: skip when RLS is already enabled on both tables (goal already met). On
-- a database where these tables still lack RLS the original statements run
-- unchanged. DROP POLICY IF EXISTS added so a re-run is idempotent.
--
-- NOT ADDRESSED HERE — two pre-existing issues this migration does not cause and
-- must not silently change:
--   1. search_cache is readable by `anon` (TO public USING (true)) and stores
--      user-submitted `mission_text`. Tightening that is a product decision, not
--      a side effect of a ledger cleanup.
--   2. search_cache has NO owner column (id, mission_hash, mission_text,
--      results, created_at) — it is a global cache keyed by mission_hash, so
--      "own rows" scoping is not expressible against the current schema. The
--      policy name "Users can view own search cache" is aspirational, not real.
-- ─────────────────────────────────────────────────────────────────────────────

DO $guard$
BEGIN

IF (SELECT bool_and(c.relrowsecurity)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('funders', 'search_cache')) THEN

  RAISE NOTICE '20260430100000: RLS already enabled on funders and search_cache; skipping to avoid adding duplicate permissive policies.';

ELSE

  EXECUTE $stmt$ ALTER TABLE public.funders ENABLE ROW LEVEL SECURITY $stmt$;

  -- Allow anonymous read access (funders are public reference data)
  EXECUTE $stmt$ DROP POLICY IF EXISTS "funders_anon_select" ON public.funders $stmt$;
  EXECUTE $stmt$
    CREATE POLICY "funders_anon_select" ON public.funders
      FOR SELECT USING (true)
  $stmt$;

  -- Only service role can insert/update/delete funders
  EXECUTE $stmt$ DROP POLICY IF EXISTS "funders_service_write" ON public.funders $stmt$;
  EXECUTE $stmt$
    CREATE POLICY "funders_service_write" ON public.funders
      FOR ALL USING (auth.role() = 'service_role')
  $stmt$;

  EXECUTE $stmt$ ALTER TABLE public.search_cache ENABLE ROW LEVEL SECURITY $stmt$;

  -- Allow authenticated users to read cached searches
  EXECUTE $stmt$ DROP POLICY IF EXISTS "search_cache_authenticated_select" ON public.search_cache $stmt$;
  EXECUTE $stmt$
    CREATE POLICY "search_cache_authenticated_select" ON public.search_cache
      FOR SELECT TO authenticated USING (true)
  $stmt$;

  -- Only service role can write to search_cache
  EXECUTE $stmt$ DROP POLICY IF EXISTS "search_cache_service_write" ON public.search_cache $stmt$;
  EXECUTE $stmt$
    CREATE POLICY "search_cache_service_write" ON public.search_cache
      FOR ALL USING (auth.role() = 'service_role')
  $stmt$;

END IF;

END
$guard$;
