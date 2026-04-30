// Phase 3A: Pipeline Statuses CRUD Edge Function

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_HEADERS_OPTS = { methods: "GET, POST, PUT, DELETE, OPTIONS" } as const;
function CORS_HEADERS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_HEADERS_OPTS);
}

function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS(req), 'Content-Type': 'application/json' },
  });
}

function errorResponse(req: Request, message: string, status = 400) {
  return jsonResponse(req, { error: message }, status);
}

async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS(req) });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return errorResponse(req, 'Unauthorized', 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Ensure user has default statuses
    await supabase.rpc('seed_pipeline_statuses', { p_user_id: user.id });

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('pipeline_statuses')
        .select('*')
        .eq('user_id', user.id)
        .order('sort_order', { ascending: true });

      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, data || []);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { name, color } = body;
      if (!name) return errorResponse(req, 'Name is required');

      // Get max sort_order
      const { data: existing } = await supabase
        .from('pipeline_statuses')
        .select('sort_order')
        .eq('user_id', user.id)
        .order('sort_order', { ascending: false })
        .limit(1);

      const nextOrder = (existing?.[0]?.sort_order ?? -1) + 1;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

      const { data, error } = await supabase.from('pipeline_statuses').insert({
        user_id: user.id,
        name,
        slug,
        color: color || '#95A5A6',
        sort_order: nextOrder,
        is_default: false,
        is_terminal: body.is_terminal || false,
      }).select().single();

      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, data, 201);
    }

    if (req.method === 'PUT') {
      const body = await req.json();
      const statusId = body.id;
      if (!statusId) return errorResponse(req, 'Status ID required');

      const updates: any = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.color !== undefined) updates.color = body.color;
      if (body.is_terminal !== undefined) updates.is_terminal = body.is_terminal;

      // Handle reordering
      if (body.sort_order !== undefined) {
        updates.sort_order = body.sort_order;
      }

      // Handle batch reorder
      if (body.reorder && Array.isArray(body.reorder)) {
        for (const item of body.reorder) {
          await supabase
            .from('pipeline_statuses')
            .update({ sort_order: item.sort_order })
            .eq('id', item.id)
            .eq('user_id', user.id);
        }
        // Return updated list
        const { data } = await supabase
          .from('pipeline_statuses')
          .select('*')
          .eq('user_id', user.id)
          .order('sort_order');
        return jsonResponse(req, data || []);
      }

      const { data, error } = await supabase
        .from('pipeline_statuses')
        .update(updates)
        .eq('id', statusId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, data);
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const statusId = url.searchParams.get('id');
      if (!statusId) return errorResponse(req, 'Status ID required');

      // Check if it's a default status
      const { data: status } = await supabase
        .from('pipeline_statuses')
        .select('is_default, slug')
        .eq('id', statusId)
        .eq('user_id', user.id)
        .single();

      if (!status) return errorResponse(req, 'Status not found', 404);
      if (status.is_default) return errorResponse(req, 'Cannot delete default statuses');

      // Get the body for reassignment target
      let reassignTo: string | null = null;
      try {
        const body = await req.json();
        reassignTo = body.reassign_to;
      } catch { /* no body */ }

      // Reassign grants using this status to 'researching' or specified target
      if (!reassignTo) {
        const { data: defaultStatus } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', user.id)
          .eq('slug', 'researching')
          .single();
        reassignTo = defaultStatus?.id;
      }

      if (reassignTo) {
        await supabase
          .from('tracked_grants')
          .update({ status_id: reassignTo })
          .eq('status_id', statusId)
          .eq('user_id', user.id);
      }

      const { error } = await supabase
        .from('pipeline_statuses')
        .delete()
        .eq('id', statusId)
        .eq('user_id', user.id);

      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, { success: true });
    }

    return errorResponse(req, 'Method not allowed', 405);
  } catch (err: any) {
    console.error('pipeline-statuses error:', err);
    return errorResponse(req, err.message || 'Internal server error', 500);
  }
});
