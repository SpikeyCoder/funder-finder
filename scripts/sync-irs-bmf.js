#!/usr/bin/env node
/**
 * sync-irs-bmf.js
 *
 * Loads the IRS Exempt Organizations Business Master File (BMF) so search
 * covers public charities that no funder's grant records name yet, and
 * matches organizations by their IRS legal name.
 * (supabase/migrations/20261004140000_irs_bmf_coverage.sql)
 *
 * Pipeline:
 *   1) Download the BMF's four regional CSVs (eo1-eo4) from irs.gov, then
 *      read them twice:
 *      first counting how many 501(c)(3)s share each name (a name 5+ share
 *      is a group's, e.g. "LITTLE LEAGUE BASEBALL INC"), then sending the
 *      501(c)(3) rows in batches to irs_bmf_stage(), which keeps active
 *      public charities with income and organizations FunderMatch holds.
 *   2) irs_bmf_add_recipients(): add the public charities this run staged
 *      that FunderMatch doesn't hold as recipients (source 'irs_bmf', no
 *      grants).
 *   3) org_search_refresh_alt(): set each search row's IRS name.
 * Each step works in small windows (each call well under the API's 8 s
 * statement timeout) and can be re-run: rows are upserted, recipients added
 * once, aliases recomputed.
 *
 * Required env vars:
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env vars:
 *   SUPABASE_URL   (default project URL)
 *   DRY_RUN        (set 1 to download and count rows without writing)
 *   MIN_ROWS       (default 1500000: fewer 501(c)(3) rows than this means a
 *                   truncated or changed file, and nothing is added; the
 *                   September 2026 BMF has 1,642,105)
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const MIN_ROWS = Number.parseInt(process.env.MIN_ROWS || '1500000', 10);

const BMF_BASE = 'https://www.irs.gov/pub/irs-soi/';
const BMF_FILES = ['eo1.csv', 'eo2.csv', 'eo3.csv', 'eo4.csv'];
const BATCH_ROWS = 5000;
const WINDOW = 10000;
// A whole file downloads in well under a minute; past this, something hung.
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const RPC_TIMEOUT_MS = 60_000;
// The BMF has no embedded quotes; more broken lines than this means a format
// change.
const MAX_BAD_LINES = 100;

// ── Pure helpers (tests/sync-irs-bmf.test.mjs) ──────────────────────────────

/**
 * Splits one CSV line: comma-separated, fields optionally "quoted" with "" for
 * a quote. Null if a quote is left open.
 */
export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** A BMF record's name if it's a 501(c)(3) with a 9-digit EIN and a name, else null. */
export function c3Name(rec) {
  const ein = (rec.EIN || '').trim();
  const name = (rec.NAME || '').trim();
  if ((rec.SUBSECTION || '').trim() !== '03' || !/^\d{9}$/.test(ein) || !name) return null;
  return name;
}

/**
 * The irs_bmf_stage() row for a BMF record (an object keyed by the header's
 * column names), or null if it isn't a 501(c)(3) with a 9-digit EIN and a
 * name. groupSize: how many 501(c)(3)s have its name.
 */
export function toStageRow(rec, groupSize = 1) {
  const name = c3Name(rec);
  if (!name) return null;
  return {
    ein: rec.EIN.trim(),
    name,
    group_size: groupSize,
    // A group-exemption chapter's own name (NAME is its parent's).
    sort_name: rec.SORT_NAME?.trim() || null,
    affiliation: rec.AFFILIATION?.trim() || null,
    city: rec.CITY?.trim() || null,
    state: rec.STATE?.trim() || null,
    // ZIP+4 as "12345-6789": keep the 5-digit ZIP.
    zip: rec.ZIP?.trim().slice(0, 5) || null,
    ntee_code: rec.NTEE_CD?.trim() || null,
    subsection: '03',
    foundation_code: rec.FOUNDATION?.trim() || null,
    status: rec.STATUS?.trim() || null,
    income_amt: toInt(rec.INCOME_AMT),
    asset_amt: toInt(rec.ASSET_AMT),
    revenue_amt: toInt(rec.REVENUE_AMT),
    ruling: rec.RULING?.trim() || null,
  };
}

/** The BMF release a file belongs to: the first of its Last-Modified month (UTC), as YYYY-MM-DD. */
export function bmfMonth(lastModified) {
  const d = new Date(lastModified);
  if (Number.isNaN(d.getTime())) throw new Error(`Unreadable Last-Modified: ${lastModified}`);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, args) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.text();
    // Retry server-side hiccups; a 4xx is a bug or a missing migration.
    if (res.status < 500 || attempt >= 5) throw new Error(`${fn}: HTTP ${res.status}: ${body.slice(0, 300)}`);
    await sleep(2 ** attempt * 1000);
  }
}

