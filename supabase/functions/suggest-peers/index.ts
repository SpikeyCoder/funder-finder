/**
 * suggest-peers - Supabase Edge Function (v10 - simple equal scoring, no IDF)
 *
 * Receives { mission, locationServed, budgetBand }.
 * Uses the foundation_grants database to find real peer nonprofits that
 * share similar mission keywords and geographic proximity.
 *
 * v8 improvements over v7:
 * - Name normalization BEFORE aggregation: strips common suffixes (INC, LLC,
 *   GROUP, FOUNDATION, etc.) so "Plymouth Housing Group" and "Plymouth Housing"
 *   merge into one entity with combined keyword matches and grant counts.
 * - Increased city bonus (10) and grant bonus cap (20) to better reward
 *   local organizations with strong grant histories.
 * - Removed IDF weighting (capped LIMIT flattens IDF distribution, hurting
 *   orgs that match common-but-relevant keywords like "homeless" and "housing")
 * - Simple equal keyword weighting: each keyword match = 10 points
 * - Generalist institution exclusion (hospitals, universities, etc.)
 * - Batched queries (2 at a time) to avoid DB statement timeouts
 * - Basic stemming for better ilike matching
 * - Expanded stop words, keyword relevance scoring, debug info
 *
 * Returns { peers: string[], debug?: {...} } — an array of 5-8 real nonprofit names.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
  'http://localhost:5173',
]);

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : 'https://fundermatch.org';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

const STOP_WORDS = new Set([
  // Common English
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','shall','should','may','might',
  'can','could','that','which','who','whom','this','these','those','it',
  'its','we','our','us','they','their','them','he','she','his','her',
  'not','no','nor','so','as','if','than','then','too','very','just',
  'about','also','into','over','such','through','during','before','after',
  'above','below','between','under','again','further','once','here',
  'there','when','where','why','how','all','each','every','both','few',
  'more','most','other','some','any','only','own','same','up','down',
  'out','off','while','because','until','what',
  // Nonprofit/mission boilerplate
  'provide','providing','program','programs','services','service','support',
  'community','communities','organization','organizations','mission',
  'help','helps','helping','people','individuals','including','based',
  'area','areas','work','working','dedicated','committed','focus','focused',
  'focuses','serve','serving','served','across','within','offer','offering',
  'offers','ensure','promote','create','address','need','needs','access',
  'improve','improving','build','building','develop','developing',
  // Generic/low-value words that waste query slots
  'desc','complex','use','achieve','achieving','highest','high','well',
  'serious','new','make','making','effort','efforts','range','able',
  'various','many','also','great','good','best','way','ways','like',
  'year','years','since','part','being','through','comprehensive',
  'potential','goal','goals','strive','striving','seek','seeking',
]);

/**
 * Basic English stemmer - strips common suffixes to get root forms.
 * This helps ilike queries match more variations in purpose_text.
 * e.g., "homelessness" → "homeless", "disorders" → "disorder", "treatment" → "treat"
 */
function stemWord(word: string): string {
  // Don't stem short words
  if (word.length <= 5) return word;

  // Order matters: try longest suffixes first
  const suffixes = [
    { suffix: 'nesses', minRoot: 4 },
    { suffix: 'ments', minRoot: 4 },
    { suffix: 'ness', minRoot: 4 },
    { suffix: 'ment', minRoot: 4 },
    { suffix: 'tion', minRoot: 3 },
    { suffix: 'sion', minRoot: 3 },
    { suffix: 'ious', minRoot: 3 },
    { suffix: 'eous', minRoot: 3 },
    { suffix: 'able', minRoot: 3 },
    { suffix: 'ible', minRoot: 3 },
    { suffix: 'ings', minRoot: 3 },
    { suffix: 'ors', minRoot: 4 },
    { suffix: 'ers', minRoot: 4 },
    { suffix: 'ing', minRoot: 3 },
    { suffix: 'ive', minRoot: 3 },
    { suffix: 'ous', minRoot: 3 },
  ];

  for (const { suffix, minRoot } of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= minRoot) {
      return word.slice(0, word.length - suffix.length);
    }
  }

  // Strip trailing 's' for plurals (but not 'ss' like "illness")
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) {
    return word.slice(0, -1);
  }

  return word;
}

