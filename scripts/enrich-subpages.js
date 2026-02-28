#!/usr/bin/env node
/**
 * enrich-subpages.js
 *
 * Discovers and stores subpage URLs for each funder:
 *   contact_url  — staff directory / contact page
 *   programs_url — programs, initiatives, portfolio, or priorities page
 *   apply_url    — how to apply, LOI, RFP, or grant guidelines page
 *   news_url     — news, annual reports, or newsletter page
 *
 * Strategy per funder:
 *   1. Skip funders with no website
 *   2. For each of the 4 subpage types, run a DuckDuckGo search:
 *        site:<domain> <keywords>
 *   3. Accept the first result that is on the same domain as the funder's website
 *   4. UPSERT the found URLs into the funders table
 *
 * Usage:
 *   node scripts/enrich-subpages.js              # all funders missing subpages
 *   LIMIT=20 node scripts/enrich-subpages.js     # only first 20
 *   DRY_RUN=1 node scripts/enrich-subpages.js    # print without writing
 *   VERBOSE=1 node scripts/enrich-subpages.js    # detailed logging
 *   ID=<funder-id> node scripts/enrich-subpages.js # single funder by id
 */

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const VERBOSE = process.env.VERBOSE === '1';
const LIMIT = parseInt(process.env.LIMIT || '500', 10);
const ID_FILTER = process.env.ID || null;  // filter to a single funder by id

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

// ── Subpage search config ─────────────────────────────────────────────────────

const SUBPAGE_TYPES = [
  {
    field: 'contact_url',
    queries: ['contact staff team', 'program officers contact', 'staff directory'],
    // URL path hints that suggest this is a contact/staff page
    pathHints: ['/contact', '/staff', '/team', '/about/team', '/people', '/program-officers'],
  },
  {
    field: 'programs_url',
    queries: ['grant programs initiatives priorities', 'funding areas grantmaking', 'programs portfolio'],
    pathHints: ['/programs', '/initiatives', '/grantmaking', '/priorities', '/our-work', '/what-we-fund', '/portfolio', '/focus-areas'],
  },
  {
    field: 'apply_url',
    queries: ['how to apply grant guidelines LOI letter of inquiry', 'apply for funding RFP'],
    pathHints: ['/apply', '/grant-guidelines', '/how-to-apply', '/loi', '/rfp', '/grants/apply', '/funding-guidelines', '/applicants'],
  },
  {
    field: 'news_url',
    queries: ['annual report news updates newsletter', 'press releases publications'],
    pathHints: ['/news', '/annual-report', '/reports', '/publications', '/newsletter', '/press', '/updates', '/media'],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(...args) {
  if (VERBOSE) console.log(...args);
}

function extractDomain(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normaliseUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!url.startsWith('http')) url = `https://${url}`;
  return url;
}

/** Delay to avoid hammering DDG */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Search DuckDuckGo for `site:<domain> <query>` and return the first
 * result URL that belongs to the same domain.
 */
async function ddgSearch(domain, query) {
  const q = encodeURIComponent(`site:${domain} ${query}`);
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FunderFinder/1.0)',
        'Accept': 'text/html',
      },
      timeout: 10000,
    });
    if (!res.ok) return null;
    const html = await res.text();

    // DDG HTML results contain links like href="https://..."
    const hrefRe = /href="(https?:\/\/[^"]+)"/g;
    let match;
    const seen = new Set();
    while ((match = hrefRe.exec(html)) !== null) {
      const link = match[1];
      // Skip DDG's own redirect URLs and ad links
      if (link.includes('duckduckgo.com')) continue;
      if (link.includes('ad_domain')) continue;
      const linkDomain = extractDomain(link);
      if (!linkDomain) continue;
      // Must be on the funder's own domain
      if (!linkDomain.includes(domain) && !domain.includes(linkDomain)) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      return link;
    }
  } catch (e) {
    log(`    DDG error for "${query}": ${e.message}`);
  }
  return null;
}

/**
 * Score a candidate URL against a subpage type's path hints.
 * Higher = better match.
 */
