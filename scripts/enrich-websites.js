#!/usr/bin/env node
/**
 * scripts/enrich-websites.js
 *
 * Fetches real website URLs for funders that are missing them.
 *
 * Lookup strategy (in order, stops at first hit):
 *   1. ProPublica organization.website  (direct from org record)
 *   2. ProPublica filings_with_data[*].websiteaddress  (IRS 990 field)
 *   3. Google Knowledge Graph Search API  (free, 100k/day — requires GOOGLE_API_KEY)
 *   4. Brave Search API  (structured JSON — requires BRAVE_API_KEY, ~1000 free/month)
 *   5. DuckDuckGo lite web search  (free, no key — HTML parsing fallback)
 *
 *   NOTE: Google/Bing HTML scraping is disabled — both now require JS execution to
 *   render results. Brave Search API is the primary web search layer.
 *
 * Usage:
 *   node scripts/enrich-websites.js
 *
 * Required env vars:
 *   SUPABASE_SERVICE_ROLE_KEY  – Supabase service role key
 *
 * Optional env vars:
 *   GOOGLE_API_KEY  – Google API key (enables Knowledge Graph layer, 100k/day free)
 *   BRAVE_API_KEY   – Brave Search API key (primary web search, ~1000 free/month)
 *   LIMIT           – max funders to process per run (default 1000)
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
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null; // Set GOOGLE_API_KEY env var to enable Knowledge Graph enrichment
const BRAVE_API_KEY  = process.env.BRAVE_API_KEY  || null; // Set BRAVE_API_KEY for Brave Search (primary web search layer)
const LIMIT         = parseInt(process.env.LIMIT  || '1000', 10);
const DRY_RUN       = process.env.DRY_RUN  === '1';
const VERBOSE       = process.env.VERBOSE  === '1';
const SINGLE_EIN    = process.env.EIN      || null;  // Test a single funder: EIN=261232520 VERBOSE=1 node scripts/enrich-websites.js

// Polite delays (ms) between external API calls
const PROPUBLICA_DELAY_MS = 350;
const SEARCH_DELAY_MS     = 500;
const CONCURRENCY         = parseInt(process.env.CONCURRENCY || '1', 10); // keep at 1 to avoid search engine rate-limits; increase for ProPublica-only runs

// ─── Runtime circuit-breakers ──────────────────────────────────────────────
// Auto-disable engines that are broken / rate-limited so we don't waste time.
let braveDisabledAt = null;       // timestamp when Brave was auto-disabled
let ddgConsecutiveFails = 0;      // count of consecutive DDG failures
const DDG_MAX_CONSECUTIVE_FAILS = 3; // disable DDG after this many consecutive timeouts/errors

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
  // Single-EIN mode for testing
  if (SINGLE_EIN) {
    const url = `${SUPABASE_URL}/rest/v1/funders?select=id,name&id=eq.${SINGLE_EIN}`;
    const res = await fetch(url, { headers: supabaseHeaders });
    if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Use RPC call to get funders prioritised by data completeness:
  // 1. Those with city+state+NTEE (most likely to appear in searches)
  // 2. Those with city+state
  // 3. Everything else
  // Within each tier, order alphabetically for reproducibility.
  const rpcQuery = `
    SELECT id, name FROM funders
    WHERE website IS NULL AND foundation_ein IS NOT NULL
    ORDER BY
      CASE
        WHEN city IS NOT NULL AND state IS NOT NULL AND ntee_code IS NOT NULL THEN 1
        WHEN city IS NOT NULL AND state IS NOT NULL THEN 2
        WHEN state IS NOT NULL THEN 3
        ELSE 4
      END,
      name ASC
    LIMIT ${LIMIT}
  `;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ query: rpcQuery }),
  });

  // Fallback: if exec_sql RPC doesn't exist, use the simple REST query
  if (!res.ok) {
    console.log('(RPC not available — using REST query with name ordering)');
    const url =
      `${SUPABASE_URL}/rest/v1/funders` +
      `?select=id,name&website=is.null&foundation_ein=not.is.null&limit=${LIMIT}&order=name.asc`;
    const res2 = await fetch(url, { headers: supabaseHeaders });
    if (!res2.ok) throw new Error(`Supabase fetch failed: ${res2.status} ${await res2.text()}`);
    return res2.json();
  }

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

// ─── Source 3: Google Knowledge Graph Search API ─────────────────────────────

/**
 * Use the Google Knowledge Graph Search API to find the official website.
 * Requires only GOOGLE_API_KEY (same key used elsewhere — no separate PSE setup).
 * Free tier: 100,000 queries/day (vs 100/day for PSE).
 *
 * The Knowledge Graph returns authoritative entity data for organisations,
 * including their official URL. Much more reliable than web-search scraping
 * for well-known foundations and nonprofits.
 */
