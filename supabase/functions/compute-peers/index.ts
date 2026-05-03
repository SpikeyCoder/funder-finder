/**
 * compute-peers v14 — Supabase Edge Function
 *
 * Finds similar organizations using the nonprofit's OWN data:
 *   1. NTEE code from recipient_organizations (populated from ProPublica)
 *   2. Organization name keyword analysis
 *   3. Geographic proximity
 *   4. Scale similarity
 *
 * ★ DOES NOT USE funder-provided purpose_text. Mission matching is based
 *   entirely on the nonprofit's own NTEE classification and name.
 *
 * Input:  { entityType: 'funder'|'recipient', entityId: string }
 * Output: { peers: PeerEntry[] }
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'http://localhost:5173',
]);

const MAX_PEERS = 10;
const RECENT_YEARS = 5;
const MIN_SHARED = 2;

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

async function restPatch(table: string, params: string, body: Record<string, unknown>): Promise<void> {
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

// ── ProPublica NTEE Lookup (fallback when DB doesn't have it yet) ───────
async function fetchNteeCode(ein: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.organization?.ntee_code || null;
  } catch {
    return null;
  }
}

// ── NTEE Classification System ──────────────────────────────────────────

// NTEE major letter descriptions (for logging/debugging)
const NTEE_MAJOR: Record<string, string> = {
  A: 'Arts/Culture', B: 'Education', C: 'Environment', D: 'Animals',
  E: 'Health', F: 'Mental Health/Crisis', G: 'Disease/Disorders',
  H: 'Medical Research', I: 'Crime/Legal', J: 'Employment',
  K: 'Food/Agriculture', L: 'Housing/Shelter', M: 'Public Safety',
  N: 'Recreation', O: 'Youth Development', P: 'Human Services',
  Q: 'International', R: 'Civil Rights', S: 'Community Improvement',
  T: 'Philanthropy', U: 'Science', V: 'Social Science',
  W: 'Public/Society', X: 'Religion', Y: 'Mutual/Membership', Z: 'Unknown',
};

// Which NTEE major letters are closely related in mission
// These represent orgs that serve overlapping populations or complementary services
const NTEE_RELATED: Record<string, string[]> = {
  F: ['L', 'P', 'E', 'I'],       // Mental Health ↔ Housing, Human Services, Health, Crime/Legal
  L: ['F', 'P', 'M', 'S'],       // Housing ↔ Mental Health, Human Services, Safety, Community
  P: ['F', 'L', 'K', 'O', 'J', 'M', 'I'], // Human Services ↔ many
  E: ['F', 'G', 'H'],            // Health ↔ Mental Health, Diseases, Medical Research
  K: ['P'],                       // Food ↔ Human Services
  M: ['L', 'P'],                  // Public Safety ↔ Housing, Human Services
  O: ['B', 'P'],                  // Youth ↔ Education, Human Services
  B: ['O', 'J'],                  // Education ↔ Youth, Employment
  I: ['R', 'P', 'F'],            // Crime/Legal ↔ Civil Rights, Human Services, Mental Health
  R: ['I', 'P'],                  // Civil Rights ↔ Crime/Legal, Human Services
  J: ['P', 'B'],                  // Employment ↔ Human Services, Education
  G: ['E', 'H'],                  // Diseases ↔ Health, Medical Research
  H: ['E', 'G'],                  // Medical Research ↔ Health, Diseases
  S: ['L', 'P'],                  // Community Improvement ↔ Housing, Human Services
};

// Subcategory-level cross-letter relationships
// These capture when a specific NTEE subcategory is closely related to
// a DIFFERENT major letter's mission area.  e.g. F3xx = "Residential
// Custodial Care" is essentially HOUSING even though F = Mental Health.
const NTEE_SUBCATEGORY_CROSS: Record<string, Record<string, number>> = {
  'F3': { 'L': 0.90 },   // F3 Residential Care ↔ L Housing — nearly identical mission
  'L4': { 'F': 0.85, 'P': 0.80 },  // L4 Temporary Shelter ↔ F Mental Health, P Human Services
  'P3': { 'F': 0.75, 'L': 0.75 },  // P3 Family Services ↔ F Mental Health, L Housing
  'P8': { 'L': 0.70 },   // P8 Ethnic/Immigrant ↔ L Housing (overlap in refugee services)
  'P6': { 'K': 0.85 },   // P6 Emergency Assistance ↔ K Food
};

// Score NTEE similarity between two codes
function nteeScore(sourceCode: string, candidateCode: string): number {
  if (!sourceCode || !candidateCode) return 0;
  if (sourceCode === 'UNKNOWN' || candidateCode === 'UNKNOWN') return 0;

  const srcUpper = sourceCode.toUpperCase();
  const candUpper = candidateCode.toUpperCase();
  const srcMajor = srcUpper.charAt(0);
  const candMajor = candUpper.charAt(0);

  // Exact same NTEE code = perfect match
  if (srcUpper === candUpper) return 1.0;

  // Same subcategory (first 2 chars, e.g., F3 and F3)
  if (srcUpper.length >= 2 && candUpper.length >= 2) {
    const srcSub = srcUpper.substring(0, 2);
    const candSub = candUpper.substring(0, 2);
    if (srcSub === candSub) return 0.95;
  }

  // ★ Subcategory cross-letter relationships (e.g., F3 ↔ L = 0.90)
  // This is KEY: F300 (Residential Care) should match L (Housing) at 0.90
  if (srcUpper.length >= 2) {
    const srcSub = srcUpper.substring(0, 2);
    const crossMap = NTEE_SUBCATEGORY_CROSS[srcSub];
    if (crossMap && crossMap[candMajor] !== undefined) {
      return crossMap[candMajor];
    }
  }
  // Check reverse: candidate's subcategory → source's major
  if (candUpper.length >= 2) {
    const candSub = candUpper.substring(0, 2);
    const crossMap = NTEE_SUBCATEGORY_CROSS[candSub];
    if (crossMap && crossMap[srcMajor] !== undefined) {
      return crossMap[srcMajor];
    }
  }

  // Same major letter (e.g., both F)
  if (srcMajor === candMajor) return 0.8;

  // Related major letters
  const related = NTEE_RELATED[srcMajor] || [];
  if (related.includes(candMajor)) {
    const idx = related.indexOf(candMajor);
    return Math.max(0.3, 0.6 - idx * 0.05);
  }

  // Check reverse
  const reverseRelated = NTEE_RELATED[candMajor] || [];
  if (reverseRelated.includes(srcMajor)) {
    const idx = reverseRelated.indexOf(srcMajor);
    return Math.max(0.3, 0.6 - idx * 0.05);
  }

  return 0;
}

// Mission keyword categories derived from org names
const NAME_MISSION_KEYWORDS: Record<string, string[]> = {
  L: ['housing', 'shelter', 'homeless', 'homelessness', 'home', 'apartment', 'residential'],
  F: ['mental health', 'crisis', 'emergency service', 'behavioral', 'psychiatric', 'counseling', 'addiction', 'recovery'],
  P: ['human service', 'social service', 'community service', 'united way', 'salvation army', 'goodwill'],
  K: ['food bank', 'food pantry', 'hunger', 'meal', 'feeding', 'nutrition'],
  E: ['health', 'hospital', 'medical', 'clinic', 'healthcare'],
  B: ['school', 'education', 'academy', 'university', 'college', 'learning', 'literacy'],
  O: ['youth', 'boys & girls', 'children', 'child', 'kids', 'teen'],
  A: ['arts', 'museum', 'theater', 'theatre', 'symphony', 'gallery', 'cultural'],
  C: ['conservation', 'environment', 'wildlife', 'nature', 'land trust', 'climate'],
  D: ['animal', 'humane', 'spca', 'veterinary', 'pet'],
  J: ['workforce', 'employment', 'job', 'career', 'vocational'],
  M: ['disaster', 'relief', 'emergency', 'safety', 'fire', 'rescue'],
  I: ['legal', 'justice', 'law', 'court'],
  R: ['civil rights', 'advocacy', 'human rights', 'naacp'],
  X: ['church', 'ministry', 'faith', 'religious', 'congregation'],
  S: ['community development', 'neighborhood', 'civic', 'chamber'],
};

// Infer NTEE major letter from org name when DB has no NTEE code
function inferNteeFromName(name: string): string | null {
  const lower = name.toLowerCase();
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [letter, keywords] of Object.entries(NAME_MISSION_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        // Longer keyword match = more confidence
        const score = kw.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = letter;
        }
      }
    }
  }

  return bestMatch;
}

// ── Shared Interfaces ───────────────────────────────────────────────────
interface GrantRow {
  foundation_id: string;
  grantee_ein: string | null;
  grantee_name: string;
  grantee_state: string | null;
  grant_amount: number | null;
}

interface FunderRow {
  id: string;
  name: string;
  state: string | null;
  total_giving: number | null;
  ntee_code: string | null;
}

// For-profit / government filters
const FOR_PROFIT_PATTERNS = [
  ' llc', ' llp', ' lp', ' ltd', ' dba ', ' d/b/a ',
  ' pllc', ' plc', ' gmbh', ' s.a.', ' sarl',
];
const GOVT_PATTERNS = [
  'department of ', 'state of ', 'city of ', 'county of ',
  'village of ', 'town of ', 'borough of ', ' police ',
  ' fire department', ' sheriff', ' public health',
];
function isLikelyNonNonprofit(name: string): boolean {
  const lower = ` ${name.toLowerCase()} `;
  if (FOR_PROFIT_PATTERNS.some(p => lower.includes(p))) return true;
  const lowerTrimmed = name.toLowerCase().trim();
  if (GOVT_PATTERNS.some(p => lowerTrimmed.includes(p))) return true;
  return false;
}

// US Census regions
const STATE_REGION: Record<string, string> = {
  CT: 'NE', ME: 'NE', MA: 'NE', NH: 'NE', RI: 'NE', VT: 'NE',
  NJ: 'NE', NY: 'NE', PA: 'NE',
  IL: 'MW', IN: 'MW', MI: 'MW', OH: 'MW', WI: 'MW',
  IA: 'MW', KS: 'MW', MN: 'MW', MO: 'MW', NE: 'MW', ND: 'MW', SD: 'MW',
  DE: 'SO', FL: 'SO', GA: 'SO', MD: 'SO', NC: 'SO', SC: 'SO', VA: 'SO', WV: 'SO', DC: 'SO',
  AL: 'SO', KY: 'SO', MS: 'SO', TN: 'SO', AR: 'SO', LA: 'SO', OK: 'SO', TX: 'SO',
  AZ: 'WE', CO: 'WE', ID: 'WE', MT: 'WE', NV: 'WE', NM: 'WE', UT: 'WE', WY: 'WE',
  AK: 'WE', CA: 'WE', HI: 'WE', OR: 'WE', WA: 'WE',
};

const MIN_FUNDER_COUNT = 3;

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const entityType = body?.entityType;
    const entityId = typeof body?.entityId === 'string' ? body.entityId.trim() : '';

    if (!entityId) {
      return new Response(
        JSON.stringify({ peers: [], error: 'entityId is required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    if (entityType !== 'funder' && entityType !== 'recipient') {
      return new Response(
        JSON.stringify({ peers: [], error: 'entityType must be "funder" or "recipient"' }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const minYear = new Date().getUTCFullYear() - RECENT_YEARS;

    // ══════════════════════════════════════════════════════════════════════
    // RECIPIENT PEERS — Based on the nonprofit's OWN NTEE classification
    // ══════════════════════════════════════════════════════════════════════
    if (entityType === 'recipient') {

      // ── Step 1: Resolve source recipient ────────────────────────────────
      const isUuid = entityId.includes('-') && entityId.length > 20;
      const lookupField = isUuid ? 'id' : 'ein';
      const sourceRows = (await restQuery(
        'recipient_organizations',
        `${lookupField}=eq.${encodeURIComponent(entityId)}&select=id,ein,name,primary_city,primary_state,total_funding,funder_count,ntee_code&limit=1`,
      )) as Array<{
        id: string; ein: string; name: string;
        primary_city: string | null; primary_state: string | null;
        total_funding: number | null; funder_count: number | null;
        ntee_code: string | null;
      }>;

      const source = sourceRows[0];
      if (!source) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // ── Step 2: Get source NTEE code ────────────────────────────────────
      // Priority: DB → ProPublica API → Name inference
      let sourceNtee = source.ntee_code;

      if (!sourceNtee || sourceNtee === 'UNKNOWN') {
        // Fetch from ProPublica and save to DB for future use
        const fetched = await fetchNteeCode(source.ein);
        if (fetched) {
          sourceNtee = fetched;
          // Save to DB asynchronously (don't block)
          restPatch(
            'recipient_organizations',
            `ein=eq.${encodeURIComponent(source.ein)}`,
            { ntee_code: fetched },
          ).catch(() => {});
        } else {
          // Last resort: infer from org name
          const inferred = inferNteeFromName(source.name);
          sourceNtee = inferred ? `${inferred}00` : null; // e.g., "F00" for inferred
        }
      }

      const sourceState = source.primary_state?.toUpperCase() || null;
      const sourceCity = source.primary_city?.toUpperCase() || null;
      const sourceFunding = Number(source.total_funding) || 0;
      const sourceMajor = sourceNtee ? sourceNtee.charAt(0).toUpperCase() : null;

      console.log(`[compute-peers] Source: ${source.name} (${source.ein}), NTEE: ${sourceNtee}, State: ${sourceState}`);

      if (!sourceMajor) {
        return new Response(JSON.stringify({ peers: [], error: 'Could not determine source NTEE code' }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // ── Step 3: Build list of NTEE letters to search ────────────────────
      const searchLetters = new Set<string>([sourceMajor]);
      const relatedLetters = NTEE_RELATED[sourceMajor] || [];
      for (const letter of relatedLetters) {
        searchLetters.add(letter);
      }

      console.log(`[compute-peers] Searching NTEE letters: ${Array.from(searchLetters).join(', ')}`);

      // ── Step 4: Query candidates from DB by NTEE code ───────────────────
      type CandidateRow = {
        id: string; ein: string; name: string;
        primary_city: string | null; primary_state: string | null;
        total_funding: number | null; funder_count: number | null;
        ntee_code: string | null;
      };

      const allCandidates: CandidateRow[] = [];

      for (const letter of searchLetters) {
        const rows = (await restQuery(
          'recipient_organizations',
          `ntee_code=like.${letter}*&funder_count=gte.${MIN_FUNDER_COUNT}&ein=neq.${encodeURIComponent(source.ein)}&select=id,ein,name,primary_city,primary_state,total_funding,funder_count,ntee_code&limit=500`,
        )) as CandidateRow[];

        allCandidates.push(...rows);
      }

      for (const letter of searchLetters) {
        const keywords = NAME_MISSION_KEYWORDS[letter] || [];
        const sorted = [...keywords].sort((a, b) => b.length - a.length).slice(0, 4);
        for (const kw of sorted) {
          if (kw.length < 4) continue;
          const nameRows = (await restQuery(
            'recipient_organizations',
            `name=ilike.*${encodeURIComponent(kw)}*&funder_count=gte.${MIN_FUNDER_COUNT}&ein=neq.${encodeURIComponent(source.ein)}&select=id,ein,name,primary_city,primary_state,total_funding,funder_count,ntee_code&limit=200`,
          )) as CandidateRow[];

          allCandidates.push(...nameRows);
        }
      }

      // Deduplicate by EIN
      const candidateMap = new Map<string, CandidateRow>();
      for (const c of allCandidates) {
        if (!candidateMap.has(c.ein)) {
          candidateMap.set(c.ein, c);
        }
      }

      console.log(`[compute-peers] Found ${candidateMap.size} unique candidates`);

      // ── Step 5: Score all candidates ────────────────────────────────────
      const W_NTEE  = 0.40;
      const W_GEO   = 0.30;
      const W_SCALE = 0.20;
      const W_NAME  = 0.10;

      const scored: Array<{
        id: string; name: string; score: number;
        matchedMission: string; state: string | null;
        totalFunding: number | null;
      }> = [];

      for (const [, c] of candidateMap) {
        if (isLikelyNonNonprofit(c.name)) continue;

        const sourceFunderCount = source.funder_count ?? 10;
        if ((c.funder_count ?? 0) > sourceFunderCount * 20) continue;

        let ntee = 0;
        const candNtee = c.ntee_code;
        if (sourceNtee && candNtee && candNtee !== 'UNKNOWN') {
          ntee = nteeScore(sourceNtee, candNtee);
        } else {
          const inferred = inferNteeFromName(c.name);
          if (inferred && sourceMajor) {
            ntee = nteeScore(sourceNtee!, `${inferred}00`);
          }
        }

        let geo = 0;
        const peerState = c.primary_state?.toUpperCase() || null;
        const peerCity = c.primary_city?.toUpperCase() || null;
        if (sourceCity && peerCity && sourceState && peerState &&
            sourceCity === peerCity && sourceState === peerState) {
          geo = 1.0;
        } else if (sourceState && peerState) {
          if (sourceState === peerState) {
            geo = 0.6;
          } else {
            const srcRegion = STATE_REGION[sourceState];
            const peerRegion = peerState ? STATE_REGION[peerState] : null;
            if (srcRegion && peerRegion && srcRegion === peerRegion) {
              geo = 0.3;
            }
          }
        }

        let scale = 0.5;
        const peerFunding = Number(c.total_funding) || 0;
        if (sourceFunding > 0 && peerFunding > 0) {
          const logDiff = Math.abs(Math.log10(sourceFunding) - Math.log10(peerFunding));
          scale = Math.max(0, 1.0 - logDiff * 0.4);
        }

        let nameOverlap = 0;
        const srcNameLower = source.name.toLowerCase();
        const candNameLower = c.name.toLowerCase();
        for (const [letter, keywords] of Object.entries(NAME_MISSION_KEYWORDS)) {
          const srcHas = keywords.some(kw => srcNameLower.includes(kw));
          const candHas = keywords.some(kw => candNameLower.includes(kw));
          if (srcHas && candHas) {
            nameOverlap = 1.0;
            break;
          }
        }
        if (nameOverlap === 0 && sourceMajor) {
          const srcCatKeywords = NAME_MISSION_KEYWORDS[sourceMajor] || [];
          if (srcCatKeywords.some(kw => candNameLower.includes(kw))) {
            nameOverlap = 0.7;
          }
        }

        const composite =
          ntee  * W_NTEE +
          geo   * W_GEO +
          scale * W_SCALE +
          nameOverlap * W_NAME;

        const candMajor = (candNtee && candNtee !== 'UNKNOWN')
          ? candNtee.charAt(0).toUpperCase()
          : inferNteeFromName(c.name);
        const missionLabel = candMajor ? (NTEE_MAJOR[candMajor] || candMajor) : 'Unknown';

        scored.push({
          id: c.id,
          name: c.name,
          score: Math.round(composite * 1000) / 1000,
          matchedMission: missionLabel,
          state: c.primary_state,
          totalFunding: Number(c.total_funding) || null,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      const peers = scored.slice(0, MAX_PEERS);

      console.log(`[compute-peers] Top 5:`, peers.slice(0, 5).map(p =>
        `${p.name} (${p.score}, ${p.matchedMission})`));

      return new Response(JSON.stringify({ peers }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    // FUNDER PEERS — Shared grantee overlap + multi-factor scoring
    // ══════════════════════════════════════════════════════════════════════

    const sourceGrants = (await restQuery(
      'foundation_grants',
      `foundation_id=eq.${encodeURIComponent(entityId)}&grant_year=gte.${minYear}&grantee_ein=not.is.null&select=grantee_ein,grantee_name&limit=5000`,
    )) as GrantRow[];

    if (sourceGrants.length === 0) {
      return new Response(JSON.stringify({ peers: [] }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const sourceEins = new Set(
      sourceGrants.map((g) => g.grantee_ein!).filter(Boolean),
    );

    if (sourceEins.size < 2) {
      return new Response(JSON.stringify({ peers: [] }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const funderEinList = Array.from(sourceEins);
    const candidateShared = new Map<string, Set<string>>();

    const BATCH = 50;
    for (let i = 0; i < funderEinList.length && i < 500; i += BATCH) {
      const batch = funderEinList.slice(i, i + BATCH);
      const einFilter = `(${batch.map((e) => `"${e}"`).join(',')})`;
      const otherGrants = (await restQuery(
        'foundation_grants',
        `grantee_ein=in.${einFilter}&grant_year=gte.${minYear}&foundation_id=neq.${encodeURIComponent(entityId)}&select=foundation_id,grantee_ein&limit=10000`,
      )) as GrantRow[];

      for (const g of otherGrants) {
        if (!g.grantee_ein) continue;
        const set = candidateShared.get(g.foundation_id) || new Set();
        set.add(g.grantee_ein);
        candidateShared.set(g.foundation_id, set);
      }
    }

    const sourceFunderRows = (await restQuery(
      'funders',
      `id=eq.${encodeURIComponent(entityId)}&select=id,name,state,total_giving,ntee_code&limit=1`,
    )) as FunderRow[];
    const sourceFunder = sourceFunderRows[0] || null;

    const qualifiedCandidates: Array<{ funderId: string; sharedSet: Set<string> }> = [];
    for (const [fId, sharedSet] of candidateShared) {
      if (sharedSet.size < MIN_SHARED) continue;
      qualifiedCandidates.push({ funderId: fId, sharedSet });
    }

    if (qualifiedCandidates.length === 0) {
      return new Response(JSON.stringify({ peers: [] }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    qualifiedCandidates.sort((a, b) => b.sharedSet.size - a.sharedSet.size);
    const funderEnrichPool = qualifiedCandidates.slice(0, 50);

    const peerIds = funderEnrichPool.map((c) => c.funderId);
    const idFilter = `(${peerIds.map((id) => `"${id}"`).join(',')})`;
    const funderRows = (await restQuery(
      'funders',
      `id=in.${idFilter}&select=id,name,state,total_giving,ntee_code`,
    )) as FunderRow[];

    const funderLookup = new Map(funderRows.map((f) => [f.id, f]));

    const WEIGHT_SHARED = 0.40;
    const WEIGHT_NTEE   = 0.20;
    const WEIGHT_BUDGET = 0.20;
    const WEIGHT_GEO    = 0.20;

    const sourceNteeChar = sourceFunder?.ntee_code?.charAt(0)?.toUpperCase() || null;
    const funderSourceState = sourceFunder?.state?.toUpperCase() || null;
    const sourceGiving = sourceFunder?.total_giving ?? null;

    const funderScored = funderEnrichPool
      .map((c) => {
        const f = funderLookup.get(c.funderId);
        if (!f) return null;

        const sharedScore = Math.min(c.sharedSet.size / sourceEins.size, 1.0);

        let fnteeScore = 0;
        if (sourceNteeChar && f.ntee_code) {
          const peerNtee = f.ntee_code.charAt(0).toUpperCase();
          if (sourceNteeChar === peerNtee) fnteeScore = 1.0;
        }

        let budgetScore = 0.5;
        if (sourceGiving && sourceGiving > 0 && f.total_giving && f.total_giving > 0) {
          const logDiff = Math.abs(Math.log10(sourceGiving) - Math.log10(f.total_giving));
          budgetScore = Math.max(0, 1.0 - logDiff * 0.5);
        }

        let geoScore = 0;
        const peerState = f.state?.toUpperCase() || null;
        if (funderSourceState && peerState) {
          if (funderSourceState === peerState) {
            geoScore = 1.0;
          } else {
            const srcRegion = STATE_REGION[funderSourceState];
            const peerRegion = STATE_REGION[peerState];
            if (srcRegion && peerRegion && srcRegion === peerRegion) {
              geoScore = 0.5;
            }
          }
        }

        const composite =
          sharedScore * WEIGHT_SHARED +
          fnteeScore * WEIGHT_NTEE +
          budgetScore * WEIGHT_BUDGET +
          geoScore * WEIGHT_GEO;

        return {
          id: f.id,
          name: f.name,
          score: Math.round(composite * 1000) / 1000,
          sharedCount: c.sharedSet.size,
          state: f.state,
          totalFunding: f.total_giving,
        };
      })
      .filter(Boolean);

    funderScored.sort((a, b) => (b?.score ?? 0) - (a?.score ?? 0));
    const peers = funderScored.slice(0, MAX_PEERS);

    return new Response(JSON.stringify({ peers }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    console.error('compute-peers error:', err);
    return new Response(
      JSON.stringify({
        peers: [],
        error: err instanceof Error ? err.message : 'Internal server error',
      }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