function scoreUrl(url, pathHints) {
  if (!url) return 0;
  const lower = url.toLowerCase();
  let score = 1; // base score for being on the right domain
  for (const hint of pathHints) {
    if (lower.includes(hint.toLowerCase())) score += 2;
  }
  return score;
}

/**
 * For a given funder and subpage type, run multiple DDG queries and pick
 * the best-scoring result.
 */
async function findSubpageUrl(funder, subpageType) {
  const domain = extractDomain(funder.website);
  if (!domain) return null;

  const candidates = [];

  for (const query of subpageType.queries) {
    const found = await ddgSearch(domain, query);
    if (found) {
      const score = scoreUrl(found, subpageType.pathHints);
      log(`    [${subpageType.field}] query="${query}" → ${found} (score=${score})`);
      candidates.push({ url: found, score });
    }
    await sleep(1500); // rate limit
  }

  if (!candidates.length) return null;

  // Pick highest-scoring candidate; if tie, prefer the one with a path hint
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function fetchFunders() {
  let url;
  if (ID_FILTER) {
    url = `${SUPABASE_URL}/rest/v1/funders?id=eq.${ID_FILTER}&select=id,name,website,contact_url,programs_url,apply_url,news_url`;
  } else {
    // Fetch funders that have a website but are missing at least one subpage URL
    url =
      `${SUPABASE_URL}/rest/v1/funders` +
      `?website=not.is.null` +
      `&or=(contact_url.is.null,programs_url.is.null,apply_url.is.null,news_url.is.null)` +
      `&select=id,name,website,contact_url,programs_url,apply_url,news_url` +
      `&order=total_giving.desc.nullslast` +
      `&limit=${LIMIT}`;
  }

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase fetch error: ${await res.text()}`);
  return res.json();
}

async function updateFunder(id, updates) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/funders?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase update error: ${body}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍  enrich-subpages.js${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  const funders = await fetchFunders();
  console.log(`Found ${funders.length} funder(s) to process\n`);

  const stats = { skipped: 0, updated: 0, unchanged: 0, errors: 0 };

  for (let i = 0; i < funders.length; i++) {
    const funder = funders[i];
    const website = normaliseUrl(funder.website);
    if (!website) {
      log(`[${i + 1}/${funders.length}] ${funder.name} — no website, skipping`);
      stats.skipped++;
      continue;
    }

    console.log(`[${i + 1}/${funders.length}] ${funder.name} (${website})`);

    const updates = {};

    for (const subpageType of SUBPAGE_TYPES) {
      // Skip if already populated
      if (funder[subpageType.field]) {
        log(`  ✓ ${subpageType.field} already set: ${funder[subpageType.field]}`);
        continue;
      }

      try {
        const found = await findSubpageUrl({ ...funder, website }, subpageType);
        if (found) {
          console.log(`  ✅ ${subpageType.field}: ${found}`);
          updates[subpageType.field] = found;
        } else {
          log(`  ⬜ ${subpageType.field}: not found`);
        }
      } catch (e) {
        console.error(`  ❌ ${subpageType.field} error: ${e.message}`);
        stats.errors++;
      }
    }

    if (Object.keys(updates).length > 0) {
      if (!DRY_RUN) {
        try {
          await updateFunder(funder.id, updates);
          stats.updated++;
        } catch (e) {
          console.error(`  ❌ DB update failed: ${e.message}`);
          stats.errors++;
        }
      } else {
        console.log(`  [DRY RUN] Would update:`, updates);
        stats.updated++;
      }
    } else {
      stats.unchanged++;
    }

    // Pause between funders to be polite to DDG
    if (i < funders.length - 1) await sleep(2000);
  }

  console.log('\n── Summary ─────────────────────────────────────────────────────');
  console.log(`  Funders updated  : ${stats.updated}`);
  console.log(`  Already complete : ${stats.unchanged}`);
  console.log(`  Skipped (no URL) : ${stats.skipped}`);
  console.log(`  Errors           : ${stats.errors}`);
  console.log('─────────────────────────────────────────────────────────────────\n');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
