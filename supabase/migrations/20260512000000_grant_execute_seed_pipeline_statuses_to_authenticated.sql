-- Bug fix: Tracker tab returns 0 grants and Track button does nothing.
-- Root cause: tracked-grants edge function calls seed_pipeline_statuses RPC
-- via the user-scoped (authenticated) Supabase client, but EXECUTE on this
-- function was only granted to service_role and postgres. The RPC call
-- raised permission denied, the edge function caught it and returned 500,
-- and the frontend treated 500 as "no grants" / "no-op".
--
-- Fix: grant EXECUTE on seed_pipeline_statuses to authenticated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REVISED 2026-07-28 (FM-2026-07-28-01) — the grant alone is not safe
-- ─────────────────────────────────────────────────────────────────────────────
-- The original rationale above claimed the function "only inserts seed rows for
-- the caller's own user_id". That is not true. The body keys entirely off the
-- `p_user_id` ARGUMENT and never consults auth.uid():
--
--   IF NOT EXISTS (SELECT 1 FROM pipeline_statuses WHERE user_id = p_user_id)
--   THEN INSERT INTO pipeline_statuses (user_id, ...) VALUES (p_user_id, ...)
--
-- Granting EXECUTE to `authenticated` on a SECURITY DEFINER function in the
-- PostgREST-exposed `public` schema therefore hands every signed-in user an
-- endpoint — POST /rest/v1/rpc/seed_pipeline_statuses — that writes ten rows
-- into another user's pipeline_statuses, bypassing that table's RLS. It also
-- doubles as an existence oracle: seeding succeeds only when the target has no
-- rows yet. That is a write-side IDOR, and it re-raises Supabase advisor lint
-- 0029 (authenticated_security_definer_function_executable) — the same finding
-- 20260728120000 closed for public.org_admin_id.
--
-- Moving the function to `private` (the fix used for org_admin_id) is not an
-- option here: unlike org_admin_id, this one is a genuine RPC — the
-- tracked-grants edge function calls it by name over PostgREST, so it has to
-- stay in an exposed schema.
--
-- So the grant is kept and the FUNCTION is hardened instead: a JWT-bearing
-- caller may only seed its own pipeline. The guard keys off auth.role() rather
-- than auth.uid() so the no-JWT paths still work — the signup trigger
-- (handle_new_user_pipeline) and any service_role call run with auth.role()
-- NULL / 'service_role' and are unaffected. The seeding body is unchanged.
--
-- Lint 0029 will still report this function; that is expected and intentional.
-- It is already on the reviewed intentional-access allowlist referenced in the
-- header of 20260614120000. The difference is that it is now actually safe to
-- be on that list.
--
-- search_path is pinned to `public, pg_temp` here, matching what 20260614120000
-- does; that later migration's ALTER becomes a harmless no-op.
--
-- CWE-639 (Authorization Bypass Through User-Controlled Key).
-- OWASP A01:2021 Broken Access Control.
-- Verification:
--   -- as an authenticated caller, seeding someone else's uuid must raise:
--   select public.seed_pipeline_statuses('<other-user-uuid>');
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.seed_pipeline_statuses(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- A caller presenting an `authenticated` JWT may only seed its own pipeline.
  -- Trigger / service_role paths carry no such claim and are not restricted.
  IF auth.role() = 'authenticated' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'seed_pipeline_statuses: callers may only seed their own pipeline'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pipeline_statuses WHERE user_id = p_user_id) THEN
    INSERT INTO pipeline_statuses (user_id, name, slug, color, sort_order, is_default, is_terminal) VALUES
      (p_user_id, 'Researching',          'researching',          '#95A5A6', 0, true, false),
      (p_user_id, 'Planned',               'planned',              '#3498DB', 1, true, false),
      (p_user_id, 'In Progress',           'in_progress',          '#2980B9', 2, true, false),
      (p_user_id, 'LOI Submitted',         'loi_submitted',        '#9B59B6', 3, true, false),
      (p_user_id, 'Submitted',             'submitted',            '#1ABC9C', 4, true, false),
      (p_user_id, 'Application Submitted', 'application_submitted','#2ECC71', 5, true, false),
      (p_user_id, 'Under Review',          'under_review',         '#F39C12', 6, true, false),
      (p_user_id, 'Awarded',               'awarded',              '#27AE60', 7, true, true),
      (p_user_id, 'Rejected',              'rejected',             '#E74C3C', 8, true, true),
      (p_user_id, 'On Hold',                'on_hold',              '#BDC3C7', 9, true, false);
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.seed_pipeline_statuses(uuid) TO authenticated;
