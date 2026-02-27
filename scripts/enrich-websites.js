#!/usr/bin/env node
/**
 * scripts/enrich-websites.js
 *
 * Fetches real website URLs for funders that are missing them.
 *
 * Lookup strategy (in order, stops at first hit):
 *   1. ProPublica organization.website  (direct from org record)
 *   2. ProPublica filings_with_data[*].websiteaddress  (IRS 990 field)
 *   3. Google Custom Search API  (requires GOOGLE_API_KEY + GOOGLE_CX env vars)
 *   4. DuckDuckGo Instant Answer API  (free, no key required)
 *
 * Usage:
 *   node scripts/enrich-websites.js
 *
 * Required env vars:
 *   SUPABASE_SERVICE_ROLE_KEY  – Supabase service role key
 *
 * Optional env vars:
 *   GOOGLE_API_KEY  – Google Custom Search API key (enables layer 3)
 *   GOOGLE_CX       – Google Programmable Search Engine ID (enables layer 3)
 *   LIMIT           – max funders to process per run (default 200)
 *   DRY_RUN=1       – log but don't write to DB
 *   VERBOSE=1       – print raw ProPublica response for first funder
 *
 * Run as many times as needed; it skips funders that already have a website.
 *
 * After a successful run, clear the search cache so fresh results pick up
 * the new URLs:
 *   node scripts/clear-cache.js
 */

const SUPABASE_URL  = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'REDACTED_ROTATE_IN_GOOGLE_CLOUD_CONSOLE';
const GOOGLE_CX     = process.env.GOOGLE_CX      || '32a112ff11dc64e78';
const LIMIT         = parseInt(process.env.LIMIT  || '200', 10);
const DRY_RUN       = process.env.DRY_RUN  === '1';
const VERBOSE       = process.env.VERBOSE  === '1';

// Polite delays (ms) between external API calls
const PROPUBLICA_DELAY_MS = 350;
const SEARCH_DELAY_MS     = 500;

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_SERVICE_ROLE_KEY env variable is required.');
  process.exit(1);
}

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Normalise a raw URL string: trim whitespace, add https:// if missing. */
function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  return s.startsWith('http') ? s : `https://${s}`;
}

/** Basic sanity-check: reject obviously bad strings. */
function looksLikeUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── Supabase ────────────────────────────────────────────────────────────────

