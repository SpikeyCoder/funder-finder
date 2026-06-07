import { corsHeaders, preflightResponse } from '../_shared/cors.ts';
import { sanitiseError } from '../_shared/errors.ts';

/**
 * backfill-funder-websites — Supabase Edge Function
 *
 * Batch-populates funders.website for funders that are missing it.
 * Uses Claude Haiku to infer the most likely official website URL
 * from the funder's name, city, and state.
 *
 * POST body: { batch_size?: number, priority?: "tracked"|"top"|"all" }
 *
 * Each invocation:
 *  1. Selects up to batch_size funders WHERE website IS NULL AND name IS NOT NULL
 *  2. Asks Claude Haiku for the most likely official website
 *  3. Updates funders.website for high/medium confidence results
 *  4. Returns { processed, updated, skipped, errors }
 */

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

/* ─── Supabase REST helpers ─── */

async function restQuery(table: string, params: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`REST ${table} [${res.status}]: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<unknown[]>;
}

async function restPatch(
  table: string,
  params: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${table} [${res.status}]: ${text.slice(0, 300)}`);
  }
}

/* ─── Claude lookup ─── */

interface LookupResult {
  url: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

const SYSTEM_PROMPT = [
  'You are a research assistant that finds official websites for US nonprofit',
  'foundations and grant-making organizations. Given a foundation name and',
  'optional location, return the official website URL if you know it with',
  'reasonable confidence. Return ONLY a JSON object with no markdown formatting:',
  '{"url": "https://...", "confidence": "high"|"medium"|"low"}',
  'or if you cannot determine the website:',
  '{"url": null, "confidence": "none"}',
  '',
  'Rules:',
  '- Only return URLs you are confident are the correct official website for this specific organization',
  '- "high" = you are very confident this is the right URL (well-known foundation)',
  '- "medium" = likely correct based on the name/location match',
  '- "low" = uncertain, could be wrong',
  '- "none" = you have no idea',
  '- Do NOT guess or fabricate URLs',
  '- Do NOT return generic search URLs or directory listings',
].join('\n');

interface ExtendedLookupResult extends LookupResult {
  source: 'claude' | 'web-search';
}

async function callClaude(
  system: string,
  userMessage: string,
  useWebSearch = false,
): Promise<{ url: string | null; confidence: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (useWebSearch) {
  }

  const body: Record<string, unknown> = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system,
    messages: [{ role: 'user', content: userMessage }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Anthropic API [' + resp.status + ']: ' + errText.slice(0, 200));
  }

  const data = await resp.json();
  // Extract the last text block (web search returns multiple content blocks)
  const textBlocks = (data.content || []).filter((b: any) => b.type === 'text');
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text.trim() : '';
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return { url: parsed.url || null, confidence: parsed.confidence || 'none' };
  } catch {
    console.error('[backfill-websites] Failed to parse Claude response: ' + cleaned.slice(0, 200));
    return { url: null, confidence: 'none' };
  }
}

const WEB_SEARCH_PROMPT = [
  'You are finding the official website for a US nonprofit foundation.',
  'Search the web for this organization and identify its official website URL.',
  'Return ONLY a JSON object with no markdown formatting:',
  '{"url": "https://...", "confidence": "high"|"medium"|"low"}',
  'or {"url": null, "confidence": "none"} if you cannot find it.',
  '',
  'Rules:',
  '- Return the foundation\'s OWN website, not a profile on another site',
  '- SKIP directory listings (guidestar.org, candid.org, charitynavigator.org, nonprofitexplorer)',
  '- SKIP social media profiles (facebook, linkedin, twitter/x)',
  '- SKIP Wikipedia, news articles, and press releases',
  '- Prefer .org domains for nonprofits',
  '- "high" = the search confirms this is the official website',
  '- "medium" = likely correct based on search results',
].join('\n');