async function lookupKnowledgeGraph(name) {
  if (!GOOGLE_API_KEY) return null;
  try {
    const query = encodeURIComponent(name);
    const apiUrl = `https://kgsearch.googleapis.com/v1/entities:search?query=${query}&key=${GOOGLE_API_KEY}&limit=3&types=Organization`;
    const res = await fetch(apiUrl);

    if (!res.ok) {
      const err = await res.text();
      console.warn(`  [KG] API error ${res.status}: ${err.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();

    if (VERBOSE) {
      console.log('\n── Knowledge Graph raw response ──');
      console.log(JSON.stringify(data, null, 2).slice(0, 2000));
      console.log('──────────────────────────────────\n');
    }

    const items = data?.itemListElement || [];
    for (const item of items) {
      // Only use results with a reasonable confidence score
      if ((item.resultScore || 0) < 5) continue;
      const url = normalizeUrl(item?.result?.url || '');
      if (url && looksLikeUrl(url)) return url;
    }
    return null;
  } catch (e) {
    console.warn(`  [KG] Exception: ${e.message}`);
    return null;
  }
}

// ─── Source 4: Brave Search API (structured JSON — requires BRAVE_API_KEY) ────

/**
 * Use the Brave Search API to find the foundation's website.
 * Returns structured JSON with result URLs — no HTML parsing needed.
 *
 * Pricing: ~1,000 free queries/month, then $5/1,000 queries.
 * Sign up at: https://brave.com/search/api/
 */
async function lookupBraveSearch(searchQuery, cleanedName, originalName) {
  if (!BRAVE_API_KEY) return null;
  if (braveDisabledAt) return null; // circuit-breaker tripped
  try {
    const query = encodeURIComponent(searchQuery);
    const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${query}&count=10&safesearch=off&text_decorations=false`;
    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = await res.text();
      if (VERBOSE) console.warn(`  [Brave] API error ${res.status}: ${err.slice(0, 300)}`);
      // Auto-disable on rate limit or auth errors (quota exhausted)
      if (res.status === 429 || res.status === 403 || res.status === 401) {
        braveDisabledAt = new Date();
        console.warn(`\n⚠️  Brave Search disabled (HTTP ${res.status}) — free tier likely exhausted.`);
        console.warn(`   Continuing with ProPublica only. ${new Date().toISOString()}\n`);
      }
      return null;
    }

    const data = await res.json();

    if (VERBOSE) {
      console.log('\n── Brave Search raw response ──');
      console.log(JSON.stringify(data?.web?.results?.slice(0, 3), null, 2)?.slice(0, 1500) || '(no results)');
      console.log('───────────────────────────────\n');
    }

    const results = data?.web?.results || [];
    const urls = results.map(r => r.url).filter(u => u && looksLikeUrl(u));

    if (VERBOSE) {
      console.log(`  [Brave] "${searchQuery}" → ${urls.length} results`);
      urls.slice(0, 5).forEach((u, i) => {
        const title = results[i]?.title || '';
        console.log(`    ${i + 1}. ${u}  [${title.slice(0, 60)}]`);
      });
    }

    return pickBestUrl(urls, cleanedName, originalName);
  } catch (e) {
    if (VERBOSE) console.warn(`  [Brave] Error: ${e.message}`);
    return null;
  }
}

// ─── Source 5: DuckDuckGo lite Web Search (HTML fallback, no key required) ───

/**
 * Domains that are aggregators / directories / social media — NOT the org's own site.
 * If the top search result is one of these, skip it and check the next one.
 */
const SKIP_DOMAINS = new Set([
  'wikipedia.org', 'en.wikipedia.org',
  'facebook.com', 'www.facebook.com',
  'twitter.com', 'x.com',
  'linkedin.com', 'www.linkedin.com',
  'instagram.com', 'www.instagram.com',
  'youtube.com', 'www.youtube.com',
  'tiktok.com', 'www.tiktok.com',
  'yelp.com', 'www.yelp.com',
  'bbb.org', 'www.bbb.org',
  'guidestar.org', 'www.guidestar.org',
  'candid.org', 'www.candid.org',
  'charitynavigator.org', 'www.charitynavigator.org',
  'greatnonprofits.org', 'www.greatnonprofits.org',
  'nonprofitfacts.com', 'www.nonprofitfacts.com',
  'open990.org', 'www.open990.org',
  'causeiq.com', 'www.causeiq.com',
  'projects.propublica.org',
  'apps.irs.gov',
  'amazon.com', 'www.amazon.com',
  'ebay.com', 'www.ebay.com',
  'etsy.com', 'www.etsy.com',
  'walmart.com', 'www.walmart.com',
  'target.com', 'www.target.com',
  'shopify.com',
  'crunchbase.com', 'www.crunchbase.com',
  'bloomberg.com', 'www.bloomberg.com',
  'glassdoor.com', 'www.glassdoor.com',
  'indeed.com', 'www.indeed.com',
  'mapquest.com', 'www.mapquest.com',
  'yellowpages.com', 'www.yellowpages.com',
  'manta.com', 'www.manta.com',
  'dnb.com', 'www.dnb.com',
  'sec.gov', 'www.sec.gov',
  'findagrave.com', 'www.findagrave.com',
  // Real estate / apartment / property sites
  'apartments.com', 'www.apartments.com',
  'zillow.com', 'www.zillow.com',
  'realtor.com', 'www.realtor.com',
  'trulia.com', 'www.trulia.com',
  'redfin.com', 'www.redfin.com',
  'dreamtown.com', 'www.dreamtown.com',
  'loopnet.com', 'www.loopnet.com',
  // News / media sites — not a foundation's own site
  'nytimes.com', 'www.nytimes.com',
  'washingtonpost.com', 'www.washingtonpost.com',
  'cnn.com', 'www.cnn.com',
  'foxnews.com', 'www.foxnews.com',
  'bbc.com', 'www.bbc.com',
  'reuters.com', 'www.reuters.com',
  'apnews.com', 'www.apnews.com',
  // Religious text / reference sites (not foundations)
  'bible.com', 'www.bible.com',
  'biblestudytools.com', 'www.biblestudytools.com',
  'biblegateway.com', 'www.biblegateway.com',
  'churchofjesuschrist.org', 'www.churchofjesuschrist.org',
  'theologyofwork.org', 'www.theologyofwork.org',
  // Search engine domains — must NEVER be saved as a foundation website
  'google.com', 'www.google.com', 'support.google.com', 'accounts.google.com',
  'maps.google.com', 'play.google.com', 'news.google.com', 'books.google.com',
  'translate.google.com', 'scholar.google.com', 'policies.google.com',
  'bing.com', 'www.bing.com',
  'duckduckgo.com', 'www.duckduckgo.com',
  'yahoo.com', 'www.yahoo.com', 'search.yahoo.com',
  // Code hosting / tech platforms — never a foundation's primary website
  'github.com', 'www.github.com',
  'gitlab.com', 'www.gitlab.com',
  'bitbucket.org', 'www.bitbucket.org',
  'sourceforge.net', 'www.sourceforge.net',
  'npmjs.com', 'www.npmjs.com',
  'pypi.org',
  'hub.docker.com',
  'stackoverflow.com', 'www.stackoverflow.com',
  'stackexchange.com',
  // Other common non-foundation domains
  'pinterest.com', 'www.pinterest.com',
  'reddit.com', 'www.reddit.com',
  'medium.com',
  'patch.com', 'www.patch.com',
  'nextdoor.com', 'www.nextdoor.com',
  'issuu.com', 'www.issuu.com',
  'scribd.com', 'www.scribd.com',
  'slideshare.net', 'www.slideshare.net',
  'eventbrite.com', 'www.eventbrite.com',
  'gofundme.com', 'www.gofundme.com',
  // Foreign Q&A / content sites that appear in search but aren't foundation sites
  'zhihu.com', 'www.zhihu.com',
  'quora.com', 'www.quora.com',
  'baike.baidu.com',
  'weibo.com', 'www.weibo.com',
  'douban.com', 'www.douban.com',
  'namu.wiki',
  // Additional aggregator / directory / info sites
  'opencorporates.com', 'www.opencorporates.com',
  'bizapedia.com', 'www.bizapedia.com',
  'corporation-wiki.com', 'www.corporation-wiki.com',
  'ein-finder.com', 'www.ein-finder.com',
  'taxexemptworld.com', 'www.taxexemptworld.com',
  'nonprofit-search.com', 'www.nonprofit-search.com',
  'give.org', 'www.give.org',
  'networkforgood.org', 'www.networkforgood.org',
  // Financial services / donor-advised fund sites (publish articles about foundations)
  'fidelitycharitable.org', 'www.fidelitycharitable.org',
  'schwabcharitable.org', 'www.schwabcharitable.org',
  'vanguardcharitable.org', 'www.vanguardcharitable.org',
  'nptrust.org', 'www.nptrust.org',
  'foundationsource.com', 'www.foundationsource.com',
  'investopedia.com', 'www.investopedia.com',
  'nerdwallet.com', 'www.nerdwallet.com',
  'bankrate.com', 'www.bankrate.com',
  'forbes.com', 'www.forbes.com',
  'wsj.com', 'www.wsj.com',
  // Encyclopedia / reference / educational content sites
  'kiddle.co', 'kids.kiddle.co',
  'britannica.com', 'www.britannica.com',
  'simple.wikipedia.org',
  'wikiwand.com', 'www.wikiwand.com',
  'dbpedia.org',
  'wikidata.org', 'www.wikidata.org',
  'encyclopedia.com', 'www.encyclopedia.com',
  'worldcat.org', 'www.worldcat.org',
  'scholarpedia.org', 'www.scholarpedia.org',
  'infoplease.com', 'www.infoplease.com',
  'howstuffworks.com', 'www.howstuffworks.com',
  // Government / legal lookup sites (not foundation websites)
  'sos.state.co.us', 'www.sos.ca.gov',
  'charities.sos.ms.gov',
  'oag.ca.gov',
  'dos.ny.gov',
]);

/**
 * Search-engine and tech-company base domains whose ANY subdomain should be rejected.
 * This catches help.aol.com, support.google.com, learn.microsoft.com, etc.
 */
const BLOCK_ALL_SUBDOMAINS = [
  'google.com', 'bing.com', 'yahoo.com', 'aol.com', 'msn.com',
  'duckduckgo.com', 'baidu.com', 'yandex.com', 'ask.com',
  'googleapis.com', 'gstatic.com', 'googleusercontent.com',
  'live.com', 'outlook.com', 'office.com',
];

/**
 * Check if a hostname should be skipped (directory / social media / aggregator / search engine).
 */
function isSkippableDomain(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  if (SKIP_DOMAINS.has(h) || SKIP_DOMAINS.has('www.' + h)) return true;
  // Also skip subdomains of skipped domains
  for (const skip of SKIP_DOMAINS) {
    if (h.endsWith('.' + skip.replace(/^www\./, ''))) return true;
  }
  // Block ALL subdomains of search engines and tech infrastructure
  for (const base of BLOCK_ALL_SUBDOMAINS) {
    if (h === base || h.endsWith('.' + base)) return true;
  }
  return false;
}

/**
 * Parse URLs from DuckDuckGo HTML search results.
 * DDG lite/HTML format uses several patterns for result links:
 *   - uddg= parameter in redirect URLs
 *   - class="result__a" anchor tags
 *   - class="result__url" spans with the displayed URL
 *   - href attributes in result link anchors
 */
function parseDDGResults(html) {
  const urls = [];
  let match;

  // Pattern 0: DDG lite — result links in <a class="result-link" href="...">
  const liteLinkPattern = /class="result-link"[^>]*href="(https?:\/\/[^"]+)"/g;
  while ((match = liteLinkPattern.exec(html)) !== null) {
    try {
      const url = match[1];
      if (looksLikeUrl(url)) urls.push(url);
    } catch { /* skip */ }
  }

  // Pattern 0b: DDG lite — plain table layout with <a rel="nofollow" href="...">
  const liteNofollow = /<a[^>]+rel="nofollow"[^>]+href="(https?:\/\/[^"]+)"/g;
  while ((match = liteNofollow.exec(html)) !== null) {
    try {
      const url = match[1];
      if (looksLikeUrl(url)) urls.push(url);
    } catch { /* skip */ }
  }

  // Pattern 1: uddg= parameter (most reliable — DDG wraps all result URLs this way)
  const uddgPattern = /uddg=([^&"']+)/g;
  while ((match = uddgPattern.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]);
      const url = normalizeUrl(decoded);
      if (url && looksLikeUrl(url)) urls.push(url);
    } catch { /* skip bad encodings */ }
  }

  // Pattern 2: result__a anchor tags (direct links)
  const resultAPattern = /class="result__a"[^>]*href="([^"]+)"/g;
  while ((match = resultAPattern.exec(html)) !== null) {
    try {
      let href = match[1];
      if (href.startsWith('//duckduckgo.com/l/?')) {
        const uddg = new URL('https:' + href).searchParams.get('uddg');
        if (uddg) href = uddg;
      }
      const url = normalizeUrl(href);
      if (url && looksLikeUrl(url)) urls.push(url);
    } catch { /* skip */ }
  }

  // Pattern 3: result__url spans — DDG sometimes shows the clean URL as text
  const resultUrlPattern = /class="result__url"[^>]*>([^<]+)</g;
  while ((match = resultUrlPattern.exec(html)) !== null) {
    try {
      const text = match[1].trim();
      if (text && !text.includes(' ')) {
        const url = normalizeUrl(text);
        if (url && looksLikeUrl(url)) urls.push(url);
      }
    } catch { /* skip */ }
  }

  // Pattern 4: Broad fallback — only if targeted patterns found nothing.
  // Filtered through isSkippableDomain() to reject search engine chrome.
  if (urls.length === 0) {
    const broadPattern = /href="(https?:\/\/[^"]+)"/g;
    while ((match = broadPattern.exec(html)) !== null) {
      try {
        const url = match[1];
        if (looksLikeUrl(url)) {
          const hostname = new URL(url).hostname.toLowerCase();
          if (!hostname.includes('duckduckgo.com') && !isSkippableDomain(hostname)) {
            urls.push(url);
          }
        }
      } catch { /* skip */ }
    }
  }

  // Deduplicate while preserving order
  return [...new Set(urls)];
}

