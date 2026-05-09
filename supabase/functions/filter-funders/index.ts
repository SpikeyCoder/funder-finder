import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { createUserScopedClient } from '../_shared/user-client.ts';
import { corsHeaders as _corsHeaders } from '../_shared/cors.ts';

const corsHeaders_OPTS = { methods: 'POST, OPTIONS' } as const;
function corsHeaders(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get('origin') ?? null, corsHeaders_OPTS);
}

function toCsv(values: unknown): string {
  if (!Array.isArray(values)) return '';
  return values
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .join(',');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) });
  }

  try {
    // User-scoped client is needed only for peer filtering by project.
    let userScopedClient = null;
    try {
      const result = await createUserScopedClient(req);
      userScopedClient = result.supabase;
    } catch {
      // Auth is optional for public browse queries.
    }

    // Read mv_funder_search_index with the service-role key.
    //
    // Migration 20260408153622_fix_materialized_view_api_exposure REVOKEd
    // SELECT on this matview from `anon` and `authenticated` to keep it off
    // the public PostgREST surface. The matview holds only 990-derived
    // public funder data, so reading it from the function with elevated
    // privileges is fine — auth-gated paths below (peer filtering, etc.)
    // still use the user-scoped client so per-user authorization is
    // unchanged.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const {
      project_id,
      query,
      filters = {},
      sort_by = 'total_giving',
      sort_order = 'desc',
      page = 1,
      per_page = 25,
    } = body;

    const {
      states = [],
      ntee_codes = [],
      funding_types: _funding_types = [],
      funder_types = [],
      grant_size_min,
      grant_size_max,
      gives_to_peers = false,
      locations_served = [],
    } = filters;

    const { data, error } = await supabase.rpc('filter_funders_grant_level', {
      p_query: query ?? null,
      p_states_csv: toCsv(states),
      p_ntee_codes_csv: toCsv(ntee_codes),
      p_funder_types_csv: toCsv(funder_types),
      p_grant_size_min: grant_size_min ?? null,
      p_grant_size_max: grant_size_max ?? null,
      p_locations_served_csv: toCsv(locations_served),
      p_sort_by: sort_by ?? 'total_giving',
      p_sort_order: sort_order ?? 'desc',
      p_page: page ?? 1,
      p_per_page: per_page ?? 25,
    });

    if (error) {
      console.error('filter_funders_grant_level RPC error:', error);
      return new Response(JSON.stringify({ error: 'Query failed', details: error.message }), {
        status: 500,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    let filteredResults = data || [];
    let finalTotal =
      filteredResults.length > 0
        ? Number((filteredResults[0] as Record<string, unknown>).total_count ?? 0)
        : 0;

    if (project_id && gives_to_peers) {
      if (!userScopedClient) {
        return new Response(
          JSON.stringify({ error: 'Authentication required for peer filtering' }),
          {
            status: 401,
            headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
          }
        );
      }

      const { data: peerMatches } = await userScopedClient
        .from('project_matches')
        .select('funder_ein')
        .eq('project_id', project_id)
        .eq('gives_to_peers', true);

      if (peerMatches && peerMatches.length > 0) {
        const peerEins = new Set(peerMatches.map((m: any) => m.funder_ein));
        filteredResults = filteredResults.filter((r: any) => peerEins.has(r.ein));
        finalTotal = filteredResults.length;
      } else {
        filteredResults = [];
        finalTotal = 0;
      }
    }

    const formattedResults = filteredResults.map((r: any) => ({
      ein: r.ein,
      funder_id: r.funder_id,
      name: r.name,
      state: r.state,
      entity_type: r.entity_type,
      ntee_code: r.ntee_code,
      avg_grant_size: Number(r.avg_grant_size) || 0,
      total_giving: Number(r.total_giving) || 0,
      grant_count: Number(r.grant_count) || 0,
      grant_range_min: r.grant_range_min,
      grant_range_max: r.grant_range_max,
    }));

    return new Response(
      JSON.stringify({
        results: formattedResults,
        total: finalTotal,
        page,
        per_page,
        applied_filters: filters,
      }),
      {
        status: 200,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    console.error('filter-funders error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      }
    );
  }
});
