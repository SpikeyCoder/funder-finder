// Phase 4A: Team invitation & member management.
//
// MIGRATED TO USER-SCOPED AUTH (Pen-test 2026-05-11 / FM-2026-05-11-01):
// The previous implementation verified the caller's JWT with a
// service-role client and then performed all subsequent DB queries with
// that service-role client, bypassing RLS. That defeated the purpose of
// the FM-2026-05-10-01 audience-pinning hardening already applied to
// 14 other Edge Functions.
//
// This rewrite:
//   1. Verifies the caller's JWT via `createUserScopedClient`, which:
//      - HTTP-verifies via `supabase.auth.getUser(token)` (with retry
//        backoff on transient gateway 5xx),
//      - pins `aud === "authenticated"`,
//      - rejects `is_anonymous === true`.
//   2. Uses the user-scoped client for ALL reads/writes against app
//      tables (org_members, projects, invitations, user_profiles,
//      tracked_grants) — letting RLS enforce row-level isolation.
//   3. Keeps a separate, locally-scoped service-role client only for
//      the narrow Supabase auth admin lookups that have no user-scope
//      equivalent: `auth.admin.getUserById()` (to resolve a member's
//      email for display) and a *paginated, early-exit* email lookup
//      (replacing the previous full-table `listUsers()` enumeration —
//      see FM-2026-05-11-01b).
//
// TODO (future PR): replace the paginated `listUsers` walk with a
// SECURITY DEFINER Postgres function `find_user_by_email(text)`
// returning `(id uuid, exists bool)` so the lookup is O(1) and never
// returns more than one record. Tracked in compliance/risk-register.md.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { createUserScopedClient } from "../_shared/user-client.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS_OPTS = { methods: "GET, POST, PUT, DELETE, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS(req), 'Content-Type': 'application/json' },
  });
}