// ─── Shared: clean foundation name for search queries ─────────────────────────

function cleanFoundationName(name) {
  let cleaned = name
    // Strip leading EIN-like numbers (e.g., "0753177 ADAMS TEMPLE..." → "ADAMS TEMPLE...")
    .replace(/^\d{5,10}\s+/, '')
    // Strip trailing EIN-like numbers
    .replace(/\s+\d{5,10}$/, '')
    // Strip common legal suffixes
    .replace(/\b(INC|INCORPORATED|LLC|LTD|CORP|CORPORATION|CO)\b\.?/gi, '')
    // Strip common fraternal/org prefixes that confuse search
    .replace(/\b(IMPROVED ORDER OF|ORDER OF|LODGE NO|POST NO|CHAPTER NO|AUXILIARY|DEPT OF)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip standalone short numbers (1-4 digits) like lodge/chapter numbers,
  // but ONLY if the name still has meaningful alpha words left afterwards.
  // This avoids turning "1 17 FOUNDATION" into just "FOUNDATION".
  const withoutNums = cleaned.replace(/\b\d{1,4}\b/g, '').replace(/\s+/g, ' ').trim();
  const alphaWords = withoutNums.split(/\s+/).filter(w => /[a-zA-Z]{3,}/.test(w));
  if (alphaWords.length >= 2) {
    // Enough alpha words remain — safe to strip numbers
    cleaned = withoutNums;
  }

  return cleaned;
}

/**
 * Filter out skippable domains from result URLs.
 */
function filterSkippable(resultUrls) {
  return resultUrls.filter(url => {
    try {
      return !isSkippableDomain(new URL(url).hostname);
    } catch { return false; }
  });
}

/**
 * Score a URL against a foundation name for relevance.
 * Higher score = better match.
 *   0 = no name overlap at all
 *   1+ = number of name tokens found in URL domain/path
 *   +5 bonus if domain looks like a dedicated foundation site (e.g., seattlefoundation.org)
 *   +3 bonus if URL is a root/homepage (not deep path)
 *   -2 penalty for deep article/subpage paths (likely an article ABOUT the foundation)
 */
function scoreUrlRelevance(url, cleanedName, originalName) {
  if (!url || !cleanedName) return 0;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    const urlText = host + ' ' + path.replace(/[^a-z0-9]/g, ' ');

    const nameTokens = tokenize(cleanedName);
    if (nameTokens.length === 0) return 1; // can't score → neutral

    const urlWords = urlText.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
    const DOMAIN_SUFFIXES = new Set(['foundation', 'fdn', 'fund', 'trust', 'charity', 'npo', 'assoc']);
    // Include digits from the ORIGINAL name for compound matching (e.g., "1fur1" for "1 Fur 1 Foundation")
    // Use originalName if available (has digits that cleanedName may have stripped)
    const digitSource = originalName || cleanedName;
    const nameDigits = digitSource.match(/\d+/g) || [];
    const allNameParts = new Set([...nameTokens, ...DOMAIN_SUFFIXES, ...nameDigits]);

    let hits = 0;
    for (const word of nameTokens) {
      if (urlWords.includes(word)) { hits++; continue; }
      const wordInDomain = urlWords.some(uw => {
        const idx = uw.indexOf(word);
        if (idx < 0) return false;
        const before = uw.slice(0, idx);
        const after = uw.slice(idx + word.length);
        const beforeOk = before === '' || allNameParts.has(before) ||
          [...allNameParts].some(p => before === p || (before.length > 2 && p.startsWith(before)));
        const afterOk = after === '' || allNameParts.has(after) ||
          [...allNameParts].some(p => after === p || (after.length > 2 && p.startsWith(after)));
        return beforeOk && afterOk;
      });
      if (wordInDomain) hits++;
    }

    let score = hits;

    // Bonus: domain itself contains name tokens (not just the path)
    // Count how MANY name tokens appear in domain — more = better match
    const hostOnly = host.replace(/\.[a-z]{2,6}$/, '').replace(/\./g, ' ');
    const hostWords = hostOnly.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
    let domainHits = 0;
    for (const t of nameTokens) {
      if (hostWords.includes(t) || hostOnly.includes(t)) domainHits++;
    }
    // Scale bonus by domain hits: more name tokens in domain = much stronger signal
    // heartcaresfoundation.org (heart+cares) >> heart.org (heart only)
    if (domainHits >= 1) score += 3 + (domainHits * 2);

    // Bonus: root page (homepage) rather than deep subpage
    const pathDepth = path.replace(/\/$/, '').split('/').filter(Boolean).length;
    if (pathDepth <= 1) score += 3;
    else if (pathDepth >= 3) score -= 2; // deep article path penalty

    return score;
  } catch {
    return 0;
  }
}

