/**
 * get-recipient-profile — Supabase Edge Function
 *
 * Returns a comprehensive profile for a grant recipient (nonprofit)
 * by aggregating their grants from foundation_grants.
 *
 * Input:  { recipientId?: string, ein?: string }
 * Output: RecipientProfile (see src/types.ts)
 */

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
  grant_year: number;
  grant_amount: number | null;
  grantee_name: string;
  grantee_ein: string | null;
  grantee_city: string | null;
  grantee_state: string | null;
}

interface FunderRow {
  id: string;
  name: string;
}

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
    const ein = typeof body?.ein === 'string' ? body.ein.trim() : '';
    const recipientId = typeof body?.recipientId === 'string' ? body.recipientId.trim() : '';

    // Use EIN if provided, otherwise try recipientId (which may also be an EIN)
    const lookupEin = ein || recipientId;
    if (!lookupEin) {
      return new Response(
        JSON.stringify({ error: 'ein or recipientId is required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch all grants where this org is the grantee
    const grants = (await restQuery(
      'foundation_grants',
      `grantee_ein=eq.${encodeURIComponent(lookupEin)}&select=foundation_id,grant_year,grant_amount,grantee_name,grantee_ein,grantee_city,grantee_state&order=grant_year.desc&limit=10000`,
    )) as GrantRow[];

    if (grants.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Recipient not found' }),
        { status: 404, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Determine name, location from most recent grant
    const name = grants[0].grantee_name;
    const city = grants[0].grantee_city;
    const state = grants[0].grantee_state;

    // Funding summary
    let totalFunding = 0;
    const funderSet = new Set<string>();
    let firstYear: number | null = null;
    let lastYear: number | null = null;

    for (const g of grants) {
      totalFunding += g.grant_amount ?? 0;
      funderSet.add(g.foundation_id);
      if (firstYear === null || g.grant_year < firstYear) firstYear = g.grant_year;
      if (lastYear === null || g.grant_year > lastYear) lastYear = g.grant_year;
    }

    // Yearly trends
    const yearMap = new Map<number, { count: number; total: number; funders: Set<string> }>();
    for (const g of grants) {
      const entry = yearMap.get(g.grant_year) || { count: 0, total: 0, funders: new Set() };
      entry.count += 1;
      entry.total += g.grant_amount ?? 0;
      entry.funders.add(g.foundation_id);
      yearMap.set(g.grant_year, entry);
    }

    const yearlyTrends = Array.from(yearMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([year, { count, total, funders }]) => ({
        year,
        grantCount: count,
        totalAmount: Math.round(total),
        funderCount: funders.size,
      }));

    // Top funders
    const funderAgg = new Map<string, { count: number; total: number; lastYear: number }>();
    for (const g of grants) {
      const entry = funderAgg.get(g.foundation_id) || { count: 0, total: 0, lastYear: 0 };
      entry.count += 1;
      entry.total += g.grant_amount ?? 0;
      if (g.grant_year > entry.lastYear) entry.lastYear = g.grant_year;
      funderAgg.set(g.foundation_id, entry);
    }

    const topFunderIds = Array.from(funderAgg.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15);

    // Enrich with funder names
    const funderIds = topFunderIds.map(([id]) => id);
    let funderLookup = new Map<string, string>();
    if (funderIds.length > 0) {
      const idFilter = `(${funderIds.map((id) => `"${id}"`).join(',')})`;
      const funderRows = (await restQuery(
        'funders',
        `id=in.${idFilter}&select=id,name`,
      )) as FunderRow[];
      funderLookup = new Map(funderRows.map((f) => [f.id, f.name]));
    }

    const topFunders = topFunderIds.map(([fId, agg]) => ({
      funderId: fId,
      funderName: funderLookup.get(fId) || fId,
      grantCount: agg.count,
      totalAmount: Math.round(agg.total),
      lastYear: agg.lastYear,
    }));

    const result = {
      id: lookupEin,
      ein: lookupEin,
      name,
      location: { city, state },
      fundingSummary: {
        totalFunding: Math.round(totalFunding),
        grantCount: grants.length,
        funderCount: funderSet.size,
        firstGrantYear: firstYear,
        lastGrantYear: lastYear,
      },
      yearlyTrends,
      topFunders,
      ntee_codes: [],
    };

    return new Response(JSON.stringify(result), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    console.error('get-recipient-profile error:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
