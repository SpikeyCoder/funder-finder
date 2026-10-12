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

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

/** `host` is the funder's own site `site` or a subdomain of it (apply.fund.org on fund.org). */
function onSite(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/** Rejects when `signal` aborts, so a stalled read can't outlive it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export type HomepageResult =
  /** An HTML page; `url` is where it was served from, after redirects. */
  | { kind: 'page'; html: string; url: string }
  /** No page to scan, for good: not found, gone, or not HTML. */
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
    if (!res.ok || !ct.includes('html') || !res.body) {
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
  } catch {
    return { kind: 'error' };
  } finally {
    reader?.cancel().catch(() => {});
  }
}

/**
 * Scan homepage HTML for grant-related links on the funder's site, return the
 * best URL or null. Relative links resolve against `pageUrl` (where the page
 * was served from, after redirects); links must be on `siteUrl`'s host or a
 * subdomain of it.
 */
export function discoverGrantPageUrl(html: string, pageUrl: string, siteUrl = pageUrl): string | null {
  const funderDomain = extractDomain(siteUrl);
  if (!funderDomain) return null;

  // Extract <a> tags — same regex as enrich-subpages.js
  const tagRe = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let best: { url: string; score: number } | null = null;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    const rawHref = m[1].trim();
    // Skip non-page links
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') ||
        rawHref.startsWith('tel:') || rawHref.startsWith('javascript:')) continue;

    let resolvedUrl: string;
    try { resolvedUrl = new URL(rawHref, pageUrl).href; } catch { continue; }

    // Must be same domain
    const linkDomain = extractDomain(resolvedUrl);
    if (!linkDomain) continue;
    if (!onSite(linkDomain, funderDomain)) continue;

    // Skip homepage itself
    try {
      const parsed = new URL(resolvedUrl);
      if (parsed.pathname === '/' || parsed.pathname === '') continue;
    } catch { continue; }

    // Score against hints
    const urlLower = resolvedUrl.toLowerCase();
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
  /** Funders whose homepage failed to load. */
  failed: string[];
}

export interface DiscoveryOptions {
  budgetMs?: number;
  concurrency?: number;
  fetchFn?: typeof fetch;
}

/**
 * Discover grant page URLs for funders missing apply_url, in the given order,
 * `concurrency` homepages at a time (each website fetched once), returning
 * once all are scanned or `budgetMs` has passed, whichever is first. Funders
 * not reached, or cut off by the budget, are in none of the result's lists.
 */
export async function discoverGrantUrlsInBatch(
  funders: { id: string; website: string }[],
  { budgetMs = DISCOVERY_BUDGET_MS, concurrency = DISCOVERY_CONCURRENCY, fetchFn = fetch }: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { found: new Map(), missed: [], failed: [] };
  if (funders.length === 0 || budgetMs <= 0) return result;

  const idsBySite = new Map<string, string[]>();
  for (const f of funders) {
    const url = f.website.startsWith('http') ? f.website : `https://${f.website}`;
    idsBySite.set(url, [...(idsBySite.get(url) || []), f.id]);
  }
  const sites = [...idsBySite];

  const deadline = AbortSignal.timeout(Math.ceil(budgetMs));
  let next = 0;
  const worker = async () => {
    while (next < sites.length && !deadline.aborted) {
      const [url, ids] = sites[next++];
      const page = await fetchHomepageHtml(url, deadline, fetchFn);
      if (deadline.aborted) return;
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
