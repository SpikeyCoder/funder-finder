-- Phase 4: Team Collaboration & Role-Based Access
-- Creates org_members, invitations, project_access, shareable_links, access_log tables

-- 4A: Organization members with roles
CREATE TABLE IF NOT EXISTS public.org_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_name text,
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  invited_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON public.org_members(user_id);

-- 4A: Invitations
CREATE TABLE IF NOT EXISTS public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
  invited_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON public.invitations(token);

-- 4A: Per-project access control
CREATE TABLE IF NOT EXISTS public.project_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission text NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'admin')),
  granted_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- 4B: Shareable links for external collaborators
CREATE TABLE IF NOT EXISTS public.shareable_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  scope text NOT NULL DEFAULT 'tracker' CHECK (scope IN ('tracker', 'portfolio', 'report')),
  password_hash text,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shareable_links_token ON public.shareable_links(token);

-- 4B: Access log for shared links
CREATE TABLE IF NOT EXISTS public.access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid REFERENCES public.shareable_links(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  ip_address text,
  user_agent text,
  accessed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_log_link ON public.access_log(link_id);

-- RLS policies
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shareable_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_log ENABLE ROW LEVEL SECURITY;

-- check_permission helper function
CREATE OR REPLACE FUNCTION public.check_permission(p_user_id uuid, p_project_id uuid, p_required text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Project owner always has access
  IF EXISTS (SELECT 1 FROM projects WHERE id = p_project_id AND user_id = p_user_id) THEN
    RETURN true;
  END IF;
  -- Check org_members role
  IF p_required = 'view' THEN
    RETURN EXISTS (
      SELECT 1 FROM project_access WHERE project_id = p_project_id AND user_id = p_user_id
      AND permission IN ('view', 'edit', 'admin')
    );
  ELSIF p_required = 'edit' THEN
    RETURN EXISTS (
      SELECT 1 FROM project_access WHERE project_id = p_project_id AND user_id = p_user_id
      AND permission IN ('edit', 'admin')
    );
  ELSIF p_required = 'admin' THEN
    RETURN EXISTS (
      SELECT 1 FROM project_access WHERE project_id = p_project_id AND user_id = p_user_id
      AND permission = 'admin'
    );
  END IF;
  RETURN false;
END;
$$;

-- RLS: org_members - users see their own org
CREATE POLICY org_members_select ON public.org_members FOR SELECT USING (
  user_id = auth.uid() OR invited_by = auth.uid()
);
CREATE POLICY org_members_insert ON public.org_members FOR INSERT WITH CHECK (invited_by = auth.uid());
CREATE POLICY org_members_update ON public.org_members FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE user_id = auth.uid() AND role = 'admin')
);

-- RLS: invitations
CREATE POLICY invitations_select ON public.invitations FOR SELECT USING (invited_by = auth.uid());
CREATE POLICY invitations_insert ON public.invitations FOR INSERT WITH CHECK (invited_by = auth.uid());
CREATE POLICY invitations_update ON public.invitations FOR UPDATE USING (invited_by = auth.uid());

-- RLS: project_access
CREATE POLICY project_access_select ON public.project_access FOR SELECT USING (
  user_id = auth.uid() OR granted_by = auth.uid()
);

-- RLS: shareable_links
CREATE POLICY shareable_links_select ON public.shareable_links FOR SELECT USING (created_by = auth.uid());
CREATE POLICY shareable_links_insert ON public.shareable_links FOR INSERT WITH CHECK (created_by = auth.uid());
CREATE POLICY shareable_links_update ON public.shareable_links FOR UPDATE USING (created_by = auth.uid());
CREATE POLICY shareable_links_delete ON public.shareable_links FOR DELETE USING (created_by = auth.uid());

-- RLS: access_log - viewable by link creator
CREATE POLICY access_log_select ON public.access_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM shareable_links sl WHERE sl.id = link_id AND sl.created_by = auth.uid())
);
