// ── Real-time grant page discovery ──────────────────────────────────────────
// Adapted from scripts/enrich-subpages.js — lightweight homepage scanner that
// finds grant application / LOI pages by scoring <a> tag hrefs + anchor text.
//
// Discovery used to run inside a visitor's /match-funders request (Trello
// #285: chunks of 6 sites one after another, each allowed 3 s for headers and
// unbounded for the body, added 6-24 s to matching and pushed it past its
// 20 s SLA). It now runs after the response is sent, within one budget, and
// its hits are read from funders.discovered_apply_url by later searches.

/** Wall-clock budget for discovering a whole batch of funders' grant pages. */
export const DISCOVERY_BUDGET_MS = 8_000;
/** Homepages fetched at once. */
export const DISCOVERY_CONCURRENCY = 8;
/** A homepage scanned without finding a grant page isn't scanned again for this long. */
export const DISCOVERY_MISS_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
/** A homepage that failed to load is retried after this long. */
export const DISCOVERY_ERROR_RECHECK_MS = 24 * 60 * 60 * 1000;
/** One homepage gets at most this long; one that takes longer counts as failed. */
export const DISCOVERY_SITE_TIMEOUT_MS = 4_000;

const MAX_HTML_CHARS = 500_000;

const GRANT_PATH_HINTS = [
  '/apply', '/grant-guideline', '/how-to-apply', '/loi', '/rfp',
  '/letter-of-inquiry', '/applicant', '/funding-guideline', '/proposal',
  '/submit', '/grantseekers', '/prospective', '/grants', '/funding',
  '/open-grant', '/grant-opportunities', '/grantmaking',
];

const GRANT_TEXT_HINTS = [
  'apply', 'how to apply', 'grant guidelines', 'loi', 'letter of inquiry',
  'rfp', 'submit', 'application', 'grantseekers', 'funding guidelines',
  'grant opportunities', 'open grants', 'apply for a grant',
  'application process', 'prospective grantees', 'request for proposals',
  'grants', 'funding', 'grantmaking',
];

/** A URL's host without www. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^www\./, '');
}

function extractDomain(url: string): string | null {
  try {
    return bareHost(new URL(url));
  } catch { return null; }
}

/** `host` is the funder's own site `site` or a subdomain of it (apply.fund.org on fund.org). */
function onSite(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/** Rejects when `signal` aborts, so a stalled read can't outlive it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // A response that arrives after the abort is let go, body included; a
  // rejection then would otherwise go unhandled and end the isolate
  const discard = (value: T) => {
    if (value instanceof Response) value.body?.cancel().catch(() => {});
  };
  if (signal.aborted) {
    promise.then(discard, () => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then((value) => (signal.aborted ? discard(value) : resolve(value)), reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export type HomepageResult =
  /** An HTML page; `url` is where it was served from, after redirects. */
  | { kind: 'page'; html: string; url: string }
  /** No page to scan, for good: not found, gone, not HTML, or a private address safeFetch won't fetch. */
  | { kind: 'miss' }
  /** Anything that may pass: network errors, 5xx, 429, 403 bot walls, the deadline. */
  | { kind: 'error' };

/**
 * Fetch a homepage's HTML (at most MAX_HTML_CHARS of it). `signal` covers the
 * whole exchange, headers and body.
 */
export async function fetchHomepageHtml(
  url: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<HomepageResult> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await abortable(fetchFn(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FunderFinder/1.0; +https://fundermatch.org)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    }), signal);
    const ct = res.headers.get('content-type') || '';
    // A missing Content-Type is read as HTML; servers that omit it usually serve pages
    if (!res.ok || (ct && !ct.toLowerCase().includes('html')) || !res.body) {
      res.body?.cancel().catch(() => {});
      return res.ok || res.status === 404 || res.status === 410 ? { kind: 'miss' } : { kind: 'error' };
    }
    // Read only as much of the page as is scanned
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    for (;;) {
      if (html.length >= MAX_HTML_CHARS) break;
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        html += decoder.decode();
        break;
      }
      html += decoder.decode(value, { stream: true });
    }
    return { kind: 'page', html: html.slice(0, MAX_HTML_CHARS), url: res.url || url };
  } catch (e) {
    // safeFetch refuses private and metadata addresses for good; its other
    // refusals (DNS failures, redirect loops) may pass
    const blocked = e instanceof Error && e.name === 'SSRFBlockedError'
      && /^(Blocked |Disallowed scheme|Invalid URL)|^Hostname \S+ resolves to private /.test(e.message);
    return blocked ? { kind: 'miss' } : { kind: 'error' };
  } finally {
    reader?.cancel().catch(() => {});
  }
}

/**
 * Where a funder's own links can be: on its site `siteUrl` (or a subdomain),
 * or, when the homepage redirected up to a parent domain (foundation.bigcorp.com
 * to www.bigcorp.com/foundation/), under the path it landed on. A redirect
 * anywhere else (an expired domain, a parked page, a social profile, a
 * rebrand) has none: a third party's link must never be shown as the funder's.
 */
function funderScope(pageUrl: string, siteUrl: string): ((link: URL) => boolean) | null {
  const site = extractDomain(siteUrl);
  let page: URL;
  try { page = new URL(pageUrl); } catch { return null; }
  const served = bareHost(page);
  if (!site) return null;
  if (onSite(served, site)) return (link) => onSite(bareHost(link), site);
  const prefix = page.pathname.endsWith('/') ? page.pathname : `${page.pathname}/`;
  if (onSite(site, served) && prefix !== '/') {
    return (link) => bareHost(link) === served && `${link.pathname}/`.startsWith(prefix);
  }
  return null;
}

/**
 * Scan homepage HTML for grant-related links on the funder's site, return the
 * best URL or null. Relative links resolve against `pageUrl` (where the page
 * was served from, after redirects); see funderScope for which links count.
 */
export function discoverGrantPageUrl(html: string, pageUrl: string, siteUrl = pageUrl): string | null {
  const inScope = funderScope(pageUrl, siteUrl);
  if (!inScope) return null;
  const trimSlash = (path: string) => path.replace(/\/+$/, '');
  const page = new URL(pageUrl);
  const landingPath = trimSlash(page.pathname);
  const homeHosts = new Set([bareHost(page), extractDomain(siteUrl)]);

  // Extract <a> tags — same regex as enrich-subpages.js
  // (Anchor text capped, so unclosed <a> tags can't make the scan quadratic)
  const tagRe = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]{0,2000}?)<\/a>/gi;
  let best: { url: string; score: number } | null = null;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    const rawHref = m[1].trim();
    // Skip non-page links
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') ||
        rawHref.startsWith('tel:') || rawHref.startsWith('javascript:')) continue;

    let link: URL;
    try { link = new URL(rawHref, pageUrl); } catch { continue; }
    const resolvedUrl = link.href;

    // Must be the funder's own web page, not its homepage or the page scanned
    if ((link.protocol !== 'https:' && link.protocol !== 'http:') || !inScope(link)) continue;
    // (a grant portal's own root, like https://grants.fund.org/, is fine)
    const path = trimSlash(link.pathname);
    if ((path === '' && homeHosts.has(bareHost(link))) || (path === landingPath && bareHost(link) === bareHost(page))) continue;

    // Score against hints
    // The path, not the funder's host name (every link on fundingfutures.org
    // isn't a grant page); a subdomain of its own counts as the first segment
    // (grants.fund.org/ reads as /grants/)
    const host = bareHost(link);
    const subdomain = host !== bareHost(page) && host !== extractDomain(siteUrl) ? `/${host.split('.')[0]}` : '';
    const urlLower = `${subdomain}${link.pathname}${link.search}`.toLowerCase();
    const anchorText = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    let score = 0;

    for (const hint of GRANT_PATH_HINTS) {
      if (urlLower.includes(hint)) score += 3;
    }
    for (const hint of GRANT_TEXT_HINTS) {
      if (anchorText.includes(hint)) score += 3;
    }

    if (score >= 3 && (!best || score > best.score)) {
      best = { url: resolvedUrl, score };
    }
  }

  return best?.url ?? null;
}

