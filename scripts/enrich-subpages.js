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
 * Strategy per funder (two-pass):
 *   PASS 1 — Homepage crawl (preferred):
 *     Fetch the funder's homepage, extract every <a> tag (href + anchor text),
 *     score each link against each subpage type using URL path patterns AND
 *     anchor text keywords, pick the highest-scoring link per type.
 *
 *   PASS 2 — DuckDuckGo fallback (if homepage yielded nothing for a type):
 *     Run a site:<domain> search and take the best-scoring result.
 *
 * Scoring works on both the URL path and the visible link text:
 *   e.g. "Apply for a Grant" → high score for apply_url even if path is /grants/2025
 *        "/staff-directory"  → high score for contact_url even with generic text
 *
 * Usage:
 *   node scripts/enrich-subpages.js                   # all funders missing subpages
 *   LIMIT=20 node scripts/enrich-subpages.js          # only first 20
 *   DRY_RUN=1 node scripts/enrich-subpages.js         # print without writing
 *   VERBOSE=1 node scripts/enrich-subpages.js         # detailed logging
 *   ID=<funder-id> node scripts/enrich-subpages.js    # single funder by id
 */

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN  = process.env.DRY_RUN  === '1';
const VERBOSE  = process.env.VERBOSE  === '1';
const LIMIT    = parseInt(process.env.LIMIT || '500', 10);
const ID_FILTER = process.env.ID || null; // single funder by id

if (!SUPABASE_KEY) {
  console.error('❌  SUPABASE_SERVICE_ROLE_KEY env variable is required.');
  process.exit(1);
}

// ── Subpage type definitions ──────────────────────────────────────────────────
//
// pathHints  – substrings to look for in the link's href/URL path
// textHints  – keywords to look for in the link's visible anchor text
//
// Each hint match adds +3 to the score. A link must score ≥ 3 to be considered.

const SUBPAGE_TYPES = [
  {
    field: 'contact_url',
    pathHints: ['/contact', '/staff', '/team', '/people', '/program-officer', '/our-team', '/about/team', '/about/staff', '/about/people', '/leadership'],
    textHints:  ['contact', 'staff', 'team', 'people', 'program officer', 'our people', 'leadership', 'meet the', 'directory'],
    ddgQueries: ['contact staff program officers', 'staff directory team'],
  },
  {
    field: 'programs_url',
    pathHints: ['/programs', '/initiatives', '/grantmaking', '/priorities', '/our-work', '/what-we-fund', '/portfolio', '/focus-area', '/grant-area', '/funding-area', '/strategy', '/areas-of-interest'],
    textHints:  ['programs', 'initiatives', 'grantmaking', 'our work', 'what we fund', 'funding areas', 'focus areas', 'priorities', 'portfolio', 'strategies', 'grant areas', 'areas of interest'],
    ddgQueries: ['grant programs initiatives priorities', 'what we fund grantmaking areas'],
  },
  {
    field: 'apply_url',
    pathHints: ['/apply', '/grant-guideline', '/how-to-apply', '/loi', '/rfp', '/letter-of-inquiry', '/applicant', '/funding-guideline', '/proposal', '/submit', '/grantseekers', '/prospective'],
    textHints:  ['apply', 'how to apply', 'grant guidelines', 'loi', 'letter of inquiry', 'rfp', 'submit', 'application', 'grantseekers', 'prospective grantees', 'funding guidelines', 'apply for a grant', 'application process'],
    ddgQueries: ['how to apply grant guidelines LOI letter of inquiry', 'apply for funding RFP grantseekers'],
  },
  {
    field: 'news_url',
    pathHints: ['/news', '/annual-report', '/report', '/publication', '/newsletter', '/press', '/media', '/updates', '/blog', '/stories', '/impact'],
    textHints:  ['news', 'annual report', 'reports', 'publications', 'newsletter', 'press', 'media', 'updates', 'blog', 'stories', 'impact report', 'latest'],
    ddgQueries: ['annual report news updates newsletter', 'press publications blog'],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(...args) { if (VERBOSE) console.log(...args); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normaliseUrl(raw) {
  if (!raw) return null;
  const s = raw.trim();
  return s.startsWith('http') ? s : `https://${s}`;
}

function extractDomain(url) {
  try {
    return new URL(normaliseUrl(url)).hostname.replace(/^www\./, '');
  } catch { return null; }
}

/** Resolve a relative href found on a page against the page's base URL. */
function resolveHref(href, base) {
  if (!href) return null;
  href = href.trim();
  // Skip non-page links
  if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return null;
  try {
    return new URL(href, base).href;
  } catch { return null; }
}

// ── Homepage crawl ────────────────────────────────────────────────────────────

/**
 * Fetch a URL's HTML. Returns null on network/HTTP errors.
 * Follows up to one redirect manually so we handle http→https etc.
 */
async function fetchHtml(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FunderFinder/1.0; +https://github.com/SpikeyCoder/funder-finder)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;
    return await res.text();
  } catch (e) {
    clearTimeout(timer);
    log(`    fetchHtml error (${url}): ${e.message}`);
    return null;
  }
}

/**
 * Extract all links from HTML as { href, text } objects.
 * href is resolved to an absolute URL against baseUrl.
 * text is the normalised visible anchor text (lowercased, trimmed).
 */
function extractLinks(html, baseUrl) {
  const links = [];
  // Match <a ...href="..."...>...</a> — handles single/double quotes and various attribute orders
  const tagRe = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const href = resolveHref(m[1], baseUrl);
    if (!href) continue;
    // Strip inner HTML tags to get visible text
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    links.push({ href, text });
  }
  return links;
}

/**
 * Score a single link { href, text } against a subpage type.
 * Returns 0 if the link is clearly not relevant.
 */
function scoreLink(link, subpageType, funderDomain) {
  const urlLower = link.href.toLowerCase();

  // Must be on the same domain (or a subdomain of it)
  const linkDomain = extractDomain(link.href);
  if (!linkDomain || (!linkDomain.includes(funderDomain) && !funderDomain.includes(linkDomain))) return 0;

  // Skip the homepage itself (path is "/" or "")
  try {
    const parsed = new URL(link.href);
    if (parsed.pathname === '/' || parsed.pathname === '') return 0;
  } catch { return 0; }

  let score = 0;
  for (const hint of subpageType.pathHints) {
    if (urlLower.includes(hint.toLowerCase())) score += 3;
  }
  for (const hint of subpageType.textHints) {
    if (link.text.includes(hint.toLowerCase())) score += 3;
  }
  return score;
}

/**
 * Crawl the funder's homepage and find the best matching URL for each
 * subpage type that still needs to be filled.
 * Returns { contact_url, programs_url, apply_url, news_url } (only populated fields).
 */
async function crawlHomepage(website, neededFields) {
  const html = await fetchHtml(website);
  if (!html) {
    log(`  homepage fetch failed — will fall back to DDG`);
    return {};
  }

  const links = extractLinks(html, website);
  log(`  crawled ${links.length} links from homepage`);

  const found = {};
  const funderDomain = extractDomain(website);

  for (const subpageType of SUBPAGE_TYPES) {
    if (!neededFields.includes(subpageType.field)) continue;

    // Score every link for this subpage type
    const scored = links
      .map(link => ({ link, score: scoreLink(link, subpageType, funderDomain) }))
      .filter(({ score }) => score >= 3)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      log(`  [crawl] ${subpageType.field}: "${best.link.text}" → ${best.link.href} (score=${best.score})`);
      found[subpageType.field] = best.link.href;
    } else {
      log(`  [crawl] ${subpageType.field}: no match found in nav`);
    }
  }

  return found;
}

