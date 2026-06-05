import { corsHeaders, preflightResponse } from '../_shared/cors.ts';
import { sanitiseError } from '../_shared/errors.ts';

/**
 * backfill-funder-websites — Supabase Edge Function
 *
 * Batch-populates funders.website for funders that are missing it.
 * Uses Claude Haiku to infer the most likely official website URL
 * from the funder's name, city, and state.
 *
 * If Claude can't identify the website (confidence = none/low), falls back
 * to a DuckDuckGo Lite search: searches for the funder, then asks Claude
 * to pick the official site from the top search results.
 *
 * POST body: { batch_size?: number, priority?: "matched"|"tracked"|"top"|"all" }
 *
 * Each invocation:
 *  1. Selects up to batch_size funders WHERE website IS NULL AND name IS NOT NULL
 *  2. Asks Claude Haiku for the most likely official website
 *  3. If confidence is none/low, tries DuckDuckGo Lite + Claude fallback
 *  4. Updates funders.website for high/medium confidence results
 *  5. Returns { processed, updated, skipped, errors }
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

async function rpcQuery(fnName: string, params: Record<string, unknown>): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RPC ${fnName} [${res.status}]: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<unknown[]>;
}

/* ─── Claude lookup ─── */

interface LookupResult {
  url: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  source: 'claude' | 'ddg+claude';
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

const SEARCH_EVAL_SYSTEM_PROMPT = [
  'You are a research assistant that identifies official websites for US nonprofit',
  'foundations and grant-making organizations. You will be given a foundation name',
  'and a list of web search results. Determine which (if any) is the official',
  'website for the foundation.',
  '',
  'Return ONLY a JSON object with no markdown formatting:',
  '{"url": "https://...", "confidence": "high"|"medium"|"low"}',
  'or if none of the results appear to be the official website:',
  '{"url": null, "confidence": "none"}',
  '',
  'Rules:',
  '- Only pick a URL if you are reasonably confident it is the official website',
  '- "high" = the result clearly matches (e.g., domain matches org name, description confirms it)',
  '- "medium" = likely correct based on title/description/URL patterns',
  '- "low" = possible but uncertain',
  '- "none" = none of the results look like the official site',
  '- Prefer .org domains for nonprofits when available',
  '- Do NOT pick generic directories (guidestar, candid, charitynavigator, etc.) as the official site',
  '- Do NOT pick social media profiles as the official site',
  '- Do NOT pick news articles or third-party pages',
].join('\n');

async function callClaude(
  system: string,
  userMessage: string,
): Promise<LookupResult> {
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
      system,
      messages: [
        {
          role: 'user',
          content: userMessage,
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
      source: 'claude',
    };
  } catch {
    return { url: null, confidence: 'none', source: 'claude' };
  }
}

/* ─── DuckDuckGo Lite search fallback ─── */

interface SearchResult {
  url: string;
  title: string;
}

async function duckduckgoSearch(query: string): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });

  if (!resp.ok) {
    console.error('[backfill-websites] DuckDuckGo Lite error [' + resp.status + ']');
    return [];
  }

  const html = await resp.text();

  // Extract uddg URLs and titles from nofollow links
  const regex = /<a[^>]*rel="nofollow"[^>]*href="[^"]*uddg=([^&"]+)[^"]*"[^>]*>(.*?)<\/a>/gs;
  const results: SearchResult[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null && results.length < 5) {
    try {
      const decodedUrl = decodeURIComponent(match[1]);
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (decodedUrl && title) {
        results.push({ url: decodedUrl, title });
      }
    } catch {
      // Skip malformed entries
    }
  }

  return results;
}

