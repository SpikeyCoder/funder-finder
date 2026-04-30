// Phase 4A: Team invitation & member management
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const ALLOWED_ORIGINS = [
  'https://fundermatch.org',
  'https://spikeycoder.github.io',
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const headers: Record<string, string> = { 'Vary': 'Origin' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  }
  return headers;
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

// Helper: verify the calling user is an admin (org owner or admin role)
async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('status', 'active')
    .eq('role', 'admin')
    .limit(1);
  // Also consider the org creator (invited_by is null or is themselves) as admin
  if (data && data.length > 0) return true;
  // Check if user owns any projects (i.e. is the primary account holder)
  const { data: projects } = await supabase
    .from('projects')
    .select('id')
    .eq('user_id', userId)
    .limit(1);
  return !!(projects && projects.length > 0);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(jwt);
  if (!user) return json(req, { error: 'Unauthorized' }, 401);

  try {
    // ─── GET: List team members, invitations, and member project summaries ───
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const includeProjects = url.searchParams.get('include_projects') === 'true';

      // List team members
      const { data: members } = await supabase
        .from('org_members')
        .select('*')
        .or(`user_id.eq.${user.id},invited_by.eq.${user.id}`)
        .eq('status', 'active');

      const { data: invitations } = await supabase
        .from('invitations')
        .select('*')
        .eq('invited_by', user.id)
        .eq('status', 'pending');

      // Get emails and display names for members
      const memberDetails = [];
      for (const m of members || []) {
        const { data: ud } = await supabase.auth.admin.getUserById(m.user_id);
        const email = ud?.user?.email || 'unknown';

        // Get user profile for display_name
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('display_name, organization_name')
          .eq('id', m.user_id)
          .single();

        let projectSummary = null;
        if (includeProjects) {
          // Get project count and details for this member
          const { data: projects } = await supabase
            .from('projects')
            .select('id, name, created_at, updated_at')
            .eq('user_id', m.user_id)
            .order('updated_at', { ascending: false });

          // Get tracked grant counts per project
          const projectIds = (projects || []).map((p: any) => p.id);
          let grantCounts: Record<string, number> = {};
          if (projectIds.length > 0) {
            const { data: grants } = await supabase
              .from('tracked_grants')
              .select('project_id')
              .in('project_id', projectIds);
            for (const g of grants || []) {
              grantCounts[g.project_id] = (grantCounts[g.project_id] || 0) + 1;
            }
          }

          projectSummary = {
            total: (projects || []).length,
            projects: (projects || []).slice(0, 5).map((p: any) => ({
              id: p.id,
              name: p.name,
              created_at: p.created_at,
              updated_at: p.updated_at,
              grant_count: grantCounts[p.id] || 0,
            })),
          };
        }

        memberDetails.push({
          ...m,
          email,
          display_name: profile?.display_name || null,
          organization_name: profile?.organization_name || null,
          project_summary: projectSummary,
        });
      }

      return json(req, { members: memberDetails, invitations });
    }

    // ─── POST: Send invitation ───────────────────────────────────────────────
    if (req.method === 'POST') {
      const { email, role = 'editor' } = await req.json();
      if (!email) return json(req, { error: 'Email is required' }, 400);
      if (!['admin', 'editor', 'viewer'].includes(role)) {
        return json(req, { error: 'Invalid role. Must be admin, editor, or viewer.' }, 400);
      }

      // Check if already invited
      const { data: existing } = await supabase
        .from('invitations')
        .select('id')
        .eq('email', email.toLowerCase())
        .eq('invited_by', user.id)
        .eq('status', 'pending')
        .limit(1);

      if (existing && existing.length > 0) return json(req, { error: 'Already invited' }, 409);

      // Check if already an active member
      const { data: existingUsers } = await supabase.auth.admin.listUsers();
      const existingUser = existingUsers?.users?.find((u: any) => u.email === email.toLowerCase());

      if (existingUser) {
        const { data: existingMember } = await supabase
          .from('org_members')
          .select('id')
          .eq('user_id', existingUser.id)
          .eq('status', 'active')
          .limit(1);
        if (existingMember && existingMember.length > 0) {
          return json(req, { error: 'This person is already a team member' }, 409);
        }
      }

      // Create invitation
      const { data: invite, error } = await supabase
        .from('invitations')
        .insert({ email: email.toLowerCase(), role, invited_by: user.id })
        .select()
        .single();

      if (error) throw error;

      // If user already exists, auto-add to org_members
      if (existingUser) {
        await supabase.from('org_members').upsert({
          user_id: existingUser.id,
          role,
          invited_by: user.id,
          status: 'active',
        }, { onConflict: 'user_id' });

        await supabase.from('invitations').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', invite.id);
      }

      return json(req, invite, 201);
    }

    // ─── PUT: Update member role or status ───────────────────────────────────
    if (req.method === 'PUT') {
      const { member_id, role, action } = await req.json();
      if (!member_id) return json(req, { error: 'member_id is required' }, 400);

      // Verify caller is admin
      const callerIsAdmin = await isAdmin(supabase, user.id);
      if (!callerIsAdmin) return json(req, { error: 'Only admins can manage team members' }, 403);

      // Get the target member
      const { data: target } = await supabase
        .from('org_members')
        .select('*')
        .eq('id', member_id)
        .single();

      if (!target) return json(req, { error: 'Member not found' }, 404);

      // Prevent self-demotion from admin (must have at least one admin)
      if (target.user_id === user.id && role && role !== 'admin') {
        return json(req, { error: 'You cannot change your own role. Ask another admin to do this.' }, 400);
      }

      // Action: remove member
      if (action === 'remove') {
        if (target.user_id === user.id) {
          return json(req, { error: 'You cannot remove yourself from the team' }, 400);
        }
        await supabase
          .from('org_members')
          .update({ status: 'removed', updated_at: new Date().toISOString() })
          .eq('id', member_id);
        return json(req, { success: true, message: 'Member removed' });
      }

      // Action: change role
      if (role) {
        if (!['admin', 'editor', 'viewer'].includes(role)) {
          return json(req, { error: 'Invalid role' }, 400);
        }
        await supabase
          .from('org_members')
          .update({ role, updated_at: new Date().toISOString() })
          .eq('id', member_id);
        return json(req, { success: true, message: `Role updated to ${role}` });
      }

      return json(req, { error: 'No action specified' }, 400);
    }

    // ─── DELETE: Revoke invitation ───────────────────────────────────────────
    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const inviteId = url.searchParams.get('id');
      if (!inviteId) return json(req, { error: 'id required' }, 400);

      await supabase.from('invitations').update({ status: 'revoked' }).eq('id', inviteId).eq('invited_by', user.id);
      return json(req, { success: true });
    }

    return json(req, { error: 'Method not allowed' }, 405);
  } catch (err: any) {
    return json(req, { error: err.message }, 500);
  }
});
