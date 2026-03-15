// Phase 3A: Tracked Grants CRUD Edge Function
// Handles: list, create, read, update, delete tracked grants
// Also handles CSV import and export

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
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
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    // Expected paths: /tracked-grants, /tracked-grants/:id, /tracked-grants/import, /tracked-grants/export

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Ensure user has pipeline statuses
    await supabase.rpc('seed_pipeline_statuses', { p_user_id: user.id });

    if (req.method === 'GET') {
      // Check for export
      const isExport = url.searchParams.get('export') === 'true';

      const projectId = url.searchParams.get('project_id');
      const grantId = url.searchParams.get('grant_id');

      if (grantId) {
        // GET single grant with tasks
        const { data: grant, error } = await supabase
          .from('tracked_grants')
          .select('*, pipeline_statuses(name, slug, color, is_terminal)')
          .eq('id', grantId)
          .eq('user_id', user.id)
          .single();

        if (error || !grant) return errorResponse('Grant not found', 404);

        // Get tasks for this grant
        const { data: tasks } = await supabase
          .from('tasks')
          .select('*')
          .eq('tracked_grant_id', grantId)
          .order('due_date', { ascending: true, nullsFirst: false });

        // Get status history
        const { data: history } = await supabase
          .from('grant_status_history')
          .select('*, from_status:pipeline_statuses!grant_status_history_from_status_id_fkey(name, color), to_status:pipeline_statuses!grant_status_history_to_status_id_fkey(name, color)')
          .eq('tracked_grant_id', grantId)
          .order('changed_at', { ascending: false });

        return jsonResponse({ ...grant, tasks: tasks || [], history: history || [] });
      }

      // LIST grants
      let query = supabase
        .from('tracked_grants')
        .select('*, pipeline_statuses(name, slug, color, is_terminal)')
        .eq('user_id', user.id);

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      // Filtering
      const statuses = url.searchParams.get('statuses');
      if (statuses) {
        const statusSlugs = statuses.split(',');
        const { data: statusIds } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', user.id)
          .in('slug', statusSlugs);
        if (statusIds && statusIds.length > 0) {
          query = query.in('status_id', statusIds.map(s => s.id));
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

      // Sorting
      const sortBy = url.searchParams.get('sort_by') || 'added_at';
      const sortOrder = url.searchParams.get('sort_order') === 'asc';
      query = query.order(sortBy, { ascending: sortOrder });

      // Pagination
      const page = parseInt(url.searchParams.get('page') || '1');
      const perPage = parseInt(url.searchParams.get('per_page') || '50');
      const from = (page - 1) * perPage;
      query = query.range(from, from + perPage - 1);

      const { data: grants, error, count } = await query;
      if (error) return errorResponse(error.message, 500);

      if (isExport) {
        // CSV export
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
            ...CORS_HEADERS,
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="tracked_grants.csv"',
          },
        });
      }

      return jsonResponse({ grants: grants || [], total: count, page, per_page: perPage });
    }

    if (req.method === 'POST') {
      const body = await req.json();

      // CSV import
      if (body.import && Array.isArray(body.rows)) {
        const projectId = body.project_id;
        if (!projectId) return errorResponse('project_id required for import');

        // Get user's statuses for mapping
        const { data: userStatuses } = await supabase
          .from('pipeline_statuses')
          .select('id, name, slug')
          .eq('user_id', user.id)
          .order('sort_order');

        const defaultStatusId = userStatuses?.find(s => s.slug === 'researching')?.id;
        if (!defaultStatusId) return errorResponse('Pipeline statuses not configured', 500);

        const imported: any[] = [];
        const errors: any[] = [];

        for (let i = 0; i < body.rows.length; i++) {
          const row = body.rows[i];
          try {
            // Map status name to status_id (case-insensitive)
            let statusId = defaultStatusId;
            if (row.status) {
              const match = userStatuses?.find(s =>
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

        return jsonResponse({ imported: imported.length, errors, total: body.rows.length });
      }

      // Regular create
      const { project_id, funder_ein, funder_name, grant_title, status_slug, amount, deadline, grant_url, notes, source, is_external } = body;

      if (!project_id || !funder_name) {
        return errorResponse('project_id and funder_name are required');
      }

      // Resolve status_slug to status_id
      let statusId: string;
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
        statusId = status?.id;
        if (!statusId) return errorResponse(`Status '${slug}' not found`, 400);
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

      if (error) return errorResponse(error.message, 500);
      return jsonResponse(grant, 201);
    }

    if (req.method === 'PUT') {
      const body = await req.json();
      const grantId = body.id || url.searchParams.get('grant_id');
      if (!grantId) return errorResponse('Grant ID required');

      const updates: any = {};
      if (body.funder_name !== undefined) updates.funder_name = body.funder_name;
      if (body.grant_title !== undefined) updates.grant_title = body.grant_title;
      if (body.amount !== undefined) updates.amount = body.amount ? parseFloat(body.amount) : null;
      if (body.deadline !== undefined) updates.deadline = body.deadline || null;
      if (body.grant_url !== undefined) updates.grant_url = body.grant_url || null;
      if (body.notes !== undefined) updates.notes = body.notes;
      if (body.awarded_amount !== undefined) updates.awarded_amount = body.awarded_amount ? parseFloat(body.awarded_amount) : null;
      if (body.awarded_date !== undefined) updates.awarded_date = body.awarded_date || null;

      // Handle status change via slug or id
      if (body.status_id) {
        updates.status_id = body.status_id;
      } else if (body.status_slug) {
        const { data: status } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', user.id)
          .eq('slug', body.status_slug)
          .single();
        if (status) updates.status_id = status.id;
      }

      const { data: grant, error } = await supabase
        .from('tracked_grants')
        .update(updates)
        .eq('id', grantId)
        .eq('user_id', user.id)
        .select('*, pipeline_statuses(name, slug, color, is_terminal)')
        .single();

      if (error) return errorResponse(error.message, 500);
      if (!grant) return errorResponse('Grant not found', 404);
      return jsonResponse(grant);
    }

    if (req.method === 'DELETE') {
      const grantId = url.searchParams.get('grant_id');
      if (!grantId) return errorResponse('Grant ID required');

      const { error } = await supabase
        .from('tracked_grants')
        .delete()
        .eq('id', grantId)
        .eq('user_id', user.id);

      if (error) return errorResponse(error.message, 500);
      return jsonResponse({ success: true });
    }

    return errorResponse('Method not allowed', 405);
  } catch (err: any) {
    console.error('tracked-grants error:', err);
    return errorResponse(err.message || 'Internal server error', 500);
  }
});
