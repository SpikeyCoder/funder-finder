// Phase 5A: Generate PDF report from portfolio data
import { createUserScopedClient } from "../_shared/user-client.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_OPTS = { methods: "POST, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS(req), 'Content-Type': 'application/json' },
    });
  }

  try {
    const { supabase, user } = await createUserScopedClient(req);

    const { format = 'csv' } = await req.json().catch(() => ({}));

    // Fetch all grants for export
    const { data: grants } = await supabase
      .from('tracked_grants')
      .select('*, pipeline_statuses(name), projects(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (format === 'csv') {
      const header = 'Project,Funder,Grant Title,Status,Amount,Deadline,Source,Created\n';
      const rows = (grants || []).map(g =>
        `"${(g as any).projects?.name || ''}","${g.funder_name}","${g.grant_title || ''}","${(g as any).pipeline_statuses?.name || ''}",${g.awarded_amount || ''},${g.deadline || ''},"${g.source || ''}","${g.created_at?.split('T')[0] || ''}"`
      ).join('\n');

      return new Response(header + rows, {
        headers: {
          ...CORS(req),
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="fundermatch-report-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }

    // Return JSON summary for other formats
    return new Response(JSON.stringify({ grants: grants?.length || 0, format: 'json', data: grants }), {
      headers: { ...CORS(req), 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 401, headers: { ...CORS(req), 'Content-Type': 'application/json' },
    });
  }
});
