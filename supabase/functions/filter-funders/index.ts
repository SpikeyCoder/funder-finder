import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

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
    const { data: countData, error: countError } = await supabase.rpc('exec_sql_readonly', {
      sql_query: countSql,
      sql_params: params,
    });

    // If the RPC doesn't exist, fall back to direct query
    let total = 0;
    let results: any[] = [];

    // Use direct SQL via the pg connection
    // Since we can't use parameterized queries directly with supabase-js on a matview,
    // build a safe query using the Supabase PostgREST-compatible approach

    // Alternative approach: query the matview using supabase client filters
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

    // International location filter: search focus_areas array or use keyword text search
    // When locations_served contains continents/countries, we combine them with websearch
    // on the search_vector so funders whose descriptions/focus areas mention those regions appear.
    if (locations_served.length > 0) {
      // Build a websearch query from the location terms (OR logic via pipe in websearch mode)
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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // If project_id is provided and gives_to_peers is true, filter by peer connection
    // This is a secondary filter applied after the main query
    let filteredResults = data || [];

    if (project_id && gives_to_peers) {
      // Get project matches that have gives_to_peers = true
      const { data: peerMatches } = await supabase
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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    console.error('filter-funders error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
