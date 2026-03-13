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
    // Uses grant purpose_text to extract mission keywords, then finds other
    // recipients with overlapping mission areas. Geography is a minor secondary signal.
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

      // Step 3: Extract mission keywords from purpose_text
      // These are the mission-relevant terms we look for in grant descriptions
      const MISSION_KEYWORDS: Record<string, string[]> = {
        'housing': ['housing', 'shelter', 'homeless', 'homelessness', 'transitional housing', 'permanent supportive housing', 'affordable housing', 'rent assistance', 'rental assistance'],
        'mental_health': ['mental health', 'behavioral health', 'psychiatric', 'counseling', 'therapy', 'substance abuse', 'addiction', 'recovery', 'drug', 'alcohol'],
        'food': ['food', 'hunger', 'nutrition', 'meal', 'meals', 'food bank', 'food pantry', 'feeding'],
        'education': ['education', 'school', 'scholarship', 'tutoring', 'literacy', 'learning', 'academic', 'stem', 'after-school', 'afterschool'],
        'youth': ['youth', 'children', 'child', 'teen', 'adolescent', 'juvenile', 'kids', 'young people', 'foster'],
        'health': ['health', 'medical', 'clinic', 'hospital', 'healthcare', 'health care', 'patient', 'disease', 'wellness'],
        'arts': ['arts', 'art', 'music', 'theater', 'theatre', 'dance', 'cultural', 'museum', 'gallery', 'creative', 'performing arts'],
        'environment': ['environment', 'conservation', 'climate', 'wildlife', 'ecological', 'sustainability', 'clean water', 'clean energy', 'nature', 'land trust'],
        'workforce': ['workforce', 'employment', 'job training', 'job placement', 'career', 'vocational', 'workforce development'],
        'disability': ['disability', 'disabilities', 'disabled', 'accessibility', 'special needs', 'deaf', 'blind', 'autism'],
        'domestic_violence': ['domestic violence', 'domestic abuse', 'sexual assault', 'violence prevention', 'victim', 'survivors', 'abuse'],
        'seniors': ['senior', 'seniors', 'elderly', 'aging', 'older adults', 'elder care', 'retirement'],
        'immigrant': ['immigrant', 'immigration', 'refugee', 'migrant', 'asylum', 'newcomer', 'resettlement'],
        'legal': ['legal', 'legal aid', 'legal services', 'justice', 'advocacy', 'civil rights', 'human rights'],
        'animals': ['animal', 'animals', 'veterinary', 'pet', 'humane', 'spay', 'neuter', 'rescue'],
        'religion': ['church', 'religious', 'faith', 'ministry', 'congregation', 'worship', 'spiritual'],
        'poverty': ['poverty', 'low-income', 'low income', 'underserved', 'disadvantaged', 'economic empowerment'],
        'community_dev': ['community development', 'neighborhood', 'civic', 'capacity building', 'community organizing'],
        'emergency': ['emergency', 'disaster', 'crisis', 'relief', 'emergency services', 'first responders'],
        'human_services': ['human services', 'social services', 'case management', 'supportive services', 'wraparound'],
      };

      // Generic terms to ignore (not mission-relevant)
      const GENERIC_PURPOSES = new Set([
        'general support', 'general operating', 'unrestricted', 'operating support',
        'general purpose', 'charitable purpose', 'charitable purposes',
        'general operations', 'annual fund', 'capital campaign',
      ]);

      // Aggregate all purpose texts for this recipient
      const allPurposeText = sourceGrants
        .map(g => g.purpose_text?.toLowerCase().trim() || '')
        .filter(t => t.length > 0 && !GENERIC_PURPOSES.has(t));

      const combinedText = allPurposeText.join(' ');

      // Find which mission categories match this recipient
      const sourceMissionCategories = new Set<string>();
      const sourceMissionSearchTerms: string[] = [];

      for (const [category, terms] of Object.entries(MISSION_KEYWORDS)) {
        for (const term of terms) {
          if (combinedText.includes(term)) {
            sourceMissionCategories.add(category);
            // Collect the most specific matching terms for SQL search (max 2 per category)
            if (!sourceMissionSearchTerms.some(t => t === term)) {
              sourceMissionSearchTerms.push(term);
            }
            break; // one match per category is enough
          }
        }
      }

      if (sourceMissionCategories.size === 0) {
        // Fallback: use the most common non-generic purpose texts as search terms
        const purposeFreq = new Map<string, number>();
        for (const t of allPurposeText) {
          if (t.length > 3 && t.length < 60) {
            purposeFreq.set(t, (purposeFreq.get(t) || 0) + 1);
          }
        }
        const topPurposes = Array.from(purposeFreq.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([text]) => text);
        for (const p of topPurposes) {
          sourceMissionSearchTerms.push(p);
          sourceMissionCategories.add(`custom_${p.slice(0, 20)}`);
        }
      }

      if (sourceMissionCategories.size === 0) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Step 4: For each mission search term, find candidate recipients via purpose_text
      // Use the most distinctive terms (up to 8) to query foundation_grants
      const searchTerms = sourceMissionSearchTerms.slice(0, 8);
      const candidateKeywordHits = new Map<string, Set<string>>(); // grantee_ein -> matched categories

      for (const term of searchTerms) {
        // Find the category this term belongs to
        let matchedCategory = '';
        for (const [cat, terms] of Object.entries(MISSION_KEYWORDS)) {
          if (terms.includes(term)) { matchedCategory = cat; break; }
        }
        if (!matchedCategory) matchedCategory = `custom_${term.slice(0, 20)}`;

        // Use PostgREST ilike filter on purpose_text to find matching grants
        const encoded = encodeURIComponent(`*${term}*`);
        const candidateGrants = (await restQuery(
          'foundation_grants',
          `purpose_text=ilike.${encoded}&grantee_ein=not.is.null&grantee_ein=neq.${encodeURIComponent(source.ein)}&select=grantee_ein&limit=3000`,
        )) as Array<{ grantee_ein: string }>;

        for (const g of candidateGrants) {
          if (!g.grantee_ein) continue;
          const cats = candidateKeywordHits.get(g.grantee_ein) || new Set();
          cats.add(matchedCategory);
          candidateKeywordHits.set(g.grantee_ein, cats);
        }
      }

      // Step 5: Score candidates by mission keyword overlap
      // Only keep candidates that match at least 2 mission categories (or 1 if source has ≤2)
      const minCategoryMatch = sourceMissionCategories.size <= 2 ? 1 : 2;

      const candidateScores: Array<{ ein: string; missionScore: number; matchedCategories: Set<string> }> = [];
      for (const [ein, matchedCats] of candidateKeywordHits) {
        if (matchedCats.size < minCategoryMatch) continue;

        // Jaccard similarity of mission categories
        const intersection = new Set([...matchedCats].filter(c => sourceMissionCategories.has(c)));
        const union = new Set([...matchedCats, ...sourceMissionCategories]);
        const missionScore = union.size > 0 ? intersection.size / union.size : 0;

        if (missionScore > 0) {
          candidateScores.push({ ein, missionScore, matchedCategories: intersection });
        }
      }

      // Sort by mission score, take top 60 for enrichment
      candidateScores.sort((a, b) => b.missionScore - a.missionScore);
      const enrichPool = candidateScores.slice(0, 60);

      if (enrichPool.length === 0) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Step 6: Enrich candidates from recipient_organizations
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

      // Step 7: Final scoring — mission similarity (85%) + geography (15%)
      const R_WEIGHT_MISSION = 0.85;
      const R_WEIGHT_GEO     = 0.15;

      const scored = enrichPool
        .map(c => {
          const r = enrichedMap.get(c.ein);
          if (!r) return null;
          // Filter out for-profit and government entities
          if (isLikelyNonNonprofit(r.name || '')) return null;
          // Filter out one-off recipients (need at least a few grants)
          if ((r.funder_count ?? 0) < MIN_GRANTS_FOR_PEER) return null;

          // Signal 1: Mission keyword overlap (primary — 85%)
          const missionScore = c.missionScore;

          // Signal 2: Geographic proximity (minor — 15%)
          let geoScore = 0;
          const peerState = r.primary_state?.toUpperCase() || null;
          const peerCity = r.primary_city?.toUpperCase() || null;
          if (sourceCity && peerCity && sourceState && peerState &&
              sourceCity === peerCity && sourceState === peerState) {
            geoScore = 1.0;
          } else if (sourceState && peerState) {
            if (sourceState === peerState) {
              geoScore = 0.7;
            } else {
              const srcRegion = STATE_REGION[sourceState];
              const peerRegion = peerState ? STATE_REGION[peerState] : null;
              if (srcRegion && peerRegion && srcRegion === peerRegion) {
                geoScore = 0.4;
              }
            }
          }

          const composite =
            missionScore * R_WEIGHT_MISSION +
            geoScore * R_WEIGHT_GEO;

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
