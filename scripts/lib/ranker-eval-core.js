#!/usr/bin/env node

const DEFAULT_SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const NOW_YEAR = new Date().getUTCFullYear();

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'their', 'they', 'them', 'our',
  'are', 'was', 'were', 'have', 'has', 'had', 'into', 'about', 'through', 'within', 'without',
  'over', 'under', 'onto', 'who', 'whom', 'where', 'when', 'which', 'while', 'there',
  'across', 'program', 'programs', 'organization', 'organizations', 'nonprofit', 'nonprofits',
  'support', 'fund', 'funding', 'grant', 'grants',
]);

const REGION_BY_STATE = {
  AL: 'south', AK: 'west', AZ: 'west', AR: 'south', CA: 'west', CO: 'west', CT: 'northeast',
  DE: 'south', DC: 'south', FL: 'south', GA: 'south', HI: 'west', ID: 'west', IL: 'midwest',
  IN: 'midwest', IA: 'midwest', KS: 'midwest', KY: 'south', LA: 'south', ME: 'northeast',
  MD: 'south', MA: 'northeast', MI: 'midwest', MN: 'midwest', MS: 'south', MO: 'midwest',
  MT: 'west', NE: 'midwest', NV: 'west', NH: 'northeast', NJ: 'northeast', NM: 'west',
  NY: 'northeast', NC: 'south', ND: 'midwest', OH: 'midwest', OK: 'south', OR: 'west',
  PA: 'northeast', RI: 'northeast', SC: 'south', SD: 'midwest', TN: 'south', TX: 'south',
  UT: 'west', VT: 'northeast', VA: 'south', WA: 'west', WV: 'south', WI: 'midwest', WY: 'west',
};

const STATE_NAME_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
};

const BUDGET_BAND_BY_NUMERIC = {
  1: 'under_250k',
  2: '250k_1m',
  3: '1m_5m',
  4: 'over_5m',
};

const NUMERIC_BY_BUDGET_BAND = {
  under_250k: 1,
  '250k_1m': 2,
  '1m_5m': 3,
  over_5m: 4,
  prefer_not_to_say: null,
};

