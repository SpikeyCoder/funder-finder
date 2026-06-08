/**
 * search-organizations — Supabase Edge Function
 *
 * Thin wrapper around the `search_organizations` PostgreSQL RPC function.
 * Accepts { query, limit? } and returns matching funders/recipients.
 *
 * FM-2026-06-08-01 (pen-test): migrated from a per-function ALLOWED_ORIGINS
 * + inline corsHeaders() implementation to the shared
 * `_shared/cors.ts` helper so the CORS allowlist has a single source of
 * truth alongside the other 32 edge functions. Closes finding
 * FM-2026-06-06-03 from the 2026-06-06 scheduled pen-test.
 */

import { corsHeaders, preflightResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') return preflightResponse(req);
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const limit = typeof body?.limit === 'number' ? Math.min(Math.max(body.limit, 1), 50) : 15;

    if (!query || query.length < 2) {
      return new Response(
        JSON.stringify({ results: [], error: 'Query must be at least 2 characters' }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Call the existing search_organizations RPC function in PostgreSQL
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_organizations`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_query: query, p_limit: limit }),
    });

    if (!rpcRes.ok) {
      const errBody = await rpcRes.text();
      console.error('search_organizations RPC error:', errBody);
      return new Response(
        JSON.stringify({ results: [], error: 'Search failed' }),
        { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const rows = await rpcRes.json();

    // Map RPC results to the OrgSearchResult shape the frontend expects
    const results = Array.isArray(rows)
      ? rows.map((r: Record<string, unknown>) => ({
          id: r.id ?? r.ein ?? '',
          ein: r.ein ?? null,
          name: r.name ?? '',
          state: r.state ?? null,
          entity_type: r.entity_type ?? 'funder',
          grant_count: Number(r.grant_count ?? 0),
          total_funding: Number(r.total_funding ?? 0),
        }))
      : [];

    return new Response(JSON.stringify({ results }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    console.error('search-organizations error:', err);
    return new Response(
      JSON.stringify({ results: [], error: 'Internal server error' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
