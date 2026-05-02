// Phase 4: Advanced portfolio reporting with breakdowns and charts data
// MIGRATED TO USER-SCOPED AUTH: Uses authenticated user context instead of SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { createUserScopedClient } from "../_shared/user-client.ts";

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_OPTS = { methods: "GET, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405);

  try {
    // Phase 4: Use user-scoped client with JWT validation
    const { supabase, user } = await createUserScopedClient(req);

    // Get all tracked grants with statuses
    const { data: grants } = await supabase
      .from('tracked_grants')
      .select('*, pipeline_statuses(name, color, is_terminal, sort_order), projects(name)')
      .eq('user_id', user.id);

    if (!grants) return json(req, { kpis: {}, pipeline: [], byProject: [], timeline: [] });

    const totalGrants = grants.length;
    const submitted = grants.filter(g => {
      const name = (g as any).pipeline_statuses?.name?.toLowerCase() || '';
      return ['application submitted', 'under review', 'awarded', 'rejected'].includes(name);
    });
    const awarded = grants.filter(g => (g as any).pipeline_statuses?.name?.toLowerCase() === 'awarded');
    const rejected = grants.filter(g => (g as any).pipeline_statuses?.name?.toLowerCase() === 'rejected');
    const pending = grants.filter(g => {
      const name = (g as any).pipeline_statuses?.name?.toLowerCase() || '';
      return ['application submitted', 'under review', 'loi submitted'].includes(name);
    });

    const totalAwarded = awarded.reduce((sum, g) => sum + (g.awarded_amount || 0), 0);
    const pendingAsk = pending.reduce((sum, g) => sum + (g.awarded_amount || 0), 0);
    const winRate = submitted.length > 0 ? Math.round((awarded.length / (awarded.length + rejected.length)) * 100) : 0;
    const avgGrantSize = awarded.length > 0 ? Math.round(totalAwarded / awarded.length) : 0;

    // Pipeline breakdown
    const pipelineMap: Record<string, { name: string; color: string; count: number; amount: number }> = {};
    for (const g of grants) {
      const status = (g as any).pipeline_statuses;
      const key = status?.name || 'Unknown';
      if (!pipelineMap[key]) pipelineMap[key] = { name: key, color: status?.color || '#6b7280', count: 0, amount: 0 };
      pipelineMap[key].count++;
      pipelineMap[key].amount += g.awarded_amount || 0;
    }

    // By project breakdown
    const projectMap: Record<string, { name: string; count: number; awarded: number; pending: number }> = {};
    for (const g of grants) {
      const pName = (g as any).projects?.name || 'Unknown';
      if (!projectMap[pName]) projectMap[pName] = { name: pName, count: 0, awarded: 0, pending: 0 };
      projectMap[pName].count++;
      const statusName = (g as any).pipeline_statuses?.name?.toLowerCase() || '';
      if (statusName === 'awarded') projectMap[pName].awarded += g.awarded_amount || 0;
      if (['application submitted', 'under review', 'loi submitted'].includes(statusName)) {
        projectMap[pName].pending += g.awarded_amount || 0;
      }
    }

    // Timeline: group by quarter
    const timelineMap: Record<string, { quarter: string; submitted: number; awarded: number }> = {};
    for (const g of grants) {
      const date = g.created_at ? new Date(g.created_at) : new Date();
      const q = `Q${Math.ceil((date.getMonth() + 1) / 3)} ${date.getFullYear()}`;
      if (!timelineMap[q]) timelineMap[q] = { quarter: q, submitted: 0, awarded: 0 };
      const statusName = (g as any).pipeline_statuses?.name?.toLowerCase() || '';
      if (['application submitted', 'under review', 'awarded', 'rejected'].includes(statusName)) timelineMap[q].submitted++;
      if (statusName === 'awarded') timelineMap[q].awarded++;
    }

    // Compliance summary
    const { data: compliance } = await supabase
      .from('compliance_requirements')
      .select('status, due_date')
      .eq('user_id', user.id);

    const now = new Date();
    const complianceSummary = {
      total: compliance?.length || 0,
      compliant: compliance?.filter(c => ['submitted', 'approved'].includes(c.status)).length || 0,
      upcoming: compliance?.filter(c => c.status === 'upcoming' && c.due_date && new Date(c.due_date) >= now).length || 0,
      overdue: compliance?.filter(c => c.due_date && new Date(c.due_date) < now && !['submitted', 'approved'].includes(c.status)).length || 0,
    };

    return json(req, {
      kpis: {
        total_grants: totalGrants,
        proposals_submitted: submitted.length,
        win_rate: winRate,
        total_awarded: totalAwarded,
        pending_ask: pendingAsk,
        avg_grant_size: avgGrantSize,
      },
      pipeline: Object.values(pipelineMap),
      byProject: Object.values(projectMap),
      timeline: Object.values(timelineMap),
      compliance: complianceSummary,
    });
  } catch (err: any) {
    const status = err.message?.includes('Unauthorized') || err.message?.includes('JWT') ? 401 : 500;
    return json(req, { error: err.message || 'Internal server error' }, status);
  }
});
