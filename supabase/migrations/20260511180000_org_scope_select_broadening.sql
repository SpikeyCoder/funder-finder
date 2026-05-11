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

CREATE OR REPLACE FUNCTION public.org_admin_id(_uid uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.org_admin_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_admin_id(uuid) TO authenticated;

-- ─── org_members: broaden SELECT to same-org members ────────────────────────

DROP POLICY IF EXISTS org_members_org_scope_select ON public.org_members;
CREATE POLICY org_members_org_scope_select ON public.org_members
  FOR SELECT
  TO authenticated
  USING (
    public.org_admin_id(user_id) =
      (SELECT public.org_admin_id((SELECT auth.uid())))
  );

-- ─── invitations: same-org admins see pending/historic invitations ──────────

DROP POLICY IF EXISTS invitations_org_scope_select ON public.invitations;
CREATE POLICY invitations_org_scope_select ON public.invitations
  FOR SELECT
  TO authenticated
  USING (
    public.org_admin_id(invited_by) =
      (SELECT public.org_admin_id((SELECT auth.uid())))
  );

-- ─── projects: same-org members visible (read-only) ─────────────────────────

DROP POLICY IF EXISTS projects_org_scope_select ON public.projects;
CREATE POLICY projects_org_scope_select ON public.projects
  FOR SELECT
  TO authenticated
  USING (
    public.org_admin_id(user_id) =
      (SELECT public.org_admin_id((SELECT auth.uid())))
  );

-- ─── tracked_grants: same-org grant summaries visible (read-only) ───────────

DROP POLICY IF EXISTS tracked_grants_org_scope_select ON public.tracked_grants;
CREATE POLICY tracked_grants_org_scope_select ON public.tracked_grants
  FOR SELECT
  TO authenticated
  USING (
    public.org_admin_id(user_id) =
      (SELECT public.org_admin_id((SELECT auth.uid())))
  );

-- ─── user_profiles: same-org profile display ────────────────────────────────
-- user_profiles.id == auth.users.id (PK = owning user).
-- Table is not created in this repo's migrations (was dashboard-applied);
-- guarded so a fresh local stack without the dashboard seed does not error.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
  ) THEN
    EXECUTE 'ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS user_profiles_org_scope_select ON public.user_profiles';
    EXECUTE '
      CREATE POLICY user_profiles_org_scope_select ON public.user_profiles
        FOR SELECT
        TO authenticated
        USING (
          public.org_admin_id(id) =
            (SELECT public.org_admin_id((SELECT auth.uid())))
        )
    ';
  END IF;
END $$;