export interface DiscoveryResult {
  /** Funder id → discovered grant page URL. */
  found: Map<string, string>;
  /** Funders whose homepage has no grant page: scanned without one, 404/410, or not HTML. */
  missed: string[];
  /** Funders whose homepage failed to load, or took longer than DISCOVERY_SITE_TIMEOUT_MS. */
  failed: string[];
}

export interface DiscoveryOptions {
  budgetMs?: number;
  concurrency?: number;
  siteTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Discover grant page URLs for funders missing apply_url (`website` an
 * absolute http(s) URL), in the given order,
 * `concurrency` homepages at a time (each website fetched once), returning
 * once all are scanned or `budgetMs` has passed, whichever is first. Funders
 * not reached, or cut off by the budget, are in none of the result's lists.
 */
export async function discoverGrantUrlsInBatch(
  funders: { id: string; website: string }[],
  {
    budgetMs = DISCOVERY_BUDGET_MS, concurrency = DISCOVERY_CONCURRENCY,
    siteTimeoutMs = DISCOVERY_SITE_TIMEOUT_MS, fetchFn = fetch,
  }: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { found: new Map(), missed: [], failed: [] };
  if (funders.length === 0 || budgetMs <= 0) return result;

  const sites = [...Map.groupBy(funders, (f) => f.website)].map(([url, group]) => [url, group.map((f) => f.id)] as const);

  const deadline = AbortSignal.timeout(Math.ceil(budgetMs));
  let next = 0;
  const worker = async () => {
    while (next < sites.length && !deadline.aborted) {
      const [url, ids] = sites[next++];
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(siteTimeoutMs)]);
      const page = await fetchHomepageHtml(url, signal, fetchFn);
      // Cut off by the batch budget, not the site: tried again next time
      if (page.kind === 'error' && deadline.aborted) return;
      if (page.kind === 'error') {
        result.failed.push(...ids);
        continue;
      }
      const discovered = page.kind === 'page' ? discoverGrantPageUrl(page.html, page.url, url) : null;
      for (const id of ids) {
        if (discovered) result.found.set(id, discovered);
        else result.missed.push(id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sites.length) }, worker));
  return result;
}