// Lazily create a service-role client only when an admin auth lookup is
// required. Kept module-local so it is never accidentally used as the
// data-plane client.
let _adminClient: ReturnType<typeof createClient> | null = null;
function adminClient() {
  if (!_adminClient) {
    if (!SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
    }
    _adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _adminClient;
}

/**
 * Resolve a user's email by id via the auth admin API. Used only for
 * displaying member emails on the team list; never used for auth.
 * Returns the empty string if the user cannot be resolved.
 */
async function lookupEmailById(userId: string): Promise<string> {
  try {
    const { data } = await adminClient().auth.admin.getUserById(userId);
    return data?.user?.email || '';
  } catch {
    return '';
  }
}

/**
 * Find an auth user by email using a paginated `listUsers` walk with
 * **early exit on first match**. Bounds the per-request data returned
 * to one page (perPage=200) at a time and aborts as soon as the target
 * is found, instead of materialising the full user table in memory the
 * way the previous implementation did.
 *
 * Returns `null` if no user with that email exists across all pages
 * checked, up to MAX_PAGES (~10k users at perPage=200 — well above
 * current org size; revisit before scaling).
 *
 * Pen-test 2026-05-11 FM-2026-05-11-01b. This is a defensive interim
 * fix; a SECURITY DEFINER Postgres function for O(1) lookup is the
 * intended successor (see TODO above).
 */
async function findAuthUserByEmail(email: string): Promise<{ id: string; email: string } | null> {
  const target = email.toLowerCase().trim();
  if (!target) return null;
  const PER_PAGE = 200;
  const MAX_PAGES = 50;
  const admin = adminClient();
  for (let page = 1; page <= MAX_PAGES; page++) {
    // The supabase-js admin client returns at most `perPage` users per
    // call; an empty page indicates the end of the user table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.auth.admin as any).listUsers({ page, perPage: PER_PAGE });
    if (error) throw error;
    const users = data?.users || [];
    if (users.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hit = users.find((u: any) => (u.email || '').toLowerCase() === target);
    if (hit) return { id: hit.id, email: hit.email };
    if (users.length < PER_PAGE) return null;
  }
  return null;
}

// Helper: verify the calling user is an admin (org owner or admin role).
// Runs through the user-scoped client so RLS applies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('status', 'active')
    .eq('role', 'admin')
    .limit(1);
  if (data && data.length > 0) return true;
  const { data: projects } = await supabase
    .from('projects')
    .select('id')
    .eq('user_id', userId)
    .limit(1);
  return !!(projects && projects.length > 0);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });

  let supabase: ReturnType<typeof createClient>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let user: any;
  try {
    const scoped = await createUserScopedClient(req);
    supabase = scoped.supabase;
    user = scoped.user;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unauthorized';
    return json(req, { error: message }, 401);
  }

  try {
    // ─── GET: List team members, invitations, member project summaries ───
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const includeProjects = url.searchParams.get('include_projects') === 'true';

      // RLS now scopes visibility to same-org members/invitations
      // (org_scope SELECT policies, migration 20260511180000).
      // No application-level user filter is needed here — adding one
      // would re-narrow visibility to "rows the caller owns" and
      // re-introduce the cross-admin blind spot the broadening fixed.
      const { data: members } = await supabase
        .from('org_members')
        .select('*')
        .eq('status', 'active');

      const { data: invitations } = await supabase
        .from('invitations')
        .select('*')
        .eq('status', 'pending');

      const memberDetails = [];
      for (const m of members || []) {
        // Email resolution uses the auth admin API (no user-scope
        // equivalent). Everything else uses the user-scoped client so
        // RLS applies.
        const email = await lookupEmailById(m.user_id);

        const { data: profile } = await supabase
          .from('user_profiles')
          .select('display_name, organization_name')
          .eq('id', m.user_id)
          .single();

        let projectSummary = null;
        if (includeProjects) {
          const { data: projects } = await supabase
            .from('projects')
            .select('id, name, created_at, updated_at')
            .eq('user_id', m.user_id)
            .order('updated_at', { ascending: false });

          const projectIds = (projects || []).map((p: { id: string }) => p.id);
          let grantCounts: Record<string, number> = {};
          if (projectIds.length > 0) {
            const { data: grants } = await supabase
              .from('tracked_grants')
              .select('project_id')
              .in('project_id', projectIds);
            for (const g of grants || []) {
              const pid = (g as { project_id: string }).project_id;
              grantCounts[pid] = (grantCounts[pid] || 0) + 1;
            }
          }

          projectSummary = {
            total: (projects || []).length,
            projects: (projects || []).slice(0, 5).map((p: { id: string; name: string; created_at: string; updated_at: string }) => ({
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
          email: email || 'unknown',
          display_name: profile?.display_name || null,
          organization_name: profile?.organization_name || null,
          project_summary: projectSummary,
        });
      }

      return json(req, { members: memberDetails, invitations });
    }

    // ─── POST: Send invitation ───────────────────────────────────────────
    if (req.method === 'POST') {
      const { email, role = 'editor' } = await req.json();
      if (!email) return json(req, { error: 'Email is required' }, 400);
      if (!['admin', 'editor', 'viewer'].includes(role)) {
        return json(req, { error: 'Invalid role. Must be admin, editor, or viewer.' }, 400);
      }

      // Only existing admins may send invites — gates the auth-admin
      // email lookup below behind an authorised caller.
      const callerIsAdmin = await isAdmin(supabase, user.id);
      if (!callerIsAdmin) {
        return json(req, { error: 'Only admins can invite team members' }, 403);
      }

      const normalisedEmail = String(email).toLowerCase().trim();

      const { data: existing } = await supabase
        .from('invitations')
        .select('id')
        .eq('email', normalisedEmail)
        .eq('invited_by', user.id)
        .eq('status', 'pending')
        .limit(1);

      if (existing && existing.length > 0) return json(req, { error: 'Already invited' }, 409);

      // Replaces the previous `auth.admin.listUsers()` full-table walk
      // (FM-2026-05-11-01b) with paginated, early-exit lookup.
      const existingUser = await findAuthUserByEmail(normalisedEmail);

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

      const { data: invite, error } = await supabase
        .from('invitations')
        .insert({ email: normalisedEmail, role, invited_by: user.id })
        .select()
        .single();

      if (error) throw error;

      if (existingUser) {
        await supabase.from('org_members').upsert(
          {
            user_id: existingUser.id,
            role,
            invited_by: user.id,
            status: 'active',
          },
          { onConflict: 'user_id' },
        );

        await supabase
          .from('invitations')
          .update({ status: 'accepted', accepted_at: new Date().toISOString() })
          .eq('id', invite.id);
      }

      return json(req, invite, 201);
    }

    // ─── PUT: Update member role or status ───────────────────────────────
    if (req.method === 'PUT') {
      const { member_id, role, action } = await req.json();
      if (!member_id) return json(req, { error: 'member_id is required' }, 400);

      const callerIsAdmin = await isAdmin(supabase, user.id);
      if (!callerIsAdmin) return json(req, { error: 'Only admins can manage team members' }, 403);

      const { data: target } = await supabase
        .from('org_members')
        .select('*')
        .eq('id', member_id)
        .single();

      if (!target) return json(req, { error: 'Member not found' }, 404);

      if (target.user_id === user.id && role && role !== 'admin') {
        return json(req, { error: 'You cannot change your own role. Ask another admin to do this.' }, 400);
      }

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

    // ─── DELETE: Revoke invitation ───────────────────────────────────────
    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const inviteId = url.searchParams.get('id');
      if (!inviteId) return json(req, { error: 'id required' }, 400);

      await supabase
        .from('invitations')
        .update({ status: 'revoked' })
        .eq('id', inviteId)
        .eq('invited_by', user.id);
      return json(req, { success: true });
    }

    return json(req, { error: 'Method not allowed' }, 405);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return json(req, { error: message }, 500);
  }
});
