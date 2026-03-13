/**
 * compute-peers — Supabase Edge Function
 *
 * Finds similar funders/recipients using multi-signal scoring:
 * - Shared grantees/funders overlap (Jaccard-like)
 * - Geographic proximity (state + census region)
 * - Budget/revenue similarity (log-scale)
 * - NTEE code match (funders only — recipient ntee_codes currently unpopulated)
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

    // ── Recipient peers: find similar orgs by geography, budget, and mission keywords ──
    if (entityType === 'recipient') {
      // Step 1: Resolve source recipient details
      const isUuid = entityId.includes('-') && entityId.length > 20;
      const lookupField = isUuid ? 'id' : 'ein';
      const sourceRows = (await restQuery(
        'recipient_organizations',
        `${lookupField}=eq.${encodeURIComponent(entityId)}&select=id,ein,name,name_normalized,primary_city,primary_state,total_funding,funder_count&limit=1`,
      )) as Array<{
        id: string; ein: string; name: string; name_normalized: string | null;
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

      // Extract meaningful keywords from the normalized name for mission-proxy matching
      const STOP_WORDS = new Set([
        'inc', 'org', 'the', 'of', 'and', 'for', 'a', 'an', 'in', 'to',
        'co', 'llc', 'ltd', 'corp', 'corporation', 'association', 'foundation',
        'fund', 'trust', 'society', 'national', 'american', 'international',
        'united', 'new', 'st', 'project', 'program', 'group', 'center',
        'centre', 'institute', 'council', 'committee', 'board', 'service',
        'services', 'community', 'north', 'south', 'east', 'west',
      ]);
      const nameWords = (source.name_normalized || '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));

      // Step 2: Pull candidate pools from recipient_organizations
      // Pool A: Same state, similar budget (primary candidates)
      // Pool B: Same region, similar budget (fallback for geographic breadth)
      // Pool C: Name-keyword matches anywhere (mission similarity)
      const candidateMap = new Map<string, {
        id: string; ein: string; name: string; name_normalized: string | null;
        primary_city: string | null; primary_state: string | null;
        total_funding: number | null; funder_count: number | null;
      }>();

      // Budget range: 0.1x to 10x of source funding (1 order of magnitude)
      const budgetLow = Math.max(1, Math.floor(sourceFunding * 0.1));
      const budgetHigh = Math.ceil(sourceFunding * 10);

      // Pool A: Same state + budget range + minimum grant count
      if (sourceState) {
        const poolA = (await restQuery(
          'recipient_organizations',
          `primary_state=eq.${encodeURIComponent(sourceState)}&total_funding=gte.${budgetLow}&total_funding=lte.${budgetHigh}&grant_count=gte.${MIN_GRANTS_FOR_PEER}&id=neq.${encodeURIComponent(source.id)}&select=id,ein,name,name_normalized,primary_city,primary_state,total_funding,funder_count&limit=100`,
        )) as typeof sourceRows;
        for (const r of poolA) candidateMap.set(r.id, r);
      }

      // Pool B: Same region (different state), budget range — only if we need more
      if (candidateMap.size < 50 && sourceState) {
        const srcRegion = STATE_REGION[sourceState];
        if (srcRegion) {
          const regionStates = Object.entries(STATE_REGION)
            .filter(([st, rg]) => rg === srcRegion && st !== sourceState)
            .map(([st]) => st);
          if (regionStates.length > 0) {
            const stateFilter = `(${regionStates.map(s => `"${s}"`).join(',')})`;
            const poolB = (await restQuery(
              'recipient_organizations',
              `primary_state=in.${stateFilter}&total_funding=gte.${budgetLow}&total_funding=lte.${budgetHigh}&grant_count=gte.${MIN_GRANTS_FOR_PEER}&id=neq.${encodeURIComponent(source.id)}&select=id,ein,name,name_normalized,primary_city,primary_state,total_funding,funder_count&limit=50`,
            )) as typeof sourceRows;
            for (const r of poolB) candidateMap.set(r.id, r);
          }
        }
      }

      // Pool C: Name keyword matches (mission proxy) — search for distinctive words
      if (nameWords.length > 0) {
        // Use the most distinctive keyword (longest word, likely most specific)
        const distinctiveWords = nameWords.sort((a, b) => b.length - a.length).slice(0, 2);
        for (const word of distinctiveWords) {
          if (candidateMap.size >= 150) break;
          const poolC = (await restQuery(
            'recipient_organizations',
            `name_normalized=ilike.*${encodeURIComponent(word)}*&grant_count=gte.${MIN_GRANTS_FOR_PEER}&id=neq.${encodeURIComponent(source.id)}&select=id,ein,name,name_normalized,primary_city,primary_state,total_funding,funder_count&limit=50`,
          )) as typeof sourceRows;
          for (const r of poolC) candidateMap.set(r.id, r);
        }
      }

      // Remove for-profit entities (LLCs, LPs, etc.) and government agencies
      for (const [cId, cRow] of candidateMap) {
        if (isLikelyNonNonprofit(cRow.name || '')) candidateMap.delete(cId);
      }

      if (candidateMap.size === 0) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Step 3: Multi-factor scoring
      // Signal 1: Geographic proximity (35%) — same city=1.0, same state=0.7, same region=0.4
      // Signal 2: Budget similarity (35%) — log-scale comparison
      // Signal 3: Name/mission keywords (30%) — Jaccard of name words

      const R_WEIGHT_GEO     = 0.35;
      const R_WEIGHT_BUDGET  = 0.35;
      const R_WEIGHT_MISSION = 0.30;

      const scored = Array.from(candidateMap.values())
        .map(r => {
          // Signal 1: Geographic proximity
          let geoScore = 0;
          const peerState = r.primary_state?.toUpperCase() || null;
          const peerCity = r.primary_city?.toUpperCase() || null;
          if (sourceCity && peerCity && sourceState && peerState &&
              sourceCity === peerCity && sourceState === peerState) {
            geoScore = 1.0; // same city + state
          } else if (sourceState && peerState) {
            if (sourceState === peerState) {
              geoScore = 0.7; // same state, different city
            } else {
              const srcRegion = STATE_REGION[sourceState];
              const peerRegion = peerState ? STATE_REGION[peerState] : null;
              if (srcRegion && peerRegion && srcRegion === peerRegion) {
                geoScore = 0.4; // same region
              }
            }
          }

          // Signal 2: Budget similarity (log-scale)
          let budgetScore = 0.3; // default if data missing
          const peerFunding = Number(r.total_funding) || 0;
          if (sourceFunding > 0 && peerFunding > 0) {
            const logDiff = Math.abs(Math.log10(sourceFunding) - Math.log10(peerFunding));
            budgetScore = Math.max(0, 1.0 - logDiff * 0.5);
          }

          // Signal 3: Name/mission keyword overlap (Jaccard of meaningful words)
          let missionScore = 0;
          if (nameWords.length > 0 && r.name_normalized) {
            const peerWords = r.name_normalized
              .split(/\s+/)
              .filter(w => w.length > 2 && !STOP_WORDS.has(w));
            if (peerWords.length > 0) {
              const peerSet = new Set(peerWords);
              const intersection = nameWords.filter(w => peerSet.has(w)).length;
              const union = new Set([...nameWords, ...peerWords]).size;
              missionScore = union > 0 ? intersection / union : 0;
            }
          }

          const composite =
            geoScore * R_WEIGHT_GEO +
            budgetScore * R_WEIGHT_BUDGET +
            missionScore * R_WEIGHT_MISSION;

          return {
            id: r.id,
            name: r.name,
            score: Math.round(composite * 1000) / 1000,
            sharedCount: 0, // not based on shared funders
            state: r.primary_state,
            totalFunding: Number(r.total_funding) || null,
          };
        });

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
