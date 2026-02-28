/**
 * match-funders — Supabase Edge Function
 *
 * Receives { mission, locationServed, forceRefresh } from the frontend.
 * Returns { results: Funder[], cached: boolean }.
 *
 * Flow:
 *   1. Check search_cache table (7-day TTL) unless forceRefresh=true
 *   2. Fetch all funders from DB
 *   3. Call Claude Haiku to rank & score funders against the mission
 *   4. Enrich each result with next_step_url = funder.website (always external, never internal routes)
 *   5. Cache + return
 */

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.32.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOP_N = 60; // funders sent to Claude for ranking
const RESULTS_N = 10; // funders returned to frontend

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashKey(mission: string, locationServed = ''): string {
  const str = `${mission.trim().toLowerCase()}|${locationServed.trim().toLowerCase()}`;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h.toString(36);
}

async function sbFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase error [${res.status}]: ${body.slice(0, 300)}`);
  }
  return res;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { mission, locationServed = '', forceRefresh = false } = await req.json();

    if (!mission?.trim()) {
      return new Response(JSON.stringify({ error: 'mission is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const cacheKey = hashKey(mission, locationServed);

    // ── 1. Cache check ────────────────────────────────────────────────────────
    if (!forceRefresh) {
      const cacheRes = await sbFetch(
        `search_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&select=results,created_at&limit=1`,
      );
      const cached = await cacheRes.json();
      if (cached?.length) {
        const age = Date.now() - new Date(cached[0].created_at).getTime();
        if (age < CACHE_TTL_MS) {
          return new Response(
            JSON.stringify({ results: cached[0].results, cached: true }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
      }
    }

    // ── 2. Fetch funders ──────────────────────────────────────────────────────
    const fundersRes = await sbFetch(
      `funders?select=id,name,type,description,focus_areas,ntee_code,city,state,` +
      `website,total_giving,asset_amount,grant_range_min,grant_range_max,` +
      `contact_name,contact_title,contact_email,next_step&limit=${TOP_N}&order=total_giving.desc.nullslast`,
    );
    const funders: any[] = await fundersRes.json();

    if (!funders?.length) {
      return new Response(JSON.stringify({ results: [], cached: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Claude ranking ─────────────────────────────────────────────────────
    const funderSummaries = funders.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      focus_areas: f.focus_areas,
      state: f.state,
      description: f.description,
      total_giving: f.total_giving,
      grant_range_min: f.grant_range_min,
      grant_range_max: f.grant_range_max,
      has_website: !!f.website,
      has_email: !!f.contact_email,
    }));

    const locationClause = locationServed
      ? `The nonprofit primarily serves: ${locationServed}.`
      : '';

    const prompt = `You are a nonprofit funding expert. Rank the most relevant funders for this nonprofit mission.

MISSION: ${mission}
${locationClause}

FUNDERS (JSON array):
${JSON.stringify(funderSummaries, null, 2)}

Return ONLY a JSON array of the top ${RESULTS_N} matches. Each item must have exactly these fields:
- "id": the funder's id (string, copy exactly from input)
- "score": relevance score 0.0–1.0 (2 decimal places)
- "reason": 1–2 sentence explanation of why this funder is a strong match (mention specific focus areas)
- "next_step": a single, specific, actionable recommendation for what the nonprofit should do next with this funder (e.g. "Request their current grant guidelines and learn about the funding cycle for community organizations." Do NOT include URLs or email addresses in this text.)

Respond with ONLY the JSON array, no markdown, no explanation.`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    let ranked: any[] = [];
    try {
      const raw = (message.content[0] as any).text.trim();
      // Strip markdown code fences if Claude wraps output
      const jsonStr = raw.startsWith('```') ? raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '') : raw;
      ranked = JSON.parse(jsonStr);
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to parse Claude response' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 4. Merge DB data + set next_step_url ──────────────────────────────────
    //
    // IMPORTANT: next_step_url is ALWAYS the funder's real external website URL,
    // or null when no website is available. We never generate internal app routes
    // (/funder/:id#...) because those break on GitHub Pages and confuse users.
    //
    const results = ranked
      .map((r: any) => {
        const funder = funders.find((f) => f.id === r.id);
        if (!funder) return null;
        return {
          ...funder,
          score: r.score,
          reason: r.reason,
          next_step: r.next_step || funder.next_step || null,
          // Only set next_step_url when the funder has a real external website
          next_step_url: funder.website?.startsWith('http') ? funder.website : null,
        };
      })
      .filter(Boolean);

    // ── 5. Cache ──────────────────────────────────────────────────────────────
    await sbFetch('search_cache', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        cache_key: cacheKey,
        results,
        created_at: new Date().toISOString(),
      }),
    });

    return new Response(JSON.stringify({ results, cached: false }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('match-funders error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