async function lookupWebsite(
  name: string,
  city: string | null,
  state: string | null,
): Promise<ExtendedLookupResult> {
  const locationParts = [city, state].filter(Boolean).join(', ');
  const locationHint = locationParts ? ' (' + locationParts + ')' : '';

  // Step 1: Try Claude from training knowledge (fast, cheap)
  const step1 = await callClaude(
    SYSTEM_PROMPT,
    'What is the official website for: ' + name + locationHint,
    false,
  );

  if (step1.url && (step1.confidence === 'high' || step1.confidence === 'medium')) {
    return { url: step1.url, confidence: step1.confidence as LookupResult['confidence'], source: 'claude' };
  }

  // Step 2: Claude with web search (more thorough, slightly slower)
  console.log('[backfill-websites] Claude training returned ' + step1.confidence + ' for "' + name + '", trying web search');
  try {
    const step2 = await callClaude(
      WEB_SEARCH_PROMPT,
      'Find the official website for this nonprofit foundation: ' + name + locationHint,
      true,
    );

    if (step2.url) {
      return {
        url: step2.url,
        confidence: step2.confidence as LookupResult['confidence'],
        source: 'web-search',
      };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[backfill-websites] Web search error for "' + name + '":', errMsg);
    return { url: null, confidence: 'none', source: ('ws-err: ' + errMsg.slice(0, 80)) as any };
  }

  return { url: null, confidence: 'none', source: 'web-search-no-result' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ─── Build the priority query ─── */

function buildQuery(priority: string, batchSize: number): string {
  // Base filters: website is null, name is not null
  const base = 'website=is.null&name=not.is.null&website_last_checked=is.null&select=foundation_ein,name,city,state';

  switch (priority) {
    case 'tracked':
      // Funders that appear in tracked_grants first, then by total_giving.
      // A REST-only join is impractical, so we use total_giving DESC as a
      // proxy — tracked funders tend to be the largest givers.
      return base + '&order=total_giving.desc.nullslast&limit=' + batchSize;

    case 'top':
      return base + '&order=total_giving.desc.nullslast&limit=' + batchSize;

    case 'all':
    default:
      return base + '&limit=' + batchSize;
  }
}

/* ─── Main handler ─── */

interface Funder {
  foundation_ein: string;
  name: string;
  city: string | null;
  state: string | null;
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') return preflightResponse(req);
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  if (!ANTHROPIC_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const body = await req.json().catch(() => ({}));

    const rawBatchSize = Number(body?.batch_size);
    const batchSize =
      Number.isFinite(rawBatchSize) && rawBatchSize > 0
        ? Math.min(Math.floor(rawBatchSize), 50)
        : 20;

    const priority = ['tracked', 'top', 'all'].includes(body?.priority)
      ? body.priority
      : 'tracked';

    // Fetch funders needing websites
    const funders = (await restQuery(
      'funders',
      buildQuery(priority, batchSize),
    )) as Funder[];

    if (funders.length === 0) {
      return new Response(
        JSON.stringify({
          processed: 0,
          updated: 0,
          skipped: 0,
          errors: 0,
          message: 'No funders with missing websites found for the given criteria.',
        }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    console.log(
      '[backfill-websites] Processing ' + funders.length + ' funders (priority=' + priority + ')',
    );

    let updated = 0;
    let skipped = 0;
    let errors  = 0;
    const results: Array<{
      foundation_ein: string;
      name: string;
      url: string | null;
      confidence: string;
    }> = [];

    for (const funder of funders) {
      try {
        const lookup = await lookupWebsite(funder.name, funder.city, funder.state);

        console.log(
          '[backfill-websites] ' + funder.name + ' -> ' + (lookup.url ?? 'null') + ' (' + lookup.confidence + ')',
        );

        results.push({
          foundation_ein: funder.foundation_ein,
          name: funder.name,
          url: lookup.url,
          confidence: lookup.confidence,
        });

        if (
          lookup.url &&
          (lookup.confidence === 'high' || lookup.confidence === 'medium')
        ) {
          await restPatch(
            'funders',
            'foundation_ein=eq.' + encodeURIComponent(funder.foundation_ein),
            { website: lookup.url },
          );
          updated++;
        } else {
          skipped++;
          try { await restPatch('funders', 'foundation_ein=eq.' + encodeURIComponent(funder.foundation_ein), { website_last_checked: new Date().toISOString() }); } catch {}
        }
      } catch (e) {
        errors++;
        console.error('[backfill-websites] Error processing ' + funder.name + ':', e);
        try { await restPatch('funders', 'foundation_ein=eq.' + encodeURIComponent(funder.foundation_ein), { website_last_checked: new Date().toISOString() }); } catch {}
      }

      // Rate-limit delay between Anthropic calls
      await sleep(200);
    }

    const summary = {
      processed: funders.length,
      updated,
      skipped,
      errors,
      priority,
      results,
      message: 'Processed ' + funders.length + ' funders: ' + updated + ' updated, ' + skipped + ' skipped (low/none confidence), ' + errors + ' errors.',
    };

    console.log('[backfill-websites] Done: ' + summary.message);

    return new Response(JSON.stringify(summary), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    console.error('[backfill-websites] Fatal error:', err);
    return new Response(
      JSON.stringify({ error: sanitiseError(err, 'Internal server error') }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