function extractMissionKeywords(mission: string): string[] {
  const words = mission
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  // Deduplicate
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }

  // Score keywords by relevance:
  // - Longer words are more specific/useful (bonus for length)
  // - Words that appear multiple times get a frequency boost
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  const scored = unique.map((w) => {
    const lengthScore = Math.min(w.length, 12); // longer = more specific
    const freqScore = (freq.get(w) || 1) * 3;
    return { word: w, score: lengthScore + freqScore };
  });

  // Sort by score descending, then alphabetically for stability
  scored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));

  return scored.map((s) => s.word).slice(0, 8);
}

function parseLocation(locationServed: string): { city: string; state: string } {
  const STATE_ABBREVS: Record<string, string> = {
    alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',
    colorado:'CO',connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',
    hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',
    kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',
    michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',
    nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ',
    'new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',
    ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI',
    'south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',
    utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',
    wisconsin:'WI',wyoming:'WY','district of columbia':'DC',
  };
  const VALID_STATES = new Set(Object.values(STATE_ABBREVS));

  const parts = locationServed.split(',').map((p) => p.trim());
  let city = '';
  let state = '';

  if (parts.length >= 2) {
    city = parts[0];
    const stateRaw = parts[parts.length - 1].replace(/\d+/g, '').trim();
    if (stateRaw.length === 2 && VALID_STATES.has(stateRaw.toUpperCase())) {
      state = stateRaw.toUpperCase();
    } else if (STATE_ABBREVS[stateRaw.toLowerCase()]) {
      state = STATE_ABBREVS[stateRaw.toLowerCase()];
    }
  } else if (parts.length === 1) {
    const val = parts[0].trim();
    if (val.length === 2 && VALID_STATES.has(val.toUpperCase())) {
      state = val.toUpperCase();
    } else if (STATE_ABBREVS[val.toLowerCase()]) {
      state = STATE_ABBREVS[val.toLowerCase()];
    } else {
      city = val;
    }
  }

  return { city, state };
}

/**
 * Normalize a grantee name by stripping common legal suffixes.
 * This merges variant names (e.g. "PLYMOUTH HOUSING GROUP" and
 * "PLYMOUTH HOUSING") into a single entity for aggregation.
 */
function normalizeGranteeName(name: string): string {
  return name
    .toUpperCase()
    .trim()
    .replace(/\s+(INC\.?|LLC|CORP\.?|GROUP|AND SUBSIDIARIES|CO\.?|ASSOCIATION|ASSOC\.?|OF AMERICA)\s*$/i, '')
    .trim();
}

interface PeerData {
  count: number;
  matchedKeywords: Set<string>;
  keywordWeightSum: number;  // sum of IDF-like weights for matched keywords
  cityMatch: boolean;
  displayName: string;  // best display name (longest variant seen)
}

/**
 * Patterns that indicate generalist institutions (hospitals, universities,
 * medical centers) which match many keywords but aren't true peer nonprofits
 * for mission-specific searches.
 */
const GENERALIST_PATTERNS = [
  /\bUNIVERSIT/i,
  /\bHOSPITAL\b/i,
  /\bMEDICAL CENTER/i,
  /\bMEDICAL SCHOOL/i,
  /\bSCHOOL OF MEDICINE/i,
  /\bCOLLEGE\b/i,
  /\bFRED HUTCH/i,
  /\bCANCER (CENTER|RESEARCH)/i,
  /\bCHILDREN'?S\b/i,  // e.g. Seattle Children's (hospital system)
];