/**
 * Pick the best URL from a list by scoring each against the foundation name.
 * Falls back to first non-skipped URL if no name is provided (legacy behavior).
 * originalName is the raw DB name (may contain digits stripped from cleanedName).
 */
// Minimum score a URL must reach to be accepted as a match.
// Prevents low-confidence false positives like kids.kiddle.co/Adams_Academy
// for "Adams Temple & School Fund" (score 4 — only one generic token matched in path).
// A score of 5 requires either a domain-level match or multiple token hits.
const MIN_SCORE_THRESHOLD = 5;

function pickBestUrl(resultUrls, cleanedName, originalName) {
  const candidates = filterSkippable(resultUrls);
  if (candidates.length === 0) return null;
  if (!cleanedName) return candidates[0]; // legacy fallback

  // Score each candidate and pick highest
  let bestUrl = null;
  let bestScore = -Infinity;
  for (const url of candidates) {
    const s = scoreUrlRelevance(url, cleanedName, originalName);
    if (VERBOSE) console.log(`    [Score] ${s} → ${url}`);
    if (s > bestScore) {
      bestScore = s;
      bestUrl = url;
    }
  }

  // Reject low-confidence matches
  if (bestScore < MIN_SCORE_THRESHOLD) {
    if (VERBOSE) console.log(`    [pickBestUrl] Best score ${bestScore} below threshold ${MIN_SCORE_THRESHOLD} — rejecting`);
    return null;
  }

  return bestUrl;
}

