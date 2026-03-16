// Phase 4B: Shareable link management
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);

  // Public access: GET with token param (no auth required)
  const token = url.searchParams.get('token');
  if (req.method === 'GET' && token) {
    const { data: link } = await supabase
      .from('shareable_links')
      .select('*, projects(id, name, description)')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (!link) return json({ error: 'Link not found or expired' }, 404);
    if (link.expires_at && new Date(link.expires_at) < new Date()) return json({ error: 'Link expired' }, 410);

    // Increment view count & log access
    await supabase.from('shareable_links').update({ view_count: link.view_count + 1 }).eq('id', link.id);
    await supabase.from('access_log').insert({ link_id: link.id, user_agent: req.headers.get('user-agent') });

    // Fetch project data based on scope
    let data: any = { project: link.projects, scope: link.scope };

    if (link.scope === 'tracker') {
      const { data: grants } = await supabase
        .from('tracked_grants')
        .select('id, funder_name, grant_title, status_id, deadline, awarded_amount, pipeline_statuses(name, color)')
        .eq('project_id', link.project_id);
      data.grants = grants;
    } else if (link.scope === 'portfolio') {
      const { data: grants } = await supabase
        .from('tracked_grants')
        .select('id, funder_name, grant_title, status_id, deadline, awarded_amount, pipeline_statuses(name, color, is_terminal)')
        .eq('project_id', link.project_id);
      data.grants = grants;
    }

    return json(data);
  }

  // Authenticated endpoints
  const authHeader = req.headers.get('authorization') || '';
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    global: { headers: { authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  try {
    if (req.method === 'GET') {
      const { data: links } = await supabase
        .from('shareable_links')
        .select('*, projects(name)')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false });
      return json(links || []);
    }

    if (req.method === 'POST') {
      const { project_id, scope = 'tracker', expires_in_days } = await req.json();
      if (!project_id) return json({ error: 'project_id required' }, 400);

      const expires_at = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000).toISOString() : null;

      const { data: link, error } = await supabase
        .from('shareable_links')
        .insert({ project_id, created_by: user.id, scope, expires_at })
        .select()
        .single();

      if (error) throw error;
      return json(link, 201);
    }

    if (req.method === 'DELETE') {
      const linkId = url.searchParams.get('id');
      if (!linkId) return json({ error: 'id required' }, 400);
      await supabase.from('shareable_links').update({ is_active: false }).eq('id', linkId).eq('created_by', user.id);
      return json({ success: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
});
