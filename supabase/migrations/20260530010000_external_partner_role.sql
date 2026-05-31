-- =====================================================================
-- FM-IC-COL-002: External partners with scoped access
--
-- Adds a dedicated 'partner' role to org_members and invitations so that
-- external collaborators (fiscal sponsors, consultants, evaluation
-- partners) can be invited as named, auditable users without granting
-- them internal-team capabilities.
--
-- Scope of the 'partner' role:
--   * Visible alongside team members in TeamSettings, but distinguished
--     in the UI as 'external'.
--   * On project_access, partners are limited to 'view' or 'edit'
--     (never 'admin').
--   * Cannot invite other members or change other users' roles.
--
-- The audit gap noted that share-links already provide read-only access
-- but named external roles were not separate from internal team. This
-- migration introduces that distinction at the data layer; the team-
-- invite function and TeamSettings UI surface it.
-- =====================================================================

-- org_members: extend role allowlist with 'partner'
ALTER TABLE public.org_members
  DROP CONSTRAINT IF EXISTS org_members_role_check;

ALTER TABLE public.org_members
  ADD CONSTRAINT org_members_role_check
  CHECK (role IN ('admin', 'editor', 'viewer', 'partner'));

-- invitations: same
ALTER TABLE public.invitations
  DROP CONSTRAINT IF EXISTS invitations_role_check;

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('admin', 'editor', 'viewer', 'partner'));

COMMENT ON CONSTRAINT org_members_role_check ON public.org_members IS
  'FM-IC-COL-002: external partners as named, scoped role (no admin escalation).';

-- Optional partner-scoped fields: organization name and partner type
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS partner_org_name text;
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS partner_type text;

COMMENT ON COLUMN public.org_members.partner_org_name IS
  'Name of the external partner organization (e.g. "Acme Eval Partners"). Used only when role = ''partner''.';
COMMENT ON COLUMN public.org_members.partner_type IS
  'Free-text partner classification (e.g. "fiscal_sponsor", "consultant", "evaluator").';

-- ---------------------------------------------------------------------
-- Enforce that partners cannot hold project-level 'admin' permission.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_partner_permission_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role
    FROM public.org_members
    WHERE user_id = NEW.user_id
    LIMIT 1;

  IF v_role = 'partner' AND NEW.permission = 'admin' THEN
    RAISE EXCEPTION 'External partners cannot hold project admin permission (FM-IC-COL-002).'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_partner_permission_scope() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_partner_permission_scope_trg ON public.project_access;
CREATE TRIGGER enforce_partner_permission_scope_trg
  BEFORE INSERT OR UPDATE OF permission, user_id
  ON public.project_access
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_partner_permission_scope();

COMMENT ON FUNCTION public.enforce_partner_permission_scope() IS
  'FM-IC-COL-002: ensures external partners can only hold view/edit project access, never admin.';