/**
 * Tokenise a string into meaningful words (lowercase, 3+ chars).
 * Strips common nonprofit suffixes and noise words.
 */
function tokenize(text) {
  if (!text) return [];
  const NOISE = new Set([
    'the', 'and', 'for', 'inc', 'incorporated', 'llc', 'ltd', 'corp',
    'corporation', 'foundation', 'fund', 'trust', 'org', 'nonprofit',
    'charity', 'charitable', 'association', 'society', 'council', 'institute',
    'http', 'https', 'www', 'com', 'net',
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !NOISE.has(w));
}

/**
 * Check if a search result URL is plausibly related to the foundation name.
 * Returns false if the result is clearly about a different entity.
 *
 * The idea: extract meaningful words from the foundation name, then check if
 * at least one of them appears in the URL's domain or path. This catches
 * false positives like "Accord Foundation" → github.com/accordproject where
 * "accord" appears in both but it's actually a software project.
 *
 * We're deliberately lenient: if ANY significant name word appears in the
 * domain/path, we accept it. We only reject when there's ZERO overlap.
 */
function urlLooksRelevant(url, foundationName, originalName) {
  if (!url || !foundationName) return true; // can't check → allow
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    const urlText = host + ' ' + path.replace(/[^a-z0-9]/g, ' ');

    const nameTokens = tokenize(foundationName);
    if (nameTokens.length === 0) return true; // nothing to check

    // Count how many significant name words appear in the URL.
    // Use word-boundary-aware matching: "accord" should match "accord-foundation"
    // but NOT "accordproject" (different entity).
    // We split urlText into tokens and also check substring boundaries.
    const urlWords = urlText.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
    // Common suffixes that foundations append to their name in domain names
    const DOMAIN_SUFFIXES = new Set(['foundation', 'fdn', 'fund', 'trust', 'charity', 'npo', 'assoc']);
    // Include digits from the ORIGINAL name for compound matching (e.g., "1fur1" for "1 Fur 1 Foundation")
    // Use originalName if available (has digits that cleanedName may have stripped)
    const digitSource = originalName || foundationName;
    const nameDigits = digitSource.match(/\d+/g) || [];
    // Build a set of all name-related words (tokens + suffixes + digits) for compound matching
    const allNameParts = new Set([...nameTokens, ...DOMAIN_SUFFIXES, ...nameDigits]);
    let hits = 0;
    for (const word of nameTokens) {
      // Exact word match in URL tokens
      if (urlWords.includes(word)) { hits++; continue; }
      // Check if the word appears inside a compound domain word where the rest
      // is also name tokens or known suffixes.
      // e.g., "seattlefoundation" contains "seattle" + "foundation" (suffix) → OK
      // e.g., "smithfamilyfdn" contains "smith" + "family" + "fdn" → OK
      // e.g., "accordproject" contains "accord" + "project" → NOT OK (project isn't a name token or suffix)
      const wordInDomain = urlWords.some(uw => {
        const idx = uw.indexOf(word);
        if (idx < 0) return false;
        // Check that everything before and after the word is also a known part
        const before = uw.slice(0, idx);
        const after = uw.slice(idx + word.length);
        const beforeOk = before === '' || allNameParts.has(before) ||
          [...allNameParts].some(p => before === p || (before.length > 2 && p.startsWith(before)));
        const afterOk = after === '' || allNameParts.has(after) ||
          [...allNameParts].some(p => after === p || (after.length > 2 && p.startsWith(after)));
        return beforeOk && afterOk;
      });
      if (wordInDomain) hits++;
    }

    // Require at least 1 matching word for short names (1-2 tokens),
    // or at least ~30% overlap for longer names
    const threshold = nameTokens.length <= 2 ? 1 : Math.ceil(nameTokens.length * 0.3);
    const relevant = hits >= threshold;

    if (!relevant && VERBOSE) {
      console.log(`  [Relevance] REJECTED: "${url}" for "${foundationName}"`);
      console.log(`    Name tokens: [${nameTokens.join(', ')}], URL text hits: ${hits}/${nameTokens.length} (need ${threshold})`);
    }

    return relevant;
  } catch {
    return true; // can't parse → allow
  }
}