// ── DuckDuckGo fallback ───────────────────────────────────────────────────────

async function ddgSearch(domain, query) {
  const q = encodeURIComponent(`site:${domain} ${query}`);
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FunderFinder/1.0)',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const hrefRe = /href="(https?:\/\/[^"]+)"/g;
    let match;
    while ((match = hrefRe.exec(html)) !== null) {
      const link = match[1];
      if (link.includes('duckduckgo.com')) continue;
      if (link.includes('ad_domain')) continue;
      const linkDomain = extractDomain(link);
      if (!linkDomain) continue;
      if (!linkDomain.includes(domain) && !domain.includes(linkDomain)) continue;
      return link;
    }
  } catch (e) {
    log(`    DDG error: ${e.message}`);
  }
  return null;
}

async function ddgFallback(website, neededFields) {
  const domain = extractDomain(website);
  if (!domain) return {};
  const found = {};

  for (const subpageType of SUBPAGE_TYPES) {
    if (!neededFields.includes(subpageType.field)) continue;

    for (const query of subpageType.ddgQueries) {
      const result = await ddgSearch(domain, query);
      if (result) {
        log(`  [ddg] ${subpageType.field}: "${query}" → ${result}`);
        found[subpageType.field] = result;
        break; // first hit per type is enough
      }
      await sleep(1500);
    }

    if (!found[subpageType.field]) {
      log(`  [ddg] ${subpageType.field}: no result`);
    }
  }

  return found;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function fetchFunders() {
  let url;
  if (ID_FILTER) {
    url = `${SUPABASE_URL}/rest/v1/funders?id=eq.${ID_FILTER}&select=id,name,website,contact_url,programs_url,apply_url,news_url`;
  } else {
    url =
      `${SUPABASE_URL}/rest/v1/funders` +
      `?website=not.is.null` +
      `&or=(contact_url.is.null,programs_url.is.null,apply_url.is.null,news_url.is.null)` +
      `&select=id,name,website,contact_url,programs_url,apply_url,news_url` +
      `&order=total_giving.desc.nullslast` +
      `&limit=${LIMIT}`;
  }
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
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
  if (!res.ok) throw new Error(`Supabase update error: ${await res.text()}`);
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

    console.log(`[${i + 1}/${funders.length}] ${funder.name}  (${website})`);

    // Fields still missing for this funder
    const neededFields = SUBPAGE_TYPES
      .map(t => t.field)
      .filter(f => !funder[f]);

    if (!neededFields.length) {
      log(`  all subpages already populated`);
      stats.unchanged++;
      continue;
    }
    log(`  needs: ${neededFields.join(', ')}`);

    // Pass 1: homepage crawl
    const fromCrawl = await crawlHomepage(website, neededFields);

    // Pass 2: DDG fallback for anything still missing
    const stillNeeded = neededFields.filter(f => !fromCrawl[f]);
    const fromDdg = stillNeeded.length > 0
      ? await ddgFallback(website, stillNeeded)
      : {};

    const updates = { ...fromCrawl, ...fromDdg };

    if (Object.keys(updates).length > 0) {
      for (const [field, url] of Object.entries(updates)) {
        console.log(`  ✅ ${field}: ${url}`);
      }
      if (!DRY_RUN) {
        try {
          await updateFunder(funder.id, updates);
          stats.updated++;
        } catch (e) {
          console.error(`  ❌ DB update failed: ${e.message}`);
          stats.errors++;
        }
      } else {
        console.log(`  [DRY RUN] would write ${Object.keys(updates).length} field(s)`);
        stats.updated++;
      }
    } else {
      console.log(`  ⬜ nothing found`);
      stats.unchanged++;
    }

    // Polite pause between funders
    if (i < funders.length - 1) await sleep(1500);
  }

  console.log('\n── Summary ──────────────────────────────────────────────────────');
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
