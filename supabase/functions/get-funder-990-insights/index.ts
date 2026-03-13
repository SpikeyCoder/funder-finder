/**
 * get-funder-990-insights — Supabase Edge Function
 *
 * Returns aggregated 990 grant intelligence for a single funder:
 *   - Giving trend by year (grant count, total amount, avg grant)
 *   - Grantee analysis (total unique, new vs repeat, % repeat)
 *   - Geographic footprint (grants by state)
 *   - Key recipients (top grantees by total amount)
 *   - Data quality score
 *
 * Input:  { funderId: string }
 * Output: FunderInsights (see src/types.ts)
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
  'http://localhost:5173',
]);

const MIN_YEAR = new Date().getUTCFullYear() - 10; // 10 years of trend data
const RECENT_WINDOW = 5; // 5-year window for grantee analysis
const TOP_RECIPIENTS_LIMIT = 20;
const TOP_GEO_LIMIT = 15;

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

async function rpcFetch(
  functionName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RPC ${functionName} failed [${res.status}]: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function restQuery(
  table: string,
  queryParams: string,
): Promise<unknown[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${queryParams}`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`REST query ${table} failed [${res.status}]: ${body.slice(0, 500)}`);
  }
  return res.json() as Promise<unknown[]>;
}

interface GrantRow {
  grant_year: number;
  grant_amount: number | null;
  grantee_name: string;
  grantee_ein: string | null;
  grantee_state: string | null;
  purpose_text: string | null;
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const funderId = typeof body?.funderId === 'string' ? body.funderId.trim() : '';
    if (!funderId) {
      return new Response(
        JSON.stringify({ error: 'funderId is required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch all grants for this funder (limit to reasonable window)
    const grants = (await restQuery(
      'foundation_grants',
      `foundation_id=eq.${encodeURIComponent(funderId)}&grant_year=gte.${MIN_YEAR}&select=grant_year,grant_amount,grantee_name,grantee_ein,grantee_state,purpose_text&order=grant_year.desc&limit=50000`,
    )) as GrantRow[];

    if (grants.length === 0) {
      // Return empty-but-valid structure so the UI shows "no data" gracefully
      return new Response(
        JSON.stringify({
          funderId,
          grantHistory: { totalGrants: 0, totalAmount: 0, yearTrend: [] },
          granteeAnalysis: {
            totalGrantees5y: 0,
            newGrantees: 0,
            repeatGrantees: 0,
            pctRepeat: 0,
          },
          geographicFootprint: [],
          keyRecipients: [],
          recentGrantPurposes: [],
          dataQuality: { completenessScore: 0, totalRecords: 0 },
        }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // ── 1. Giving Trends by Year ──────────────────────────────────────────
    const yearMap = new Map<number, { count: number; total: number }>();
    let totalAmount = 0;
    for (const g of grants) {
      const yr = g.grant_year;
      const amt = g.grant_amount ?? 0;
      totalAmount += amt;
      const entry = yearMap.get(yr) || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += amt;
      yearMap.set(yr, entry);
    }

    const yearTrend = Array.from(yearMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([year, { count, total }]) => ({
        year,
        grantCount: count,
        totalAmount: Math.round(total),
        avgGrant: count > 0 ? Math.round(total / count) : 0,
      }));

    // ── 2. Grantee Analysis (5-year window) ───────────────────────────────
    const currentYear = new Date().getUTCFullYear();
    const recentCutoff = currentYear - RECENT_WINDOW;

    // Track grantees by EIN (preferred) or normalized name
    const normalizeGranteeName = (name: string) =>
      name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 80);

    const granteeKey = (g: GrantRow) =>
      g.grantee_ein || normalizeGranteeName(g.grantee_name);

    // All grantees and their first appearance year
    const granteeFirstYear = new Map<string, number>();
    for (const g of grants) {
      const key = granteeKey(g);
      const existing = granteeFirstYear.get(key);
      if (!existing || g.grant_year < existing) {
        granteeFirstYear.set(key, g.grant_year);
      }
    }

    // Grantees in the recent window
    const recentGrants = grants.filter((g) => g.grant_year >= recentCutoff);
    const recentGrantees = new Set(recentGrants.map(granteeKey));
    const totalGrantees5y = recentGrantees.size;

    // Count how many appeared for the first time within the window
    let newGrantees = 0;
    for (const key of recentGrantees) {
      const firstYear = granteeFirstYear.get(key);
      if (firstYear && firstYear >= recentCutoff) newGrantees++;
    }
    const repeatGrantees = totalGrantees5y - newGrantees;
    const pctRepeat =
      totalGrantees5y > 0
        ? Math.round((repeatGrantees / totalGrantees5y) * 100)
        : 0;

    // ── 3. Geographic Footprint ───────────────────────────────────────────
    const geoMap = new Map<string, { count: number; total: number }>();
    let geoTotal = 0;
    for (const g of recentGrants) {
      const st = g.grantee_state?.trim().toUpperCase();
      if (!st) continue;
      geoTotal++;
      const entry = geoMap.get(st) || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += g.grant_amount ?? 0;
      geoMap.set(st, entry);
    }

    const geographicFootprint = Array.from(geoMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, TOP_GEO_LIMIT)
      .map(([state, { count, total }]) => ({
        state,
        grantCount: count,
        totalAmount: Math.round(total),
        pctOfGrants: geoTotal > 0 ? Math.round((count / geoTotal) * 100) : 0,
      }));

    // ── 4. Key Recipients ─────────────────────────────────────────────────
    const recipientMap = new Map<
      string,
      { name: string; ein: string | null; count: number; total: number; lastYear: number }
    >();
    for (const g of grants) {
      const key = granteeKey(g);
      const entry = recipientMap.get(key) || {
        name: g.grantee_name,
        ein: g.grantee_ein,
        count: 0,
        total: 0,
        lastYear: 0,
      };
      entry.count += 1;
      entry.total += g.grant_amount ?? 0;
      if (g.grant_year > entry.lastYear) entry.lastYear = g.grant_year;
      // Prefer the most common name form (usually longest)
      if (g.grantee_name.length > entry.name.length) entry.name = g.grantee_name;
      recipientMap.set(key, entry);
    }

    const keyRecipients = Array.from(recipientMap.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_RECIPIENTS_LIMIT)
      .map(({ name, ein, count, total, lastYear }) => ({
        granteeEin: ein,
        granteeName: name,
        grantCount: count,
        totalAmount: Math.round(total),
        lastYear,
      }));

    // ── 5. Recent Grant Purposes (FEAT-001) ───────────────────────────────
    // Grab up to 25 recent, distinct purpose descriptions for display
    const purposesSeen = new Set<string>();
    const recentGrantPurposes: Array<{
      purpose: string;
      granteeName: string;
      amount: number | null;
      year: number;
    }> = [];
    for (const g of grants) {
      if (recentGrantPurposes.length >= 25) break;
      const text = g.purpose_text?.trim();
      if (!text || text.length < 10) continue;
      // Deduplicate by first 60 chars
      const dedup = text.slice(0, 60).toUpperCase();
      if (purposesSeen.has(dedup)) continue;
      purposesSeen.add(dedup);
      recentGrantPurposes.push({
        purpose: text,
        granteeName: g.grantee_name,
        amount: g.grant_amount,
        year: g.grant_year,
      });
    }

    // ── 6. Data Quality Score ─────────────────────────────────────────────
    let qualityPoints = 0;
    const totalRecords = grants.length;
    const hasAmount = grants.filter((g) => g.grant_amount != null).length;
    const hasEin = grants.filter((g) => g.grantee_ein).length;
    const hasState = grants.filter((g) => g.grantee_state).length;
    const hasPurpose = grants.filter((g) => g.purpose_text).length;
    qualityPoints += (hasAmount / totalRecords) * 25;
    qualityPoints += (hasEin / totalRecords) * 25;
    qualityPoints += (hasState / totalRecords) * 25;
    qualityPoints += (hasPurpose / totalRecords) * 25;
    const completenessScore = Math.round(qualityPoints);

    // ── Build response ────────────────────────────────────────────────────
    const result = {
      funderId,
      grantHistory: {
        totalGrants: grants.length,
        totalAmount: Math.round(totalAmount),
        yearTrend,
      },
      granteeAnalysis: {
        totalGrantees5y,
        newGrantees,
        repeatGrantees,
        pctRepeat,
      },
      geographicFootprint,
      keyRecipients,
      recentGrantPurposes,
      dataQuality: { completenessScore, totalRecords },
    };

    return new Response(JSON.stringify(result), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    console.error('get-funder-990-insights error:', err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'Internal server error',
      }),
      {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' },
      },
    );
  }
});
