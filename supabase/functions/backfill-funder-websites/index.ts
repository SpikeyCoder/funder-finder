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

async function lookupWebsite(
  name: string,
  city: string | null,
  state: string | null,
): Promise<LookupResult> {
  const locationParts = [city, state].filter(Boolean).join(', ');
  const locationHint = locationParts ? ' (' + locationParts + ')' : '';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: 'What is the official website for: ' + name + locationHint,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Anthropic API [' + resp.status + ']: ' + errText.slice(0, 200));
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text?.trim() || '';
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      url: parsed.url || null,
      confidence: parsed.confidence || 'none',
    };
  } catch {
    console.error('[backfill-websites] Failed to parse Claude response for "' + name + '": ' + cleaned);
    return { url: null, confidence: 'none' };
  }
}



/* ─── DuckDuckGo search fallback ─── */

interface SearchResult {
  url: string;
  title: string;
}

async function duckduckgoSearch(query: string): Promise<SearchResult[]> {
  try {
    const resp = await fetch(
      'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query),
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } },
    );
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];
    const regex = /<a[^>]*rel="nofollow"[^>]*href="[^"]*uddg=([^&"]+)[^"]*"[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 5) {
      const decodedUrl = decodeURIComponent(match[1]);
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (decodedUrl.startsWith('http')) {
        results.push({ url: decodedUrl, title });
      }
    }
    return results;
  } catch (err) {
    console.error('[backfill-websites] DuckDuckGo search error:', err);
    return [];
  }
}

const SEARCH_EVAL_PROMPT = [
  'You are evaluating search results to find the official website for a US nonprofit foundation.',
  'Given the foundation name and a list of search results, identify which URL (if any) is the official website.',
  'Return ONLY a JSON object: {"url": "https://...", "confidence": "high"|"medium"|"low"}',
  'or {"url": null, "confidence": "none"} if none of the results is the official website.',
  '',
  'Rules:',
  '- Prefer .org domains for nonprofits',
  '- SKIP directory listings (guidestar.org, candid.org, nonprofitexplorer, charitynavigator)',
  '- SKIP social media profiles (facebook.com, linkedin.com, twitter.com)',
  '- SKIP news articles or press releases',
  '- SKIP Wikipedia pages',
  '- The URL should be the foundation\'s OWN website, not a profile on another site',
].join('\n');

async function searchFallback(
  name: string,
  city: string | null,
  state: string | null,
): Promise<LookupResult & { source: string }> {
  const locationParts = [city, state].filter(Boolean).join(' ');
  const query = '"' + name + '"' + (locationParts ? ' ' + locationParts : '') + ' foundation official website';

  let results = await duckduckgoSearch(query);

  // Retry with simpler query if no results
  if (results.length === 0) {
    results = await duckduckgoSearch(name + ' nonprofit website');
  }

  if (results.length === 0) {
    return { url: null, confidence: 'none', source: 'ddg+claude' };
  }

  // Ask Claude to evaluate the search results
  const resultsText = results
    .map((r, i) => (i + 1) + '. ' + r.title + ' — ' + r.url)
    .join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: SEARCH_EVAL_PROMPT,
      messages: [{
        role: 'user',
        content: 'Foundation: ' + name + (locationParts ? ' (' + locationParts + ')' : '') + '\n\nSearch results:\n' + resultsText,
      }],
    }),
  });

  if (!resp.ok) {
    return { url: null, confidence: 'none', source: 'ddg+claude' };
  }

  const data = await resp.json();
  const text = (data.content?.[0]?.text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      url: parsed.url || null,
      confidence: parsed.confidence || 'none',
      source: 'ddg+claude',
    };
  } catch {
    return { url: null, confidence: 'none', source: 'ddg+claude' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ─── Build the priority query ─── */

function buildQuery(priority: string, batchSize: number): string {
  // Base filters: website is null, name is not null
  const base = 'website=is.null&name=not.is.null&select=ein,name,city,state';

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
  ein: string;
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
      ein: string;
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
          ein: funder.ein,
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
            'ein=eq.' + encodeURIComponent(funder.ein),
            { website: lookup.url },
          );
          updated++;
        } else {
          skipped++;
        }
      } catch (e) {
        errors++;
        console.error('[backfill-websites] Error processing ' + funder.name + ':', e);
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