Deno.serve(async (req: Request) => {
  const requestOrigin = req.headers.get('origin');
  const headers = corsHeaders(requestOrigin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers });
  }

  try {
    const startTime = Date.now();
    console.log('[suggest-peers] Processing request...');

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const mission = typeof body?.mission === 'string' ? body.mission.trim() : '';
    const locationServed = typeof body?.locationServed === 'string' ? body.locationServed.trim() : '';

    if (!mission) {
      return new Response(
        JSON.stringify({ error: 'mission is required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const keywords = extractMissionKeywords(mission);
    console.log('[suggest-peers] Keywords:', keywords.join(', '));

    if (keywords.length === 0) {
      return new Response(
        JSON.stringify({ peers: [], debug: { keywords: [], candidates: 0 } }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const { city, state } = parseLocation(locationServed);
    console.log(`[suggest-peers] Location: city="${city}", state="${state}"`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // === PARALLEL queries for ALL keywords ===
    // Apply basic stemming to each keyword for better ilike matching
    const searchTerms = keywords.map((kw) => ({
      original: kw,
      stemmed: stemWord(kw),
    }));

    console.log('[suggest-peers] Search terms:', searchTerms.map(t =>
      t.original === t.stemmed ? t.original : `${t.original}→${t.stemmed}`
    ).join(', '));

    // Run a single keyword query
    async function runKeywordQuery(original: string, stemmed: string) {
      const searchTerm = stemmed;

      let query = supabase
        .from('foundation_grants')
        .select('grantee_name, grantee_city')
        .ilike('purpose_text', `%${searchTerm}%`)
        .not('purpose_text', 'is', null)
        .gte('grant_year', 2019)
        .limit(500);

      if (state) {
        query = query.ilike('grantee_state', state);
      }

      const { data, error } = await query;
      if (error) {
        console.error(`[suggest-peers] Query error for "${searchTerm}":`, error.message);
        return { keyword: original, rows: [] as Array<{ grantee_name: string; grantee_city: string }>, rowCount: 0, error: error.message };
      }
      const rows = (data || []) as Array<{ grantee_name: string; grantee_city: string }>;
      console.log(`[suggest-peers] "${original}" (search: "${searchTerm}"): ${rows.length} rows`);
      return { keyword: original, rows, rowCount: rows.length, error: null };
    }

    // Run queries in batches of 2 to avoid overwhelming the DB
    // (8 parallel ilike queries cause statement timeouts on large tables)
    const BATCH_SIZE = 2;
    const results: Array<{ keyword: string; rows: Array<{ grantee_name: string; grantee_city: string }>; rowCount: number; error: string | null }> = [];

    for (let i = 0; i < searchTerms.length; i += BATCH_SIZE) {
      const batch = searchTerms.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(({ original, stemmed }) => runKeywordQuery(original, stemmed))
      );
      results.push(...batchResults);
    }

    const queryTime = Date.now() - startTime;
    console.log(`[suggest-peers] All ${searchTerms.length} queries completed in ${queryTime}ms`);

    // Single-pass aggregation: build peerMap with keyword tracking
    // Names are normalized BEFORE aggregation so variants like
    // "PLYMOUTH HOUSING GROUP" and "PLYMOUTH HOUSING" merge together.
    const peerMap = new Map<string, PeerData>();

    for (const { keyword, rows } of results) {
      for (const row of rows) {
        const rawName = (row.grantee_name || '').trim();
        if (!rawName || rawName.length < 3) continue;

        const key = normalizeGranteeName(rawName);
        if (!key || key.length < 3) continue;

        let entry = peerMap.get(key);
        if (!entry) {
          entry = { count: 0, matchedKeywords: new Set(), keywordWeightSum: 0, cityMatch: false, displayName: rawName };
          peerMap.set(key, entry);
        }
        entry.count += 1;
        // Keep the longest variant as the display name
        if (rawName.length > entry.displayName.length) {
          entry.displayName = rawName;
        }
        if (!entry.matchedKeywords.has(keyword)) {
          entry.matchedKeywords.add(keyword);
          entry.keywordWeightSum += 1; // equal weight per keyword
        }
        if (city && (row.grantee_city || '').toUpperCase().includes(city.toUpperCase())) {
          entry.cityMatch = true;
        }
      }
    }

    // Score and sort: simple formula that rewards keyword matches,
    // city proximity, and grant count equally weighted.
    // Each keyword match = 10 pts, city match = 10 pts, grants capped at 20 pts
    const scoredPeers = [...peerMap.entries()].map(([name, data]) => {
      const kwCount = data.matchedKeywords.size;
      const kwScore = kwCount * 10;
      const cityBonus = data.cityMatch ? 10 : 0;
      const grantBonus = Math.min(data.count, 20);

      // Exclude generalist institutions entirely - they match many keywords
      // due to broad research/service portfolios but aren't true peer nonprofits
      const isGeneralist = GENERALIST_PATTERNS.some(p => p.test(name));

      const score = isGeneralist ? -1 : kwScore + cityBonus + grantBonus;
      return { name: data.displayName, normKey: name, score, kwCount,
               count: data.count, cityMatch: data.cityMatch,
               weightSum: data.keywordWeightSum, isGeneralist };
    });

    scoredPeers.sort((a, b) => b.score - a.score || b.count - a.count);

    console.log(`[suggest-peers] ${scoredPeers.length} candidates found`);
    if (scoredPeers.length > 0) {
      console.log('[suggest-peers] Top 10:', scoredPeers.slice(0, 10).map(p =>
        `${p.name} (kw=${p.kwCount}, wt=${p.weightSum.toFixed(1)}, grants=${p.count}, city=${p.cityMatch}, gen=${p.isGeneralist}, score=${p.score.toFixed(1)})`
      ).join(' | '));
    }

    // Deduplicate similar names and format
    // Names are already normalized as aggregation keys, so dedup uses normKey
    const seen = new Set<string>();
    const peers: string[] = [];

    for (const row of scoredPeers) {
      if (peers.length >= 8) break;
      if (row.kwCount < 1) continue;
      if (row.score < 0) continue;  // skip excluded generalists

      const normKey = row.normKey.replace(/[^A-Z0-9\s]/g, '').trim();
      if (!normKey || normKey.length < 3) continue;

      let isDupe = false;
      for (const s of seen) {
        if (s.includes(normKey) || normKey.includes(s)) {
          isDupe = true;
          break;
        }
      }
      if (isDupe) continue;
      seen.add(normKey);

      // Title-case for display using the best display name
      const displayName = row.name
        .split(/\s+/)
        .map((w: string) => {
          if (w.length <= 3 && w === w.toUpperCase()) return w;
          return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        })
        .join(' ');

      peers.push(displayName);
    }

    const totalTime = Date.now() - startTime;
    console.log(`[suggest-peers] Returning ${peers.length} peers in ${totalTime}ms:`, peers.join(', '));

    // Include debug info for diagnostics
    const debug = {
      keywords: searchTerms.map(t => t.original === t.stemmed ? t.original : `${t.original}→${t.stemmed}`),
      queryResults: results.map(r => ({ keyword: r.keyword, rows: r.rowCount, error: r.error })),
      candidates: scoredPeers.length,
      topCandidates: scoredPeers.slice(0, 10).map(p => ({
        name: p.name, kwCount: p.kwCount, weightSum: +p.weightSum.toFixed(2),
        grants: p.count, cityMatch: p.cityMatch, isGeneralist: p.isGeneralist,
        score: +p.score.toFixed(1),
      })),
      queryTimeMs: queryTime,
      totalTimeMs: totalTime,
    };

    return new Response(JSON.stringify({ peers, debug }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[suggest-peers] Unhandled error:', String(err));
    console.error('[suggest-peers] Stack:', (err as Error)?.stack || 'no stack');
    return new Response(
      JSON.stringify({ error: 'Internal server error', detail: String(err) }),
      {
        status: 500,
        headers: {
          ...corsHeaders(req.headers.get('origin')),
          'Content-Type': 'application/json',
        },
      },
    );
  }
});
