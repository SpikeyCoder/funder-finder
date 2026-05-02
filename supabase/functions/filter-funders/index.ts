import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { createUserScopedClient } from "../_shared/user-client.ts";

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const corsHeaders_OPTS = { methods: "POST, OPTIONS" } as const;
function corsHeaders(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, corsHeaders_OPTS);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) });
  }

  try {
    // Phase 4: Use user-scoped client for project_matches access
    // But we also need public anon access for the matview
    let userScopedClient = null;
    try {
      const result = await createUserScopedClient(req);
      userScopedClient = result.supabase;
    } catch {
      // Auth is optional for public funder search, but required if filtering by project
      // Will check later if needed
    }

    // Always use anon key for public matview access
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
      funding_types = [],
      funder_types = [],
      grant_size_min,
      grant_size_max,
      gives_to_peers = false,
      locations_served = [],
    } = filters;

    // Build the SQL query against the materialized view
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Keyword search using tsvector
    if (query && query.trim()) {
      // Convert query to tsquery format
      const terms = query.trim().split(/\s+/).map((t: string) => t.replace(/[^\w]/g, '')).filter(Boolean);
      if (terms.length > 0) {
        const tsquery = terms.map((t: string) => `${t}:*`).join(' & ');
        conditions.push(`search_vector @@ to_tsquery('english', $${paramIdx})`);
        params.push(tsquery);
        paramIdx++;
      }
    }

    // State filter (OR logic)
    if (states.length > 0) {
      conditions.push(`state = ANY($${paramIdx})`);
      params.push(states);
      paramIdx++;
    }

    // NTEE code filter (OR on major category letter)
    if (ntee_codes.length > 0) {
      const nteeConditions = ntee_codes.map((_: string, i: number) => {
        params.push(ntee_codes[i] + '%');
        return `ntee_code LIKE $${paramIdx++}`;
      });
      conditions.push(`(${nteeConditions.join(' OR ')})`);
    }

    // Funder type filter
    if (funder_types.length > 0) {
      conditions.push(`entity_type = ANY($${paramIdx})`);
      params.push(funder_types);
      paramIdx++;
    }

    // Grant size range
    if (grant_size_min != null && grant_size_min > 0) {
      conditions.push(`avg_grant_size >= $${paramIdx}`);
      params.push(grant_size_min);
      paramIdx++;
    }
    if (grant_size_max != null && grant_size_max > 0) {
      conditions.push(`avg_grant_size <= $${paramIdx}`);
      params.push(grant_size_max);
      paramIdx++;
    }

    // Exclude zero-activity funders
    conditions.push('grant_count > 0');

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Validate sort column
    const validSortCols: Record<string, string> = {
      total_giving: 'total_giving',
      grant_count: 'grant_count',
      avg_grant_size: 'avg_grant_size',
      name: 'name',
      match_score: 'total_giving', // fallback
    };
    const sortCol = validSortCols[sort_by] || 'total_giving';
    const sortDir = sort_order === 'asc' ? 'ASC' : 'DESC';
    const nullsLast = sortDir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';

    const offset = (Math.max(1, page) - 1) * per_page;

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM mv_funder_search_index ${whereClause}`;

    // Query the public matview
    let query_builder = supabase
      .from('mv_funder_search_index')
      .select('funder_id, ein, name, state, entity_type, ntee_code, total_giving, avg_grant_size, grant_count, grant_range_min, grant_range_max, focus_areas', { count: 'exact' });

    // Apply filters
    if (query && query.trim()) {
      query_builder = query_builder.textSearch('search_vector', query.trim(), { type: 'websearch' });
    }

    if (states.length > 0) {
      query_builder = query_builder.in('state', states);
    }

    if (ntee_codes.length > 0) {
      // Filter by NTEE major letter - use OR conditions
      const nteeFilters = ntee_codes.map((code: string) => `ntee_code.like.${code}%`).join(',');
      query_builder = query_builder.or(nteeFilters);
    }

    if (funder_types.length > 0) {
      query_builder = query_builder.in('entity_type', funder_types);
    }

    if (grant_size_min != null && grant_size_min > 0) {
      query_builder = query_builder.gte('avg_grant_size', grant_size_min);
    }

    if (grant_size_max != null && grant_size_max > 0) {
      query_builder = query_builder.lte('avg_grant_size', grant_size_max);
    }

    // Only show funders with grants
    query_builder = query_builder.gt('grant_count', 0);

    // International location filter
    if (locations_served.length > 0) {
      const locationQuery = locations_served.join(' | ');
      query_builder = query_builder.textSearch('search_vector', locationQuery, { type: 'websearch' });
    }

    // Sort
    query_builder = query_builder.order(sortCol, { ascending: sort_order === 'asc', nullsFirst: false });

    // Paginate
    query_builder = query_builder.range(offset, offset + per_page - 1);

    const { data, error, count } = await query_builder;

    if (error) {
      console.error('Filter query error:', error);
      return new Response(JSON.stringify({ error: 'Query failed', details: error.message }), {
        status: 500,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // If project_id is provided and gives_to_peers is true, filter by peer connection
    let filteredResults = data || [];

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

      // Get project matches that have gives_to_peers = true
      const { data: peerMatches } = await userScopedClient
        .from('project_matches')
        .select('funder_ein')
        .eq('project_id', project_id)
        .eq('gives_to_peers', true);

      if (peerMatches && peerMatches.length > 0) {
        const peerEins = new Set(peerMatches.map((m: any) => m.funder_ein));
        filteredResults = filteredResults.filter((r: any) => peerEins.has(r.ein));
      }
    }

    // Format response
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
        total: count ?? formattedResults.length,
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