// ─── Source 4a: DuckDuckGo HTML web search ────────────────────────────────────

async function lookupDDGWebSearch(searchQuery, cleanedName, originalName) {
  if (ddgConsecutiveFails >= DDG_MAX_CONSECUTIVE_FAILS) return null; // circuit-breaker tripped
  const query = encodeURIComponent(searchQuery);

  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${query}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000), // 8s timeout — DDG can be slow
    });
    if (!res.ok) {
      if (VERBOSE) console.warn(`  [DDG] HTTP ${res.status}`);
      ddgConsecutiveFails++;
      if (ddgConsecutiveFails >= DDG_MAX_CONSECUTIVE_FAILS) {
        console.warn(`\n⚠️  DDG disabled after ${DDG_MAX_CONSECUTIVE_FAILS} consecutive failures. Skipping for rest of run.\n`);
      }
      return null;
    }

    const html = await res.text();

    if (VERBOSE && html.length < 2000) {
      // Likely a captcha / empty page — dump first 500 chars for diagnosis
      console.warn(`  [DDG] Suspiciously short response (${html.length} chars):`);
      console.warn(`  ${html.slice(0, 500)}`);
    }

    const resultUrls = parseDDGResults(html);
    if (VERBOSE) {
      console.log(`  [DDG] "${searchQuery}" → ${resultUrls.length} results`);
      resultUrls.slice(0, 5).forEach((u, i) => console.log(`    ${i + 1}. ${u}`));
    }

    const picked = pickBestUrl(resultUrls, cleanedName, originalName);
    if (picked) {
      ddgConsecutiveFails = 0; // reset on success
    } else {
      ddgConsecutiveFails++;
      if (ddgConsecutiveFails >= DDG_MAX_CONSECUTIVE_FAILS) {
        console.warn(`\n⚠️  DDG disabled after ${DDG_MAX_CONSECUTIVE_FAILS} consecutive failures. Skipping for rest of run.\n`);
      }
    }
    return picked;
  } catch (e) {
    if (VERBOSE) console.warn(`  [DDG] Error: ${e.message}`);
    ddgConsecutiveFails++;
    if (ddgConsecutiveFails >= DDG_MAX_CONSECUTIVE_FAILS) {
      console.warn(`\n⚠️  DDG disabled after ${DDG_MAX_CONSECUTIVE_FAILS} consecutive failures (${e.message}). Skipping for rest of run.\n`);
    }
    return null;
  }
}

// ─── Source 4b: Google HTML web search (fallback) ─────────────────────────────

/**
 * Parse URLs from Google's search results HTML.
 * Google wraps result URLs in <a href="/url?q=<actual-url>&..."> tags
 * and also in <div class="yuRUbf"><a href="<actual-url>"> for organic results.
 */
/**
 * Check if a URL belongs to a Google-owned domain (any subdomain of google.com/google.*).
 */
function isGoogleDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'google.com' || hostname.endsWith('.google.com') ||
           /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(hostname) ||
           hostname.endsWith('.googleapis.com') || hostname.endsWith('.gstatic.com');
  } catch { return false; }
}

function parseGoogleResults(html) {
  const urls = [];
  let match;

  // Pattern 1: /url?q= redirect links (most common in Google HTML)
  const urlqPattern = /\/url\?q=(https?[^&"]+)/g;
  while ((match = urlqPattern.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (looksLikeUrl(decoded) && !isGoogleDomain(decoded)) urls.push(decoded);
    } catch { /* skip */ }
  }

  // Pattern 2: Direct href in organic result containers (yuRUbf class)
  const hrefPattern = /class="[^"]*yuRUbf[^"]*"[^>]*>[\s\S]*?href="(https?:\/\/[^"]+)"/g;
  while ((match = hrefPattern.exec(html)) !== null) {
    try {
      const url = match[1];
      if (looksLikeUrl(url) && !isGoogleDomain(url)) urls.push(url);
    } catch { /* skip */ }
  }

  // Pattern 2b: <div class="g"> result containers with <a href="...">
  const divGPattern = /class="g"[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"/g;
  while ((match = divGPattern.exec(html)) !== null) {
    try {
      const url = match[1];
      if (looksLikeUrl(url) && !isGoogleDomain(url)) urls.push(url);
    } catch { /* skip */ }
  }

  // Pattern 2c: data-href attributes (Google sometimes uses these for result links)
  const dataHrefPattern = /data-href="(https?:\/\/[^"]+)"/g;
  while ((match = dataHrefPattern.exec(html)) !== null) {
    try {
      const url = match[1];
      if (looksLikeUrl(url) && !isGoogleDomain(url)) urls.push(url);
    } catch { /* skip */ }
  }

  // Pattern 3: Broad href fallback — Google changes their HTML frequently,
  // so targeted patterns may miss results. We filter through isSkippableDomain()
  // which now has comprehensive coverage of search engines, aggregators, etc.
  if (urls.length === 0) {
    const broadPattern = /href="(https?:\/\/[^"]+)"/g;
    while ((match = broadPattern.exec(html)) !== null) {
      try {
        const url = match[1];
        if (looksLikeUrl(url)) {
          const hostname = new URL(url).hostname.toLowerCase();
          if (!isGoogleDomain(url) && !isSkippableDomain(hostname)) {
            urls.push(url);
          }
        }
      } catch { /* skip */ }
    }
  }

  return [...new Set(urls)];
}

