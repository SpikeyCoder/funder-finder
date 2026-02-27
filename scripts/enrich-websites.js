#!/usr/bin/env node
/**
 * scripts/enrich-websites.js
 *
 * Fetches real website URLs for funders missing them.
 * Source: ProPublica Nonprofit Explorer API (free, no key required).
 *
 * Usage:
 *   node scripts/enrich-websites.js
 *
 * Optional env:
 *   SUPABASE_SERVICE_ROLE_KEY  – defaults to what's in your .env or shell
 *   LIMIT                      – max funders to process per run (default 200)
 *   DRY_RUN=1                  – log but don't write to DB
 *
 * Run as many times as needed; it skips funders that already have a website.
 */

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIMIT = parseInt(process.env.LIMIT || '200', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
const DELAY_MS = 350; // be polite to ProPublica

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_SERVICE_ROLE_KEY env variable is required.');
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Fetch up to LIMIT funders with no website from Supabase */
async function getFundersWithoutWebsite() {
  const url = `${SUPABASE_URL}/rest/v1/funders?select=id,name&website=is.null&limit=${LIMIT}&order=name.asc`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
  return res.json();
}

/** Call ProPublica API for a single EIN; returns website string or null */
async function lookupWebsite(ein) {
  try {
    const res = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const org = data.organization || {};
    // ProPublica may have `website` or `ntee_url` or social URLs
    const site = org.website || org.ntee_url || null;
    if (!site || site.trim() === '') return null;
    // Normalize — add https:// if missing
    return site.startsWith('http') ? site.trim() : `https://${site.trim()}`;
  } catch {
    return null;
  }
}

/** Update a funder's website in Supabase */
async function updateWebsite(id, website) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/funders?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ website }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase PATCH failed for ${id}: ${body}`);
  }
}

async function main() {
  console.log(`Enriching up to ${LIMIT} funders without websites…${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  const funders = await getFundersWithoutWebsite();
  console.log(`Found ${funders.length} funders to process.\n`);

  let updated = 0;
  let notFound = 0;

  for (const { id, name } of funders) {
    const website = await lookupWebsite(id);
    if (website) {
      console.log(`✅  ${name} (${id}) → ${website}`);
      if (!DRY_RUN) await updateWebsite(id, website);
      updated++;
    } else {
      console.log(`–   ${name} (${id}) → no website found`);
      notFound++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDone. Updated: ${updated}  |  Not found: ${notFound}`);
  if (DRY_RUN) console.log('(Dry run — no changes written to DB)');
  else if (updated > 0) {
    console.log('\nTip: Clear the search cache so fresh results use the new URLs:');
    console.log('  node scripts/clear-cache.js');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