async function lookupWebsiteWithSearchFallback(
  name: string,
  city: string | null,
  state: string | null,
): Promise<LookupResult> {
  const locationParts = [city, state].filter(Boolean).join(', ');
  const locationHint = locationParts ? ' (' + locationParts + ')' : '';

  // Step 1: Ask Claude from training knowledge
  const claudeResult = await callClaude(
    SYSTEM_PROMPT,
    'What is the official website for: ' + name + locationHint,
  );

  // If Claude is confident, return immediately
  if (
    claudeResult.url &&
    (claudeResult.confidence === 'high' || claudeResult.confidence === 'medium')
  ) {
    return claudeResult;
  }

  // Step 2: DuckDuckGo Lite search fallback (always available, no API key needed)
  console.log('[backfill-websites] Claude returned ' + claudeResult.confidence + ' for "' + name + '", trying DuckDuckGo Lite fallback');

  // Try two search queries for better coverage
  const searchQuery = '"' + name + '"' + (locationParts ? ' ' + locationParts : '') + ' foundation official website';
  const searchResults = await duckduckgoSearch(searchQuery);

  if (searchResults.length === 0) {
    // Try a simpler query if the quoted search returned nothing
    const fallbackQuery = name + ' nonprofit website' + (state ? ' ' + state : '');
    const fallbackResults = await duckduckgoSearch(fallbackQuery);
    if (fallbackResults.length === 0) {
      console.log('[backfill-websites] No DuckDuckGo results for "' + name + '"');
      return claudeResult;
    }
    searchResults.push(...fallbackResults);
  }

  // Format search results for Claude
  const formattedResults = searchResults
    .map(
      (r, i) =>
        (i + 1) + '. URL: ' + r.url + '\n   Title: ' + r.title,
    )
    .join('\n\n');

  const evalPrompt =
    'I am looking for the official website of the nonprofit foundation: ' +
    name +
    locationHint +
    '\n\nHere are the top search results:\n\n' +
    formattedResults +
    '\n\nWhich of these URLs (if any) is the official website for this foundation?';

  // Rate-limit delay before second Claude call
  await sleep(200);

  const searchResult = await callClaude(SEARCH_EVAL_SYSTEM_PROMPT, evalPrompt);
  searchResult.source = 'ddg+claude';

  console.log(
    '[backfill-websites] Search fallback for "' + name + '": ' +
    (searchResult.url ?? 'null') + ' (' + searchResult.confidence + ')',
  );

  return searchResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ─── Build the priority query ─── */

function buildQuery(priority: string, batchSize: number): string {
  // Base filters: website is null, name is not null
  const base = 'website=is.null&name=not.is.null&select=ein,name,city,state';

  switch (priority) {
    case 'matched':
      // "matched" priority is handled separately via fetchMatchedFunders()
      // This fallback should not be reached, but return a safe default
      return base + '&limit=' + batchSize;

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

/**
 * Fetch funders that appear in project_matches or tracked_grants but
 * have no website yet. These are the funders users actually see, so
 * backfilling them first has the highest impact.
 */
async function fetchMatchedFunders(batchSize: number): Promise<Funder[]> {
  // Get distinct funder EINs from project_matches that don't have websites
  const matchedEins = (await restQuery(
    'project_matches',
    'select=funder_ein&limit=500',
  )) as Array<{ funder_ein: string }>;

  const trackedEins = (await restQuery(
    'tracked_grants',
    'select=funder_ein&limit=500',
  )) as Array<{ funder_ein: string }>;

  // Combine and deduplicate EINs
  const allEins = new Set<string>();
  for (const row of matchedEins) {
    if (row.funder_ein) allEins.add(row.funder_ein);
  }
  for (const row of trackedEins) {
    if (row.funder_ein) allEins.add(row.funder_ein);
  }

  if (allEins.size === 0) {
    return [];
  }

  // Fetch funders by these EINs that still need websites
  // Process in chunks to avoid URL length limits
  const einArray = Array.from(allEins);
  const chunkSize = 50;
  const funders: Funder[] = [];

  for (let i = 0; i < einArray.length && funders.length < batchSize; i += chunkSize) {
    const chunk = einArray.slice(i, i + chunkSize);
    const einFilter = 'ein=in.(' + chunk.map(e => encodeURIComponent(e)).join(',') + ')';
    const rows = (await restQuery(
      'funders',
      einFilter + '&website=is.null&name=not.is.null&select=ein,name,city,state&limit=' + (batchSize - funders.length),
    )) as Funder[];
    funders.push(...rows);
  }

  return funders.slice(0, batchSize);
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

    const priority = ['matched', 'tracked', 'top', 'all'].includes(body?.priority)
      ? body.priority
      : 'matched';

    // Fetch funders needing websites
    let funders: Funder[];
    if (priority === 'matched') {
      funders = await fetchMatchedFunders(batchSize);
      // If no matched funders need websites, fall back to tracked ordering
      if (funders.length === 0) {
        console.log('[backfill-websites] No matched funders need websites, falling back to tracked priority');
        funders = (await restQuery(
          'funders',
          buildQuery('tracked', batchSize),
        )) as Funder[];
      }
    } else {
      funders = (await restQuery(
        'funders',
        buildQuery(priority, batchSize),
      )) as Funder[];
    }

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
      source: string;
    }> = [];

    for (const funder of funders) {
      try {
        const lookup = await lookupWebsiteWithSearchFallback(funder.name, funder.city, funder.state);

        console.log(
          '[backfill-websites] ' + funder.name + ' -> ' + (lookup.url ?? 'null') +
          ' (' + lookup.confidence + ', ' + lookup.source + ')',
        );

        results.push({
          ein: funder.ein,
          name: funder.name,
          url: lookup.url,
          confidence: lookup.confidence,
          source: lookup.source,
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

      // Rate-limit delay between lookups
      await sleep(200);
    }

    const summary = {
      processed: funders.length,
      updated,
      skipped,
      errors,
      priority,
      web_search_enabled: true,
      results,
      message:
        'Processed ' + funders.length + ' funders: ' + updated + ' updated, ' +
        skipped + ' skipped (low/none confidence), ' + errors + ' errors.' +
        ' DuckDuckGo Lite search fallback enabled.',
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