/**
 * Google HTML web search — DISABLED.
 *
 * As of 2025+, Google serves a 100% JavaScript-rendered page to fetch() clients.
 * The HTML contains zero search result URLs — only obfuscated JS that requires
 * browser execution to render results. No regex pattern can extract results.
 *
 * Alternatives that still work:
 *   - DuckDuckGo HTML search (html.duckduckgo.com) — serves real HTML
 *   - Bing HTML search (bing.com/search) — serves real HTML
 *   - Google Knowledge Graph API — returns structured JSON
 *   - Google Custom Search JSON API — structured results ($5/1000 queries after free tier)
 */
async function lookupGoogleWebSearch(/* searchQuery */) {
  // Disabled: Google requires JS execution to render search results.
  // DDG and Bing still serve parseable HTML and are used instead.
  return null;
}

// ─── Source 4c: Bing HTML web search (fallback) ───────────────────────────────

/**
 * Parse URLs from Bing's search results HTML.
 * Bing uses <li class="b_algo"><h2><a href="..."> for organic results.
 */
function parseBingResults(html) {
  const urls = [];
  let match;

  // Pattern 1: Organic result links in b_algo list items
  const algoPattern = /class="b_algo"[\s\S]*?<a\s+href="(https?:\/\/[^"]+)"/g;
  while ((match = algoPattern.exec(html)) !== null) {
    try {
      const url = match[1];
      if (looksLikeUrl(url)) {
        const hostname = new URL(url).hostname.toLowerCase();
        if (!hostname.endsWith('bing.com') && !isSkippableDomain(hostname)) urls.push(url);
      }
    } catch { /* skip */ }
  }

  // Pattern 2: cite tags that show clean URLs
  const citePattern = /<cite[^>]*>(https?:\/\/[^<]+)</g;
  while ((match = citePattern.exec(html)) !== null) {
    try {
      // Strip any HTML tags inside the cite
      const raw = match[1].replace(/<[^>]+>/g, '').trim();
      const url = normalizeUrl(raw);
      if (url && looksLikeUrl(url)) {
        const hostname = new URL(url).hostname.toLowerCase();
        if (!isSkippableDomain(hostname)) urls.push(url);
      }
    } catch { /* skip */ }
  }

  // Pattern 3: Broad href fallback — only if targeted patterns found nothing.
  // Filtered through isSkippableDomain() to reject search engine chrome.
  if (urls.length === 0) {
    const broadPattern = /href="(https?:\/\/[^"]+)"/g;
    while ((match = broadPattern.exec(html)) !== null) {
      try {
        const url = match[1];
        if (looksLikeUrl(url)) {
          const hostname = new URL(url).hostname.toLowerCase();
          if (!hostname.endsWith('bing.com') && !hostname.endsWith('microsoft.com') &&
              !hostname.endsWith('msn.com') && !isSkippableDomain(hostname)) {
            urls.push(url);
          }
        }
      } catch { /* skip */ }
    }
  }

  return [...new Set(urls)];
}

