/**
 * suggest-peers - Supabase Edge Function (v11 - LLM-powered keyword expansion)
 *
 * Receives { mission, locationServed, budgetBand }.
 * Uses Claude Haiku to expand mission text into semantically related search
 * terms, then searches foundation_grants.purpose_text to find real peer
 * nonprofits with similar missions.
 *
 * v11 improvements over v10:
 * - LLM-powered keyword expansion: uses Claude Haiku to generate 12-15
 *   semantically related search terms from the mission description.
 *   This catches peers whose grant descriptions use different wording
 *   for similar work (e.g., "youth mentoring" instead of "STEM education").
 * - Falls back to rule-based extraction if LLM is unavailable
 * - Increased result limit to 10 peers (from 8)
 * - Multi-word phrase support: LLM can return 2-word phrases for precise matching
 * - Better scoring: LLM keywords weighted higher (15pts) vs fallback (10pts)
 *
 * Returns { peers: string[], debug?: {...} } — an array of 8-10 real nonprofit names.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

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
  'provide','providing','program','programs','services','service','support',
  'community','communities','organization','organizations','mission',
  'help','helps','helping','people','individuals','including','based',
  'area','areas','work','working','dedicated','committed','focus','focused',
  'focuses','serve','serving','served','across','within','offer','offering',
  'offers','ensure','promote','create','address','need','needs','access',
  'improve','improving','build','building','develop','developing',
  'desc','complex','use','achieve','achieving','highest','high','well',
  'serious','new','make','making','effort','efforts','range','able',
  'various','many','also','great','good','best','way','ways','like',
  'year','years','since','part','being','through','comprehensive',
  'potential','goal','goals','strive','striving','seek','seeking',
]);

/**
 * Use Claude Haiku to expand a mission description into semantically related
 * search terms that would appear in foundation grant purpose descriptions
 * for similar organizations.
 */
