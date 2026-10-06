-- Supabase security advisor lint 0029 (authenticated_security_definer_function_executable)
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDING
-- -------
-- `public.org_admin_id(_uid uuid)` is SECURITY DEFINER and holds EXECUTE for the
-- `authenticated` role. Because it lives in `public` — a PostgREST-exposed schema —
-- every signed-in user can call it directly as an RPC:
--
--     POST /rest/v1/rpc/org_admin_id  {"_uid": "<any uuid>"}
--
-- The function walks the org_members invited_by chain with the definer's rights,
-- so it answers "which org does this arbitrary user id belong to?" while bypassing
-- RLS on org_members. That is an org-membership oracle: it leaks org topology for
-- user ids outside the caller's own org, and confirms whether a guessed uuid is a
-- real user at all. The function was never meant to be a public API — it exists
-- only to be called from inside RLS policy expressions.
--
-- WHY NOT THE OTHER TWO REMEDIATIONS
-- ----------------------------------
--   * REVOKE EXECUTE ... FROM authenticated — breaks the app. Postgres evaluates
--     RLS policy expressions with the privileges of the *querying* role, not the
--     table owner. Without EXECUTE, every SELECT on org_members / invitations /
--     projects / tracked_grants / user_profiles fails with
--     "permission denied for function org_admin_id".
--   * SECURITY INVOKER — also breaks. The function reads org_members; under
--     invoker rights that read is itself filtered by org_members' RLS, whose
--     policy calls org_admin_id. Infinite recursion, and a truncated chain walk.
--
-- FIX
-- ---
-- Move the function to a `private` schema that PostgREST does not expose
-- (exposed schemas are `public` + `graphql_public`), keeping EXECUTE for
-- `authenticated` so RLS still works. The RPC endpoint disappears; the policies
-- are unaffected. Grants are reproduced exactly as they were on the public
-- function (`authenticated`, `service_role`) so no role gains or loses access —
-- `anon` could not execute it before and still cannot.
--
-- search_path is tightened from `public` to `''` while we are here. The body only
-- touches `public.org_members`, which is already schema-qualified.
--
-- ORDERING / SAFETY
-- -----------------
-- Deliberately no BEGIN/COMMIT and deliberately ALTER POLICY rather than
-- DROP + CREATE POLICY: every step is safe to stop at.
--   1. The private function is additive.
--   2. ALTER POLICY swaps each expression atomically — there is never a moment
--      where a table sits unprotected by a dropped-and-not-yet-recreated policy.
--   3. The final DROP is self-guarding: Postgres refuses to drop a function a
--      policy still depends on, so a missed reference fails loudly instead of
--      silently breaking reads.
-- ALTER POLICY leaves the TO clause untouched, preserving the live role targeting
-- (`org_members_update`/`_delete` are TO authenticated; the SELECT policies are
-- TO public).
--
-- NOTE: the policy bodies below are transcribed from the live database, not from
-- 20260511180000 / 20260610120000. Those two migrations created separate
-- `*_org_scope_select` policies which were later consolidated (dashboard-applied,
-- untracked in this repo) into the single OR'd `*_select` policies restated here.
--
-- CWE-200 (Exposure of Sensitive Information). OWASP A01:2021 Broken Access Control.
-- Verification:
--   SELECT n.nspname, p.proacl FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE p.proname = 'org_admin_id';
--   -- Expect exactly one row, schema `private`.
--   -- POST /rest/v1/rpc/org_admin_id should return 404.

-- ─── 1. private schema ──────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- ─── 2. relocated function (body unchanged) ─────────────────────────────────

CREATE OR REPLACE FUNCTION private.org_admin_id(_uid uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
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

REVOKE ALL ON FUNCTION private.org_admin_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.org_admin_id(uuid) TO authenticated, service_role;

-- ─── 3. repoint the seven dependent policies ────────────────────────────────

ALTER POLICY invitations_select ON public.invitations
  USING (
    invited_by = (select auth.uid())
    OR private.org_admin_id(invited_by) =
       (SELECT private.org_admin_id((select auth.uid())))
  );

ALTER POLICY org_members_select ON public.org_members
  USING (
    user_id = (select auth.uid())
    OR invited_by = (select auth.uid())
    OR private.org_admin_id(user_id) =
       (SELECT private.org_admin_id((select auth.uid())))
  );

ALTER POLICY org_members_update ON public.org_members
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om_admin
      WHERE om_admin.user_id = (select auth.uid())
        AND om_admin.role = 'admin'
        AND om_admin.status = 'active'
    )
    AND private.org_admin_id(user_id) =
        (SELECT private.org_admin_id((select auth.uid())))
  )
  WITH CHECK (
    private.org_admin_id(user_id) =
        (SELECT private.org_admin_id((select auth.uid())))
  );

ALTER POLICY org_members_delete ON public.org_members
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om_admin
      WHERE om_admin.user_id = (select auth.uid())
        AND om_admin.role = 'admin'
        AND om_admin.status = 'active'
    )
    AND private.org_admin_id(user_id) =
        (SELECT private.org_admin_id((select auth.uid())))
    AND user_id <> (select auth.uid())
  );

ALTER POLICY projects_select ON public.projects
  USING (
    (select auth.uid()) = user_id
    OR private.org_admin_id(user_id) =
       (SELECT private.org_admin_id((select auth.uid())))
  );

ALTER POLICY tracked_grants_select ON public.tracked_grants
  USING (
    (select auth.uid()) = user_id
    OR private.org_admin_id(user_id) =
       (SELECT private.org_admin_id((select auth.uid())))
  );

ALTER POLICY user_profiles_select ON public.user_profiles
  USING (
    (select auth.uid()) = id
    OR private.org_admin_id(id) =
       (SELECT private.org_admin_id((select auth.uid())))
  );

-- ─── 4. remove the exposed RPC ──────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.org_admin_id(uuid);
