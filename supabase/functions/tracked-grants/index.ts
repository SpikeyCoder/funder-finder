// Phase 3A: Tracked Grants CRUD Edge Function
// Handles: list, create, read, update, delete tracked grants
// Also handles CSV import and export

import { createUserScopedClient } from "../_shared/user-client.ts";
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

function errorResponse(req: Request, message: string, status = 400, extra: Record<string, unknown> = {}) {
  return jsonResponse(req, { error: message, ...extra }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS(req) });
  }

  let stage = 'init';
  try {
    stage = 'auth';
    const { supabase, user } = await createUserScopedClient(req);

    const url = new URL(req.url);

    // Ensure user has pipeline statuses. Best-effort: a permission denied
    // here used to kill every tracked-grants request. Pipeline statuses are
    // also seeded for new users via DB trigger and by the pipeline-statuses
    // edge function, so missing this RPC is non-fatal for callers who
    // already have statuses (which is the common case).
    stage = 'seed_pipeline_statuses';
    try {
      await supabase.rpc('seed_pipeline_statuses', { p_user_id: user.id });
    } catch (seedErr) {
      console.error('seed_pipeline_statuses rpc failed (non-fatal):', seedErr);
    }

    if (req.method === 'GET') {
      stage = 'get';
      const isExport = url.searchParams.get('export') === 'true';

      const projectId = url.searchParams.get('project_id');
      const grantId = url.searchParams.get('grant_id');

      if (grantId) {
        stage = 'get_one';
        const { data: grant, error } = await supabase
          .from('tracked_grants')
          .select('*, pipeline_statuses(name, slug, color, is_terminal)')
          .eq('id', grantId)
          .eq('user_id', user.id)
          .single();

        if (error || !grant) return errorResponse(req, 'Grant not found', 404);

        const { data: tasks } = await supabase
          .from('tasks')
          .select('*')
          .eq('tracked_grant_id', grantId)
          .order('due_date', { ascending: true, nullsFirst: false });

        const { data: history } = await supabase
          .from('grant_status_history')
          .select('*, from_status:pipeline_statuses!grant_status_history_from_status_id_fkey(name, color), to_status:pipeline_statuses!grant_status_history_to_status_id_fkey(name, color)')
          .eq('tracked_grant_id', grantId)
          .order('changed_at', { ascending: false });

        return jsonResponse(req, { ...grant, tasks: tasks || [], history: history || [] });
      }

      stage = 'list';
      let query = supabase
        .from('tracked_grants')
        .select('*, pipeline_statuses(name, slug, color, is_terminal)')
        .eq('user_id', user.id);

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const statuses = url.searchParams.get('statuses');
      if (statuses) {
        const statusSlugs = statuses.split(',');
        const { data: statusIds } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', user.id)
          .in('slug', statusSlugs);
        if (statusIds && statusIds.length > 0) {
          query = query.in('status_id', statusIds.map((s: { id: string }) => s.id));
        }
      }

      const funderSearch = url.searchParams.get('funder');
      if (funderSearch) {
        query = query.ilike('funder_name', `%${funderSearch}%`);
      }

      const deadlineFrom = url.searchParams.get('deadline_from');
      const deadlineTo = url.searchParams.get('deadline_to');
      if (deadlineFrom) query = query.gte('deadline', deadlineFrom);
      if (deadlineTo) query = query.lte('deadline', deadlineTo);

      const sortBy = url.searchParams.get('sort_by') || 'added_at';
      const sortOrder = url.searchParams.get('sort_order') === 'asc';
      query = query.order(sortBy, { ascending: sortOrder });

      const page = parseInt(url.searchParams.get('page') || '1');
      const perPage = parseInt(url.searchParams.get('per_page') || '50');
      const from = (page - 1) * perPage;
      query = query.range(from, from + perPage - 1);

      const { data: grants, error, count } = await query;
      if (error) return errorResponse(req, error.message, 500, { stage, details: error });

      if (isExport) {
        const csvHeader = 'Funder Name,Grant Title,Status,Amount,Deadline,Notes,URL,Source,Added,Updated';
        const csvRows = (grants || []).map((g: any) => {
          const status = g.pipeline_statuses?.name || '';
          return [
            `"${(g.funder_name || '').replace(/"/g, '""')}"`,
            `"${(g.grant_title || '').replace(/"/g, '""')}"`,
            `"${status}"`,
            g.amount || '',
            g.deadline || '',
            `"${(g.notes || '').replace(/"/g, '""')}"`,
            `"${(g.grant_url || '').replace(/"/g, '""')}"`,
            g.source || '',
            g.added_at || '',
            g.updated_at || '',
          ].join(',');
        });
        const csv = [csvHeader, ...csvRows].join('\n');
        return new Response(csv, {
          headers: {
            ...CORS_HEADERS(req),
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="tracked_grants.csv"',
          },
        });
      }

      return jsonResponse(req, { grants: grants || [], total: count, page, per_page: perPage });
    }

    if (req.method === 'POST') {
      stage = 'post';
      const body = await req.json();

      if (body.import && Array.isArray(body.rows)) {
        stage = 'post_import';
        const projectId = body.project_id;
        if (!projectId) return errorResponse(req, 'project_id required for import');

        const { data: userStatuses } = await supabase
          .from('pipeline_statuses')
          .select('id, name, slug')
          .eq('user_id', user.id)
          .order('sort_order');

        const defaultStatusId = (userStatuses as any[] | null)?.find((s) => s.slug === 'researching')?.id;
        if (!defaultStatusId) return errorResponse(req, 'Pipeline statuses not configured', 500);

        const imported: any[] = [];
        const errors: any[] = [];

        for (let i = 0; i < body.rows.length; i++) {
          const row = body.rows[i];
          try {
            let statusId = defaultStatusId;
            if (row.status) {
              const match = (userStatuses as any[] | null)?.find((s) =>
                s.name.toLowerCase() === row.status.toLowerCase() ||
                s.slug === row.status.toLowerCase().replace(/\s+/g, '_')
              );
              if (match) statusId = match.id;
            }

            const { data, error } = await supabase.from('tracked_grants').insert({
              project_id: projectId,
              user_id: user.id,
              funder_name: row.funder_name || 'Unknown Funder',
              funder_ein: row.funder_ein || null,
              grant_title: row.grant_title || null,
              amount: row.amount ? parseFloat(row.amount) : null,
              deadline: row.deadline || null,
              notes: row.notes || null,
              grant_url: row.url || null,
              status_id: statusId,
              source: 'csv_import',
              is_external: true,
            }).select().single();

            if (error) throw error;
            imported.push(data);
          } catch (err: any) {
            errors.push({ row: i + 1, error: err.message });
          }
        }

        return jsonResponse(req, { imported: imported.length, errors, total: body.rows.length });
      }

      stage = 'post_create';
      const { project_id, funder_ein, funder_name, grant_title, status_slug, amount, deadline, grant_url, notes, source, is_external } = body;

      if (!project_id || !funder_name) {
        return errorResponse(req, 'project_id and funder_name are required');
      }

      let statusId: string | undefined;
      if (body.status_id) {
        statusId = body.status_id;
      } else {
        const slug = status_slug || 'researching';
        const { data: status } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', user.id)
          .eq('slug', slug)
          .single();
        statusId = (status as { id: string } | null)?.id;
        if (!statusId) return errorResponse(req, `Status '${slug}' not found`, 400);
      }

      const { data: grant, error } = await supabase.from('tracked_grants').insert({
        project_id,
        user_id: user.id,
        funder_ein: funder_ein || null,
        funder_name,
        grant_title: grant_title || null,
        status_id: statusId,
        amount: amount ? parseFloat(amount) : null,
        deadline: deadline || null,
        grant_url: grant_url || null,
        notes: notes || null,
        source: source || (is_external ? 'manual' : 'search'),
        is_external: is_external || false,
      }).select('*, pipeline_statuses(name, slug, color, is_terminal)').single();

      if (error) return errorResponse(req, error.message, 500, { stage, details: error });
      return jsonResponse(req, grant, 201);
    }

    if (req.method === 'PUT') {
      stage = 'put';
      const body = await req.json();
      const grantId = body.id || url.searchParams.get('grant_id');
      if (!grantId) return errorResponse(req, 'Grant ID required');

      const updates: any = {};
      if (body.funder_name !== undefined) updates.funder_name = body.funder_name;
      if (body.grant_title !== undefined) updates.grant_title = body.grant_title;
      if (body.amount !== undefined) updates.amount = body.amount ? parseFloat(body.amount) : null;
      if (body.deadline !== undefined) updates.deadline = body.deadline || null;
      if (body.grant_url !== undefined) updates.grant_url = body.grant_url || null;
      if (body.notes !== undefined) updates.notes = body.notes;
      if (body.awarded_amount !== undefined) updates.awarded_amount = body.awarded_amount ? parseFloat(body.awarded_amount) : null;
      if (body.awarded_date !== undefined) updates.awarded_date = body.awarded_date || null;

      if (body.status_id) {
        updates.status_id = body.status_id;
      } else if (body.status_slug) {
        const { data: status } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', user.id)
          .eq('slug', body.status_slug)
          .single();
        if (status) updates.status_id = (status as { id: string }).id;
      }

      const { data: grant, error } = await supabase
        .from('tracked_grants')
        .update(updates)
        .eq('id', grantId)
        .eq('user_id', user.id)
        .select('*, pipeline_statuses(name, slug, color, is_terminal)')
        .single();

      if (error) return errorResponse(req, error.message, 500, { stage, details: error });
      if (!grant) return errorResponse(req, 'Grant not found', 404);
      return jsonResponse(req, grant);
    }

    if (req.method === 'DELETE') {
      stage = 'delete';
      const grantId = url.searchParams.get('grant_id');
      if (!grantId) return errorResponse(req, 'Grant ID required');

      const { error } = await supabase
        .from('tracked_grants')
        .delete()
        .eq('id', grantId)
        .eq('user_id', user.id);

      if (error) return errorResponse(req, error.message, 500, { stage, details: error });
      return jsonResponse(req, { success: true });
    }

    return errorResponse(req, 'Method not allowed', 405);
  } catch (err: any) {
    console.error('tracked-grants error at stage', stage, ':', err);
    return errorResponse(req, err?.message || 'Internal server error', 500, { stage });
  }
});
