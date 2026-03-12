#!/usr/bin/env node
/**
 * scripts/enrich-websites.js
 *
 * Scalable website enrichment for funders missing website URLs.
 *
 * Lookup strategy (kept from prior flow, first hit wins):
 *   1) ProPublica organization.website
 *   2) ProPublica filings_with_data / filings_without_data website fields
 *   3) Google Knowledge Graph API (optional, GOOGLE_API_KEY)
 *   4) Brave Search API (optional, BRAVE_API_KEY)
 *   5) DuckDuckGo lite HTML fallback
 *
 * Scale features:
 *   - Cursor pagination (id > last_id) instead of one-shot LIMIT queries
 *   - Concurrency-controlled workers
 *   - Batched DB updates (single SQL UPDATE ... FROM VALUES ...)
 *   - Retry + timeout wrappers
 *   - Checkpoint file for resumable runs
 *   - Per-name cache to avoid repeated external lookups
 *
 * Required env:
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   GOOGLE_API_KEY
 *   BRAVE_API_KEY
 *   SINGLE_EIN=#########           # process one EIN only
 *   MAX_ROWS=0                     # 0 = no cap; processes until exhaustion
 *   FETCH_BATCH_SIZE=2000
 *   CONCURRENCY=12
 *   SEARCH_CONCURRENCY=3
 *   WRITE_BATCH_SIZE=200
 *   CHECKPOINT_EVERY=250
 *   RESET_CHECKPOINT=0
 *   CHECKPOINT_PATH=.../enrich-websites.checkpoint.json
 *   DRY_RUN=0
 *   VERBOSE=0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || null;
const SINGLE_EIN = process.env.SINGLE_EIN || process.env.EIN || null;

const MAX_ROWS = Number.parseInt(process.env.MAX_ROWS || process.env.LIMIT || '0', 10); // 0 => unlimited
const FETCH_BATCH_SIZE = Number.parseInt(process.env.FETCH_BATCH_SIZE || '2000', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '12', 10);
const SEARCH_CONCURRENCY = Number.parseInt(process.env.SEARCH_CONCURRENCY || '3', 10);
const WRITE_BATCH_SIZE = Number.parseInt(process.env.WRITE_BATCH_SIZE || '200', 10);
const CHECKPOINT_EVERY = Number.parseInt(process.env.CHECKPOINT_EVERY || '250', 10);

const DRY_RUN = process.env.DRY_RUN === '1';
const VERBOSE = process.env.VERBOSE === '1';
const RESET_CHECKPOINT = process.env.RESET_CHECKPOINT === '1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CHECKPOINT_PATH = path.join(__dirname, '..', 'eval', 'results', 'enrich-websites.checkpoint.json');
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || DEFAULT_CHECKPOINT_PATH;

const PROPUBLICA_DELAY_MS = Number.parseInt(process.env.PROPUBLICA_DELAY_MS || '40', 10);
const SEARCH_DELAY_MS = Number.parseInt(process.env.SEARCH_DELAY_MS || '120', 10);

const NETWORK_TIMEOUT_MS = Number.parseInt(process.env.NETWORK_TIMEOUT_MS || '12000', 10);
const SUPABASE_TIMEOUT_MS = Number.parseInt(process.env.SUPABASE_TIMEOUT_MS || '15000', 10);
const RETRY_BASE_MS = Number.parseInt(process.env.RETRY_BASE_MS || '300', 10);
const RETRY_ATTEMPTS = Number.parseInt(process.env.RETRY_ATTEMPTS || '4', 10);

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_SERVICE_ROLE_KEY env variable is required.');
  process.exit(1);
}

const SUPABASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

let braveDisabledAt = null;
let ddgConsecutiveFails = 0;
const DDG_MAX_CONSECUTIVE_FAILS = 4;

const nameLookupCache = new Map(); // cleanedName -> { url, source } | null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function looksLikeUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function chunkArray(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function shouldRetryStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(url, options = {}, cfg = {}) {
  const {
    attempts = RETRY_ATTEMPTS,
    timeoutMs = NETWORK_TIMEOUT_MS,
    baseDelayMs = RETRY_BASE_MS,
    retryOn = shouldRetryStatus,
  } = cfg;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      const body = await res.text();
      if (!retryOn(res.status) || attempt === attempts) {
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
      }
      await sleep(baseDelayMs * attempt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === attempts) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError || new Error('request failed');
}

async function supabaseRequest(pathAndQuery, options = {}, timeoutMs = SUPABASE_TIMEOUT_MS) {
  return fetchWithRetry(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...options,
    headers: {
      ...SUPABASE_HEADERS,
      ...(options.headers || {}),
    },
  }, { timeoutMs });
}

async function supabaseRpcExecSql(query) {
  const res = await supabaseRequest('rpc/exec_sql', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
  return res.json();
}

async function ensureCheckpointDir() {
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
}

async function loadCheckpoint() {
  if (RESET_CHECKPOINT) return null;
  try {
    const raw = await fs.readFile(CHECKPOINT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveCheckpoint(state) {
  await ensureCheckpointDir();
  const payload = {
    version: 2,
    updated_at: new Date().toISOString(),
    ...state,
  };
  await fs.writeFile(CHECKPOINT_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

async function fetchFundersBatch(afterId, limit) {
  if (SINGLE_EIN) {
    if (afterId) return [];
    const res = await supabaseRequest(
      `funders?select=id,name,foundation_ein&id=eq.${encodeURIComponent(SINGLE_EIN)}&limit=1`,
      {},
    );
    return res.json();
  }

  let query =
    `funders?select=id,name,foundation_ein` +
    `&website=is.null` +
    `&foundation_ein=not.is.null` +
    `&order=id.asc` +
    `&limit=${limit}`;
  if (afterId) query += `&id=gt.${encodeURIComponent(afterId)}`;

  const res = await supabaseRequest(query);
  return res.json();
}

let execSqlAvailable = null;

async function detectExecSqlAvailability() {
  if (execSqlAvailable !== null) return execSqlAvailable;
  try {
    await supabaseRpcExecSql('SELECT 1 AS ok;');
    execSqlAvailable = true;
  } catch {
    execSqlAvailable = false;
  }
  return execSqlAvailable;
}

async function updateWebsiteSingle(id, website) {
  await supabaseRequest(
    `funders?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ website }),
    },
  );
}

async function updateWebsitesBatch(rows) {
  if (!rows.length || DRY_RUN) return 0;

  if (await detectExecSqlAvailability()) {
    const values = rows.map(({ id, website }) =>
      `('${escapeSql(id)}','${escapeSql(website)}')`
    ).join(',');

    const query = `
      UPDATE funders AS f
      SET website = v.website
      FROM (VALUES ${values}) AS v(id, website)
      WHERE f.id = v.id
        AND (f.website IS NULL OR f.website = '')
    `;

    await supabaseRpcExecSql(query);
    return rows.length;
  }

  for (const row of rows) {
    await updateWebsiteSingle(row.id, row.website);
  }
  return rows.length;
}

function cleanFoundationName(name) {
  let cleaned = String(name || '')
    .replace(/^\d{5,10}\s+/, '')
    .replace(/\s+\d{5,10}$/, '')
    .replace(/\b(INC|INCORPORATED|LLC|LTD|CORP|CORPORATION|CO)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const noNums = cleaned.replace(/\b\d{1,4}\b/g, '').replace(/\s+/g, ' ').trim();
  const alphaWords = noNums.split(/\s+/).filter((w) => /[a-zA-Z]{3,}/.test(w));
  if (alphaWords.length >= 2) cleaned = noNums;

  return cleaned;
}

const SKIP_DOMAINS = new Set([
  'wikipedia.org', 'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com',
  'youtube.com', 'tiktok.com', 'guidestar.org', 'candid.org', 'charitynavigator.org',
  'projects.propublica.org', 'apps.irs.gov', 'google.com', 'bing.com', 'duckduckgo.com',
  'yahoo.com', 'github.com', 'reddit.com', 'medium.com',
]);

function isSkippableDomain(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  if (SKIP_DOMAINS.has(h) || SKIP_DOMAINS.has(`www.${h}`)) return true;
  for (const skip of SKIP_DOMAINS) {
    const base = skip.replace(/^www\./, '');
    if (h.endsWith(`.${base}`)) return true;
  }
  return false;
}

function tokenize(text) {
  const noise = new Set([
    'the', 'and', 'for', 'inc', 'incorporated', 'llc', 'ltd', 'corp', 'corporation',
    'foundation', 'fund', 'trust', 'org', 'nonprofit', 'charity', 'charitable',
  ]);
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !noise.has(word));
}

function scoreUrlRelevance(url, cleanedName, originalName) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathPart = parsed.pathname.toLowerCase();
    const urlWords = `${host} ${pathPart}`.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
    const nameTokens = tokenize(cleanedName);
    if (!nameTokens.length) return 1;

    const digits = String(originalName || cleanedName).match(/\d+/g) || [];
    const suffixes = new Set(['foundation', 'fdn', 'fund', 'trust', 'charity', ...digits]);

    let hits = 0;
    for (const token of nameTokens) {
      if (urlWords.includes(token)) {
        hits += 1;
        continue;
      }
      const compound = urlWords.some((word) => {
        const idx = word.indexOf(token);
        if (idx < 0) return false;
        const before = word.slice(0, idx);
        const after = word.slice(idx + token.length);
        const beforeOk = !before || nameTokens.includes(before) || suffixes.has(before);
        const afterOk = !after || nameTokens.includes(after) || suffixes.has(after);
        return beforeOk && afterOk;
      });
      if (compound) hits += 1;
    }

    let score = hits;
    const rootDepth = pathPart.replace(/\/$/, '').split('/').filter(Boolean).length;
    if (rootDepth <= 1) score += 2;
    if (rootDepth >= 3) score -= 1;
    return score;
  } catch {
    return 0;
  }
}

function pickBestUrl(urls, cleanedName, originalName) {
  const candidates = urls.filter((url) => {
    try {
      const host = new URL(url).hostname;
      return !isSkippableDomain(host);
    } catch {
      return false;
    }
  });
  if (!candidates.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const url of candidates) {
    const score = scoreUrlRelevance(url, cleanedName, originalName);
    if (score > bestScore) {
      best = url;
      bestScore = score;
    }
  }

  return bestScore >= 5 ? best : null;
}

async function lookupProPublica(ein) {
  try {
    const res = await fetchWithRetry(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${encodeURIComponent(ein)}.json`,
      { headers: { Accept: 'application/json' } },
      { timeoutMs: NETWORK_TIMEOUT_MS },
    );
    const data = await res.json();
    const org = data?.organization || {};

    const top = normalizeUrl(org.website);
    if (top && looksLikeUrl(top)) return top;

    const filings = [
      ...(Array.isArray(data?.filings_with_data) ? data.filings_with_data : []),
      ...(Array.isArray(data?.filings_without_data) ? data.filings_without_data : []),
    ];
    for (const filing of filings) {
      const raw = filing?.websiteaddress || filing?.website_address || filing?.websiteurl;
      const url = normalizeUrl(raw);
      if (url && looksLikeUrl(url)) return url;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (PROPUBLICA_DELAY_MS > 0) await sleep(PROPUBLICA_DELAY_MS);
  }
}

async function lookupKnowledgeGraph(name) {
  if (!GOOGLE_API_KEY) return null;
  try {
    const q = encodeURIComponent(name);
    const url = `https://kgsearch.googleapis.com/v1/entities:search?query=${q}&key=${GOOGLE_API_KEY}&limit=3&types=Organization`;
    const res = await fetchWithRetry(url, {}, { timeoutMs: NETWORK_TIMEOUT_MS });
    const data = await res.json();
    const items = Array.isArray(data?.itemListElement) ? data.itemListElement : [];
    for (const item of items) {
      if ((item?.resultScore || 0) < 5) continue;
      const hit = normalizeUrl(item?.result?.url || '');
      if (hit && looksLikeUrl(hit)) return hit;
    }
  } catch {
    return null;
  }
  return null;
}

function parseDDGResults(html) {
  const urls = [];
  let match = null;
  const patterns = [
    /class="result-link"[^>]*href="(https?:\/\/[^"]+)"/g,
    /<a[^>]+rel="nofollow"[^>]+href="(https?:\/\/[^"]+)"/g,
    /uddg=([^&"']+)/g,
  ];

  for (const pattern of patterns) {
    while ((match = pattern.exec(html)) !== null) {
      try {
        const raw = pattern.source.includes('uddg=') ? decodeURIComponent(match[1]) : match[1];
        const normalized = normalizeUrl(raw);
        if (normalized && looksLikeUrl(normalized)) urls.push(normalized);
      } catch {
        // ignore bad matches
      }
    }
  }

  return [...new Set(urls)];
}

async function lookupBrave(searchQuery, cleanedName, originalName) {
  if (!BRAVE_API_KEY || braveDisabledAt) return null;
  try {
    const q = encodeURIComponent(searchQuery);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${q}&count=10&safesearch=off&text_decorations=false`;
    const res = await fetchWithRetry(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    }, { timeoutMs: NETWORK_TIMEOUT_MS });
    const data = await res.json();
    const results = Array.isArray(data?.web?.results) ? data.web.results : [];
    const urls = results.map((r) => normalizeUrl(r?.url)).filter((u) => !!u && looksLikeUrl(u));
    return pickBestUrl(urls, cleanedName, originalName);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || '');
    if (msg.includes('HTTP 401') || msg.includes('HTTP 403') || msg.includes('HTTP 429')) {
      braveDisabledAt = new Date();
      console.warn(`⚠️  Brave disabled due to auth/rate response: ${msg}`);
    }
    return null;
  }
}

async function lookupDDG(searchQuery, cleanedName, originalName) {
  if (ddgConsecutiveFails >= DDG_MAX_CONSECUTIVE_FAILS) return null;
  try {
    const q = encodeURIComponent(searchQuery);
    const res = await fetchWithRetry(`https://lite.duckduckgo.com/lite/?q=${q}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    }, { timeoutMs: NETWORK_TIMEOUT_MS });
    const html = await res.text();
    const urls = parseDDGResults(html);
    const picked = pickBestUrl(urls, cleanedName, originalName);
    if (picked) ddgConsecutiveFails = 0;
    else ddgConsecutiveFails += 1;
    return picked;
  } catch {
    ddgConsecutiveFails += 1;
    return null;
  }
}

function buildSearchQueries(name) {
  const clean = cleanFoundationName(name);
  const list = [clean];
  list.push(`${clean} nonprofit`);
  list.push(`"${clean}"`);
  return [...new Set(list.filter((q) => q && q.trim().length >= 3))];
}

function createSemaphore(maxConcurrent) {
  const max = Math.max(1, maxConcurrent);
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    Promise.resolve()
      .then(next.fn)
      .then((value) => next.resolve(value))
      .catch((err) => next.reject(err))
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        runNext();
      });
    },
  };
}

const searchSemaphore = createSemaphore(SEARCH_CONCURRENCY);

async function lookupWebSearch(name) {
  const cleaned = cleanFoundationName(name);
  if (!cleaned) return null;

  if (nameLookupCache.has(cleaned)) return nameLookupCache.get(cleaned);

  const queries = buildSearchQueries(name);
  for (let i = 0; i < queries.length; i += 1) {
    const q = queries[i];
    const braveHit = await lookupBrave(q, cleaned, name);
    if (braveHit) {
      const out = { url: braveHit, source: 'WebSearch-Brave' };
      nameLookupCache.set(cleaned, out);
      return out;
    }
    if (SEARCH_DELAY_MS > 0) await sleep(SEARCH_DELAY_MS);

    const ddgHit = await lookupDDG(q, cleaned, name);
    if (ddgHit) {
      const out = { url: ddgHit, source: 'WebSearch-DDG' };
      nameLookupCache.set(cleaned, out);
      return out;
    }
    if (i < queries.length - 1 && SEARCH_DELAY_MS > 0) await sleep(SEARCH_DELAY_MS);
  }

  nameLookupCache.set(cleaned, null);
  return null;
}

async function lookupOneFunder(funder) {
  const { id, name, foundation_ein: foundationEinRaw } = funder;
  const foundationEin = String(foundationEinRaw || id || '').replace(/\D/g, '');

  const ppUrl = foundationEin ? await lookupProPublica(foundationEin) : null;
  if (ppUrl) return { id, name, website: ppUrl, source: 'ProPublica' };

  const kgUrl = await searchSemaphore.run(() => lookupKnowledgeGraph(name));
  if (kgUrl) return { id, name, website: kgUrl, source: 'KnowledgeGraph' };

  const web = await searchSemaphore.run(() => lookupWebSearch(name));
  if (web?.url) return { id, name, website: web.url, source: web.source };

  return { id, name, website: null, source: null };
}

async function processWorkerChunk(chunk) {
  return Promise.allSettled(chunk.map((f) => lookupOneFunder(f)));
}

async function main() {
  const checkpointEnabled = !SINGLE_EIN && !DRY_RUN;
  const checkpoint = checkpointEnabled ? await loadCheckpoint() : null;
  let lastId = checkpoint?.last_id || null;
  let processed = checkpoint?.processed || 0;
  let updated = checkpoint?.updated || 0;
  let notFound = checkpoint?.not_found || 0;
  let errors = checkpoint?.errors || 0;
  const sourceCounts = checkpoint?.sources || { ProPublica: 0, KnowledgeGraph: 0, WebSearch: 0 };

  console.log(
    `Website enrichment start | batch=${FETCH_BATCH_SIZE} workers=${CONCURRENCY} search_workers=${SEARCH_CONCURRENCY}` +
    ` | max_rows=${MAX_ROWS || 'unlimited'}${DRY_RUN ? ' | DRY_RUN' : ''}`,
  );
  if (checkpointEnabled) {
    console.log(`Checkpoint: ${CHECKPOINT_PATH}`);
    if (lastId) console.log(`Resuming from last_id=${lastId}\n`);
  } else {
    console.log('Checkpoint: disabled for this run mode\n');
  }

  let keepRunning = true;
  while (keepRunning) {
    if (MAX_ROWS > 0 && processed >= MAX_ROWS) break;

    const remaining = MAX_ROWS > 0 ? Math.max(0, MAX_ROWS - processed) : FETCH_BATCH_SIZE;
    const batchLimit = Math.min(FETCH_BATCH_SIZE, Math.max(1, remaining));
    const funders = await fetchFundersBatch(lastId, batchLimit);
    if (!funders.length) break;

    const updatesBuffer = [];
    for (let i = 0; i < funders.length; i += CONCURRENCY) {
      const slice = funders.slice(i, i + CONCURRENCY);
      const results = await processWorkerChunk(slice);

      for (const result of results) {
        if (MAX_ROWS > 0 && processed >= MAX_ROWS) {
          keepRunning = false;
          break;
        }

        processed += 1;

        if (result.status !== 'fulfilled') {
          errors += 1;
          continue;
        }

        const { id, name, website, source } = result.value;
        lastId = id;

        if (!website) {
          notFound += 1;
          if (VERBOSE) console.log(`- [none] ${name} (${id})`);
        } else {
          updatesBuffer.push({ id, website });
          if (source === 'ProPublica') sourceCounts.ProPublica += 1;
          else if (source === 'KnowledgeGraph') sourceCounts.KnowledgeGraph += 1;
          else sourceCounts.WebSearch += 1;
          if (VERBOSE) console.log(`+ [${source}] ${name} (${id}) -> ${website}`);
        }

        if (updatesBuffer.length >= WRITE_BATCH_SIZE) {
          const chunks = chunkArray(updatesBuffer.splice(0, updatesBuffer.length), WRITE_BATCH_SIZE);
          for (const updateChunk of chunks) {
            updated += await updateWebsitesBatch(updateChunk);
          }
        }

        if (checkpointEnabled && processed % CHECKPOINT_EVERY === 0) {
          await saveCheckpoint({
            last_id: lastId,
            processed,
            updated,
            not_found: notFound,
            errors,
            sources: sourceCounts,
            dry_run: DRY_RUN,
          });
          console.log(`Progress: processed=${processed} updated=${updated} not_found=${notFound} errors=${errors}`);
        }
      }
    }

    if (updatesBuffer.length) {
      const chunks = chunkArray(updatesBuffer, WRITE_BATCH_SIZE);
      for (const updateChunk of chunks) {
        updated += await updateWebsitesBatch(updateChunk);
      }
    }

    if (checkpointEnabled) {
      await saveCheckpoint({
        last_id: lastId,
        processed,
        updated,
        not_found: notFound,
        errors,
        sources: sourceCounts,
        dry_run: DRY_RUN,
      });
    }
  }

  console.log('\nSummary');
  console.log(`  Processed      : ${processed}`);
  console.log(`  Updated        : ${updated}`);
  console.log(`  Not found      : ${notFound}`);
  console.log(`  Errors         : ${errors}`);
  console.log(`  ProPublica     : ${sourceCounts.ProPublica}`);
  console.log(`  KnowledgeGraph : ${sourceCounts.KnowledgeGraph}`);
  console.log(`  WebSearch      : ${sourceCounts.WebSearch}`);
  if (braveDisabledAt) console.log(`  Brave disabled : ${braveDisabledAt.toISOString()}`);
  if (ddgConsecutiveFails >= DDG_MAX_CONSECUTIVE_FAILS) console.log('  DDG disabled due to consecutive failures');
  console.log(`  Checkpoint     : ${checkpointEnabled ? CHECKPOINT_PATH : '(disabled for this run)'}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