async function expandKeywordsWithLLM(
  mission: string,
  locationServed: string,
  budgetBand: string,
): Promise<{ terms: string[]; usedLLM: boolean }> {
  if (!ANTHROPIC_API_KEY) {
    console.log('[suggest-peers] No ANTHROPIC_API_KEY, falling back to rule-based extraction');
    return { terms: extractMissionKeywords(mission), usedLLM: false };
  }

  try {
    const prompt = `You are a nonprofit grant database search expert. I need to find PEER ORGANIZATIONS — nonprofits doing similar work — by searching a database of foundation grant purpose descriptions.

NONPROFIT MISSION: "${mission}"
${locationServed ? `LOCATION: ${locationServed}` : ''}
${budgetBand && budgetBand !== 'prefer_not_to_say' ? `BUDGET: ${budgetBand}` : ''}

Your task: generate 15-18 search terms that would appear in foundation grant PURPOSE TEXT for organizations doing SIMILAR work. These terms will be used as substring searches (SQL ilike '%term%') on grant purpose descriptions.

Think step by step:
1. What KIND of nonprofit is this? (e.g., youth development org, food bank, arts education, etc.)
2. What are 5-10 well-known organizations that do very similar work? Think of their names and what words would appear in grants TO those organizations.
3. What words do grant makers use when describing grants to these types of orgs?

Generate terms in these categories:
- ACTIVITY terms: what staff/volunteers do day-to-day (e.g., "mentoring", "tutoring", "counseling")
- BENEFICIARY terms: who is served, described multiple ways (e.g., "at-risk youth", "low-income", "underserved")
- METHOD terms: how the work is delivered (e.g., "after-school", "summer camp", "hands-on")
- FIELD terms: the sector of work (e.g., "youth development", "workforce", "literacy")
- OUTCOME terms: what the work achieves (e.g., "graduation", "college readiness", "leadership")
- LOCATION terms: the specific city/metro area if provided

CRITICAL RULES:
- Each term MUST be 1-3 words (for substring matching in grant descriptions)
- Use terms that literally appear in how grant makers DESCRIBE grants to these types of orgs
- AVOID generic words: "community", "program", "services", "support", "organization"
- MUST include the city name if location is provided
- Include BOTH specific terms (e.g., "robotics") AND broader category terms (e.g., "youth development")
- Think about what grant purpose text says: "To support [TERM]..." or "For [TERM]..."

Return ONLY a JSON array of strings, nothing else.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`[suggest-peers] LLM API error ${res.status}: ${err.substring(0, 200)}`);
      return { terms: extractMissionKeywords(mission), usedLLM: false };
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text || '';

    // Parse JSON array from response - handle markdown code blocks too
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      console.error('[suggest-peers] LLM response not parseable:', text.substring(0, 200));
      return { terms: extractMissionKeywords(mission), usedLLM: false };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { terms: extractMissionKeywords(mission), usedLLM: false };
    }

    // Clean and validate terms
    const terms = parsed
      .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length >= 2)
      .map((t: string) => t.trim().toLowerCase())
      .slice(0, 18);

    console.log(`[suggest-peers] LLM expanded to ${terms.length} terms:`, terms.join(', '));
    return { terms, usedLLM: true };
  } catch (err) {
    console.error('[suggest-peers] LLM expansion failed:', String(err));
    return { terms: extractMissionKeywords(mission), usedLLM: false };
  }
}

function stemWord(word: string): string {
  if (word.length <= 5) return word;
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

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  const scored = unique.map((w) => {
    const lengthScore = Math.min(w.length, 12);
    const freqScore = (freq.get(w) || 1) * 3;
    return { word: w, score: lengthScore + freqScore };
  });

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
  keywordWeightSum: number;
  cityMatch: boolean;
  displayName: string;
}

const GENERALIST_PATTERNS = [
  /\bUNIVERSIT/i,
  /\bHOSPITAL\b/i,
  /\bMEDICAL CENTER/i,
  /\bMEDICAL SCHOOL/i,
  /\bSCHOOL OF MEDICINE/i,
  /\bCOLLEGE\b/i,
  /\bFRED HUTCH/i,
  /\bCANCER (CENTER|RESEARCH)/i,
  /\bCHILDREN'?S\b/i,
  /\bSCHOOL DISTRICT\b/i,
  /\bPUBLIC SCHOOL/i,
  /\bBOARD OF EDUCATION/i,
  // Intermediaries/funders that appear as grantees but aren't peer service orgs
  /\bUNITED WAY\b/i,
  /\bCOMMUNITY FOUNDATION\b/i,
  /\bJEWISH FEDERATION/i,
  /\bCATHOLIC CHARIT/i,
  /\bSALVATION ARMY/i,
  /\bYMCA\b/i,
  /\bYWCA\b/i,
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
    const budgetBand = typeof body?.budgetBand === 'string' ? body.budgetBand.trim() : 'prefer_not_to_say';

    if (!mission) {
      return new Response(
        JSON.stringify({ error: 'mission is required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Step 1: Use LLM to expand mission into semantically related search terms
    const { terms: searchTerms, usedLLM } = await expandKeywordsWithLLM(
      mission, locationServed, budgetBand,
    );

    const llmTime = Date.now() - startTime;
    console.log(`[suggest-peers] Keyword expansion (${usedLLM ? 'LLM' : 'rule-based'}) in ${llmTime}ms: ${searchTerms.join(', ')}`);

    if (searchTerms.length === 0) {
      return new Response(
        JSON.stringify({ peers: [], debug: { keywords: [], candidates: 0 } }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    let { city, state } = parseLocation(locationServed);

    // Also extract city names from mission text if not provided in locationServed
    // This handles cases like "STEM programs in Chicago" where locationServed is just "IL"
    if (!city) {
      const MAJOR_CITIES = [
        'chicago','new york','los angeles','houston','phoenix','philadelphia',
        'san antonio','san diego','dallas','san jose','austin','jacksonville',
        'fort worth','columbus','charlotte','indianapolis','san francisco',
        'seattle','denver','washington','nashville','oklahoma city','el paso',
        'boston','portland','las vegas','memphis','louisville','baltimore',
        'milwaukee','albuquerque','tucson','fresno','mesa','sacramento',
        'atlanta','kansas city','colorado springs','omaha','raleigh','miami',
        'long beach','virginia beach','oakland','minneapolis','tulsa','tampa',
        'arlington','new orleans','cleveland','pittsburgh','detroit','st louis',
        'cincinnati','orlando','newark','brooklyn','bronx','queens','manhattan',
      ];
      const missionLower = mission.toLowerCase();
      for (const c of MAJOR_CITIES) {
        if (missionLower.includes(c)) {
          city = c.charAt(0).toUpperCase() + c.slice(1);
          // Handle multi-word cities
          if (c.includes(' ')) {
            city = c.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          }
          break;
        }
      }
    }

    console.log(`[suggest-peers] Location: city="${city}", state="${state}"`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Step 2: Search grant purpose text for each term
    // For multi-word terms, search as exact phrase; for single words, apply stemming
    const preparedTerms = searchTerms.map((term) => {
      const words = term.split(/\s+/);
      if (words.length > 1) {
        // Multi-word phrase: use as-is for exact matching
        return { original: term, searchTerm: term };
      }
      // Single word: apply stemming
      return { original: term, searchTerm: stemWord(term) };
    });

    async function runKeywordQuery(original: string, searchTerm: string) {
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

    // Run queries in batches of 3 (LLM terms are more targeted, less DB load per query)
    const BATCH_SIZE = 3;
    const results: Array<{ keyword: string; rows: Array<{ grantee_name: string; grantee_city: string }>; rowCount: number; error: string | null }> = [];

    for (let i = 0; i < preparedTerms.length; i += BATCH_SIZE) {
      const batch = preparedTerms.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(({ original, searchTerm }) => runKeywordQuery(original, searchTerm))
      );
      results.push(...batchResults);
    }

    const queryTime = Date.now() - startTime;
    console.log(`[suggest-peers] All ${preparedTerms.length} queries completed in ${queryTime}ms`);

    // Step 3: Aggregate results
    const peerMap = new Map<string, PeerData>();
    // Weight per keyword match: LLM terms are more targeted so get higher weight
    const KW_WEIGHT = usedLLM ? 15 : 10;

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
        if (rawName.length > entry.displayName.length) {
          entry.displayName = rawName;
        }
        if (!entry.matchedKeywords.has(keyword)) {
          entry.matchedKeywords.add(keyword);
          entry.keywordWeightSum += 1;
        }
        if (city && (row.grantee_city || '').toUpperCase().includes(city.toUpperCase())) {
          entry.cityMatch = true;
        }
      }
    }

    // Step 4: Score and rank
    // City bonus is high (30pts) to strongly prefer local organizations
    const scoredPeers = [...peerMap.entries()].map(([name, data]) => {
      const kwCount = data.matchedKeywords.size;
      const kwScore = kwCount * KW_WEIGHT;
      const cityBonus = data.cityMatch ? 30 : 0;
      const grantBonus = Math.min(data.count, 25);

      const isGeneralist = GENERALIST_PATTERNS.some(p => p.test(name));
      const score = isGeneralist ? -1 : kwScore + cityBonus + grantBonus;

      return { name: data.displayName, normKey: name, score, kwCount,
               count: data.count, cityMatch: data.cityMatch,
               weightSum: data.keywordWeightSum, isGeneralist };
    });

    scoredPeers.sort((a, b) => b.score - a.score || b.count - a.count);

    console.log(`[suggest-peers] ${scoredPeers.length} candidates found`);
    if (scoredPeers.length > 0) {
      console.log('[suggest-peers] Top 15:', scoredPeers.slice(0, 15).map(p =>
        `${p.name} (kw=${p.kwCount}, grants=${p.count}, city=${p.cityMatch}, gen=${p.isGeneralist}, score=${p.score.toFixed(1)})`
      ).join(' | '));
    }

    // Step 5: Deduplicate and format
    const seen = new Set<string>();
    const peers: string[] = [];

    for (const row of scoredPeers) {
      if (peers.length >= 10) break;
      if (row.kwCount < 1) continue;
      if (row.score < 0) continue;

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

    const debug = {
      usedLLM,
      keywords: preparedTerms.map(t => t.original === t.searchTerm ? t.original : `${t.original}→${t.searchTerm}`),
      queryResults: results.map(r => ({ keyword: r.keyword, rows: r.rowCount, error: r.error })),
      candidates: scoredPeers.length,
      topCandidates: scoredPeers.slice(0, 15).map(p => ({
        name: p.name, kwCount: p.kwCount, weightSum: +p.weightSum.toFixed(2),
        grants: p.count, cityMatch: p.cityMatch, isGeneralist: p.isGeneralist,
        score: +p.score.toFixed(1),
      })),
      llmTimeMs: llmTime,
      queryTimeMs: queryTime - llmTime,
      totalTimeMs: totalTime,
    };

    return new Response(JSON.stringify({ peers, debug }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[suggest-peers] Unhandled error:', String(err));
    console.error('[suggest-peers] Stack:', (err as Error)?.stack || 'no stack');
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
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