async function lookupBingWebSearch(searchQuery) {
  const query = encodeURIComponent(searchQuery);

  try {
    const res = await fetch(`https://www.bing.com/search?q=${query}&count=10`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000), // 10s timeout
    });
    if (!res.ok) {
      if (VERBOSE) console.warn(`  [Bing] HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Only treat as captcha if the page is short (real captchas are small)
    // OR if it explicitly contains captcha challenge markup.
    // Bing's normal pages (50K+) may include the word "captcha" in boilerplate JS.
    if (html.length < 3000) {
      if (VERBOSE) console.warn(`  [Bing] Suspiciously short response (${html.length} chars) — skipping`);
      return null;
    }
    if (html.length < 15000 && (html.includes('/captcha/') || html.includes('id="captcha"'))) {
      if (VERBOSE) console.warn(`  [Bing] Captcha page detected (${html.length} chars) — skipping`);
      return null;
    }

    const resultUrls = parseBingResults(html);
    if (VERBOSE) {
      console.log(`  [Bing] "${searchQuery}" → ${resultUrls.length} results`);
      resultUrls.slice(0, 5).forEach((u, i) => console.log(`    ${i + 1}. ${u}`));
    }

    return pickBestUrl(resultUrls);
  } catch (e) {
    if (VERBOSE) console.warn(`  [Bing] Error: ${e.message}`);
    return null;
  }
}

// ─── Unified web search: multi-query × multi-engine ──────────────────────────

/**
 * Build a list of query variations to try for a foundation name.
 * Each engine will be tried with each query until one returns a result.
 */
function buildSearchQueries(name) {
  const clean = cleanFoundationName(name);
  const queries = [clean];

  // Variation 2: add "nonprofit" to help search engines disambiguate
  queries.push(`${clean} nonprofit`);

  // Variation 3: quoted name for exact-match
  queries.push(`"${clean}"`);

  return queries;
}

/**
 * Try a single query across all three search engines.
 * Returns { url, engine } or null.
 */
async function tryQueryAcrossEngines(searchQuery, cleanedName, originalName) {
  // If both search engines are circuit-broken, skip entirely (ProPublica-only mode)
  const braveAvailable = BRAVE_API_KEY && !braveDisabledAt;
  const ddgAvailable = ddgConsecutiveFails < DDG_MAX_CONSECUTIVE_FAILS;
  if (!braveAvailable && !ddgAvailable) return null;

  // Try Brave Search API first (structured JSON — most reliable)
  if (braveAvailable) {
    const braveUrl = await lookupBraveSearch(searchQuery, cleanedName, originalName);
    if (braveUrl) return { url: braveUrl, engine: 'Brave' };
  }

  if (ddgAvailable) {
    if (braveAvailable) await sleep(SEARCH_DELAY_MS); // only delay between engines
    // Try DDG lite as fallback (free, no key, HTML parsing)
    const ddgUrl = await lookupDDGWebSearch(searchQuery, cleanedName, originalName);
    if (ddgUrl) return { url: ddgUrl, engine: 'DDG' };
  }

  return null;
}

async function lookupWebSearch(name) {
  const queries = buildSearchQueries(name);
  const cleanedName = cleanFoundationName(name);

  for (let i = 0; i < queries.length; i++) {
    if (VERBOSE && i > 0) console.log(`  [WebSearch] Trying alternate query: "${queries[i]}"`);

    const result = await tryQueryAcrossEngines(queries[i], cleanedName, name);
    if (result) {
      // Post-hoc relevance check: reject URLs that don't relate to the foundation name.
      // Use cleanedName for tokens, but pass original name for digit extraction.
      if (!urlLooksRelevant(result.url, cleanedName, name)) {
        if (VERBOSE) console.log(`  [WebSearch] Skipping irrelevant result: ${result.url}`);
        continue; // try next query variation
      }
      return result;
    }

    // Pause before trying next query variation
    if (i < queries.length - 1) await sleep(SEARCH_DELAY_MS);
  }

  return null;
}

// ─── Batch processor ──────────────────────────────────────────────────────────

/**
 * Process a single funder through the lookup pipeline.
 * Returns { id, name, url, source } or { id, name, url: null }.
 */
async function lookupOneFunder({ id, name }) {
  // Layer 1 + 2: ProPublica (by EIN — checks org.website + IRS 990 websiteaddress)
  const ppUrl = await lookupProPublica(id);
  if (ppUrl) return { id, name, url: ppUrl, source: 'ProPublica' };

  // Layer 3: Google Knowledge Graph (if GOOGLE_API_KEY is set)
  const kgUrl = await lookupKnowledgeGraph(name);
  if (kgUrl) return { id, name, url: kgUrl, source: 'KnowledgeGraph' };

  // Layer 4: Web search (Brave API → DDG lite) — catches foundations whose
  // domain doesn't match their name by finding what a real search returns
  const webResult = await lookupWebSearch(name);
  if (webResult) return { id, name, url: webResult.url, source: `WebSearch-${webResult.engine}` };

  return { id, name, url: null, source: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const kgEnabled = !!GOOGLE_API_KEY;
  const braveEnabled = !!BRAVE_API_KEY;
  console.log(
    `Enriching up to ${LIMIT} funders without websites (concurrency=${CONCURRENCY})…` +
    (DRY_RUN  ? ' [DRY RUN]'  : '') +
    (VERBOSE  ? ' [VERBOSE]'  : '') +
    (kgEnabled    ? ' [Knowledge Graph enabled]'    : ' [Knowledge Graph disabled — set GOOGLE_API_KEY]') +
    (braveEnabled ? ' [Brave Search enabled]'       : ' [Brave Search disabled — set BRAVE_API_KEY]') +
    '\n'
  );

  const funders = await getFundersWithoutWebsite();
  console.log(`Found ${funders.length} funders to process.\n`);

  const stats = { propublica: 0, kg: 0, webSearch: 0, notFound: 0, errors: 0 };
  let processed = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < funders.length; i += CONCURRENCY) {
    const batch = funders.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(f => lookupOneFunder(f)));

    for (const result of results) {
      processed++;
      if (result.status === 'rejected') {
        stats.errors++;
        continue;
      }

      const { id, name, url, source } = result.value;

      if (url) {
        console.log(`✅  [${source}] ${name} (${id}) → ${url}`);
        if (!DRY_RUN) {
          try {
            await updateWebsite(id, url);
          } catch (e) {
            console.error(`  ❌ DB update failed for ${id}: ${e.message}`);
            stats.errors++;
            continue;
          }
        }
        if (source === 'ProPublica') stats.propublica++;
        else if (source === 'KnowledgeGraph') stats.kg++;
        else stats.webSearch++;  // DDG, Google, or Bing
      } else {
        console.log(`–   [none]       ${name} (${id}) → no website found`);
        stats.notFound++;
      }
    }

    // Progress indicator every 50 funders
    if (processed % 50 === 0 || processed === funders.length) {
      const totalFound = stats.propublica + stats.kg + stats.webSearch;
      console.log(`\n  … ${processed}/${funders.length} processed (${totalFound} found so far)\n`);
    }

    // Polite pause between batches
    if (i + CONCURRENCY < funders.length) await sleep(PROPUBLICA_DELAY_MS);
  }

  const totalFound = stats.propublica + stats.kg + stats.webSearch;

  console.log('\n── Summary ─────────────────────────────────────');
  console.log(`  ProPublica hits    : ${stats.propublica}`);
  console.log(`  Knowledge Graph    : ${stats.kg}`);
  console.log(`  Web Search (Brave/DDG) : ${stats.webSearch}`);
  console.log(`  Not found          : ${stats.notFound}`);
  console.log(`  Errors             : ${stats.errors}`);
  console.log(`  Total updated      : ${totalFound}`);
  if (braveDisabledAt) console.log(`  ⚠️  Brave auto-disabled at ${braveDisabledAt.toISOString()}`);
  if (ddgConsecutiveFails >= DDG_MAX_CONSECUTIVE_FAILS) console.log(`  ⚠️  DDG auto-disabled after ${DDG_MAX_CONSECUTIVE_FAILS} consecutive failures`);
  console.log('─────────────────────────────────────────────────');

  if (DRY_RUN) {
    console.log('\n(Dry run — no changes written to DB)');
  } else if (totalFound > 0) {
    console.log('\nNext steps:');
    console.log('  1. Run subpage enrichment: node scripts/enrich-subpages.js');
    console.log('  2. Clear the search cache: node scripts/clear-cache.js');
    console.log('  3. Re-run this script with a higher LIMIT to process more funders');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
