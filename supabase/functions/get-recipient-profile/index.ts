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
const SUPABASE_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
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
  ntee_code: string | null;
  state: string | null;
}

// Known Donor-Advised Fund (DAF) sponsor EINs — these are intermediaries, not direct funders
const DAF_EINS = new Set([
  '110303001',  // Fidelity Investments Charitable Gift Fund
  '934792247',  // Fidelity Investments Charitable Gift Fund (alt)
  '311640316',  // Schwab Charitable Fund
  '341747398',  // American Endowment Foundation
  '450931286',  // PayPal Charitable Giving Fund
  '810739440',  // American Online Giving Foundation
  '233100408',  // National Philanthropic Trust
  '204073032',  // Vanguard Charitable Endowment Program
  '522166327',  // Goldman Sachs Philanthropy Fund
  '133791717',  // Morgan Stanley Global Impact Funding Trust
  '208106820',  // BNY Mellon Charitable Gift Fund
  '900614284',  // Renaissance Charitable Foundation
]);

// NTEE codes that indicate DAF / fiscal sponsorship intermediaries
const DAF_NTEE_PREFIXES = ['T11', 'T12', 'T30'];

function isDonorAdvisedFund(funderId: string, funderName: string, nteeCode: string | null): boolean {
  if (DAF_EINS.has(funderId)) return true;
  if (nteeCode && DAF_NTEE_PREFIXES.some(p => nteeCode.startsWith(p))) return true;
  const lower = funderName.toLowerCase();
  if (lower.includes('donor advised') || lower.includes('donor-advised')) return true;
  if (lower.includes('charitable gift fund')) return true;
  if (lower.includes('charitable giving fund')) return true;
  return false;
}

/**
 * Fetch the grantee's latest 990 financial data from ProPublica API.
 * Returns { totalRevenue, totalExpenses, taxYear } or null if unavailable.
 */
async function fetchGrantee990Budget(ein: string): Promise<{
  totalRevenue: number | null;
  totalExpenses: number | null;
  taxYear: number | null;
} | null> {
  try {
    const resp = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`,
      { headers: { 'User-Agent': 'FunderMatch/1.0' } },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const org = data?.organization;
    if (!org) return null;

    // Org-level fields (available for most orgs)
    const orgIncome = typeof org.income_amount === 'number' ? org.income_amount : null;

    // Filing-level fields have more detail (totfuncexpns = total functional expenses)
    let totalExpenses: number | null = null;
    let totalRevenue: number | null = orgIncome;
    let taxYear: number | null = null;

    const filings = data?.filings_with_data;
    if (Array.isArray(filings) && filings.length > 0) {
      const latest = filings[0];
      taxYear = latest?.tax_prd_yr ?? null;
      // Pull expenses from the filing if available
      if (typeof latest?.totfuncexpns === 'number') {
        totalExpenses = latest.totfuncexpns;
      }
      // Filing-level revenue is more accurate than org-level
      if (typeof latest?.totrevenue === 'number') {
        totalRevenue = latest.totrevenue;
      }
    }

    if (totalRevenue === null && totalExpenses === null) return null;

    return { totalRevenue, totalExpenses, taxYear };
  } catch (_e) {
    return null; // non-critical
  }
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

    // Resolve the EIN to query grants with
    let lookupEin = ein;

    if (!lookupEin && recipientId) {
      // recipientId might be a UUID (from OrgSearch) — resolve it to an EIN
      const isUuid = recipientId.includes('-') && recipientId.length > 20;
      if (isUuid) {
        const rows = (await restQuery(
          'recipient_organizations',
          `id=eq.${encodeURIComponent(recipientId)}&select=ein&limit=1`,
        )) as Array<{ ein: string }>;
        if (rows.length > 0) {
          lookupEin = rows[0].ein;
        }
      } else {
        // recipientId is likely an EIN itself (e.g. from peer links)
        lookupEin = recipientId;
      }
    }

    if (!lookupEin) {
      return new Response(
        JSON.stringify({ error: 'ein or recipientId is required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch grants and 990 budget concurrently
    const [grants, budget990] = await Promise.all([
      restQuery(
        'foundation_grants',
        `grantee_ein=eq.${encodeURIComponent(lookupEin)}&select=foundation_id,grant_year,grant_amount,grantee_name,grantee_ein,grantee_city,grantee_state&order=grant_year.desc&limit=10000`,
      ) as Promise<GrantRow[]>,
      fetchGrantee990Budget(lookupEin),
    ]);

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

    // Sort all funders by total giving, take a larger pool to allow for DAF filtering
    const allFunderIds = Array.from(funderAgg.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 30); // fetch extra to compensate for filtered DAFs

    // Enrich with funder names, NTEE codes, and states
    const funderIds = allFunderIds.map(([id]) => id);
    let funderLookup = new Map<string, FunderRow>();
    if (funderIds.length > 0) {
      const idFilter = `(${funderIds.map((id) => `"${id}"`).join(',')})`;
      const funderRows = (await restQuery(
        'funders',
        `id=in.${idFilter}&select=id,name,ntee_code,state`,
      )) as FunderRow[];
      funderLookup = new Map(funderRows.map((f) => [f.id, f]));
    }

    // Return top 25 funders with isDaf flag and funderState (frontend handles filtering)
    const topFunders = allFunderIds
      .map(([fId, agg]) => {
        const funder = funderLookup.get(fId);
        const funderName = funder?.name || fId;
        const nteeCode = funder?.ntee_code || null;
        return {
          funderId: fId,
          funderName,
          grantCount: agg.count,
          totalAmount: Math.round(agg.total),
          lastYear: agg.lastYear,
          isDaf: isDonorAdvisedFund(fId, funderName, nteeCode),
          funderState: funder?.state || null,
        };
      })
      .slice(0, 25);

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
      // 990 budget data from ProPublica (null if unavailable)
      budget: budget990,
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
