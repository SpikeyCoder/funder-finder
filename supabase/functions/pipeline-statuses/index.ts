// Phase 3A: Pipeline Statuses CRUD Edge Function
// Auth: see _shared/auth.ts -- decodes JWT payload locally and queries via
// service-role client filtered by user_id.

import { authFromRequest, adminClient, statusForAuthError } from "../_shared/auth.ts";
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

async function ensureDefaultStatuses(supabase: any, userId: string) {
  const { data: existing } = await supabase
    .from('pipeline_statuses')
    .select('id')
    .eq('user_id', userId)
    .limit(1);
  if (existing && existing.length > 0) return;
  await supabase.from('pipeline_statuses').insert([
    { user_id: userId, name: 'Researching', slug: 'researching', color: '#95A5A6', sort_order: 0, is_default: true, is_terminal: false },
    { user_id: userId, name: 'Planned', slug: 'planned', color: '#3498DB', sort_order: 1, is_default: true, is_terminal: false },
    { user_id: userId, name: 'In Progress', slug: 'in_progress', color: '#2980B9', sort_order: 2, is_default: true, is_terminal: false },
    { user_id: userId, name: 'LOI Submitted', slug: 'loi_submitted', color: '#9B59B6', sort_order: 3, is_default: true, is_terminal: false },
    { user_id: userId, name: 'Submitted', slug: 'submitted', color: '#1ABC9C', sort_order: 4, is_default: true, is_terminal: false },
    { user_id: userId, name: 'Application Submitted', slug: 'application_submitted', color: '#2ECC71', sort_order: 5, is_default: true, is_terminal: false },
    { user_id: userId, name: 'Under Review', slug: 'under_review', color: '#F39C12', sort_order: 6, is_default: true, is_terminal: false },
    { user_id: userId, name: 'Awarded', slug: 'awarded', color: '#27AE60', sort_order: 7, is_default: true, is_terminal: true },
    { user_id: userId, name: 'Rejected', slug: 'rejected', color: '#E74C3C', sort_order: 8, is_default: true, is_terminal: true },
    { user_id: userId, name: 'On Hold', slug: 'on_hold', color: '#BDC3C7', sort_order: 9, is_default: true, is_terminal: false },
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS(req) });
  try {
    const { userId } = authFromRequest(req);
    const supabase = adminClient();
    await ensureDefaultStatuses(supabase, userId);

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('pipeline_statuses')
        .select('*')
        .eq('user_id', userId)
        .order('sort_order', { ascending: true });
      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, data || []);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { name, color } = body;
      if (!name) return errorResponse(req, 'Name is required');
      const { data: existing } = await supabase
        .from('pipeline_statuses')
        .select('sort_order')
        .eq('user_id', userId)
        .order('sort_order', { ascending: false })
        .limit(1);
      const nextOrder = ((existing as any[] | null)?.[0]?.sort_order ?? -1) + 1;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const { data, error } = await supabase
        .from('pipeline_statuses')
        .insert({
          user_id: userId,
          name,
          slug,
          color: color || '#95A5A6',
          sort_order: nextOrder,
          is_default: false,
          is_terminal: body.is_terminal || false,
        })
        .select()
        .single();
      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, data, 201);
    }

    if (req.method === 'PUT') {
      const body = await req.json();
      if (body.reorder && Array.isArray(body.reorder)) {
        for (const item of body.reorder) {
          await supabase
            .from('pipeline_statuses')
            .update({ sort_order: item.sort_order })
            .eq('id', item.id)
            .eq('user_id', userId);
        }
        const { data } = await supabase
          .from('pipeline_statuses')
          .select('*')
          .eq('user_id', userId)
          .order('sort_order');
        return jsonResponse(req, data || []);
      }
      const statusId = body.id;
      if (!statusId) return errorResponse(req, 'Status ID required');
      const updates: any = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.color !== undefined) updates.color = body.color;
      if (body.is_terminal !== undefined) updates.is_terminal = body.is_terminal;
      if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
      const { data, error } = await supabase
        .from('pipeline_statuses')
        .update(updates)
        .eq('id', statusId)
        .eq('user_id', userId)
        .select()
        .single();
      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, data);
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const statusId = url.searchParams.get('id');
      if (!statusId) return errorResponse(req, 'Status ID required');
      const { data: status } = await supabase
        .from('pipeline_statuses')
        .select('is_default')
        .eq('id', statusId)
        .eq('user_id', userId)
        .single();
      if (!status) return errorResponse(req, 'Status not found', 404);
      if ((status as any).is_default) return errorResponse(req, 'Cannot delete default statuses');
      let reassignTo: string | null = null;
      try {
        const body = await req.json();
        reassignTo = body.reassign_to;
      } catch {
        // no body provided
      }
      if (!reassignTo) {
        const { data: defaultStatus } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', userId)
          .eq('slug', 'researching')
          .single();
        reassignTo = (defaultStatus as any)?.id;
      }
      if (reassignTo) {
        await supabase
          .from('tracked_grants')
          .update({ status_id: reassignTo })
          .eq('status_id', statusId)
          .eq('user_id', userId);
      }
      const { error } = await supabase
        .from('pipeline_statuses')
        .delete()
        .eq('id', statusId)
        .eq('user_id', userId);
      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, { success: true });
    }

    return errorResponse(req, 'Method not allowed', 405);
  } catch (err: any) {
    console.error('pipeline-statuses error:', err);
    const msg = err?.message || 'Internal server error';
    return errorResponse(req, msg, statusForAuthError(msg));
  }
});
