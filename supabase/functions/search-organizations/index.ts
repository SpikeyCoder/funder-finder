/**
 * search-organizations — Supabase Edge Function
 *
 * Thin wrapper around the `search_organizations` PostgreSQL RPC function.
 * Accepts { query, limit?, state? } and returns matching funders/recipients.
 * `state` (a 2-letter code) ranks organizations in that state first among
 * equally good matches; anything else is ignored.
 *
 * FM-2026-06-08-01 (pen-test): migrated from a per-function ALLOWED_ORIGINS
 * + inline corsHeaders() implementation to the shared
 * `_shared/cors.ts` helper so the CORS allowlist has a single source of
 * truth alongside the other 32 edge functions. Closes finding
 * FM-2026-06-06-03 from the 2026-06-06 scheduled pen-test.
 *
 * FM-2026-06-17-01 (pen-test): added a per-IP rate limit. The endpoint
 * is intentionally callable without a logged-in JWT (the typeahead
 * widget on the marketing-side org picker uses it), so the only
 * abuse-cost ceiling today is the global Supabase gateway. Without an
 * IP cap, a single client can spin the underlying `search_organizations`
 * PostgreSQL RPC at line speed -- expensive trigram + ILIKE work over
 * `foundation_grants` + `recipient_organizations`. Threshold (60/min)
 * is well above any legitimate typeahead burst and matches the shared
 * default in `_shared/rate_limit.ts`.
 */

import { corsHeaders, preflightResponse } from "../_shared/cors.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";

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

  // FM-2026-06-17-01: per-IP rate limit (defense-in-depth) so an
  // attacker cannot spin the trigram-backed RPC at line speed.
  // The limiter's call normally answers in well under 500 ms, but its trip to
  // the API gateway sometimes stalls for 1.5 s or more (SLA card, 2026-10-06),
  // eating most of search's 2 s budget before the search even starts. Past
  // 1 s it fails open: a stalled limiter costs at most a second, and a rare
  // unlimited request is the trade.
  const limited = await ipRateLimit(req, {
    namespace: 'search-organizations',
    limit: 60,
    windowMs: 60_000,
    extraHeaders: headers,
    timeoutMs: 1000,
  });
  if (!limited.allow && limited.response) return limited.response;

  try {
    const body = await req.json();
    // No organization name is longer; the RPC applies the same cap. Cut by
    // code point so an emoji at the boundary isn't split into a lone surrogate
    // (after cheap code-unit cuts, so a huge body isn't scanned or split up;
    // 1000 units always hold more than 200 code points, so that cut can't
    // leave a half pair in the result). Whitespace runs are collapsed before
    // the 1000-unit cut, as the RPC does, so ordinary padding can't push real
    // words past it.
    const query = typeof body?.query === 'string'
      ? [
        ...body.query
          .slice(0, 4000)
          // The 4000-unit cut can leave half an emoji; drop any lone surrogate
          // before whitespace collapse could pull it within the first 200.
          .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1000),
      ].slice(0, 200).join('')
      : '';
    // p_limit is an integer: a fractional limit would make PostgREST reject the call.
    const limit = Number.isFinite(body?.limit) ? Math.min(Math.max(Math.trunc(body.limit), 1), 50) : 15;
    const state = typeof body?.state === 'string' && /^[A-Za-z]{2}$/.test(body.state)
      ? body.state.toUpperCase()
      : null;

    if (!query || query.length < 2) {
      return new Response(
        JSON.stringify({ results: [], error: 'Query must be at least 2 characters' }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const callRpc = (params: Record<string, unknown>) =>
      fetch(`${SUPABASE_URL}/rest/v1/rpc/search_organizations`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });
    let rpcRes = await callRpc(state ? { p_query: query, p_limit: limit, p_state: state } : { p_query: query, p_limit: limit });
    // A database without p_state yet (this deployed before its migration, or
    // after a rollback) answers PGRST202; search without the state rather
    // than fail.
    if (state && rpcRes.status === 404) {
      const errBody = await rpcRes.text();
      if (errBody.includes('PGRST202')) {
        console.error('search_organizations has no p_state; searching without it');
        rpcRes = await callRpc({ p_query: query, p_limit: limit });
      } else {
        rpcRes = new Response(errBody, { status: 404 });
      }
    }

    const searchFailed = () => new Response(
      JSON.stringify({ results: [], error: 'Search failed' }),
      { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } },
    );

    if (!rpcRes.ok) {
      const errBody = await rpcRes.text();
      console.error('search_organizations RPC error:', errBody);
      return searchFailed();
    }

    const text = await rpcRes.text();
    let rows: unknown = null;
    try {
      rows = JSON.parse(text);
    } catch {
      // Logged below with the raw body.
    }

    // A 200 that isn't a row array (or isn't JSON) is a failure, not "no
    // matches" — report it so the client shows its error state instead of an
    // empty result.
    if (!Array.isArray(rows)) {
      console.error('search_organizations RPC returned a non-array body:', text.slice(0, 300));
      return searchFailed();
    }

    // Map RPC results to the OrgSearchResult shape the frontend expects
    // (A malformed element is skipped rather than throwing a 500.)
    const results = rows.filter((r) => r !== null && typeof r === 'object').map((r: Record<string, unknown>) => ({
      id: r.id ?? r.ein ?? '',
      ein: r.ein ?? null,
      name: r.name ?? '',
      state: r.state ?? null,
      entity_type: r.entity_type ?? 'funder',
      grant_count: Number(r.grant_count ?? 0),
      total_funding: Number(r.total_funding ?? 0),
    }));

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
