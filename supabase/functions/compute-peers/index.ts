/**
 * compute-peers — Supabase Edge Function
 *
 * Finds similar organizations:
 * - Recipients: mission keyword similarity from grant purpose_text (primary),
 *   geographic proximity (secondary)
 * - Funders: shared grantee overlap, NTEE code, budget, geography
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
const MIN_SHARED = 2; // need at least 2 shared entities to be a peer

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

// For-profit indicators — names containing these tokens are filtered out of peer results
const FOR_PROFIT_PATTERNS = [
  ' llc', ' llp', ' lp', ' ltd', ' dba ', ' d/b/a ',
  ' pllc', ' plc', ' gmbh', ' s.a.', ' sarl',
];
// Government entity patterns
const GOVT_PATTERNS = [
  'department of ', 'state of ', 'city of ', 'county of ',
  'village of ', 'town of ', 'borough of ', ' police ',
  ' fire department', ' sheriff', ' public health',
];
function isLikelyNonNonprofit(name: string): boolean {
  const lower = ` ${name.toLowerCase()} `;
  if (FOR_PROFIT_PATTERNS.some(p => lower.includes(p))) return true;
  // Check government entities
  const lowerTrimmed = name.toLowerCase().trim();
  if (GOVT_PATTERNS.some(p => lowerTrimmed.includes(p))) return true;
  return false;
}

const MIN_GRANTS_FOR_PEER = 3; // filter out one-off COVID relief recipients etc.

// US Census regions for geographic proximity — shared by both funder & recipient paths
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

    // ── Recipient peers: find similar orgs by MISSION KEYWORD SIMILARITY ──
    // v10 — Uses grant purpose_text to build a weighted mission profile for the
    // source org, then finds other recipients whose grants concentrate on the
    // SAME mission areas.  Rewards focused orgs, penalises mega-orgs that match
    // every category.  Geography and scale are secondary signals.
    if (entityType === 'recipient') {
      // Step 1: Resolve source recipient details
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

      // Step 2: Fetch all grants for this recipient to get purpose_text values
      const sourceGrants = (await restQuery(
        'foundation_grants',
        `grantee_ein=eq.${encodeURIComponent(source.ein)}&select=purpose_text&limit=5000`,
      )) as Array<{ purpose_text: string | null }>;

      if (sourceGrants.length === 0) {
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

      // Generic purpose texts to exclude
      const GENERIC_PURPOSES = new Set([
        'general support', 'general operating', 'unrestricted', 'operating support',
        'general purpose', 'charitable purpose', 'charitable purposes',
        'general operations', 'annual fund', 'capital campaign',
      ]);

      // Aggregate all purpose texts for this recipient
      const allPurposeText = sourceGrants
        .map(g => g.purpose_text?.toLowerCase().trim() || '')
        .filter(t => t.length > 0 && !GENERIC_PURPOSES.has(t));

      // Step 4: Build WEIGHTED mission profile for source org
      // Count how many grants fall into each category → this is the mission profile
      const sourceCategoryHits = new Map<string, number>();
      let totalCategorised = 0;

      for (const text of allPurposeText) {
        for (const [category, terms] of Object.entries(MISSION_KEYWORDS)) {
          for (const term of terms) {
            if (text.includes(term)) {
              sourceCategoryHits.set(category, (sourceCategoryHits.get(category) || 0) + 1);
              totalCategorised++;
              break; // one category match per purpose text per category
            }
          }
        }
      }

      if (sourceCategoryHits.size === 0) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Build source profile weights (normalised to sum to 1.0)
      const sourceProfile = new Map<string, number>();
      for (const [cat, count] of sourceCategoryHits) {
        sourceProfile.set(cat, count / totalCategorised);
      }

      // Rank categories by weight — top categories are the org's core mission
      const rankedCategories = Array.from(sourceProfile.entries())
        .sort((a, b) => b[1] - a[1]);

      // Step 5: Build search terms — use multiple terms per TOP category
      // More specific terms first (already ordered in MISSION_KEYWORDS)
      const searchTermsForCategory = new Map<string, string[]>();
      const combinedText = allPurposeText.join(' ');

      for (const [cat] of rankedCategories.slice(0, 6)) {
        const terms = MISSION_KEYWORDS[cat] || [];
        const matching = terms.filter(t => combinedText.includes(t));
        // Pick up to 2 search terms per category, prefer the more specific ones (first in list)
        searchTermsForCategory.set(cat, matching.slice(0, 2));
      }

      // Step 6: Search for candidate grantees via purpose_text
      // Track per-candidate: which categories matched AND how many grant hits
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

      // Step 7: Score candidates using WEIGHTED PRECISION
      // Weighted precision = (sum of source profile weights for matching categories)
      //                    / (candidate's total matched categories)
      // This heavily rewards focused orgs whose mission aligns with the source's
      // CORE mission areas, and penalises orgs that match many diverse categories.
      const candidateScores: Array<{
        ein: string; focusScore: number; hitCount: number;
        matchedCategories: Set<string>;
      }> = [];

      for (const [ein, data] of candidateHits) {
        if (data.categories.size === 0) continue;

        // Weighted sum: how much of the source's profile does this candidate overlap?
        let weightedOverlap = 0;
        for (const cat of data.categories) {
          weightedOverlap += sourceProfile.get(cat) || 0;
        }

        // Focus score = weighted overlap / candidate's breadth
        // An org matching only housing (weight 0.5) scores: 0.5 / 1 = 0.50
        // A mega-org matching 8 categories (total weight 0.9) scores: 0.9 / 8 = 0.11
        const focusScore = weightedOverlap / data.categories.size;

        // Also require a minimum number of matching grants to filter out noise
        if (data.hitCount < 2) continue;

        candidateScores.push({
          ein,
          focusScore,
          hitCount: data.hitCount,
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

      // Step 9: Final composite scoring
      // 55% mission focus + 20% geography + 15% scale similarity + 10% hit volume
      const W_FOCUS = 0.55;
      const W_GEO   = 0.20;
      const W_SCALE = 0.15;
      const W_HITS  = 0.10;

      // Max hit count for normalisation
      const maxHits = Math.max(...enrichPool.map(c => c.hitCount), 1);

      const scored = enrichPool
        .map(c => {
          const r = enrichedMap.get(c.ein);
          if (!r) return null;
          if (isLikelyNonNonprofit(r.name || '')) return null;
          if ((r.funder_count ?? 0) < MIN_GRANTS_FOR_PEER) return null;

          // Exclude mega-orgs: if funder_count is 20x+ the source, likely a national org
          const sourceFunderCount = source.funder_count ?? 10;
          if ((r.funder_count ?? 0) > sourceFunderCount * 20) return null;

          // Signal 1: Mission focus score (55%)
          const focusScore = c.focusScore;

          // Signal 2: Geographic proximity (20%)
          let geoScore = 0;
          const peerState = r.primary_state?.toUpperCase() || null;
          const peerCity = r.primary_city?.toUpperCase() || null;
          if (sourceCity && peerCity && sourceState && peerState &&
              sourceCity === peerCity && sourceState === peerState) {
            geoScore = 1.0; // same city
          } else if (sourceState && peerState) {
            if (sourceState === peerState) {
              geoScore = 0.6; // same state
            } else {
              const srcRegion = STATE_REGION[sourceState];
              const peerRegion = peerState ? STATE_REGION[peerState] : null;
              if (srcRegion && peerRegion && srcRegion === peerRegion) {
                geoScore = 0.3; // same region
              }
            }
          }

          // Signal 3: Scale similarity — log-ratio of total funding (15%)
          let scaleScore = 0.5; // neutral default
          const peerFunding = Number(r.total_funding) || 0;
          if (sourceFunding > 0 && peerFunding > 0) {
            const logDiff = Math.abs(Math.log10(sourceFunding) - Math.log10(peerFunding));
            scaleScore = Math.max(0, 1.0 - logDiff * 0.4);
          }

          // Signal 4: Hit volume — more matching grants = stronger signal (10%)
          const hitScore = c.hitCount / maxHits;

          const composite =
            focusScore * W_FOCUS +
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
        })
        .filter(Boolean) as Array<{
          id: string; name: string; score: number; matchedMission: string;
          state: string | null; totalFunding: number | null;
        }>;

      scored.sort((a, b) => b.score - a.score);
      const peers = scored.slice(0, MAX_PEERS);

      return new Response(JSON.stringify({ peers }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // ── Funder peers ─────────────────────────────────────────────────────

    // Step 1: Get this funder's grantees (by EIN) from last N years
    const sourceGrants = (await restQuery(
      'foundation_grants',
      `foundation_id=eq.${encodeURIComponent(entityId)}&grant_year=gte.${minYear}&grantee_ein=not.is.null&select=grantee_ein,grantee_name&limit=5000`,
    )) as GrantRow[];

    if (sourceGrants.length === 0) {
      return new Response(JSON.stringify({ peers: [] }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Unique grantee EINs for this funder
    const sourceEins = new Set(
      sourceGrants.map((g) => g.grantee_ein!).filter(Boolean),
    );

    if (sourceEins.size < 2) {
      return new Response(JSON.stringify({ peers: [] }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Step 2: Find other funders who also funded these grantees
    const einList = Array.from(sourceEins);
    const candidateShared = new Map<string, Set<string>>();

    const BATCH = 50;
    for (let i = 0; i < einList.length && i < 500; i += BATCH) {
      const batch = einList.slice(i, i + BATCH);
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

    // Step 3: Fetch source funder details for multi-factor scoring
    const sourceFunderRows = (await restQuery(
      'funders',
      `id=eq.${encodeURIComponent(entityId)}&select=id,name,state,total_giving,ntee_code&limit=1`,
    )) as FunderRow[];
    const sourceFunder = sourceFunderRows[0] || null;

    // Pre-filter candidates that meet minimum shared threshold
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

    // Step 4: Enrich candidates with funder details for multi-factor scoring
    qualifiedCandidates.sort((a, b) => b.sharedSet.size - a.sharedSet.size);
    const funderEnrichPool = qualifiedCandidates.slice(0, 50);

    const peerIds = funderEnrichPool.map((c) => c.funderId);
    const idFilter = `(${peerIds.map((id) => `"${id}"`).join(',')})`;
    const funderRows = (await restQuery(
      'funders',
      `id=in.${idFilter}&select=id,name,state,total_giving,ntee_code`,
    )) as FunderRow[];

    const funderLookup = new Map(funderRows.map((f) => [f.id, f]));

    // ── Multi-factor scoring (FEAT-007) ─────────────────────────────────
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

        // Signal 1: Shared grantees overlap (Jaccard-like)
        const sharedScore = Math.min(c.sharedSet.size / sourceEins.size, 1.0);

        // Signal 2: NTEE code match
        let nteeScore = 0;
        if (sourceNtee && f.ntee_code) {
          const peerNtee = f.ntee_code.charAt(0).toUpperCase();
          if (sourceNtee === peerNtee) nteeScore = 1.0;
        }

        // Signal 3: Budget proximity (log-scale comparison)
        let budgetScore = 0.5;
        if (sourceGiving && sourceGiving > 0 && f.total_giving && f.total_giving > 0) {
          const logDiff = Math.abs(Math.log10(sourceGiving) - Math.log10(f.total_giving));
          budgetScore = Math.max(0, 1.0 - logDiff * 0.5);
        }

        // Signal 4: Geographic overlap
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

        // Composite score
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
