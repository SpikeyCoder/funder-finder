// Phase 5A: Generate PDF report from portfolio data
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('authorization') || '';
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    global: { headers: { authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
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
          ...CORS,
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="fundermatch-report-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }

    // Return JSON summary for other formats
    return new Response(JSON.stringify({ grants: grants?.length || 0, format: 'json', data: grants }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
