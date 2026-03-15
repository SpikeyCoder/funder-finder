// Phase 3A: Cross-project portfolio view with aggregate metrics

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

  if (req.method !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const url = new URL(req.url);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Get all user's tracked grants with status info and project name
    const { data: allGrants, error: grantsError } = await supabase
      .from('tracked_grants')
      .select('*, pipeline_statuses(name, slug, color, is_terminal), projects(name)')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });

    if (grantsError) return errorResponse(grantsError.message, 500);
    const grants = allGrants || [];

    // Compute metrics
    const totalTracked = grants.length;
    const terminalGrants = grants.filter((g: any) => g.pipeline_statuses?.is_terminal);
    const awardedGrants = grants.filter((g: any) => g.pipeline_statuses?.slug === 'awarded');
    const rejectedGrants = grants.filter((g: any) => g.pipeline_statuses?.slug === 'rejected');
    const activeGrants = grants.filter((g: any) => !g.pipeline_statuses?.is_terminal);

    const pendingAsk = activeGrants.reduce((sum: number, g: any) => sum + (parseFloat(g.amount) || 0), 0);
    const totalAwarded = awardedGrants.reduce((sum: number, g: any) => sum + (parseFloat(g.awarded_amount) || parseFloat(g.amount) || 0), 0);

    const decided = awardedGrants.length + rejectedGrants.length;
    const winRate = decided > 0 ? Math.round((awardedGrants.length / decided) * 100) : null;

    const now = new Date();
    const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingDeadlines = grants.filter((g: any) => {
      if (!g.deadline || g.pipeline_statuses?.is_terminal) return false;
      const dl = new Date(g.deadline);
      return dl >= now && dl <= thirtyDaysOut;
    }).length;

    // Pipeline breakdown
    const statusCounts: Record<string, { name: string; color: string; count: number }> = {};
    for (const g of grants) {
      const slug = (g as any).pipeline_statuses?.slug || 'unknown';
      if (!statusCounts[slug]) {
        statusCounts[slug] = {
          name: (g as any).pipeline_statuses?.name || slug,
          color: (g as any).pipeline_statuses?.color || '#95A5A6',
          count: 0,
        };
      }
      statusCounts[slug].count++;
    }
    const pipelineBreakdown = Object.values(statusCounts);

    // Apply filters for grant list
    let filteredGrants = grants;

    const projectIds = url.searchParams.get('project_ids');
    if (projectIds) {
      const ids = projectIds.split(',');
      filteredGrants = filteredGrants.filter((g: any) => ids.includes(g.project_id));
    }

    const statuses = url.searchParams.get('statuses');
    if (statuses) {
      const slugs = statuses.split(',');
      filteredGrants = filteredGrants.filter((g: any) => slugs.includes((g as any).pipeline_statuses?.slug));
    }

    const funderSearch = url.searchParams.get('funder');
    if (funderSearch) {
      const search = funderSearch.toLowerCase();
      filteredGrants = filteredGrants.filter((g: any) => g.funder_name?.toLowerCase().includes(search));
    }

    // Sorting
    const sortBy = url.searchParams.get('sort_by') || 'updated_at';
    const sortAsc = url.searchParams.get('sort_order') === 'asc';
    filteredGrants.sort((a: any, b: any) => {
      const aVal = a[sortBy] || '';
      const bVal = b[sortBy] || '';
      const cmp = typeof aVal === 'number' ? aVal - bVal : String(aVal).localeCompare(String(bVal));
      return sortAsc ? cmp : -cmp;
    });

    // Pagination
    const page = parseInt(url.searchParams.get('page') || '1');
    const perPage = parseInt(url.searchParams.get('per_page') || '50');
    const total = filteredGrants.length;
    const paged = filteredGrants.slice((page - 1) * perPage, page * perPage);

    // Format grants for response
    const formattedGrants = paged.map((g: any) => ({
      id: g.id,
      project_id: g.project_id,
      project_name: g.projects?.name || '',
      funder_name: g.funder_name,
      funder_ein: g.funder_ein,
      grant_title: g.grant_title,
      status_name: g.pipeline_statuses?.name || '',
      status_slug: g.pipeline_statuses?.slug || '',
      status_color: g.pipeline_statuses?.color || '#95A5A6',
      amount: g.amount,
      deadline: g.deadline,
      source: g.source,
      added_at: g.added_at,
      updated_at: g.updated_at,
    }));

    // CSV export
    const isExport = url.searchParams.get('export') === 'true';
    if (isExport) {
      const csvHeader = 'Project,Funder Name,Grant Title,Status,Amount,Deadline,Notes,URL,Source,Added,Updated';
      const csvRows = grants.map((g: any) => [
        `"${(g.projects?.name || '').replace(/"/g, '""')}"`,
        `"${(g.funder_name || '').replace(/"/g, '""')}"`,
        `"${(g.grant_title || '').replace(/"/g, '""')}"`,
        `"${(g.pipeline_statuses?.name || '').replace(/"/g, '""')}"`,
        g.amount || '',
        g.deadline || '',
        `"${(g.notes || '').replace(/"/g, '""')}"`,
        `"${(g.grant_url || '').replace(/"/g, '""')}"`,
        g.source || '',
        g.added_at || '',
        g.updated_at || '',
      ].join(','));
      const csv = [csvHeader, ...csvRows].join('\n');
      return new Response(csv, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="portfolio_export.csv"',
        },
      });
    }

    return jsonResponse({
      metrics: {
        total_tracked: totalTracked,
        active_proposals: activeGrants.length,
        pending_ask: pendingAsk,
        win_rate: winRate,
        total_awarded: totalAwarded,
        upcoming_deadlines: upcomingDeadlines,
      },
      pipeline_breakdown: pipelineBreakdown,
      grants: formattedGrants,
      total,
      page,
      per_page: perPage,
    });
  } catch (err: any) {
    console.error('portfolio error:', err);
    return errorResponse(err.message || 'Internal server error', 500);
  }
});
