/**
 * match-funders — Supabase Edge Function
 *
 * Receives { mission, locationServed, forceRefresh } from the frontend.
 * Returns { results: Funder[], cached: boolean }.
 *
 * Flow:
 *   1. Check search_cache table (7-day TTL) unless forceRefresh=true
 *   2. Fetch all funders from DB (including subpage URL columns)
 *   3. Call Claude Haiku to rank & score funders; Claude also labels next_step_type
 *   4. Resolve next_step_url using next_step_type → best subpage URL → fallback to website
 *   5. Cache + return
 *
 * next_step_type → URL column mapping:
 *   "contact"  → contact_url  → website
 *   "apply"    → apply_url    → programs_url → website
 *   "programs" → programs_url → website
 *   "news"     → news_url     → website
 *   "homepage" → website
 */

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.32.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOP_N = 60;    // funders sent to Claude for ranking
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

/**
 * Normalise a raw URL string to a fully-qualified external URL, or null.
 *   - Bare domain "cct.org"                       → "https://cct.org"
 *   - Stale GitHub Pages path "...github.io/…"    → strip prefix, then normalise
 *   - Internal route "/funder/…"                  → null
 *   - Already "https://…"                         → as-is
 *   - Empty / null                                → null
 */
function toExternalUrl(url: string | null | undefined): string | null {
  let s = url?.trim();
  if (!s) return null;
  // Strip legacy cached GitHub Pages internal funder paths
  s = s.replace(/^https?:\/\/[^/]*\.github\.io\/[^/]+\/funder\//, '');
  if (!s || s.startsWith('/')) return null;
  if (s.startsWith('http')) return s;
  return `https://${s}`;
}

/**
 * Given a next_step_type label from Claude and the full funder DB row,
 * return the most relevant external URL, falling back through the chain.
 *
 * Fallback chains:
 *   contact  → contact_url  → website
 *   apply    → apply_url    → programs_url → website
 *   programs → programs_url → apply_url    → website
 *   news     → news_url     → website
 *   homepage → website
 */
function resolveNextStepUrl(type: string, funder: any): string | null {
  const chain: (string | null | undefined)[] = (() => {
    switch (type) {
      case 'contact':  return [funder.contact_url,  funder.website];
      case 'apply':    return [funder.apply_url,    funder.programs_url, funder.website];
      case 'programs': return [funder.programs_url, funder.apply_url,    funder.website];
      case 'news':     return [funder.news_url,     funder.website];
      default:         return [funder.website];
    }
  })();
  for (const url of chain) {
    const resolved = toExternalUrl(url);
    if (resolved) return resolved;
  }
  return null;
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
        `search_cache?mission_hash=eq.${encodeURIComponent(cacheKey)}&select=results,created_at&limit=1`,
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

    // ── 2. Fetch funders (including all subpage URL columns) ──────────────────
    const fundersRes = await sbFetch(
      `funders?select=id,name,type,description,focus_areas,ntee_code,city,state,` +
      `website,contact_url,programs_url,apply_url,news_url,` +
      `total_giving,asset_amount,grant_range_min,grant_range_max,` +
      `contact_name,contact_title,contact_email,next_step` +
      `&limit=${TOP_N}&order=total_giving.desc.nullslast`,
    );
    const funders: any[] = await fundersRes.json();

    if (!funders?.length) {
      return new Response(JSON.stringify({ results: [], cached: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Claude ranking + next_step_type labelling ──────────────────────────
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
      has_contact_page: !!f.contact_url,
      has_programs_page: !!f.programs_url,
      has_apply_page: !!f.apply_url,
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
- "next_step": a single, specific, actionable recommendation for what the nonprofit should do next with this funder. Do NOT include URLs or email addresses in this text.
- "next_step_type": classify next_step into exactly one of these values:
    "contact"  — the recommended action is to reach out to staff, a program officer, or the contact team
    "apply"    — the action involves submitting an LOI, application, or reviewing grant guidelines/RFP
    "programs" — the action involves researching the funder's programs, priorities, portfolio, or initiatives
    "news"     — the action involves reading their annual report, newsletter, or recent news
    "homepage" — none of the above; link to their main website

Choose next_step_type to match what next_step actually recommends, not just the funder type.

Respond with ONLY the JSON array, no markdown, no explanation.`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    let ranked: any[] = [];
    try {
      const raw = (message.content[0] as any).text.trim();
      // Strip markdown code fences if present
      const jsonStr = raw.startsWith('```')
        ? raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
        : raw;
      ranked = JSON.parse(jsonStr);
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to parse Claude response' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 4. Merge DB data + resolve subpage URL ────────────────────────────────
    const results = ranked
      .map((r: any) => {
        const funder = funders.find((f) => f.id === r.id);
        if (!funder) return null;

        const nextStepType: string = r.next_step_type || 'homepage';
        const nextStepUrl = resolveNextStepUrl(nextStepType, funder);

        return {
          ...funder,
          score: r.score,
          reason: r.reason,
          next_step: r.next_step || funder.next_step || null,
          next_step_type: nextStepType,
          next_step_url: nextStepUrl,
        };
      })
      .filter(Boolean);

    // ── 5. Cache ──────────────────────────────────────────────────────────────
    await sbFetch('search_cache', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        mission_hash: cacheKey,
        mission_text: mission,
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
