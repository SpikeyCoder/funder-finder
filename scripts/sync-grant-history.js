#!/usr/bin/env node
/**
 * sync-grant-history.js
 *
 * Refreshes cached prior-grantee data for seeded foundations.
 *
 * Pipeline:
 *   1) Discover recent 990-PF XML object IDs per foundation from ProPublica org pages.
 *   2) Upsert filing metadata into foundation_filings.
 *   3) Download XML filings (throttled), parse GrantOrContributionPdDurYrGrp rows.
 *   4) Upsert grants into foundation_grants.
 *   5) Compute and upsert per-foundation aggregates in foundation_history_features.
 *
 * Required env vars:
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env vars:
 *   SUPABASE_URL                (default project URL)
 *   YEARS_BACK                  (default 5)
 *   LIMIT                       (default 25)
 *   FOUNDATION_ID               (single funder id)
 *   MAX_XML_PER_RUN             (default 20)
 *   XML_MIN_INTERVAL_MS         (default 65000)
 *   OPENAI_API_KEY              (optional, for mission embeddings)
 *   ENABLE_EMBEDDINGS           (set 1 to enable OpenAI embedding calls)
 *   DRY_RUN                     (set 1 to skip writes)
 *   VERBOSE                     (set 1 for detailed logs)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://auth.fundermatch.org';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YEARS_BACK = Number.parseInt(process.env.YEARS_BACK || '5', 10);
const LIMIT = Number.parseInt(process.env.LIMIT || '25', 10);
const FOUNDATION_ID = process.env.FOUNDATION_ID || null;
const MAX_XML_PER_RUN = Number.parseInt(process.env.MAX_XML_PER_RUN || '20', 10);
const XML_MIN_INTERVAL_MS = Number.parseInt(process.env.XML_MIN_INTERVAL_MS || '65000', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ENABLE_EMBEDDINGS = process.env.ENABLE_EMBEDDINGS === '1' && !!OPENAI_API_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const VERBOSE = process.env.VERBOSE === '1';

if (!SUPABASE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY is required.');
  process.exit(1);
}

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

const FOUNDATION_FORM_HINT = 'IRS990PF';
const NOW_YEAR = new Date().getUTCFullYear();
const MIN_YEAR = NOW_YEAR - YEARS_BACK;

const US_STATE_TO_REGION = {
  AL: 'south', AK: 'west', AZ: 'west', AR: 'south', CA: 'west', CO: 'west', CT: 'northeast',
  DE: 'south', DC: 'south', FL: 'south', GA: 'south', HI: 'west', ID: 'west', IL: 'midwest',
  IN: 'midwest', IA: 'midwest', KS: 'midwest', KY: 'south', LA: 'south', ME: 'northeast',
  MD: 'south', MA: 'northeast', MI: 'midwest', MN: 'midwest', MS: 'south', MO: 'midwest',
  MT: 'west', NE: 'midwest', NV: 'west', NH: 'northeast', NJ: 'northeast', NM: 'west',
  NY: 'northeast', NC: 'south', ND: 'midwest', OH: 'midwest', OK: 'south', OR: 'west',
  PA: 'northeast', RI: 'northeast', SC: 'south', SD: 'midwest', TN: 'south', TX: 'south',
  UT: 'west', VT: 'northeast', VA: 'south', WA: 'west', WV: 'south', WI: 'midwest', WY: 'west',
};

const EIN_PROFILE_CACHE = new Map();
const EMBEDDING_CACHE = new Map();
let lastXmlFetchMs = 0;

function log(...args) {
  if (VERBOSE) console.log(...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeEin(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickBudgetBand(revenue, expenses) {
  const basis = asNumber(revenue) ?? asNumber(expenses);
  if (!basis || basis <= 0) return null;
  if (basis < 250_000) return 1;
  if (basis < 1_000_000) return 2;
  if (basis < 5_000_000) return 3;
  return 4;
}

function hashText(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h.toString(16);
}

function buildInFilter(values) {
  const quoted = values.map(v => `"${String(v).replace(/"/g, '')}"`);
  return encodeURIComponent(`(${quoted.join(',')})`);
}

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...HEADERS, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 500)}`);
  }
  return res;
}

async function fetchSeedFoundations() {
  const base = FOUNDATION_ID
    ? `funders?id=eq.${encodeURIComponent(FOUNDATION_ID)}`
    : `funders?select=id,name,foundation_ein&limit=${LIMIT}&order=total_giving.desc.nullslast`;
  const select = FOUNDATION_ID
    ? '&select=id,name,foundation_ein'
    : '';
  const res = await sb(`${base}${select}`);
  const rows = await res.json();

  const normalized = rows
    .map(r => {
      const ein = normalizeEin(r.foundation_ein || r.id);
      return {
        id: r.id,
        name: r.name,
        foundation_ein: ein,
      };
    })
    .filter(r => !!r.foundation_ein);

  return normalized;
}

function extractYearAnchors(html) {
  const anchors = [];
  const re = /id=['"]filing(\d{4})['"]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    anchors.push({ idx: m.index, year: Number.parseInt(m[1], 10) });
  }
  return anchors;
}

function findYearForIndex(yearAnchors, idx) {
  let year = null;
  for (const y of yearAnchors) {
    if (y.idx <= idx) year = y.year;
    else break;
  }
  return year;
}

function extractObjectIdsFromOrgPage(html) {
  const yearAnchors = extractYearAnchors(html);
  const entries = [];
  const re = /data-href="\/nonprofits\/organizations\/\d+\/(\d+)\/([^"\/?#]+)"/g;

  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const objectId = m[1];
    const formName = m[2];
    if (formName !== FOUNDATION_FORM_HINT) continue;
    if (seen.has(objectId)) continue;
    seen.add(objectId);

    const year = findYearForIndex(yearAnchors, m.index);
    if (!year || year < MIN_YEAR) continue;

    entries.push({
      object_id: objectId,
      tax_year: year,
      form_type: '990PF',
      xml_url: `https://projects.propublica.org/nonprofits/download-xml?object_id=${objectId}`,
    });
  }

  return entries;
}

async function fetchOrgPage(ein) {
  const url = `https://projects.propublica.org/nonprofits/organizations/${ein}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
      Accept: 'text/html',
    },
  });
  if (!res.ok) {
    throw new Error(`Org page fetch failed (${res.status}) for EIN ${ein}`);
  }
  return res.text();
}

async function upsertFilings(foundation, filingRows) {
  if (filingRows.length === 0) return;

  const rows = filingRows.map(row => ({
    foundation_id: foundation.id,
    foundation_ein: foundation.foundation_ein,
    tax_year: row.tax_year,
    form_type: row.form_type,
    object_id: row.object_id,
    xml_url: row.xml_url,
    parse_status: 'pending',
    fetched_at: new Date().toISOString(),
    source_hash: hashText(`${foundation.id}|${row.object_id}|${row.tax_year}`),
  }));

  if (DRY_RUN) {
    console.log(`  [dry-run] would upsert ${rows.length} filings for ${foundation.name}`);
    return;
  }

  await sb('foundation_filings', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
}

async function listFilingsToParse(foundationIds) {
  if (foundationIds.length === 0) return [];
  const inFilter = buildInFilter(foundationIds);
  const path =
    `foundation_filings?select=id,foundation_id,foundation_ein,tax_year,object_id,xml_url,parse_status` +
    `&foundation_id=in.${inFilter}` +
    `&tax_year=gte.${MIN_YEAR}` +
    `&order=tax_year.desc,created_at.desc`;

  const res = await sb(path);
  const rows = await res.json();
  return rows.filter(r => r.parse_status !== 'parsed').slice(0, MAX_XML_PER_RUN);
}

function sanitizeXml(xml) {
  // Drop XML namespace prefix clutter to make tag regex handling straightforward.
  return xml
    .replace(/<\/?[a-zA-Z0-9_]+:/g, tag => tag.replace(':', ''))
    .replace(/\r/g, '');
}

function pickTag(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

function parseTaxYear(xml) {
  const fromTaxYr = pickTag(xml, 'TaxYr');
  if (fromTaxYr && /^\d{4}$/.test(fromTaxYr)) return Number.parseInt(fromTaxYr, 10);
  const fromPeriodEnd = pickTag(xml, 'TaxPeriodEndDt');
  if (fromPeriodEnd && /^\d{4}/.test(fromPeriodEnd)) return Number.parseInt(fromPeriodEnd.slice(0, 4), 10);
  return null;
}

function parseGrantBlocks(xml) {
  const grants = [];
  const re = /<GrantOrContributionPdDurYrGrp>([\s\S]*?)<\/GrantOrContributionPdDurYrGrp>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const granteeName =
      pickTag(block, 'BusinessNameLine1Txt') ||
      pickTag(block, 'RecipientPersonNm') ||
      pickTag(block, 'RecipientBusinessName') ||
      null;
    if (!granteeName) continue;

    const grantAmount = asNumber(pickTag(block, 'Amt'));
    const purposeText = pickTag(block, 'GrantOrContributionPurposeTxt');
    const city = pickTag(block, 'CityNm');
    const state = pickTag(block, 'StateAbbreviationCd');
    const country = pickTag(block, 'CountryCd');
    const recipientEin = normalizeEin(pickTag(block, 'EIN'));

    grants.push({
      grantee_name: granteeName,
      grantee_ein: recipientEin,
      grantee_city: city,
      grantee_state: state,
      grantee_country: country || (state ? 'US' : null),
      grant_amount: grantAmount,
      purpose_text: purposeText,
    });
  }
  return grants;
}

async function fetchOpenAIEmbedding(text) {
  if (!ENABLE_EMBEDDINGS) return null;
  const input = text.trim();
  if (!input) return null;

  const cacheKey = input.toLowerCase();
  if (EMBEDDING_CACHE.has(cacheKey)) return EMBEDDING_CACHE.get(cacheKey);

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.warn(`  [embedding] skipped (${res.status}): ${body.slice(0, 200)}`);
    return null;
  }

  const json = await res.json();
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) return null;
  EMBEDDING_CACHE.set(cacheKey, embedding);
  return embedding;
}

async function fetchGranteeProfileByEin(ein) {
  if (!ein) return null;
  if (EIN_PROFILE_CACHE.has(ein)) return EIN_PROFILE_CACHE.get(ein);

  const url = `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
      },
    });

    if (!res.ok) {
      EIN_PROFILE_CACHE.set(ein, null);
      return null;
    }

    const data = await res.json();
    const org = data?.organization || {};
    const filing = Array.isArray(data?.filings_with_data) && data.filings_with_data.length
      ? data.filings_with_data[0]
      : null;

    const revenue = asNumber(filing?.totrevenue);
    const expenses = asNumber(filing?.totfuncexpns);

    const profile = {
      ntee_code: org?.ntee_code || filing?.ntee_code || null,
      revenue,
      expenses,
      city: org?.city || null,
      state: org?.state || null,
      budget_band: pickBudgetBand(revenue, expenses),
    };

    EIN_PROFILE_CACHE.set(ein, profile);
    await sleep(250);
    return profile;
  } catch {
    EIN_PROFILE_CACHE.set(ein, null);
    return null;
  }
}

async function enforceXmlRateLimit() {
  const now = Date.now();
  const elapsed = now - lastXmlFetchMs;
  if (elapsed < XML_MIN_INTERVAL_MS) {
    await sleep(XML_MIN_INTERVAL_MS - elapsed);
  }
  lastXmlFetchMs = Date.now();
}

async function fetchXmlWithRetry(xmlUrl, attempts = 4) {
  for (let i = 1; i <= attempts; i += 1) {
    await enforceXmlRateLimit();

    try {
      const res = await fetch(xmlUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
          Accept: 'application/xml,text/xml,text/html',
        },
      });

      const body = await res.text();
      const isXml = body.trim().startsWith('<?xml');
      const isRateLimited = res.status === 429 || /Error\s*429/i.test(body);

      if (isXml) return body;
      if (isRateLimited) {
        const waitMs = XML_MIN_INTERVAL_MS * (i + 1);
        console.warn(`  [xml] rate-limited, retrying in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }

      throw new Error(`unexpected response ${res.status}`);
    } catch (err) {
      if (i === attempts) throw err;
      await sleep(XML_MIN_INTERVAL_MS);
    }
  }

  throw new Error('xml download retries exhausted');
}

function regionForState(state) {
  if (!state) return null;
  return US_STATE_TO_REGION[String(state).toUpperCase()] || null;
}

function aggregateFoundationFeatures(grants) {
  const recent = grants.filter(g => g.grant_year >= MIN_YEAR);
  const total = recent.length;

  if (total === 0) {
    return {
      grants_last_5y_count: 0,
      grants_with_budget_count: 0,
      grants_with_location_count: 0,
      grants_with_mission_signal_count: 0,
      median_grant_amount: null,
      median_grantee_budget_band: null,
      budget_band_distribution: {},
      top_states: [],
      top_ntee_codes: [],
      data_completeness_score: 0,
      refreshed_at: new Date().toISOString(),
    };
  }

  const withBudget = recent.filter(g => Number.isInteger(g.grantee_budget_band)).length;
  const withLocation = recent.filter(g => !!g.grantee_state || !!g.grantee_country).length;
  const withMission = recent.filter(g => !!(g.purpose_text || g.ntee_code || g.mission_signal_text)).length;

  const amounts = recent
    .map(g => asNumber(g.grant_amount))
    .filter(v => v !== null)
    .sort((a, b) => a - b);

  const bands = recent
    .map(g => g.grantee_budget_band)
    .filter(v => Number.isInteger(v))
    .sort((a, b) => a - b);

  const stateCounts = new Map();
  const nteeCounts = new Map();
  const bandCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };

  for (const g of recent) {
    if (g.grantee_state) {
      const s = g.grantee_state.toUpperCase();
      stateCounts.set(s, (stateCounts.get(s) || 0) + 1);
    }
    if (g.ntee_code) {
      const n = String(g.ntee_code).toUpperCase();
      nteeCounts.set(n, (nteeCounts.get(n) || 0) + 1);
    }
    if (Number.isInteger(g.grantee_budget_band) && bandCounts[g.grantee_budget_band] !== undefined) {
      bandCounts[g.grantee_budget_band] += 1;
    }
  }

  const completeness = (
    (withBudget / total) * 0.4 +
    (withLocation / total) * 0.2 +
    (withMission / total) * 0.3 +
    Math.min(total / 25, 1) * 0.1
  );

  return {
    grants_last_5y_count: total,
    grants_with_budget_count: withBudget,
    grants_with_location_count: withLocation,
    grants_with_mission_signal_count: withMission,
    median_grant_amount: amounts.length ? amounts[Math.floor(amounts.length / 2)] : null,
    median_grantee_budget_band: bands.length ? bands[Math.floor(bands.length / 2)] : null,
    budget_band_distribution: {
      band_1: bandCounts[1],
      band_2: bandCounts[2],
      band_3: bandCounts[3],
      band_4: bandCounts[4],
    },
    top_states: [...stateCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([state, count]) => ({ state, count, region: regionForState(state) })),
    top_ntee_codes: [...nteeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => ({ code, count })),
    data_completeness_score: Number(completeness.toFixed(4)),
    refreshed_at: new Date().toISOString(),
  };
}

async function replaceGrantsForFiling(filingId, rows) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would replace grants for filing ${filingId} (${rows.length} rows)`);
    return;
  }

  await sb(`foundation_grants?filing_id=eq.${encodeURIComponent(filingId)}`, {
    method: 'DELETE',
  });

  if (rows.length === 0) return;

  const BATCH = 250;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await sb('foundation_grants', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(batch),
    });
  }
}

async function updateFilingStatus(filingId, updates) {
  if (DRY_RUN) return;
  await sb(`foundation_filings?id=eq.${encodeURIComponent(filingId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(updates),
  });
}

async function upsertHistoryFeature(foundationId, feature) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would upsert features for ${foundationId}`);
    return;
  }

  await sb('foundation_history_features', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      foundation_id: foundationId,
      ...feature,
    }),
  });
}

async function fetchGrantsByFoundation(foundationId) {
  const res = await sb(
    `foundation_grants?foundation_id=eq.${encodeURIComponent(foundationId)}` +
    `&grant_year=gte.${MIN_YEAR}` +
    `&select=grant_year,grant_amount,grantee_budget_band,grantee_state,grantee_country,purpose_text,ntee_code,mission_signal_text` +
    `&limit=20000`,
  );
  return res.json();
}

async function parseAndStoreFiling(filing) {
  const started = Date.now();
  try {
    const rawXml = await fetchXmlWithRetry(filing.xml_url);
    const xml = sanitizeXml(rawXml);

    const xmlTaxYear = parseTaxYear(xml) || filing.tax_year;
    const blocks = parseGrantBlocks(xml);

    const grantRows = [];
    for (const g of blocks) {
      const profile = g.grantee_ein ? await fetchGranteeProfileByEin(g.grantee_ein) : null;
      const nteeCode = profile?.ntee_code || null;
      const revenue = profile?.revenue ?? null;
      const expenses = profile?.expenses ?? null;
      const budgetBand = profile?.budget_band ?? pickBudgetBand(revenue, expenses);
      const missionSignal = [g.purpose_text, nteeCode].filter(Boolean).join(' | ') || null;
      const missionEmbedding = missionSignal ? await fetchOpenAIEmbedding(missionSignal) : null;

      const sourceHash = hashText([
        filing.foundation_id,
        filing.object_id,
        g.grantee_name,
        g.grant_amount ?? '',
        g.purpose_text ?? '',
        g.grantee_city ?? '',
        g.grantee_state ?? '',
      ].join('|'));

      grantRows.push({
        foundation_id: filing.foundation_id,
        filing_id: filing.id,
        grant_year: xmlTaxYear,
        grant_amount: g.grant_amount,
        grantee_name: g.grantee_name,
        grantee_ein: g.grantee_ein,
        grantee_city: g.grantee_city || profile?.city || null,
        grantee_state: g.grantee_state || profile?.state || null,
        grantee_country: g.grantee_country || 'US',
        purpose_text: g.purpose_text,
        ntee_code: nteeCode,
        mission_signal_text: missionSignal,
        mission_embedding: missionEmbedding,
        grantee_revenue: revenue,
        grantee_expenses: expenses,
        grantee_budget_band: budgetBand,
        data_quality: {
          has_ein: !!g.grantee_ein,
          has_purpose: !!g.purpose_text,
          has_budget: !!budgetBand,
          source: 'propublica_990pf_xml',
        },
        source_row_hash: sourceHash,
      });
    }

    await replaceGrantsForFiling(filing.id, grantRows);
    await updateFilingStatus(filing.id, {
      tax_year: xmlTaxYear,
      parse_status: 'parsed',
      parse_error: null,
      parsed_at: new Date().toISOString(),
      fetched_at: new Date().toISOString(),
    });

    const tookSec = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ✅ parsed filing ${filing.object_id} (${grantRows.length} grants, ${tookSec}s)`);
    return { ok: true, grants: grantRows.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateFilingStatus(filing.id, {
      parse_status: 'failed',
      parse_error: msg.slice(0, 500),
      fetched_at: new Date().toISOString(),
    });
    console.warn(`  ❌ failed filing ${filing.object_id}: ${msg}`);
    return { ok: false, grants: 0 };
  }
}

async function refreshFoundationHistoryFeatures(foundationId) {
  const grants = await fetchGrantsByFoundation(foundationId);
  const feature = aggregateFoundationFeatures(grants);
  await upsertHistoryFeature(foundationId, feature);
}

async function run() {
  console.log(`\n🔄 sync-grant-history${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`   years_back=${YEARS_BACK}, min_year=${MIN_YEAR}, limit=${LIMIT}, max_xml=${MAX_XML_PER_RUN}`);
  if (ENABLE_EMBEDDINGS) {
    console.log('   embeddings=enabled (OpenAI)');
  } else {
    console.log('   embeddings=disabled');
  }

  const foundations = await fetchSeedFoundations();
  if (foundations.length === 0) {
    console.log('No foundations with EIN found in seed set.');
    return;
  }

  console.log(`\n📚 Found ${foundations.length} seeded foundations with EIN.`);

  for (const foundation of foundations) {
    console.log(`\n🔎 ${foundation.name} (${foundation.foundation_ein})`);
    try {
      const html = await fetchOrgPage(foundation.foundation_ein);
      const filings = extractObjectIdsFromOrgPage(html);
      console.log(`  discovered ${filings.length} filings in last ${YEARS_BACK} years`);
      await upsertFilings(foundation, filings);
      await sleep(400);
    } catch (err) {
      console.warn(`  failed discovery: ${err.message}`);
    }
  }

  const parseTargets = await listFilingsToParse(foundations.map(f => f.id));
  console.log(`\n🧾 filings queued for parse: ${parseTargets.length}`);

  let parsedOk = 0;
  let parsedFail = 0;
  let grantRows = 0;

  for (const filing of parseTargets) {
    const result = await parseAndStoreFiling(filing);
    if (result.ok) parsedOk += 1;
    else parsedFail += 1;
    grantRows += result.grants;
  }

  console.log(`\n📊 parse summary: ok=${parsedOk} failed=${parsedFail} grants=${grantRows}`);

  console.log('\n🧮 refreshing foundation history features...');
  for (const foundation of foundations) {
    try {
      await refreshFoundationHistoryFeatures(foundation.id);
      log(`  refreshed features for ${foundation.id}`);
      await sleep(150);
    } catch (err) {
      console.warn(`  feature refresh failed for ${foundation.id}: ${err.message}`);
    }
  }

  console.log('\n✅ grant-history sync complete.');
}

run().catch(err => {
  console.error('\n❌ sync-grant-history failed:', err);
  process.exit(1);
});
