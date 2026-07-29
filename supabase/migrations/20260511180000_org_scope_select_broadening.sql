-- Org-scoped SELECT broadening for PR #67 (FM-2026-05-11-01)
-- ─────────────────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ----------
-- PR #67 migrated the team-invite Edge Function from a service-role
-- bypass-RLS data plane to a user-scoped client. That hardening
-- surfaced a CX/UX gap: existing SELECT policies on org_members,
-- user_profiles, projects, invitations, and tracked_grants are
-- narrowed to "caller's own rows" only. With service-role bypass
-- that did not matter — the function read everything. Under
-- user-scoped RLS, an admin can no longer see members that another
-- admin in the same org invited, nor those members' profile,
-- project, or grant data on the Team page.
--
-- This migration ADDS additional permissive SELECT policies that
-- broaden read access from "row.user-key = caller" to "row's owning
-- user is in the same org as caller". Existing narrow SELECT
-- policies are kept; Postgres OR's permissive policies, so the
-- visible set is the union — never narrower than before.
--
-- Write policies (INSERT/UPDATE/DELETE) are intentionally NOT
-- broadened. Cross-org mutations remain blocked.
--
-- ORG MODEL
-- ---------
-- The schema has no normalised org_id column. Orgs are implicit:
-- an org root is the user at the top of an invited_by chain in
-- org_members. We define:
--
--   org_admin_id(uid) :=
--     walk org_members.invited_by chain starting at uid until no
--     parent row exists; return the terminal user_id. If uid has
--     no org_members row, return uid (singleton org).
--
-- Two users are in the same org iff their org_admin_id values
-- match. The function is SECURITY DEFINER so it can read
-- org_members without recursing through RLS on itself. Depth is
-- capped at 10 to bound pathological cycles; real chains in
-- production are 1–2 deep.
-- ─────────────────────────────────────────────────────────────────────────────
-- REPLAY GUARD (added 2026-07-28, FM-2026-07-28-01)
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration is NOT in the remote migration ledger
-- (supabase_migrations.schema_migrations) even though its objects are live —
-- schema changes on this project are applied ad-hoc via the dashboard / MCP
-- apply_migration, and the repo file is written afterwards as documentation.
-- A `supabase db push` therefore still considers this migration pending and
-- would replay it against the production database.
--
-- Replaying it unguarded is a SECURITY REGRESSION. 20260728120000 moved
-- org_admin_id to the `private` schema to close Supabase advisor lint 0029
-- (authenticated_security_definer_function_executable): as a SECURITY DEFINER
-- function in the PostgREST-exposed `public` schema it was callable by any
-- signed-in user at /rest/v1/rpc/org_admin_id with an arbitrary uuid, acting as
-- an org-membership oracle that bypassed RLS on org_members. The
-- CREATE OR REPLACE below would recreate it in `public` and re-grant EXECUTE to
-- `authenticated`, reopening exactly that hole — silently, since CREATE OR
-- REPLACE succeeds.
--
-- The five *_org_scope_select policies below are also superseded: they were
-- later folded into the consolidated OR'd *_select policies. Recreating them
-- would resurrect redundant permissive policies AND re-establish a dependency
-- on public.org_admin_id, blocking any future attempt to drop it.
--
-- Guard: if private.org_admin_id(uuid) exists, 20260728120000 has already run,
-- so this migration is historical and must be a no-op. to_regprocedure returns
-- NULL rather than raising when the name is unresolvable, so this is safe even
-- when the `private` schema does not exist at all.
--
-- On a database that has NOT seen 20260728120000, behaviour is unchanged.
--
-- Correct long-term fix is to reconcile the ledger (`supabase migration repair`)
-- so already-applied migrations stop being replayed. This guard is the stopgap.
-- ─────────────────────────────────────────────────────────────────────────────

DO $guard$
BEGIN

