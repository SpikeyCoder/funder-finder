#!/usr/bin/env node
/**
 * ProPublica Nonprofit Explorer → Supabase ingestion script
 *
 * Fetches foundations (NTEE category T = Philanthropy/Grantmaking) from
 * ProPublica's free API and upserts them into the Supabase `funders` table.
 *
 * Usage:
 *   SUPABASE_URL=https://tgtotjvdubhjxzybmdex.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key> \
 *   node scripts/ingest-propublica.js
 *
 * Get your service role key from:
 *   https://supabase.com/dashboard/project/tgtotjvdubhjxzybmdex/settings/api
 *   (Project Settings → API → service_role secret)
 *
 * Run time: ~5-10 minutes for full T-category (thousands of orgs).
 * Re-running is safe — it upserts by EIN.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROPUBLICA_BASE = 'https://projects.propublica.org/nonprofits/api/v2';

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY env var is required.');
  console.error('Get it from: https://supabase.com/dashboard/project/tgtotjvdubhjxzybmdex/settings/api');
  process.exit(1);
}

// ── NTEE sub-codes we care about (Philanthropy / Grantmaking) ──────────────
// T20 = Private Grantmaking Foundations
// T21 = Corporate Foundations
// T22 = Private Independent Foundations
// T30 = Public Foundations
// T31 = Community Foundations
// T50 = Philanthropy, Charity & Voluntarism Promotion
const NTEE_CODES = ['T20', 'T21', 'T22', 'T30', 'T31', 'T50'];

// ── Focus area keyword map ─────────────────────────────────────────────────
const FOCUS_KEYWORDS = {
  education:       ['education','school','learning','literacy','college','university','scholarship','academic','stem','tutoring'],
  health:          ['health','medical','disease','cancer','mental health','hospital','wellness','medicine','research','clinical'],
  environment:     ['environment','climate','conservation','sustainability','nature','wildlife','ocean','energy','green','forest'],
  arts:            ['arts','culture','museum','theater','music','film','dance','creative','humanities','heritage'],
  housing:         ['housing','homeless','shelter','affordable','community development','real estate'],
  food:            ['food','hunger','nutrition','farming','agriculture','meals','pantry'],
  youth:           ['youth','children','child','kids','afterschool','mentoring','juvenile'],
  women:           ['women','girls','gender','femini','maternal'],
  racial_equity:   ['racial','equity','justice','civil rights','diversity','inclusion','minority','BIPOC','Black','Latino','Indigenous'],
  international:   ['international','global','developing','africa','asia','latin america','humanitarian','refugee'],
  veterans:        ['veteran','military','service member','armed forces'],
  disability:      ['disability','disabled','accessibility','special needs'],
  workforce:       ['workforce','employment','job','career','economic','poverty','economic mobility'],
  civic:           ['civic','democracy','voting','policy','advocacy','community organizing'],
  animal:          ['animal','wildlife','humane','pet','shelter','veterinary'],
  religion:        ['faith','religious','church','spiritual','interfaith'],
};

function extractFocusAreas(name = '', description = '') {
  const text = (name + ' ' + description).toLowerCase();
  return Object.entries(FOCUS_KEYWORDS)
    .filter(([, keywords]) => keywords.some(kw => text.includes(kw)))
    .map(([area]) => area);
}

function formatGrantRange(totalGiving) {
  if (!totalGiving || totalGiving <= 0) return { min: null, max: null };
  // Rough heuristic: typical single grant ≈ 1-5% of total annual giving
  const low  = Math.round(totalGiving * 0.005 / 1000) * 1000;  // 0.5%
  const high = Math.round(totalGiving * 0.02  / 1000) * 1000;  // 2%
  return {
    min: Math.max(1000, low),
    max: Math.max(5000, high),
  };
}

function buildNextStep(funder) {
  if (funder.website) return `Visit ${funder.website} for grant guidelines and application portal.`;
  return `Search "${funder.name}" on GuideStar or the IRS Tax Exempt Org Search for contact details.`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FunderFinder/1.0 (nonprofit research tool)' },
  });
  if (!res.ok) {
    if (res.status === 429) {
      console.log('  Rate limited, waiting 10s...');
      await sleep(10000);
      return fetchJson(url);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchAllForNtee(nteeCode) {
  const orgs = [];
  let page = 0;
  while (true) {
    const url = `${PROPUBLICA_BASE}/search.json?q=&ntee[id]=${encodeURIComponent(nteeCode)}&page=${page}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      console.warn(`  Warning: failed page ${page} for ${nteeCode}: ${e.message}`);
      break;
    }

    const batch = data.organizations || [];
    if (batch.length === 0) break;
    orgs.push(...batch);
    console.log(`  ${nteeCode} page ${page}: ${batch.length} orgs (total: ${orgs.length})`);

    if (batch.length < 100) break; // last page
    page++;
    await sleep(500); // be polite to ProPublica
  }
  return orgs;
}

function transformOrg(org) {
  const grantRange = formatGrantRange(org.total_giving || org.totrevenue);
  const focusAreas = extractFocusAreas(org.name, org.city);
  const ein = String(org.ein || '').replace(/\D/g, ''); // strip non-digits

  return {
    id:              ein || `pp-${org.id}`,
    name:            org.name || 'Unknown',
    type:            org.ntee_code?.startsWith('T21') ? 'corporate' : 'foundation',
    description:     null, // ProPublica search doesn't return descriptions; enriched separately
    focus_areas:     focusAreas,
    ntee_code:       org.ntee_code || null,
    city:            org.city || null,
    state:           org.state || null,
    website:         null, // not in search results
    total_giving:    org.total_giving || null,
    asset_amount:    org.asset_amount || null,
    income_amount:   org.income_amount || null,
    contact_name:    null,
    contact_title:   null,
    contact_email:   null,
    grant_range_min: grantRange.min,
    grant_range_max: grantRange.max,
    next_step:       buildNextStep(org),
    raw_data:        org,
    last_synced:     new Date().toISOString(),
  };
}

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/funders`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey':        SUPABASE_SERVICE_ROLE_KEY,
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upsert failed (${res.status}): ${body}`);
  }
}

async function main() {
  console.log('🔍 Starting ProPublica → Supabase ingestion\n');
  let grandTotal = 0;

  for (const ntee of NTEE_CODES) {
    console.log(`\n📂 Fetching NTEE ${ntee}...`);
    const orgs = await fetchAllForNtee(ntee);
    if (orgs.length === 0) { console.log('  No results.'); continue; }

    // Filter: only include orgs with meaningful grant activity
    const significant = orgs.filter(o =>
      (o.total_giving && o.total_giving > 10000) ||
      (o.asset_amount  && o.asset_amount  > 100000)
    );
    console.log(`  Filtered to ${significant.length} significant funders (of ${orgs.length})`);

    // Upsert in batches of 200
    const BATCH = 200;
    for (let i = 0; i < significant.length; i += BATCH) {
      const batch = significant.slice(i, i + BATCH).map(transformOrg);
      await upsertBatch(batch);
      process.stdout.write(`  Upserted ${Math.min(i + BATCH, significant.length)}/${significant.length}\r`);
    }
    console.log(`  ✓ Done with ${ntee}: ${significant.length} funders upserted`);
    grandTotal += significant.length;
  }

  console.log(`\n✅ Ingestion complete! Total funders upserted: ${grandTotal}`);
  console.log('   View your data: https://supabase.com/dashboard/project/tgtotjvdubhjxzybmdex/editor');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
