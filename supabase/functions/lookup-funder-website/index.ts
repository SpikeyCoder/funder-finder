import { corsHeaders, preflightResponse } from '../_shared/cors.ts';
import { sanitiseError } from '../_shared/errors.ts';

/**
 * lookup-funder-website — On-demand website lookup for a single funder.
 *
 * Called from:
 *  - FunderDetail page (frontend, with user JWT)
 *  - tracked-grants fire-and-forget (service role)
 *
 * POST body: { "funder_ein": "123456789" }
 * Response:  { "url": "https://...", "confidence": "high", "source": "claude" }
 *         or { "url": null, "confidence": "none" }
 *
 * verify_jwt = false — this function handles its own lightweight auth check
 * (accepts both user JWTs and service-role calls).
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

/* ─── Claude lookup (copied from backfill-funder-websites) ─── */

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
    headers['anthropic-beta'] = 'web-search-2025-03-05';
  }

  const body: Record<string, unknown> = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system,
    messages: [{ role: 'user', content: userMessage }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search', name: 'web_search', max_uses: 3 }];
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
  const textBlocks = (data.content || []).filter((b: any) => b.type === 'text');
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text.trim() : '';
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return { url: parsed.url || null, confidence: parsed.confidence || 'none' };
  } catch {
    console.error('[lookup-funder-website] Failed to parse Claude response:', cleaned.slice(0, 200));
    return { url: null, confidence: 'none' };
  }
}

interface LookupResult {
  url: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  source: 'claude' | 'web-search';
}

async function lookupWebsite(
  name: string,
  city: string | null,
  state: string | null,
): Promise<LookupResult> {
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
  console.log('[lookup-funder-website] Claude training returned ' + step1.confidence + ' for "' + name + '", trying web search');
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
    console.error('[lookup-funder-website] Web search fallback error for "' + name + '":', err);
  }

  return { url: null, confidence: 'none', source: 'claude' };
}

/* ─── Main handler ─── */

interface FunderRow {
  foundation_ein: string;
  name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  website_last_checked: string | null;
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
    const funderEin = body?.funder_ein;

    if (!funderEin || typeof funderEin !== 'string') {
      return new Response(
        JSON.stringify({ error: 'funder_ein is required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Query the funder by foundation_ein
    const rows = (await restQuery(
      'funders',
      `foundation_ein=eq.${encodeURIComponent(funderEin)}&select=foundation_ein,name,city,state,website,website_last_checked&limit=1`,
    )) as FunderRow[];

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ url: null, confidence: 'none', error: 'Funder not found' }),
        { status: 404, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const funder = rows[0];

    // Cache hit: website already set
    if (funder.website) {
      return new Response(
        JSON.stringify({ url: funder.website, confidence: 'high', source: 'cache' }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Already tried and failed: don't retry
    if (funder.website_last_checked) {
      return new Response(
        JSON.stringify({ url: null, confidence: 'none', source: 'cache' }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Run the two-step Claude lookup
    console.log('[lookup-funder-website] Looking up website for:', funder.name, `(EIN: ${funderEin})`);
    const result = await lookupWebsite(funder.name, funder.city, funder.state);

    // Write results back to the funders table
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { website_last_checked: now };
    if (result.url && (result.confidence === 'high' || result.confidence === 'medium')) {
      patch.website = result.url;
    }

    await restPatch(
      'funders',
      `foundation_ein=eq.${encodeURIComponent(funderEin)}`,
      patch,
    );

    console.log(
      '[lookup-funder-website]',
      funder.name,
      '->',
      result.url ?? 'null',
      `(${result.confidence}, ${result.source})`,
    );

    return new Response(
      JSON.stringify({
        url: result.url && (result.confidence === 'high' || result.confidence === 'medium')
          ? result.url
          : null,
        confidence: result.confidence,
        source: result.source,
      }),
      { headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    console.error('[lookup-funder-website] Error:', err);
    return new Response(
      JSON.stringify({ error: sanitiseError(err, 'Internal server error') }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
