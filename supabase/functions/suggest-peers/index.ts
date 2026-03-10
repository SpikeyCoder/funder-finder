/**
 * suggest-peers - Supabase Edge Function (v3 - database-driven)
 *
 * Receives { mission, locationServed, budgetBand }.
 * Uses the foundation_grants database to find real peer nonprofits that
 * share similar mission keywords and geographic proximity.
 *
 * Returns { peers: string[] } — an array of 5-8 real nonprofit names.
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
  'out','off','while','because','until','what','provide','providing',
  'program','programs','services','service','support','community',
  'communities','organization','organizations','mission','help','people',
  'individuals','including','based','area','areas','work','working',
  'dedicated','committed','focus','focused','focuses','serve','serving',
  'served','across','within','offer','offering','offers',
  'ensure','promote','create','address','need','needs','access',
  'improve','improving','build','building','develop','developing',
]);

function extractMissionKeywords(mission: string): string[] {
  const words = mission
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 8);
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

Deno.serve(async (req: Request) => {
  const requestOrigin = req.headers.get('origin');
  const headers = corsHeaders(requestOrigin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers });
  }

  try {
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
        JSON.stringify({ peers: [] }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const { city, state } = parseLocation(locationServed);
    console.log(`[suggest-peers] Location: city="${city}", state="${state}"`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Query for each keyword separately and aggregate results
    const peerMap = new Map<string, { count: number; keywords: number; cityMatch: boolean }>();
    const topKeywords = keywords.slice(0, 5);

    for (const kw of topKeywords) {
      let query = supabase
        .from('foundation_grants')
        .select('grantee_name, grantee_city')
        .ilike('purpose_text', `%${kw}%`)
        .not('purpose_text', 'is', null)
        .gte('grant_year', 2019)
        .limit(400);

      if (state) {
        query = query.ilike('grantee_state', state);
      }

      const { data, error } = await query;
      if (error) {
        console.error(`[suggest-peers] Query error for keyword "${kw}":`, error.message);
        continue;
      }

      if (data) {
        for (const row of data) {
          const rawName = (row.grantee_name || '').trim();
          if (!rawName || rawName.length < 3) continue;
          const key = rawName.toUpperCase();
          const existing = peerMap.get(key) || { count: 0, keywords: 0, cityMatch: false };
          existing.count += 1;
          // Track unique keyword matches by using a Set approach
          // Simple: just increment keywords for each new keyword round
          if (existing.count === 1 || kw === topKeywords[0]) {
            // First time seeing this name in this keyword round
          }
          if (city && (row.grantee_city || '').toUpperCase().includes(city.toUpperCase())) {
            existing.cityMatch = true;
          }
          peerMap.set(key, existing);
        }
      }
    }

    // Better keyword counting: re-scan to count distinct keyword matches
    // Reset and do a proper count
    const peerKeywordCount = new Map<string, Set<string>>();
    for (const kw of topKeywords) {
      let query = supabase
        .from('foundation_grants')
        .select('grantee_name')
        .ilike('purpose_text', `%${kw}%`)
        .not('purpose_text', 'is', null)
        .gte('grant_year', 2019)
        .limit(400);

      if (state) {
        query = query.ilike('grantee_state', state);
      }

      const { data } = await query;
      if (data) {
        for (const row of data) {
          const key = (row.grantee_name || '').trim().toUpperCase();
          if (!key) continue;
          if (!peerKeywordCount.has(key)) peerKeywordCount.set(key, new Set());
          peerKeywordCount.get(key)!.add(kw);
        }
      }
    }

    // Build final scored list
    const scoredPeers = [...peerMap.entries()].map(([name, data]) => {
      const kwCount = peerKeywordCount.get(name)?.size || 0;
      const cityBonus = data.cityMatch ? 3 : 0;
      const grantBonus = Math.min(data.count, 15);
      const score = kwCount * 4 + cityBonus + grantBonus;
      return { name, score, kwCount, count: data.count, cityMatch: data.cityMatch };
    });

    scoredPeers.sort((a, b) => b.score - a.score || b.count - a.count);

    console.log(`[suggest-peers] ${scoredPeers.length} candidates found`);

    // Deduplicate similar names and format
    const seen = new Set<string>();
    const peers: string[] = [];

    for (const row of scoredPeers) {
      if (peers.length >= 8) break;
      if (row.kwCount < 1) continue;

      const normKey = row.name
        .replace(/\s+(INC|LLC|CORP|GROUP|AND SUBSIDIARIES|FOUNDATION)\s*$/i, '')
        .replace(/[^A-Z0-9\s]/g, '')
        .trim();

      let isDupe = false;
      for (const s of seen) {
        if (s.includes(normKey) || normKey.includes(s)) {
          isDupe = true;
          break;
        }
      }
      if (isDupe) continue;
      seen.add(normKey);

      // Title-case for display
      const displayName = row.name
        .split(/\s+/)
        .map((w: string) => {
          if (w.length <= 3 && w === w.toUpperCase()) return w;
          return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        })
        .join(' ');

      peers.push(displayName);
    }

    console.log('[suggest-peers] Returning', peers.length, 'peers:', peers.join(', '));

    return new Response(JSON.stringify({ peers }), {
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