export function inferBudgetBandFromGrantAmount(grantAmount) {
  const amount = Number(grantAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // Proxy budget-band fallback when grantee revenue/expense data is unavailable.
  if (amount < 25_000) return 1;
  if (amount < 150_000) return 2;
  if (amount < 500_000) return 3;
  return 4;
}

export function defaultWeights() {
  return {
    foundationScanLimit: 250,
    candidateLimit: 120,
    topGrantAverageN: 6,
    recencySlope: 0.08,
    recencyFloor: 0.62,
    baselineMission: 0.72,
    baselineLocation: 0.28,
    grantMission: 0.48,
    grantLocation: 0.22,
    grantSize: 0.30,
    historyWeightMin: 0.55,
    historyCoverageBoost: 0.20,
    historyWeightMax: 0.78,
    historyWeightMaxLimited: 0.46,
    sizePenaltyMultiplier: 0.24,
    medianBandPenalty: 0.06,
    dataCompletenessBonus: 0.06,
    fallbackBaselineMultiplier: 0.94,
    limitedDataMinGrants: 3,
    limitedDataMinCompleteness: 0.24,
  };
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(token) {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

export function tokenize(text) {
  const cleaned = normalizeText(text);
  if (!cleaned) return new Set();

  return new Set(
    cleaned
      .split(' ')
      .map((token) => stem(token.trim()))
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function lexicalSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(a.size * b.size);
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function numericBudgetBand(budgetBand) {
  if (budgetBand in NUMERIC_BY_BUDGET_BAND) return NUMERIC_BY_BUDGET_BAND[budgetBand];
  if (Number.isInteger(budgetBand) && budgetBand >= 1 && budgetBand <= 4) return budgetBand;
  return null;
}

export function budgetBandFromNumeric(num) {
  return BUDGET_BAND_BY_NUMERIC[num] || 'prefer_not_to_say';
}

export function normalizeState(value) {
  if (!value) return null;
  const upper = String(value).trim().toUpperCase();
  if (REGION_BY_STATE[upper]) return upper;
  const lower = String(value).trim().toLowerCase();
  return STATE_NAME_TO_CODE[lower] || null;
}

export function regionForState(state) {
  const normalized = normalizeState(state);
  return normalized ? REGION_BY_STATE[normalized] || null : null;
}

export function parseUserLocation(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { state: null, region: null, isNationalUS: false, isGlobal: false, hasLocationInput: false };
  }

  const text = raw.toLowerCase();
  const isGlobal = /\b(global|international|worldwide|world)\b/.test(text);
  const isNationalUS = /\b(national|nationwide|united states|u\.s\.|u\.s|usa|us)\b/.test(text);

  let state = null;
  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
    if (text.includes(name)) {
      state = code;
      break;
    }
  }

  if (!state) {
    const stateTokens = raw.toUpperCase().match(/\b[A-Z]{2}\b/g) || [];
    for (const token of stateTokens) {
      if (REGION_BY_STATE[token]) {
        state = token;
        break;
      }
    }
  }

  let region = state ? REGION_BY_STATE[state] : null;
  if (!region) {
    if (text.includes('northeast')) region = 'northeast';
    else if (text.includes('midwest')) region = 'midwest';
    else if (text.includes('south')) region = 'south';
    else if (text.includes('west')) region = 'west';
  }

  return {
    state,
    region,
    isNationalUS,
    isGlobal,
    hasLocationInput: true,
  };
}

function locationSimilarity(userLocation, granteeState, granteeCountry) {
  if (userLocation.isGlobal) return 1;
  if (!userLocation.hasLocationInput) return 0.5;

  const state = normalizeState(granteeState);
  const country = String(granteeCountry || '').trim().toUpperCase();
  const isUS = !country || country === 'US' || country === 'USA' || country === 'UNITED STATES';

  if (userLocation.state && state && userLocation.state === state) return 1;

  if (userLocation.region && state && REGION_BY_STATE[state] === userLocation.region) return 0.78;

  if (userLocation.isNationalUS && isUS) return 0.65;

  if (userLocation.region && !state && isUS) return 0.48;

  if (!userLocation.state && !userLocation.region && isUS) return 0.5;

  return 0.2;
}

function funderLocationBaseline(userLocation, funderState) {
  if (userLocation.isGlobal) return 0.75;
  if (!userLocation.hasLocationInput) return 0.5;

  const state = normalizeState(funderState);
  if (!state) return userLocation.isNationalUS ? 0.58 : 0.4;

  if (userLocation.state && userLocation.state === state) return 0.92;
  if (userLocation.region && REGION_BY_STATE[state] === userLocation.region) return 0.72;
  if (userLocation.isNationalUS) return 0.62;
  return 0.34;
}

function sizeSimilarity(userBand, granteeBand) {
  if (!userBand) return 0.55;
  if (!granteeBand) return 0.45;

  const diff = Math.abs(userBand - granteeBand);
  if (diff === 0) return 1;
  if (diff === 1) return 0.68;
  if (diff === 2) return 0.26;
  return 0.08;
}

function buildHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

function inFilter(ids) {
  const encoded = ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
  return `(${encoded})`;
}

async function sbFetch(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function fetchPaged({ supabaseUrl, path, headers, pageSize = 1000, maxRows = 120000 }) {
  const rows = [];
  let offset = 0;

  while (offset < maxRows) {
    const url = `${supabaseUrl}/rest/v1/${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}&offset=${offset}`;
    const page = await sbFetch(url, headers);
    rows.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

function deriveFeaturesFromGrants(grantsByFoundation) {
  const features = new Map();

  for (const [foundationId, grants] of grantsByFoundation.entries()) {
    const total = grants.length;
    if (!total) {
      features.set(foundationId, {
        foundation_id: foundationId,
        grants_last_5y_count: 0,
        data_completeness_score: 0,
        median_grantee_budget_band: null,
      });
      continue;
    }

    const withBudget = grants.filter((g) => Number.isInteger(g.grantee_budget_band) || Number.isInteger(inferBudgetBandFromGrantAmount(g.grant_amount))).length;
    const withLocation = grants.filter((g) => !!(g.grantee_state || g.grantee_country)).length;
    const withMission = grants.filter((g) => !!(g.mission_signal_text || g.purpose_text || g.ntee_code)).length;

    const bands = grants
      .map((g) => g.grantee_budget_band ?? inferBudgetBandFromGrantAmount(g.grant_amount))
      .filter((v) => Number.isInteger(v))
      .sort((a, b) => a - b);

    const medianBand = bands.length ? bands[Math.floor(bands.length / 2)] : null;

    const completeness = clamp01(
      (withBudget / total) * 0.4 +
      (withLocation / total) * 0.2 +
      (withMission / total) * 0.3 +
      Math.min(total / 25, 1) * 0.1,
    );

    features.set(foundationId, {
      foundation_id: foundationId,
      grants_last_5y_count: total,
      data_completeness_score: Number(completeness.toFixed(4)),
      median_grantee_budget_band: medianBand,
    });
  }

  return features;
}

export async function createDataset({
  supabaseUrl = DEFAULT_SUPABASE_URL,
  serviceRoleKey,
  minGrantYear = NOW_YEAR - 5,
  foundationLimit = 1000,
} = {}) {
  if (!serviceRoleKey) {
    throw new Error('serviceRoleKey is required');
  }

  const headers = buildHeaders(serviceRoleKey);

  const grants = await fetchPaged({
    supabaseUrl,
    path: `foundation_grants?select=foundation_id,grant_year,grant_amount,grantee_name,grantee_state,grantee_country,purpose_text,ntee_code,mission_signal_text,grantee_budget_band&grant_year=gte.${minGrantYear}`,
    headers,
    pageSize: 2000,
    maxRows: 200000,
  });

  const foundationIdsFromGrants = [...new Set(grants.map((g) => g.foundation_id))];

  const topFunders = await fetchPaged({
    supabaseUrl,
    path: `funders?select=id,name,type,description,focus_areas,ntee_code,city,state,website,contact_url,programs_url,apply_url,news_url,total_giving,asset_amount,grant_range_min,grant_range_max,contact_name,contact_title,contact_email,next_step&order=total_giving.desc.nullslast`,
    headers,
    pageSize: 500,
    maxRows: foundationLimit,
  });

  const topFunderIds = new Set(topFunders.map((f) => f.id));
  const missingGrantFoundationIds = foundationIdsFromGrants.filter((id) => !topFunderIds.has(id));

  let extraGrantFunders = [];
  if (missingGrantFoundationIds.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < missingGrantFoundationIds.length; i += chunkSize) {
      const chunk = missingGrantFoundationIds.slice(i, i + chunkSize);
      const rows = await sbFetch(
        `${supabaseUrl}/rest/v1/funders?select=id,name,type,description,focus_areas,ntee_code,city,state,website,contact_url,programs_url,apply_url,news_url,total_giving,asset_amount,grant_range_min,grant_range_max,contact_name,contact_title,contact_email,next_step&id=in.${encodeURIComponent(inFilter(chunk))}`,
        headers,
      );
      extraGrantFunders = extraGrantFunders.concat(rows);
    }
  }

  const featuresRows = await fetchPaged({
    supabaseUrl,
    path: 'foundation_history_features?select=foundation_id,grants_last_5y_count,data_completeness_score,median_grantee_budget_band',
    headers,
    pageSize: 1000,
    maxRows: 100000,
  });

  const fundersMap = new Map();
  for (const row of topFunders.concat(extraGrantFunders)) {
    fundersMap.set(row.id, {
      ...row,
      focus_areas: Array.isArray(row.focus_areas) ? row.focus_areas : [],
    });
  }

  const grantsByFoundation = new Map();
  for (const row of grants) {
    const list = grantsByFoundation.get(row.foundation_id) || [];
    list.push(row);
    grantsByFoundation.set(row.foundation_id, list);
  }

  const featuresByFoundation = new Map();
  for (const row of featuresRows) {
    featuresByFoundation.set(row.foundation_id, row);
  }

  const derived = deriveFeaturesFromGrants(grantsByFoundation);
  for (const [foundationId, derivedFeature] of derived.entries()) {
    const existing = featuresByFoundation.get(foundationId);
    if (!existing) {
      featuresByFoundation.set(foundationId, derivedFeature);
      continue;
    }

    const merged = {
      ...existing,
      grants_last_5y_count: Number(existing.grants_last_5y_count || 0) || derivedFeature.grants_last_5y_count,
      data_completeness_score: Number(existing.data_completeness_score || 0) || derivedFeature.data_completeness_score,
      median_grantee_budget_band: existing.median_grantee_budget_band ?? derivedFeature.median_grantee_budget_band,
    };

    featuresByFoundation.set(foundationId, merged);
  }

  const dataset = {
    funders: [...fundersMap.values()],
    fundersById: fundersMap,
    grants,
    grantsByFoundation,
    featuresByFoundation,
    minGrantYear,
    regionByState: REGION_BY_STATE,
  };

  return dataset;
}

function baselineMissionScore(userTokens, funder) {
  const focus = Array.isArray(funder.focus_areas) ? funder.focus_areas.join(' ') : '';
  const corpus = [funder.name, funder.description || '', focus, funder.ntee_code || ''].join(' ');
  const funderTokens = tokenize(corpus);
  const score = lexicalSimilarity(userTokens, funderTokens);
  if (score > 0) return score;
  return 0.22;
}

export function rankFundersForCase(dataset, userCase, weightsInput = {}, options = {}) {
  const weights = { ...defaultWeights(), ...weightsInput };
  const topN = options.topN || 10;

  const mission = String(userCase.mission || '').trim();
  const locationServed = String(userCase.locationServed || '').trim();
  const keywords = Array.isArray(userCase.keywords) ? userCase.keywords : [];
  const budgetBand = userCase.budgetBand || 'prefer_not_to_say';

  const userTokens = tokenize(`${mission} ${keywords.join(' ')}`);
  const userLocation = parseUserLocation(locationServed);
  const userBudgetBandNumeric = numericBudgetBand(budgetBand);

  const prelim = dataset.funders
    .map((funder) => {
      const missionScore = baselineMissionScore(userTokens, funder);
      const locationScore = funderLocationBaseline(userLocation, funder.state);
      const baseline = clamp01(missionScore * weights.baselineMission + locationScore * weights.baselineLocation);
      return {
        funder,
        baseline,
        baselineMissionScore: missionScore,
        baselineLocationScore: locationScore,
      };
    })
    .sort((a, b) => {
      if (b.baseline !== a.baseline) return b.baseline - a.baseline;
      return (b.funder.total_giving || 0) - (a.funder.total_giving || 0);
    })
    .slice(0, weights.candidateLimit);

  const ranked = prelim
    .map((entry) => {
      const { funder, baseline, baselineMissionScore, baselineLocationScore } = entry;
      const grants = dataset.grantsByFoundation.get(funder.id) || [];
      const feature = dataset.featuresByFoundation.get(funder.id);

      const scoredGrants = grants
        .map((grant) => {
          const textSignal = [grant.mission_signal_text || '', grant.purpose_text || '', grant.ntee_code || '', grant.grantee_name || ''].join(' ');
          const textTokens = tokenize(textSignal);
          const missionScore = lexicalSimilarity(userTokens, textTokens) || 0.2;
          const locationScore = locationSimilarity(userLocation, grant.grantee_state, grant.grantee_country);
          const inferredBudgetBand = grant.grantee_budget_band ?? inferBudgetBandFromGrantAmount(grant.grant_amount);
          const sizeScore = sizeSimilarity(userBudgetBandNumeric, inferredBudgetBand);

          const recencyYears = Math.max(0, NOW_YEAR - (grant.grant_year || dataset.minGrantYear));
          const recencyMultiplier = Math.max(weights.recencyFloor, 1 - recencyYears * weights.recencySlope);

          const score = clamp01(
            (missionScore * weights.grantMission + locationScore * weights.grantLocation + sizeScore * weights.grantSize)
            * recencyMultiplier,
          );

          return {
            grant,
            inferredBudgetBand,
            missionScore,
            locationScore,
            sizeScore,
            recencyMultiplier,
            score,
          };
        })
        .sort((a, b) => b.score - a.score);

      const topGrants = scoredGrants.slice(0, 3);
      const avgGrantSlice = scoredGrants.slice(0, weights.topGrantAverageN);
      const historyScore = avgGrantSlice.length
        ? avgGrantSlice.reduce((sum, item) => sum + item.score, 0) / avgGrantSlice.length
        : 0;

      const grantsWithBand = scoredGrants.filter((item) => Number.isInteger(item.inferredBudgetBand));
      const oversizedCount = grantsWithBand.filter((item) =>
        userBudgetBandNumeric
        && item.inferredBudgetBand
        && item.inferredBudgetBand >= userBudgetBandNumeric + 2,
      ).length;
      const oversizedRate = grantsWithBand.length ? oversizedCount / grantsWithBand.length : 0;

      let sizePenalty = userBudgetBandNumeric ? oversizedRate * weights.sizePenaltyMultiplier : 0;
      if (
        userBudgetBandNumeric
        && feature?.median_grantee_budget_band
        && feature.median_grantee_budget_band >= userBudgetBandNumeric + 2
      ) {
        sizePenalty += weights.medianBandPenalty;
      }

      const dataCompleteness = typeof feature?.data_completeness_score === 'number'
        ? clamp01(feature.data_completeness_score)
        : clamp01(Math.min(scoredGrants.length / 20, 1) * 0.4);

      const historyCoverage = clamp01((feature?.grants_last_5y_count || scoredGrants.length) / 12);
      const historyWeightRaw = weights.historyWeightMin + historyCoverage * weights.historyCoverageBoost;

      const limitedGrantHistoryData =
        scoredGrants.length < weights.limitedDataMinGrants
        || (feature?.grants_last_5y_count || 0) < weights.limitedDataMinGrants
        || dataCompleteness < weights.limitedDataMinCompleteness;

      const historyWeight = limitedGrantHistoryData
        ? Math.min(historyWeightRaw, weights.historyWeightMaxLimited)
        : Math.min(historyWeightRaw, weights.historyWeightMax);

      let fitScore = clamp01(
        baseline * (1 - historyWeight)
        + historyScore * historyWeight
        + dataCompleteness * weights.dataCompletenessBonus
        - sizePenalty,
      );

      if (!scoredGrants.length) {
        fitScore = clamp01(baseline * weights.fallbackBaselineMultiplier);
      }

      const topSimilarGrantees = topGrants.map((item) => ({
        name: item.grant.grantee_name,
        year: item.grant.grant_year,
        amount: item.grant.grant_amount,
        score: Number(item.score.toFixed(4)),
      }));

      return {
        foundationId: funder.id,
        foundationName: funder.name,
        foundationState: funder.state,
        fitScore,
        baseline,
        baselineMissionScore,
        baselineLocationScore,
        historyScore,
        historyWeight,
        dataCompleteness,
        sizePenalty,
        limitedGrantHistoryData,
        topSimilarGrantees,
      };
    })
    .sort((a, b) => {
      if (b.fitScore !== a.fitScore) return b.fitScore - a.fitScore;
      const bGiving = dataset.fundersById.get(b.foundationId)?.total_giving || 0;
      const aGiving = dataset.fundersById.get(a.foundationId)?.total_giving || 0;
      return bGiving - aGiving;
    });

  return {
    ranked,
    topResults: ranked.slice(0, topN),
  };
}

export function evaluateRanking(labels, rankedIds, k = 10) {
  const positives = new Set(labels.positives || []);
  const negatives = new Set(labels.negatives || []);
  const top = rankedIds.slice(0, k);

  const positiveHits = top.filter((id) => positives.has(id)).length;
  const negativeHits = top.filter((id) => negatives.has(id)).length;

  return {
    precisionAtK: top.length ? positiveHits / top.length : 0,
    negativeRateAtK: top.length ? negativeHits / top.length : 0,
    positiveHits,
    negativeHits,
    kUsed: top.length,
  };
}
