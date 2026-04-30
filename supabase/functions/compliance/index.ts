// Phase 5B: Compliance requirement CRUD
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (!user) return json(req, { error: 'Unauthorized' }, 401);

  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const grantId = url.searchParams.get('grant_id');
      const projectId = url.searchParams.get('project_id');

      let query = supabase.from('compliance_requirements').select('*').eq('user_id', user.id);
      if (grantId) query = query.eq('tracked_grant_id', grantId);
      if (projectId) query = query.eq('project_id', projectId);

      const { data, error } = await query.order('due_date', { ascending: true });
      if (error) throw error;

      // Mark overdue items
      const now = new Date();
      const enriched = (data || []).map(r => ({
        ...r,
        is_overdue: r.due_date && new Date(r.due_date) < now && !['submitted', 'approved'].includes(r.status),
      }));

      return json(req, enriched);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { data, error } = await supabase
        .from('compliance_requirements')
        .insert({ ...body, user_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return json(req, data, 201);
    }

    if (req.method === 'PUT') {
      const { id, ...updates } = await req.json();
      if (!id) return json(req, { error: 'id required' }, 400);

      if (updates.status === 'submitted' || updates.status === 'approved') {
        updates.completed_at = new Date().toISOString();
      }
      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('compliance_requirements')
        .update(updates)
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single();
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json(req, { error: 'id required' }, 400);
      await supabase.from('compliance_requirements').delete().eq('id', id).eq('user_id', user.id);
      return json(req, { success: true });
    }

    return json(req, { error: 'Method not allowed' }, 405);
  } catch (err: any) {
    return json(req, { error: err.message }, 500);
  }
});
