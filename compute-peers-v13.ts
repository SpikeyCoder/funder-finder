/**
 * compute-peers v12 — Supabase Edge Function
 *
 * Finds similar organizations using:
 *   1. ProPublica NTEE code lookup (authoritative mission classification)
 *   2. Grant purpose_text keyword analysis
 *   3. Org name keyword extraction
 *   4. Semantic category proximity
 *   5. Geographic & scale signals
 *
 * Input:  { entityType: 'funder'|'recipient', entityId: string }
 * Output: { peers: PeerEntry[] }
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
  'http://localhost:5173',
]);

const RECENT_YEARS = 5;
const MAX_PEERS = 10;
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

// ── ProPublica NTEE Lookup ──────────────────────────────────────────────
// Fetches the NTEE code for a nonprofit from the ProPublica API.
// Returns null on any error (network, 404, etc.) — never blocks scoring.
async function fetchNteeCode(ein: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`,
      { signal: AbortSignal.timeout(4000) }, // 4s timeout per call
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.organization?.ntee_code || null;
  } catch {
    return null;
  }
}

// ── NTEE Code → Mission Category Mapping ────────────────────────────────
// Maps NTEE major letter (and some subcategories) to our mission categories
const NTEE_TO_CATEGORIES: Record<string, string[]> = {
  'A': ['arts'],
  'B': ['education'],
  'C': ['environment'],
  'D': ['animals'],
  'E': ['health'],
  'F': ['mental_health'],      // F = Mental Health, Crisis Intervention
  'F3': ['mental_health', 'housing'],  // F3xx = Residential, Custodial Care — housing focused
  'G': ['health'],
  'H': ['health'],
  'I': ['legal'],
  'J': ['workforce'],
  'K': ['food'],
  'L': ['housing'],
  'L4': ['housing', 'emergency'],  // L4x = Temporary Shelter
  'M': ['emergency'],
  'N': [],                     // Recreation
  'O': ['youth'],
  'P': ['human_services', 'poverty'],
  'Q': [],                     // International
  'R': ['legal'],
  'S': ['community_dev'],
  'T': [],                     // Philanthropy
  'U': [],                     // Science
  'V': [],
  'W': [],
  'X': ['religion'],
  'Y': [],
  'Z': [],
};

// Which NTEE major letters are mission-related to each other
const NTEE_RELATED_LETTERS: Record<string, string[]> = {
  'F': ['L', 'P', 'E'],       // Mental Health ↔ Housing, Human Services, Health
  'L': ['F', 'P', 'M'],       // Housing ↔ Mental Health, Human Services, Emergency
  'P': ['F', 'L', 'K', 'O', 'J', 'M'], // Human Services ↔ many
  'E': ['F', 'G', 'H'],       // Health ↔ Mental Health, Diseases, Medical Research
  'K': ['P'],                  // Food ↔ Human Services
  'M': ['L', 'P'],             // Emergency ↔ Housing, Human Services
  'O': ['B', 'P'],             // Youth ↔ Education, Human Services
  'B': ['O'],                  // Education ↔ Youth
  'I': ['R'],                  // Crime/Legal ↔ Civil Rights
  'R': ['I', 'P'],             // Civil Rights ↔ Crime/Legal, Human Services
  'J': ['P', 'B'],             // Employment ↔ Human Services, Education
};

// Compute NTEE similarity score between two NTEE codes
function nteeSimScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const majorA = a.charAt(0).toUpperCase();
  const majorB = b.charAt(0).toUpperCase();

  // Same major letter = strong match
  if (majorA === majorB) return 1.0;

  // Check if related
  const relatedA = NTEE_RELATED_LETTERS[majorA] || [];
  if (relatedA.includes(majorB)) return 0.6;

  // Check reverse
  const relatedB = NTEE_RELATED_LETTERS[majorB] || [];
  if (relatedB.includes(majorA)) return 0.6;

  return 0;
}

// Map an NTEE code to our mission categories (checks subcategory first, then major)
function nteeToCats(ntee: string | null): string[] {
  if (!ntee || ntee.length < 1) return [];
  const upper = ntee.toUpperCase();

  // Try 2-char subcategory first (e.g., "F3" for F300)
  if (upper.length >= 2) {
    const sub2 = upper.substring(0, 2);
    if (NTEE_TO_CATEGORIES[sub2]) return NTEE_TO_CATEGORIES[sub2];
  }

  // Fall back to major letter
  const major = upper.charAt(0);
  return NTEE_TO_CATEGORIES[major] || [];
}

// ── Interfaces ──────────────────────────────────────────────────────────
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

interface RecipientRow {
  id: string;
  ein: string;
  name: string;
  primary_state: string | null;
  total_funding: number | null;
  funder_count: number | null;
}

// For-profit indicators
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

const MIN_GRANTS_FOR_PEER = 3;

// US Census regions for geographic proximity
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

    // ── Recipient peers ─────────────────────────────────────────────────
    if (entityType === 'recipient') {
      // Step 1: Resolve source recipient
      const isUuid = entityId.includes('-') && entityId.length > 20;
      const lookupField = isUuid ? 'id' : 'ein';
      const sourceRows = (await restQuery(
        'recipient_organizations',
        `${lookupField}=eq.${encodeURIComponent(entityId)}&select=id,ein,name,primary_city,primary_state,total_funding,funder_count&limit=1`,
      )) as Array<{
        id: string; ein: string; name: string;
        primary_city: string | null; primary_state: string | null;
        total_funding: number | null; funder_count: number | null;
      }>;

      const source = sourceRows[0];
      if (!source) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      const sourceState = source.primary_state?.toUpperCase() || null;
      const sourceCity = source.primary_city?.toUpperCase() || null;
      const sourceFunding = Number(source.total_funding) || 0;

      // Step 2: Fetch source grants + NTEE code in parallel
      const [sourceGrants, sourceNtee] = await Promise.all([
        restQuery(
          'foundation_grants',
          `grantee_ein=eq.${encodeURIComponent(source.ein)}&select=purpose_text&limit=5000`,
        ) as Promise<Array<{ purpose_text: string | null }>>,
        fetchNteeCode(source.ein),
      ]);

      console.log(`[compute-peers] Source: ${source.name} (${source.ein}), NTEE: ${sourceNtee}, grants: ${sourceGrants.length}`);

      if (sourceGrants.length === 0 && !sourceNtee) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Step 3: Mission keyword dictionary
      const MISSION_KEYWORDS: Record<string, string[]> = {
        'housing': ['permanent supportive housing', 'transitional housing', 'affordable housing', 'rental assistance', 'rent assistance', 'homelessness', 'homeless', 'housing', 'shelter'],
        'mental_health': ['behavioral health', 'mental health', 'substance abuse', 'psychiatric', 'counseling', 'addiction', 'recovery', 'therapy'],
        'food': ['food bank', 'food pantry', 'food', 'hunger', 'nutrition', 'meal', 'meals', 'feeding'],
        'education': ['after-school', 'afterschool', 'scholarship', 'education', 'tutoring', 'literacy', 'learning', 'academic', 'school'],
        'youth': ['young people', 'foster', 'youth', 'children', 'child', 'teen', 'adolescent', 'juvenile', 'kids'],
        'health': ['health care', 'healthcare', 'hospital', 'medical', 'clinic', 'patient', 'disease', 'health', 'wellness'],
        'arts': ['performing arts', 'arts', 'music', 'theater', 'theatre', 'dance', 'cultural', 'museum', 'gallery', 'creative'],
        'environment': ['clean water', 'clean energy', 'land trust', 'conservation', 'environment', 'climate', 'wildlife', 'sustainability', 'nature'],
        'workforce': ['workforce development', 'job training', 'job placement', 'workforce', 'employment', 'career', 'vocational'],
        'disability': ['special needs', 'disability', 'disabilities', 'disabled', 'accessibility', 'deaf', 'blind', 'autism'],
        'domestic_violence': ['domestic violence', 'domestic abuse', 'sexual assault', 'violence prevention', 'victim', 'survivors'],
        'seniors': ['older adults', 'elder care', 'senior', 'seniors', 'elderly', 'aging'],
        'immigrant': ['immigrant', 'immigration', 'refugee', 'migrant', 'asylum', 'newcomer', 'resettlement'],
        'legal': ['legal aid', 'legal services', 'civil rights', 'human rights', 'legal', 'justice', 'advocacy'],
        'animals': ['animal', 'animals', 'veterinary', 'pet', 'humane', 'rescue'],
        'religion': ['church', 'religious', 'faith', 'ministry', 'congregation', 'worship', 'spiritual'],
        'poverty': ['low-income', 'low income', 'poverty', 'underserved', 'disadvantaged', 'economic empowerment'],
        'community_dev': ['community development', 'capacity building', 'community organizing', 'neighborhood', 'civic'],
        'emergency': ['emergency services', 'first responders', 'emergency', 'disaster', 'crisis', 'relief'],
        'human_services': ['human services', 'social services', 'case management', 'supportive services', 'wraparound'],
      };

      // Semantic proximity
      const RELATED_CATEGORIES: Record<string, string[]> = {
        'housing':        ['emergency', 'human_services', 'mental_health', 'poverty', 'food'],
        'emergency':      ['housing', 'human_services', 'food', 'poverty', 'mental_health'],
        'human_services': ['housing', 'emergency', 'food', 'poverty', 'mental_health'],
        'food':           ['emergency', 'human_services', 'poverty', 'housing'],
        'mental_health':  ['human_services', 'housing', 'emergency'],
        'poverty':        ['housing', 'food', 'emergency', 'human_services'],
        'youth':          ['education', 'domestic_violence'],
        'education':      ['youth', 'workforce'],
        'workforce':      ['education', 'poverty'],
        'domestic_violence': ['human_services', 'legal', 'housing'],
        'seniors':        ['health', 'human_services', 'disability'],
        'health':         ['mental_health', 'disability', 'seniors'],
        'disability':     ['health', 'seniors', 'human_services'],
        'immigrant':      ['legal', 'human_services'],
        'legal':          ['immigrant', 'domestic_violence', 'human_services'],
      };

      // Generic purpose texts to exclude
      const GENERIC_PURPOSES = new Set([
        'general support', 'general operating', 'unrestricted', 'operating support',
        'general purpose', 'charitable purpose', 'charitable purposes',
        'general operations', 'annual fund', 'capital campaign',
        'to provide general support', 'to provide general support.',
        'for recipient\'s exempt purpose', 'program support',
      ]);

      // Aggregate purpose texts
      const allPurposeText = sourceGrants
        .map(g => g.purpose_text?.toLowerCase().trim() || '')
        .filter(t => t.length > 0 && !GENERIC_PURPOSES.has(t));

      // Step 4: Build WEIGHTED mission profile
      const sourceCategoryHits = new Map<string, number>();
      let totalCategorised = 0;

      // 4a: From purpose_text
      for (const text of allPurposeText) {
        for (const [category, terms] of Object.entries(MISSION_KEYWORDS)) {
          for (const term of terms) {
            if (text.includes(term)) {
              sourceCategoryHits.set(category, (sourceCategoryHits.get(category) || 0) + 1);
              totalCategorised++;
              break;
            }
          }
        }
      }

      // 4b: From org name keywords
      const orgNameLower = source.name.toLowerCase();
      for (const [category, terms] of Object.entries(MISSION_KEYWORDS)) {
        for (const term of terms) {
          if (orgNameLower.includes(term)) {
            sourceCategoryHits.set(category, (sourceCategoryHits.get(category) || 0) + 3);
            totalCategorised += 3;
            break;
          }
        }
      }

      // 4c: ★ NEW — From ProPublica NTEE code (strongest signal)
      // NTEE is an authoritative classification from the IRS/NCCS.
      // Weight it heavily (equivalent to 8 grants) because it's the most reliable
      // indicator of mission, especially when purpose_text is generic.
      const nteeCats = nteeToCats(sourceNtee);
      for (const cat of nteeCats) {
        sourceCategoryHits.set(cat, (sourceCategoryHits.get(cat) || 0) + 8);
        totalCategorised += 8;
      }

      console.log(`[compute-peers] Source categories (pre-expand):`, Object.fromEntries(sourceCategoryHits));

      // 4d: Expand profile with RELATED categories at reduced weight
      const expandedHits = new Map(sourceCategoryHits);
      for (const [cat, count] of sourceCategoryHits) {
        const related = RELATED_CATEGORIES[cat] || [];
        for (const relCat of related) {
          if (!expandedHits.has(relCat)) {
            expandedHits.set(relCat, Math.ceil(count * 0.3));
            totalCategorised += Math.ceil(count * 0.3);
          }
        }
      }

      if (expandedHits.size === 0) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Build source profile weights (normalised to sum ≈ 1.0)
      const sourceProfile = new Map<string, number>();
      for (const [cat, count] of expandedHits) {
        sourceProfile.set(cat, count / totalCategorised);
      }

      const rankedCategories = Array.from(sourceProfile.entries())
        .sort((a, b) => b[1] - a[1]);

      console.log(`[compute-peers] Source profile (expanded):`, rankedCategories.slice(0, 10));

      // Step 5: Build search terms from TOP categories
      const searchTermsForCategory = new Map<string, string[]>();
      const combinedText = allPurposeText.join(' ') + ' ' + orgNameLower;

      for (const [cat] of rankedCategories.slice(0, 10)) {
        const terms = MISSION_KEYWORDS[cat] || [];
        const matching = terms.filter(t => combinedText.includes(t));
        const searchTerms = matching.length > 0 ? matching.slice(0, 3) : terms.slice(0, 3);
        searchTermsForCategory.set(cat, searchTerms);
      }

      // Step 6: Search for candidate grantees via purpose_text
      type CandidateData = { categories: Set<string>; hitCount: number };
      const candidateHits = new Map<string, CandidateData>();

      for (const [cat, terms] of searchTermsForCategory) {
        for (const term of terms) {
          const encoded = encodeURIComponent(`*${term}*`);
          const grants = (await restQuery(
            'foundation_grants',
            `purpose_text=ilike.${encoded}&grantee_ein=not.is.null&grantee_ein=neq.${encodeURIComponent(source.ein)}&select=grantee_ein&limit=5000`,
          )) as Array<{ grantee_ein: string }>;

          for (const g of grants) {
            if (!g.grantee_ein) continue;
            const data = candidateHits.get(g.grantee_ein) || { categories: new Set(), hitCount: 0 };
            data.categories.add(cat);
            data.hitCount += 1;
            candidateHits.set(g.grantee_ein, data);
          }
        }
      }

      // Step 6b: ★ Supplementary candidate search by ORG NAME
      // This catches orgs that share mission keywords in their NAME even when
      // their grant purpose_texts are generic.  Critical for cases like Plymouth
      // Housing Group whose funders describe grants as "general support".
      // We search recipient_organizations directly for name matches on the
      // source's TOP categories (especially NTEE-derived ones).
      const nameSearchCats = nteeCats.length > 0
        ? nteeCats
        : rankedCategories.slice(0, 3).map(([cat]) => cat);

      for (const cat of nameSearchCats) {
        const terms = MISSION_KEYWORDS[cat] || [];
        // Use the most distinctive terms (longer phrases first for precision)
        const sortedTerms = [...terms].sort((a, b) => b.length - a.length).slice(0, 4);

        for (const term of sortedTerms) {
          // Only search single-word or short terms that are distinctive enough
          if (term.length < 4) continue;

          const nameMatches = (await restQuery(
            'recipient_organizations',
            `name=ilike.*${encodeURIComponent(term)}*&ein=neq.${encodeURIComponent(source.ein)}&select=ein,name&limit=100`,
          )) as Array<{ ein: string; name: string }>;

          for (const r of nameMatches) {
            if (!r.ein) continue;
            const data = candidateHits.get(r.ein) || { categories: new Set(), hitCount: 0 };
            data.categories.add(cat);
            data.hitCount += 3; // Name match = strong signal (3 hits)
            candidateHits.set(r.ein, data);
          }
        }
      }

      console.log(`[compute-peers] Total candidates after name search: ${candidateHits.size}`);

      // Step 7: Score candidates — first pass using MISSION KEYWORDS
      const candidateScores: Array<{
        ein: string; focusScore: number; hitCount: number;
        matchedCategories: Set<string>;
      }> = [];

      for (const [ein, data] of candidateHits) {
        if (data.categories.size === 0) continue;

        let weightedOverlap = 0;
        for (const cat of data.categories) {
          weightedOverlap += sourceProfile.get(cat) || 0;
        }

        const focus = weightedOverlap / data.categories.size;
        const focusScore = weightedOverlap * 0.6 + focus * 0.4;

        if (data.hitCount < 2) continue;

        candidateScores.push({
          ein, focusScore, hitCount: data.hitCount,
          matchedCategories: data.categories,
        });
      }

      // Sort by focus score, take top 80 for enrichment
      candidateScores.sort((a, b) => b.focusScore - a.focusScore);
      const enrichPool = candidateScores.slice(0, 80);

      if (enrichPool.length === 0) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Step 8: Enrich candidates from recipient_organizations
      type RecipientInfo = {
        id: string; ein: string; name: string;
        primary_city: string | null; primary_state: string | null;
        total_funding: number | null; funder_count: number | null;
      };
      const enrichedMap = new Map<string, RecipientInfo>();
      const einList = enrichPool.map(c => c.ein);
      const EIN_BATCH = 50;
      for (let i = 0; i < einList.length; i += EIN_BATCH) {
        const batch = einList.slice(i, i + EIN_BATCH);
        const einFilter = `(${batch.map(e => `"${e}"`).join(',')})`;
        const rows = (await restQuery(
          'recipient_organizations',
          `ein=in.${einFilter}&select=id,ein,name,primary_city,primary_state,total_funding,funder_count`,
        )) as RecipientInfo[];
        for (const r of rows) enrichedMap.set(r.ein, r);
      }

      // Step 9: Filter and pre-score to find top 25 for NTEE lookup
      const preScored = enrichPool
        .map(c => {
          const r = enrichedMap.get(c.ein);
          if (!r) return null;
          if (isLikelyNonNonprofit(r.name || '')) return null;
          if ((r.funder_count ?? 0) < MIN_GRANTS_FOR_PEER) return null;

          const sourceFunderCount = source.funder_count ?? 10;
          if ((r.funder_count ?? 0) > sourceFunderCount * 20) return null;

          return { ...c, recipient: r };
        })
        .filter(Boolean) as Array<{
          ein: string; focusScore: number; hitCount: number;
          matchedCategories: Set<string>; recipient: RecipientInfo;
        }>;

      // Step 10: ★ Fetch NTEE codes for top 25 candidates in parallel
      const top25 = preScored.slice(0, 25);
      const nteeResults = await Promise.allSettled(
        top25.map(c => fetchNteeCode(c.ein)),
      );
      const candidateNtees = new Map<string, string | null>();
      top25.forEach((c, i) => {
        const result = nteeResults[i];
        candidateNtees.set(c.ein, result.status === 'fulfilled' ? result.value : null);
      });

      console.log(`[compute-peers] Fetched NTEE for ${top25.length} candidates`);

      // Step 11: Final composite scoring
      // 40% mission keyword + 25% NTEE similarity + 15% geo + 10% scale + 10% hits
      const W_FOCUS = 0.40;
      const W_NTEE  = 0.25;
      const W_GEO   = 0.15;
      const W_SCALE = 0.10;
      const W_HITS  = 0.10;

      const maxHits = Math.max(...preScored.map(c => c.hitCount), 1);

      const scored = preScored.map(c => {
        const r = c.recipient;

        // Signal 1: Mission keyword focus (40%)
        const focusScore = c.focusScore;

        // Signal 2: ★ NTEE similarity (25%)
        const candidateNtee = candidateNtees.get(c.ein) ?? null;
        let nteeScore = 0;

        if (sourceNtee && candidateNtee) {
          nteeScore = nteeSimScore(sourceNtee, candidateNtee);
        }
        // Bonus: if candidate's NTEE maps to categories that overlap with source profile
        if (candidateNtee && nteeScore === 0) {
          const candNteeCats = nteeToCats(candidateNtee);
          let catOverlap = 0;
          for (const cat of candNteeCats) {
            if (sourceProfile.has(cat)) catOverlap += sourceProfile.get(cat)!;
          }
          nteeScore = Math.min(catOverlap * 0.5, 0.4); // Cap at 0.4
        }
        // Also: if candidate name strongly matches source's NTEE-derived categories
        const candNameLower = r.name.toLowerCase();
        for (const cat of nteeCats) {
          const terms = MISSION_KEYWORDS[cat] || [];
          for (const term of terms) {
            if (candNameLower.includes(term)) {
              nteeScore = Math.max(nteeScore, 0.5);
              break;
            }
          }
        }

        // Signal 3: Geographic proximity (15%)
        let geoScore = 0;
        const peerState = r.primary_state?.toUpperCase() || null;
        const peerCity = r.primary_city?.toUpperCase() || null;
        if (sourceCity && peerCity && sourceState && peerState &&
            sourceCity === peerCity && sourceState === peerState) {
          geoScore = 1.0;
        } else if (sourceState && peerState) {
          if (sourceState === peerState) {
            geoScore = 0.6;
          } else {
            const srcRegion = STATE_REGION[sourceState];
            const peerRegion = peerState ? STATE_REGION[peerState] : null;
            if (srcRegion && peerRegion && srcRegion === peerRegion) {
              geoScore = 0.3;
            }
          }
        }

        // Signal 4: Scale similarity (10%)
        let scaleScore = 0.5;
        const peerFunding = Number(r.total_funding) || 0;
        if (sourceFunding > 0 && peerFunding > 0) {
          const logDiff = Math.abs(Math.log10(sourceFunding) - Math.log10(peerFunding));
          scaleScore = Math.max(0, 1.0 - logDiff * 0.4);
        }

        // Signal 5: Hit volume (10%)
        const hitScore = c.hitCount / maxHits;

        const composite =
          focusScore * W_FOCUS +
          nteeScore  * W_NTEE +
          geoScore   * W_GEO +
          scaleScore * W_SCALE +
          hitScore   * W_HITS;

        return {
          id: r.id,
          name: r.name,
          score: Math.round(composite * 1000) / 1000,
          matchedMission: Array.from(c.matchedCategories).join(', '),
          state: r.primary_state,
          totalFunding: Number(r.total_funding) || null,
        };
      });

      scored.sort((a, b) => b.score - a.score);
      const peers = scored.slice(0, MAX_PEERS);

      console.log(`[compute-peers] Top 5 peers:`, peers.slice(0, 5).map(p => `${p.name} (${p.score})`));

      return new Response(JSON.stringify({ peers }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // ── Funder peers ──────────────────────────────────────────────────────

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

    const WEIGHT_SHARED   = 0.40;
    const WEIGHT_NTEE     = 0.20;
    const WEIGHT_BUDGET   = 0.20;
    const WEIGHT_GEO      = 0.20;

    const sourceNtee = sourceFunder?.ntee_code?.charAt(0)?.toUpperCase() || null;
    const funderSourceState = sourceFunder?.state?.toUpperCase() || null;
    const sourceGiving = sourceFunder?.total_giving ?? null;

    const funderScored = funderEnrichPool
      .map((c) => {
        const f = funderLookup.get(c.funderId);
        if (!f) return null;

        const sharedScore = Math.min(c.sharedSet.size / sourceEins.size, 1.0);

        let nteeScore = 0;
        if (sourceNtee && f.ntee_code) {
          const peerNtee = f.ntee_code.charAt(0).toUpperCase();
          if (sourceNtee === peerNtee) nteeScore = 1.0;
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
          nteeScore * WEIGHT_NTEE +
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