async function fetchOk(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (res.ok) return res;
      if (attempt >= 4) throw new Error(`${url}: HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= 4) throw err;
    }
    await sleep(2 ** attempt * 1000);
  }
}

// Saves url to dest whole, retrying from the start if the connection drops
// (irs.gov closes long-lived ones, so files aren't read while staging).
async function download(url, dest) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchOk(url);
      // (Compressed, the length is of what was sent, not of the decoded file.)
      const encoded = res.headers.get('content-encoding');
      const expected = encoded && encoded !== 'identity' ? null : Number(res.headers.get('content-length')) || null;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      const { size } = await stat(dest);
      if (expected && size !== expected) throw new Error(`${url}: got ${size} of ${expected} bytes`);
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      console.error(`${url}: download failed (${err.message}); retrying`);
      await sleep(2 ** attempt * 1000);
    }
  }
}

async function* bmfRecords(path) {
  const url = path; // for messages
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header = null;
  let bad = 0;
  for await (const line of lines) {
    if (!line) continue;
    const fields = parseCsvLine(line);
    if (!fields) {
      if (++bad > MAX_BAD_LINES) throw new Error(`${url}: over ${MAX_BAD_LINES} unparseable lines; the BMF format changed`);
      continue;
    }
    if (!header) {
      header = fields.map((h) => h.trim().toUpperCase());
      for (const col of ['EIN', 'NAME', 'SUBSECTION', 'FOUNDATION', 'STATUS', 'INCOME_AMT', 'AFFILIATION', 'SORT_NAME']) {
        if (!header.includes(col)) throw new Error(`${url}: no ${col} column; the BMF layout changed`);
      }
      continue;
    }
    const rec = {};
    header.forEach((h, i) => { rec[h] = fields[i]; });
    yield rec;
  }
}

async function main() {
  if (!SUPABASE_KEY && !DRY_RUN) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  // Rows this run stages are stamped after this; only those are added, so a
  // re-run can't add one that has since lapsed. (Taken a minute early: the
  // stamps are the database's clock.)
  const since = new Date(Date.now() - 60_000).toISOString();

  // All four files come from one release; date it by the newest.
  let latest = 0;
  for (const f of BMF_FILES) {
    const res = await fetchOk(BMF_BASE + f, { method: 'HEAD' });
    latest = Math.max(latest, new Date(res.headers.get('last-modified') || 0).getTime());
  }
  if (!latest) throw new Error('No Last-Modified on the BMF files');
  const month = bmfMonth(new Date(latest).toUTCString());
  console.log(`BMF release ${month}${DRY_RUN ? ' (dry run)' : ''}`);

  const dir = await mkdtemp(join(tmpdir(), 'bmf-'));
  try {
    await sync(dir, month, since);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function sync(dir, month, since) {
  const files = [];
  for (const f of BMF_FILES) {
    const path = join(dir, f);
    await download(BMF_BASE + f, path);
    files.push([f, path]);
  }

  const nameCounts = new Map();
  for (const [, path] of files) {
    for await (const rec of bmfRecords(path)) {
      const name = c3Name(rec);
      if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
  }
  console.log(`Counted ${nameCounts.size} distinct 501(c)(3) names`);

  let rows = 0;
  let stored = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    if (!DRY_RUN) stored += await rpc('irs_bmf_stage', { p_rows: batch, p_month: month });
    batch = [];
  };
  // An EIN listed twice in one batch would fail it ("ON CONFLICT DO UPDATE
  // command cannot affect row a second time"); keep the first.
  const seen = new Set();
  for (const [f, path] of files) {
    let fileRows = 0;
    for await (const rec of bmfRecords(path)) {
      const row = toStageRow(rec, nameCounts.get(c3Name(rec)) || 1);
      if (!row || seen.has(row.ein)) continue;
      seen.add(row.ein);
      batch.push(row);
      fileRows++;
      if (batch.length >= BATCH_ROWS) await flush();
    }
    await flush();
    rows += fileRows;
    console.log(`${f}: ${fileRows} 501(c)(3) rows`);
  }
  console.log(`Staged: ${rows} rows read, ${stored} kept`);
  if (rows < MIN_ROWS) {
    throw new Error(`Only ${rows} 501(c)(3) rows (expected ${MIN_ROWS}+); not adding organizations from a partial file`);
  }
  if (DRY_RUN) return;

  let after = '';
  let added = 0;
  for (;;) {
    const [r] = await rpc('irs_bmf_add_recipients', { p_since: since, p_after: after, p_window: WINDOW });
    if (!r || r.last_ein === null) break;
    added += r.added;
    after = r.last_ein;
  }
  console.log(`Added ${added} public charities as recipients`);

  let kind = '';
  let id = '';
  let changed = 0;
  for (;;) {
    const [r] = await rpc('org_search_refresh_alt', { p_after_kind: kind, p_after_id: id, p_window: WINDOW });
    if (!r || r.last_kind === null) break;
    changed += r.changed;
    kind = r.last_kind;
    id = r.last_id;
  }
  console.log(`Updated the IRS legal name on ${changed} search rows`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
