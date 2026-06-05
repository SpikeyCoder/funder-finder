import { sanitiseError } from '../_shared/errors.ts';
// Phase 4B: Shareable link management
// Auth: local JWT decode via authFromRequest + adminClient (service-role for
// user-filtered queries). Replaces the createUserScopedClient flow that was
// unreliable in the Edge runtime.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { authFromRequest, adminClient, statusForAuthError } from "../_shared/auth.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_OPTS = { allowAny: true, methods: "GET, POST, DELETE, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });

  const url = new URL(req.url);

  // Public access: GET with token param (no auth required)
  const token = url.searchParams.get('token');
  if (req.method === 'GET' && token) {
    // Defense-in-depth per-IP rate limit (60 req/min/IP) on the public,
    // unauthenticated GET-by-token path. Token entropy already makes
    // online brute-force impractical (two concatenated gen_random_uuid()
    // values, ~256 bits); the rate limit short-circuits token-replay
    // floods before they touch the SELECT, and surfaces abuse signals as
    // 429s in the access log. Mirrors the calendar-feed pattern (PR #62,
    // finding FM-2026-05-09-01) -- pen-test 2026-05-10 finding
    // FM-2026-05-10-02 closes the parallel gap on share-link.
    const limited = await ipRateLimit(req, {
      namespace: "share-link-public-get",
      extraHeaders: CORS(req),
    });
    if (!limited.allow && limited.response) return limited.response;
    // Public token shares intentionally bypass user RLS: the token is the
    // credential, and the response is scoped to that single active link.
    const serviceRole = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: link } = await serviceRole
      .from('shareable_links')
      .select('*, projects(id, name, description)')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (!link) return json(req, { error: 'Link not found or expired' }, 404);
    if (link.expires_at && new Date(link.expires_at) < new Date()) return json(req, { error: 'Link expired' }, 410);

    // Increment view count & log access
    await serviceRole.from('shareable_links').update({ view_count: link.view_count + 1 }).eq('id', link.id);
    await serviceRole.from('access_log').insert({ link_id: link.id, user_agent: req.headers.get('user-agent') });

    // Fetch project data based on scope
    let data: any = { project: link.projects, scope: link.scope };

    if (link.scope === 'tracker') {
      const { data: grants } = await serviceRole
        .from('tracked_grants')
        .select('id, funder_name, grant_title, status_id, deadline, awarded_amount, pipeline_statuses(name, color)')
        .eq('project_id', link.project_id);
      data.grants = grants;
    } else if (link.scope === 'portfolio') {
      const { data: grants } = await serviceRole
        .from('tracked_grants')
        .select('id, funder_name, grant_title, status_id, deadline, awarded_amount, pipeline_statuses(name, color, is_terminal)')
        .eq('project_id', link.project_id);
      data.grants = grants;
    }

    return json(req, data);
  }

  // Authenticated endpoints
  let userId: string;
  try {
    const auth = await authFromRequest(req);
    userId = auth.userId;
  } catch {
    return json(req, { error: 'Unauthorized' }, 401);
  }
  const supabase = adminClient();

  try {
    if (req.method === 'GET') {
      const { data: links } = await supabase
        .from('shareable_links')
        .select('*, projects(name)')
        .eq('created_by', userId)
        .order('created_at', { ascending: false });
      return json(req, links || []);
    }

    if (req.method === 'POST') {
      const { project_id, scope = 'tracker', expires_in_days } = await req.json();
      if (!project_id) return json(req, { error: 'project_id required' }, 400);

      const { data: project } = await supabase
        .from('projects')
        .select('id')
        .eq('id', project_id)
        .eq('user_id', userId)
        .single();
      if (!project) return json(req, { error: 'Project not found' }, 404);

      const expires_at = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000).toISOString() : null;

      const { data: link, error } = await supabase
        .from('shareable_links')
        .insert({ project_id, created_by: userId, scope, expires_at })
        .select()
        .single();

      if (error) throw error;
      return json(req, link, 201);
    }

    if (req.method === 'DELETE') {
      const linkId = url.searchParams.get('id');
      if (!linkId) return json(req, { error: 'id required' }, 400);
      await supabase.from('shareable_links').update({ is_active: false }).eq('id', linkId).eq('created_by', userId);
      return json(req, { success: true });
    }

    return json(req, { error: 'Method not allowed' }, 405);
  } catch (err: any) {
    return json(req, { error: sanitiseError(err, 'Internal server error') }, 500);
  }
});