async function getFundersWithoutWebsite() {
  const url =
    `${SUPABASE_URL}/rest/v1/funders` +
    `?select=id,name&website=is.null&limit=${LIMIT}&order=name.asc`;
  const res = await fetch(url, { headers: supabaseHeaders });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateWebsite(id, website) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/funders?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ website }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase PATCH failed for ${id}: ${body}`);
  }
}

// ─── Source 1 + 2: ProPublica Nonprofit Explorer ─────────────────────────────

/**
 * Call the ProPublica Nonprofit Explorer API for a single EIN.
 * Checks:
 *   • organization.website         (top-level org field)
 *   • filings_with_data[*].websiteaddress  (IRS 990 element name, often populated
 *     even when organization.website is blank)
 *
 * Returns the first valid URL found, or null.
 */
async function lookupProPublica(ein) {
  try {
    const res = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;

    const data = await res.json();

    if (VERBOSE) {
      console.log('\n── ProPublica raw response (first funder) ──');
      console.log(JSON.stringify(data, null, 2).slice(0, 4000));
      console.log('────────────────────────────────────────────\n');
    }

    const org = data.organization || {};

    // 1. Top-level org website
    const orgWebsite = normalizeUrl(org.website);
    if (orgWebsite && looksLikeUrl(orgWebsite)) return orgWebsite;

    // 2. Walk filings_with_data for IRS websiteaddress element
    const filings = Array.isArray(data.filings_with_data) ? data.filings_with_data : [];
    for (const filing of filings) {
      const raw = filing.websiteaddress || filing.website_address || filing.websiteurl;
      const url = normalizeUrl(raw);
      if (url && looksLikeUrl(url)) return url;
    }

    // 3. Also check filings_without_data (older filings, fewer fields but worth trying)
    const filings2 = Array.isArray(data.filings_without_data) ? data.filings_without_data : [];
    for (const filing of filings2) {
      const raw = filing.websiteaddress || filing.website_address;
      const url = normalizeUrl(raw);
      if (url && looksLikeUrl(url)) return url;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Source 3: Google Custom Search API ──────────────────────────────────────

/**
 * Use the Google Custom Search JSON API to find the most likely homepage.
 * Requires GOOGLE_API_KEY and GOOGLE_CX env vars (or the defaults baked in).
 * Free tier: 100 queries/day. Returns first result URL, or null.
 *
 * Search engine is configured to search the entire web
 * (cx: 32a112ff11dc64e78 — "Funder Finder - Nonprofit Website Lookup").
 */
async function lookupGoogle(name) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return null;
  try {
    const query = encodeURIComponent(`${name} nonprofit foundation`);
    const res = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${query}&num=1`
    );
    if (!res.ok) {
      if (VERBOSE) {
        const err = await res.text();
        console.warn(`  [Google] API error ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    const data = await res.json();
    const url = data?.items?.[0]?.link;
    return looksLikeUrl(url) ? url : null;
  } catch {
    return null;
  }
}

// ─── Source 4: DuckDuckGo Instant Answer API (no key required) ───────────────

/**
 * DuckDuckGo's Instant Answer API returns zero-click info.
 * The `AbstractURL` field often contains the official website for well-known orgs.
 * Less reliable than Bing for obscure small foundations, but free.
 * Returns a URL string or null.
 */
async function lookupDuckDuckGo(name) {
  try {
    const query = encodeURIComponent(`${name} nonprofit`);
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${query}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();

    // AbstractURL is the canonical entity URL (e.g., official website)
    const url = normalizeUrl(data.AbstractURL || data.Official_site || '');
    if (url && looksLikeUrl(url)) return url;

    // Fallback: first Related Topic that has a FirstURL pointing to the org's own domain
    const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const t of topics) {
      const u = normalizeUrl(t.FirstURL || '');
      // Skip DuckDuckGo and Wikipedia URLs
      if (u && looksLikeUrl(u) && !u.includes('duckduckgo.com') && !u.includes('wikipedia.org')) {
        return u;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const googleEnabled = !!(GOOGLE_API_KEY && GOOGLE_CX);
  console.log(
    `Enriching up to ${LIMIT} funders without websites…` +
    (DRY_RUN       ? ' [DRY RUN]'  : '') +
    (VERBOSE       ? ' [VERBOSE]'  : '') +
    (googleEnabled ? ' [Google Custom Search enabled]' : ' [Google disabled — set GOOGLE_API_KEY + GOOGLE_CX]') +
    '\n'
  );

  const funders = await getFundersWithoutWebsite();
  console.log(`Found ${funders.length} funders to process.\n`);

  const stats = { propublica: 0, google: 0, ddg: 0, notFound: 0 };
  let verboseDone = false;

  for (const { id, name } of funders) {
    // Temporarily enable verbose for the very first funder only
    if (!verboseDone && VERBOSE) {
      // VERBOSE flag already checked inside lookupProPublica
    }

    // ── Layer 1 + 2: ProPublica ──
    const ppUrl = await lookupProPublica(id);
    verboseDone = true; // raw dump only printed once (on first call)

    if (ppUrl) {
      console.log(`✅  [ProPublica] ${name} (${id}) → ${ppUrl}`);
      if (!DRY_RUN) await updateWebsite(id, ppUrl);
      stats.propublica++;
      await sleep(PROPUBLICA_DELAY_MS);
      continue;
    }

    await sleep(PROPUBLICA_DELAY_MS);

    // ── Layer 3: Google Custom Search ──
    const googleUrl = await lookupGoogle(name);
    if (googleUrl) {
      console.log(`✅  [Google]     ${name} (${id}) → ${googleUrl}`);
      if (!DRY_RUN) await updateWebsite(id, googleUrl);
      stats.google++;
      await sleep(SEARCH_DELAY_MS);
      continue;
    }

    if (googleEnabled) await sleep(SEARCH_DELAY_MS);

    // ── Layer 4: DuckDuckGo ──
    const ddgUrl = await lookupDuckDuckGo(name);
    if (ddgUrl) {
      console.log(`✅  [DuckDuckGo] ${name} (${id}) → ${ddgUrl}`);
      if (!DRY_RUN) await updateWebsite(id, ddgUrl);
      stats.ddg++;
      await sleep(SEARCH_DELAY_MS);
      continue;
    }

    await sleep(SEARCH_DELAY_MS);

    console.log(`–   [none]       ${name} (${id}) → no website found`);
    stats.notFound++;
  }

  const totalFound = stats.propublica + stats.bing + stats.ddg;

  console.log('\n── Summary ─────────────────────────────────────');
  console.log(`  ProPublica hits : ${stats.propublica}`);
  console.log(`  Google hits     : ${stats.google}`);
  console.log(`  DuckDuckGo hits : ${stats.ddg}`);
  console.log(`  Not found       : ${stats.notFound}`);
  console.log(`  Total updated   : ${totalFound}`);
  console.log('─────────────────────────────────────────────────');

  if (DRY_RUN) {
    console.log('\n(Dry run — no changes written to DB)');
  } else if (totalFound > 0) {
    console.log('\nTip: Clear the search cache so fresh results use the new URLs:');
    console.log('  node scripts/clear-cache.js');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
