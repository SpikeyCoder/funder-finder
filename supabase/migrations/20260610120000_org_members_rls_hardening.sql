-- Pen-test finding FM-2026-06-10-01 — High
-- ============================================
-- The org_members INSERT policy installed in 20260316000000_phase4_team_collaboration.sql
-- and re-asserted in 20260316160000_security_performance_advisor_fixes.sql allowed any
-- authenticated user to insert a row with `invited_by = auth.uid()` and arbitrary
-- (user_id, role, status). That meant any signed-in user could write
--   {user_id: <self>, invited_by: <self>, role: 'admin', status: 'active'}
-- and become an admin in the org_members table, which subsequently unlocked the
-- `org_members_update` policy (caller is admin anywhere) to mutate ANY org's
-- member rows — including cross-org demotion / lockout / promotion of an
-- attacker-controlled account.
--
-- This migration:
--   (1) Replaces org_members_insert with a two-branch policy:
--       (a) initial self-row only when no row exists for the user (org creation
--           bootstrap); or
--       (b) caller is an active admin (in any org), in which case the new
--           member inherits the org root via the invited_by chain — so
--           org_admin_id(new_user_id) automatically equals the caller's org
--           root and there is no cross-org leak.
--   (2) Replaces org_members_update with an org-scoped admin check that
--       requires BOTH (caller is active admin) AND (org_admin_id(target) ==
--       org_admin_id(caller)). A WITH CHECK on the same predicate prevents
--       admins from re-rooting members into another org via UPDATE.
--   (3) Adds a DELETE policy with the same org-scoped admin check.
--
-- Behaviour preserved: the legitimate org-creation bootstrap (a user signing
-- up and inserting a self-row) still works as branch (a). Adding members via
-- the team-invite edge function still works as branch (b) because the new
-- row's invited_by chains to the caller's org root.

BEGIN;

DROP POLICY IF EXISTS org_members_insert ON public.org_members;
CREATE POLICY org_members_insert ON public.org_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    invited_by = (select auth.uid())
    AND (
      (
        user_id = (select auth.uid())
        AND NOT EXISTS (
          SELECT 1 FROM public.org_members om_bootstrap
          WHERE om_bootstrap.user_id = (select auth.uid())
        )
      )
      OR
      (
        user_id <> (select auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.org_members om_admin
          WHERE om_admin.user_id = (select auth.uid())
            AND om_admin.role = 'admin'
            AND om_admin.status = 'active'
        )
      )
    )
  );

DROP POLICY IF EXISTS org_members_update ON public.org_members;
CREATE POLICY org_members_update ON public.org_members
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om_admin
      WHERE om_admin.user_id = (select auth.uid())
        AND om_admin.role = 'admin'
        AND om_admin.status = 'active'
    )
    AND public.org_admin_id(user_id) =
        (SELECT public.org_admin_id((SELECT auth.uid())))
  )
  WITH CHECK (
    public.org_admin_id(user_id) =
        (SELECT public.org_admin_id((SELECT auth.uid())))
  );

DROP POLICY IF EXISTS org_members_delete ON public.org_members;
CREATE POLICY org_members_delete ON public.org_members
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om_admin
      WHERE om_admin.user_id = (select auth.uid())
        AND om_admin.role = 'admin'
        AND om_admin.status = 'active'
    )
    AND public.org_admin_id(user_id) =
        (SELECT public.org_admin_id((SELECT auth.uid())))
    AND user_id <> (select auth.uid())
  );

COMMIT;