IF to_regprocedure('private.org_admin_id(uuid)') IS NOT NULL THEN
  RAISE NOTICE '20260511180000: superseded by 20260728120000 (org_admin_id lives in schema private); skipping to avoid reintroducing the public.org_admin_id RPC.';
ELSE

  EXECUTE $stmt$
    CREATE OR REPLACE FUNCTION public.org_admin_id(_uid uuid)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $body$
      WITH RECURSIVE chain AS (
        SELECT _uid AS uid, 0 AS depth
        UNION ALL
        SELECT om.invited_by, chain.depth + 1
        FROM public.org_members om
        JOIN chain ON om.user_id = chain.uid
        WHERE om.status = 'active'
          AND om.invited_by IS NOT NULL
          AND om.invited_by <> chain.uid
          AND chain.depth < 10
      )
      SELECT uid FROM chain ORDER BY depth DESC LIMIT 1
    $body$
  $stmt$;

  EXECUTE $stmt$ REVOKE ALL ON FUNCTION public.org_admin_id(uuid) FROM PUBLIC $stmt$;
  EXECUTE $stmt$ GRANT EXECUTE ON FUNCTION public.org_admin_id(uuid) TO authenticated $stmt$;

  -- ─── org_members: broaden SELECT to same-org members ──────────────────────

  EXECUTE $stmt$ DROP POLICY IF EXISTS org_members_org_scope_select ON public.org_members $stmt$;
  EXECUTE $stmt$
    CREATE POLICY org_members_org_scope_select ON public.org_members
      FOR SELECT
      TO authenticated
      USING (
        public.org_admin_id(user_id) =
          (SELECT public.org_admin_id((SELECT auth.uid())))
      )
  $stmt$;

  -- ─── invitations: same-org admins see pending/historic invitations ────────

  EXECUTE $stmt$ DROP POLICY IF EXISTS invitations_org_scope_select ON public.invitations $stmt$;
  EXECUTE $stmt$
    CREATE POLICY invitations_org_scope_select ON public.invitations
      FOR SELECT
      TO authenticated
      USING (
        public.org_admin_id(invited_by) =
          (SELECT public.org_admin_id((SELECT auth.uid())))
      )
  $stmt$;

  -- ─── projects: same-org members visible (read-only) ───────────────────────

  EXECUTE $stmt$ DROP POLICY IF EXISTS projects_org_scope_select ON public.projects $stmt$;
  EXECUTE $stmt$
    CREATE POLICY projects_org_scope_select ON public.projects
      FOR SELECT
      TO authenticated
      USING (
        public.org_admin_id(user_id) =
          (SELECT public.org_admin_id((SELECT auth.uid())))
      )
  $stmt$;

  -- ─── tracked_grants: same-org grant summaries visible (read-only) ─────────

  EXECUTE $stmt$ DROP POLICY IF EXISTS tracked_grants_org_scope_select ON public.tracked_grants $stmt$;
  EXECUTE $stmt$
    CREATE POLICY tracked_grants_org_scope_select ON public.tracked_grants
      FOR SELECT
      TO authenticated
      USING (
        public.org_admin_id(user_id) =
          (SELECT public.org_admin_id((SELECT auth.uid())))
      )
  $stmt$;

  -- ─── user_profiles: same-org profile display ──────────────────────────────
  -- user_profiles.id == auth.users.id (PK = owning user).
  -- Table is not created in this repo's migrations (was dashboard-applied);
  -- guarded so a fresh local stack without the dashboard seed does not error.

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
  ) THEN
    EXECUTE $stmt$ ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY $stmt$;
    EXECUTE $stmt$ DROP POLICY IF EXISTS user_profiles_org_scope_select ON public.user_profiles $stmt$;
    EXECUTE $stmt$
      CREATE POLICY user_profiles_org_scope_select ON public.user_profiles
        FOR SELECT
        TO authenticated
        USING (
          public.org_admin_id(id) =
            (SELECT public.org_admin_id((SELECT auth.uid())))
        )
    $stmt$;
  END IF;

END IF;

END
$guard$;
