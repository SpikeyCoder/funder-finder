// Phase 4: Compliance requirement CRUD
// MIGRATED TO USER-SCOPED AUTH: Uses authenticated user context instead of SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { createUserScopedClient } from "../_shared/user-client.ts";

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_OPTS = { methods: "GET, POST, PUT, DELETE, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });

  try {
    // Phase 4: Use user-scoped client with JWT validation
    const { supabase, user } = await createUserScopedClient(req);

    const url = new URL(req.url);

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
    const status = err.message?.includes('Unauthorized') || err.message?.includes('JWT') ? 401 : 500;
    return json(req, { error: err.message || 'Internal server error' }, status);
  }
});
