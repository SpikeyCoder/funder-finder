#!/usr/bin/env node
/**
 * ProPublica Nonprofit Explorer → Supabase ingestion script
 *
 * Fetches foundations (NTEE category T = Philanthropy/Grantmaking) from
 * ProPublica's free API and upserts them into the Supabase `funders` table.
 *
 * Usage:
 *   SUPABASE_URL=https://auth.fundermatch.org \
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

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://auth.fundermatch.org';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROPUBLICA_BASE = 'https://projects.propublica.org/nonprofits/api/v2';

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY env var is required.');
  console.error('Get it from: https://supabase.com/dashboard/project/tgtotjvdubhjxzybmdex/settings/api');
  process.exit(1);
}

// Search terms to pull foundation data from ProPublica.
// Each query pulls up to ~25 results/page across multiple pages.
const SEARCH_QUERIES = [
  // Generic foundation types
  'foundation',
  'community foundation',
  'family foundation',
  'private foundation',
  'public foundation',
  'grantmaking foundation',
  'charitable foundation',
  'philanthropic fund',
  'charitable trust',
  'endowment fund',

  // Issue-area foundations (high-volume categories)
  'education foundation',
  'health foundation',
  'arts foundation',
  'environment foundation',
  'housing foundation',
  'youth foundation',
  'community development foundation',
  'women foundation',
  'racial equity foundation',
  'social justice fund',
  'medical research foundation',
  'science foundation',
  'technology foundation',
  'economic development foundation',

  // Named foundation patterns (major philanthropies)
  'community trust',
  'charitable fund',
  'giving foundation',
  'philanthropy',
];

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

const MAX_PAGES_PER_QUERY = 10; // 10 pages × 25 orgs = 250 max per query

async function fetchAllForQuery(query, debug = false) {
  const orgs = [];
  let page = 0;
  while (page < MAX_PAGES_PER_QUERY) {
    const url = `${PROPUBLICA_BASE}/search.json?q=${encodeURIComponent(query)}&page=${page}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      console.warn(`  Warning: failed page ${page} for "${query}": ${e.message}`);
      break;
    }

    if (debug && page === 0) {
      console.log('\n  🔍 DEBUG — raw API response keys:', Object.keys(data));
      console.log('  🔍 DEBUG — total_results:', data.total_results);
      const sample = (data.organizations || [])[0];
      if (sample) {
        console.log('  🔍 DEBUG — first org keys:', Object.keys(sample));
        console.log('  🔍 DEBUG — first org:', JSON.stringify(sample, null, 2));
      } else {
        console.log('  🔍 DEBUG — organizations array is empty or missing');
        console.log('  🔍 DEBUG — full response:', JSON.stringify(data, null, 2).slice(0, 500));
      }
    }

    const batch = data.organizations || [];
    if (batch.length === 0) break;
    orgs.push(...batch);
    process.stdout.write(`  "${query}" page ${page}: ${orgs.length} orgs so far...\r`);

    // ProPublica returns up to 25 orgs per page; keep going until we get nothing back
    if (batch.length === 0) break;
    page++;
    await sleep(400);
  }
  console.log(`  "${query}": fetched ${orgs.length} orgs total`);
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
    raw_data:        null,  // omit raw payload to keep upsert batches small
    last_synced:     new Date().toISOString(),
  };
}

async function upsertBatch(rows, attempt = 1) {
  try {
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
  } catch (err) {
    if (attempt < 3) {
      console.warn(`  Batch failed (attempt ${attempt}), retrying in 2s...`);
      await sleep(2000);
      return upsertBatch(rows, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  const debug = process.argv.includes('--debug');
  console.log('🔍 Starting ProPublica → Supabase ingestion\n');
  if (debug) console.log('⚠️  Debug mode ON — will print raw API response for first query\n');
  let grandTotal = 0;

  // Collect all orgs across queries, deduplicating by EIN
  const seen = new Set();
  const allSignificant = [];

  for (const query of SEARCH_QUERIES) {
    console.log(`\n📂 Searching "${query}"...`);
    const orgs = await fetchAllForQuery(query, debug && query === SEARCH_QUERIES[0]);
    if (orgs.length === 0) { console.log('  No results.'); continue; }

    // Keep grantmaking orgs, deduplicated.
    // NOTE: ProPublica search results often omit ntee_code, so we accept orgs that
    // either (a) have a T-coded NTEE, OR (b) have a foundation/grantmaking name.
    const FOUNDATION_TERMS = ['foundation', 'fund', 'trust', 'endowment', 'grant', 'philanthropi', 'charitable', 'giving'];
    let added = 0;
    for (const org of orgs) {
      const ntee    = (org.ntee_code || '').toUpperCase();
      const nameLow = (org.name || '').toLowerCase();
      const ein     = String(org.ein || org.id || '');

      const looksLikeFoundation = ntee.startsWith('T') ||
        FOUNDATION_TERMS.some(t => nameLow.includes(t));
      if (!looksLikeFoundation) continue;         // skip non-grantmaking orgs

      if (seen.has(ein)) continue;                // deduplicate
      // Note: ProPublica search results don't include financial figures —
      // those only appear in individual org lookups. Skip money filter here.
      seen.add(ein);
      allSignificant.push(org);
      added++;
    }
    console.log(`  Added ${added} new funders (running total: ${allSignificant.length})`);
  }

  if (allSignificant.length === 0) {
    console.log('\n❌ No funders found across all queries.');
    console.log('   Possible causes:');
    console.log('   1. Network issue — check your internet connection');
    console.log('   2. ProPublica API may be down — try again in a few minutes');
    return;
  }

  // Upsert in small batches with pauses to avoid overwhelming Supabase
  console.log(`\n💾 Upserting ${allSignificant.length} funders to Supabase...`);
  const BATCH = 25;
  for (let i = 0; i < allSignificant.length; i += BATCH) {
    const batch = allSignificant.slice(i, i + BATCH).map(transformOrg);
    await upsertBatch(batch);
    grandTotal += batch.length;
    process.stdout.write(`  Upserted ${grandTotal}/${allSignificant.length}\r`);
    if (i + BATCH < allSignificant.length) await sleep(300);
  }

  console.log(`\n✅ Ingestion complete! Total funders upserted: ${grandTotal}`);
  console.log('   View your data: https://supabase.com/dashboard/project/tgtotjvdubhjxzybmdex/editor');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
