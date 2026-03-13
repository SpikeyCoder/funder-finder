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

    // ── Recipient peers: find other recipients who share funders ──────────
    if (entityType === 'recipient') {
      // entityId is the recipient's UUID (from recipient_organizations) or EIN
      // Step 1: Resolve recipient details (EIN, state, funding) for multi-factor scoring
      let recipientEin = entityId;
      let sourceState: string | null = null;
      let sourceFunding: number | null = null;

      if (entityId.includes('-') && entityId.length > 20) {
        // UUID — look up from recipient_organizations
        const recipientRows = (await restQuery(
          'recipient_organizations',
          `id=eq.${encodeURIComponent(entityId)}&select=ein,primary_state,total_funding&limit=1`,
        )) as Array<{ ein: string | null; primary_state: string | null; total_funding: number | null }>;
        recipientEin = recipientRows[0]?.ein || '';
        sourceState = recipientRows[0]?.primary_state?.toUpperCase() || null;
        sourceFunding = recipientRows[0]?.total_funding ?? null;
      } else {
        // EIN — look up state and funding
        const recipientRows = (await restQuery(
          'recipient_organizations',
          `ein=eq.${encodeURIComponent(entityId)}&select=ein,primary_state,total_funding&limit=1`,
        )) as Array<{ ein: string | null; primary_state: string | null; total_funding: number | null }>;
        sourceState = recipientRows[0]?.primary_state?.toUpperCase() || null;
        sourceFunding = recipientRows[0]?.total_funding ?? null;
      }

      if (!recipientEin) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Step 2: Get funders of this recipient
      const myGrants = (await restQuery(
        'foundation_grants',
        `grantee_ein=eq.${encodeURIComponent(recipientEin)}&grant_year=gte.${minYear}&select=foundation_id&limit=5000`,
      )) as Array<{ foundation_id: string }>;

      const myFunders = new Set(myGrants.map(g => g.foundation_id));
      if (myFunders.size < 1) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Step 3: Find other recipients funded by the same funders
      const funderList = Array.from(myFunders);
      const peerShared = new Map<string, Set<string>>(); // grantee_ein -> Set<shared_funder_ids>

      const BATCH = 50;
      for (let i = 0; i < funderList.length && i < 200; i += BATCH) {
        const batch = funderList.slice(i, i + BATCH);
        const fFilter = `(${batch.map(f => `"${f}"`).join(',')})`;
        const peerGrants = (await restQuery(
          'foundation_grants',
          `foundation_id=in.${fFilter}&grant_year=gte.${minYear}&grantee_ein=not.is.null&grantee_ein=neq.${encodeURIComponent(recipientEin)}&select=grantee_ein,foundation_id&limit=10000`,
        )) as Array<{ grantee_ein: string; foundation_id: string }>;

        for (const g of peerGrants) {
          if (!g.grantee_ein) continue;
          const set = peerShared.get(g.grantee_ein) || new Set();
          set.add(g.foundation_id);
          peerShared.set(g.grantee_ein, set);
        }
      }

      // Step 4: Pre-filter candidates with minimum shared funders, take top 50 for enrichment
      const recipientCandidates: Array<{ ein: string; sharedCount: number; sharedSet: Set<string> }> = [];
      for (const [ein, sharedFunderSet] of peerShared) {
        if (sharedFunderSet.size < MIN_SHARED) continue;
        recipientCandidates.push({ ein, sharedCount: sharedFunderSet.size, sharedSet: sharedFunderSet });
      }

      if (recipientCandidates.length === 0) {
        return new Response(JSON.stringify({ peers: [] }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Sort by raw shared count and take top 50 for enrichment
      recipientCandidates.sort((a, b) => b.sharedCount - a.sharedCount);
      const enrichPool = recipientCandidates.slice(0, 50);

      // Step 5: Enrich from recipient_organizations for multi-factor scoring
      const rEins = enrichPool.map(r => r.ein);
      const rFilter = `(${rEins.map(e => `"${e}"`).join(',')})`;
      const recipientRows = (await restQuery(
        'recipient_organizations',
        `ein=in.${rFilter}&select=id,ein,name,primary_state,total_funding,funder_count&limit=50`,
      )) as RecipientRow[];
      const rLookup = new Map(recipientRows.map(r => [r.ein, r]));

      // Step 6: Multi-factor scoring for recipient peers
      // Signal 1: Shared funders overlap (40%) — geometric mean normalization
      // Signal 2: Geographic proximity (30%) — same state=1.0, same region=0.5
      // Signal 3: Budget/funding proximity (30%) — log-scale comparison
      // (NTEE codes omitted — currently unpopulated for recipients)

      const R_WEIGHT_SHARED = 0.40;
      const R_WEIGHT_GEO    = 0.30;
      const R_WEIGHT_BUDGET = 0.30;

      const scored = enrichPool
        .map(c => {
          const r = rLookup.get(c.ein);
          if (!r) return null;

          // Signal 1: Shared funders — geometric mean normalization
          // sharedCount / sqrt(myFunders * peerFunders) gives a balanced Jaccard-like score
          const peerFunderCount = r.funder_count && r.funder_count > 0 ? r.funder_count : c.sharedCount;
          const denominator = Math.sqrt(myFunders.size * peerFunderCount);
          const sharedScore = denominator > 0 ? Math.min(c.sharedCount / denominator, 1.0) : 0;

          // Signal 2: Geographic proximity
          let geoScore = 0;
          const peerState = r.primary_state?.toUpperCase() || null;
          if (sourceState && peerState) {
            if (sourceState === peerState) {
              geoScore = 1.0;
            } else {
              const srcRegion = STATE_REGION[sourceState];
              const peerRegion = STATE_REGION[peerState];
              if (srcRegion && peerRegion && srcRegion === peerRegion) {
                geoScore = 0.5;
              }
            }
          }

          // Signal 3: Budget/funding proximity (log-scale)
          let budgetScore = 0.5; // default if data missing
          if (sourceFunding && sourceFunding > 0 && r.total_funding && r.total_funding > 0) {
            const logDiff = Math.abs(Math.log10(sourceFunding) - Math.log10(r.total_funding));
            // 0 diff = 1.0, 1 order of magnitude diff = 0.5, 2+ orders = ~0
            budgetScore = Math.max(0, 1.0 - logDiff * 0.5);
          }

          // Composite score
          const composite =
            sharedScore * R_WEIGHT_SHARED +
            geoScore * R_WEIGHT_GEO +
            budgetScore * R_WEIGHT_BUDGET;

          return {
            id: r.id,
            name: r.name,
            score: Math.round(composite * 1000) / 1000,
            sharedCount: c.sharedCount,
            state: r.primary_state,
            totalFunding: r.total_funding,
          };
        })
        .filter(Boolean);

      scored.sort((a, b) => (b?.score ?? 0) - (a?.score ?? 0));
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
