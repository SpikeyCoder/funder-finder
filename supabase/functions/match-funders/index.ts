/**
 * match-funders - Supabase Edge Function
 *
 * Receives { mission, locationServed, keywords, budgetBand, forceRefresh }.
 * Returns ranked funders with prior-grantee fit metadata:
 *   - fit_score (0..1)
 *   - fit_explanation
 *   - limited_grant_history_data
 *   - similar_past_grantees (top 3)
 *
 * Scoring strategy:
 *   1) Baseline mission/location alignment against funder metadata
 *   2) Prior-grantee similarity (mission + location + budget), last 5 years
 *   3) Budget mismatch downweight for foundations whose grantee history skews larger
 *   4) Fallback to baseline when grant-history data is missing/incomplete
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FOUNDATION_SCAN_LIMIT = 250;
const CANDIDATE_LIMIT = 120;
const RESULTS_N = 10;
const MIN_GRANT_YEAR = new Date().getUTCFullYear() - 5;
const SCORING_VERSION = 'grantee-fit-v2';

// Tuned on eval/cases.silver.jsonl via scripts/tune-ranker-weights.js.
const SCORING_WEIGHTS = {
  topGrantAverageN: 6,
  recencySlope: 0.0429,
  recencyFloor: 0.5096,
  baselineMission: 0.5564,
  baselineLocation: 0.4436,
  grantMission: 0.4967,
  grantLocation: 0.1222,
  grantSize: 0.3811,
  historyWeightMin: 0.534,
  historyCoverageBoost: 0.1599,
  historyWeightMax: 0.6744,
  historyWeightMaxLimited: 0.5871,
  sizePenaltyMultiplier: 0.1721,
  medianBandPenalty: 0.0464,
  dataCompletenessBonus: 0.0263,
  fallbackBaselineMultiplier: 0.9489,
  limitedDataMinGrants: 3,
  limitedDataMinCompleteness: 0.1882,
} as const;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
  'http://localhost:5173',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'their', 'they', 'them', 'our',
  'are', 'was', 'were', 'have', 'has', 'had', 'into', 'about', 'through', 'within', 'without',
  'over', 'under', 'into', 'onto', 'who', 'whom', 'where', 'when', 'which', 'while', 'there',
  'across', 'program', 'programs', 'organization', 'organizations', 'nonprofit', 'nonprofits',
]);

type BudgetBand = 'under_250k' | '250k_1m' | '1m_5m' | 'over_5m' | 'prefer_not_to_say';

interface FunderRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  focus_areas: string[] | null;
  ntee_code: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  contact_url: string | null;
  programs_url: string | null;
  apply_url: string | null;
  news_url: string | null;
  total_giving: number | null;
  asset_amount: number | null;
  grant_range_min: number | null;
  grant_range_max: number | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  next_step: string | null;
}

interface GrantRow {
  foundation_id: string;
  grant_year: number;
  grant_amount: number | null;
  grantee_name: string;
  grantee_state: string | null;
  grantee_country: string | null;
  purpose_text: string | null;
  ntee_code: string | null;
  mission_signal_text: string | null;
  grantee_budget_band: number | null;
  mission_embedding?: unknown;
}

interface HistoryFeatureRow {
  foundation_id: string;
  grants_last_5y_count: number;
  data_completeness_score: number;
  median_grantee_budget_band: number | null;
}

interface UserLocation {
  state: string | null;
  region: string | null;
  isNationalUS: boolean;
  isGlobal: boolean;
  hasLocationInput: boolean;
}

interface ScoredGrant {
  grant: GrantRow;
  score: number;
  missionScore: number;
  locationScore: number;
  sizeScore: number;
}

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin = requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
    ? requestOrigin
    : 'https://fundermatch.org';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): Set<string> {
  const cleaned = normalizeText(text);
  if (!cleaned) return new Set();
  const parts = cleaned
    .split(' ')
    .map((t) => stem(t.trim()))
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(parts);
}

function lexicalSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(a.size * b.size);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function hashKey(
  mission: string,
  locationServed: string,
  keywords: string[],
  budgetBand: BudgetBand,
): string {
  const normalized = [
    SCORING_VERSION,
    mission.trim().toLowerCase(),
    locationServed.trim().toLowerCase(),
    keywords.map((k) => k.trim().toLowerCase()).sort().join('|'),
    budgetBand,
  ].join('||');

  let h = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    h = Math.imul(31, h) + normalized.charCodeAt(i) | 0;
  }
  return h.toString(36);
}

async function sbFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase error [${res.status}] ${body.slice(0, 500)}`);
  }

  return res;
}

function toExternalUrl(url: string | null | undefined): string | null {
  let s = url?.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/[^/]*\.github\.io\/[^/]+\/funder\//, '');
  if (!s || s.startsWith('/')) return null;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return `https://${s}`;
}

function resolveNextStepUrl(type: string, funder: FunderRow): string | null {
  const chain: (string | null | undefined)[] = (() => {
    switch (type) {
      case 'contact':
        return [funder.contact_url, funder.website];
      case 'apply':
        return [funder.apply_url, funder.programs_url, funder.website];
      case 'programs':
        return [funder.programs_url, funder.apply_url, funder.website];
      case 'news':
        return [funder.news_url, funder.website];
      default:
        return [funder.website];
    }
  })();

  for (const url of chain) {
    const resolved = toExternalUrl(url);
    if (resolved) return resolved;
  }
  return null;
}

function deriveNextStep(funder: FunderRow): { text: string; type: string } {
  if (funder.next_step?.trim()) {
    if (funder.apply_url) return { text: funder.next_step.trim(), type: 'apply' };
    if (funder.contact_url || funder.contact_email) return { text: funder.next_step.trim(), type: 'contact' };
    if (funder.programs_url) return { text: funder.next_step.trim(), type: 'programs' };
    if (funder.news_url) return { text: funder.next_step.trim(), type: 'news' };
    return { text: funder.next_step.trim(), type: 'homepage' };
  }

  if (funder.apply_url) {
    return {
      type: 'apply',
      text: 'Review current grant guidelines and draft a concise LOI tailored to this funder\'s priorities.',
    };
  }

  if (funder.contact_url || funder.contact_email) {
    return {
      type: 'contact',
      text: 'Share a brief mission summary and ask whether your program aligns with current funding priorities.',
    };
  }

  if (funder.programs_url) {
    return {
      type: 'programs',
      text: 'Review program focus areas and recent grants to identify the strongest alignment before outreach.',
    };
  }

  if (funder.news_url) {
    return {
      type: 'news',
      text: 'Read recent reports and updates to align your pitch with their current funding direction.',
    };
  }

  return {
    type: 'homepage',
    text: 'Review eligibility, giving priorities, and deadlines on the funder website before initiating contact.',
  };
}

const REGION_BY_STATE: Record<string, string> = {
  AL: 'south', AK: 'west', AZ: 'west', AR: 'south', CA: 'west', CO: 'west', CT: 'northeast',
  DE: 'south', DC: 'south', FL: 'south', GA: 'south', HI: 'west', ID: 'west', IL: 'midwest',
  IN: 'midwest', IA: 'midwest', KS: 'midwest', KY: 'south', LA: 'south', ME: 'northeast',
  MD: 'south', MA: 'northeast', MI: 'midwest', MN: 'midwest', MS: 'south', MO: 'midwest',
  MT: 'west', NE: 'midwest', NV: 'west', NH: 'northeast', NJ: 'northeast', NM: 'west',
  NY: 'northeast', NC: 'south', ND: 'midwest', OH: 'midwest', OK: 'south', OR: 'west',
  PA: 'northeast', RI: 'northeast', SC: 'south', SD: 'midwest', TN: 'south', TX: 'south',
  UT: 'west', VT: 'northeast', VA: 'south', WA: 'west', WV: 'south', WI: 'midwest', WY: 'west',
};

const STATE_NAME_TO_CODE: Record<string, string> = {
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

function parseUserLocation(input: string): UserLocation {
  const raw = input.trim();
  if (!raw) {
    return { state: null, region: null, isNationalUS: false, isGlobal: false, hasLocationInput: false };
  }

  const text = raw.toLowerCase();
  const isGlobal = /\b(global|international|worldwide|world)\b/.test(text);
  const isNationalUS = /\b(national|nationwide|united states|u\.s\.|u\.s|usa|us)\b/.test(text);

  let state: string | null = null;

  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
    if (text.includes(name)) {
      state = code;
      break;
    }
  }

  if (!state) {
    const matches = raw.toUpperCase().match(/\b[A-Z]{2}\b/g) || [];
    for (const candidate of matches) {
      if (REGION_BY_STATE[candidate]) {
        state = candidate;
        break;
      }
    }
  }

  let region: string | null = state ? REGION_BY_STATE[state] : null;
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

function normalizeState(value: string | null | undefined): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  if (REGION_BY_STATE[upper]) return upper;

  const lower = value.trim().toLowerCase();
  return STATE_NAME_TO_CODE[lower] || null;
}

function locationSimilarity(userLocation: UserLocation, granteeState: string | null, granteeCountry: string | null): number {
  if (userLocation.isGlobal) return 1;
  if (!userLocation.hasLocationInput) return 0.5;

  const state = normalizeState(granteeState);
  const country = (granteeCountry || '').trim().toUpperCase();
  const isUS = !country || country === 'US' || country === 'USA' || country === 'UNITED STATES';

  if (userLocation.state && state && userLocation.state === state) return 1;

  if (userLocation.region && state && REGION_BY_STATE[state] === userLocation.region) {
    return 0.78;
  }

  if (userLocation.isNationalUS && isUS) return 0.65;

  if (userLocation.region && !state && isUS) return 0.48;

  if (!userLocation.state && !userLocation.region && isUS) return 0.5;

  return 0.2;
}

function funderLocationBaseline(userLocation: UserLocation, funderState: string | null): number {
  if (userLocation.isGlobal) return 0.75;
  if (!userLocation.hasLocationInput) return 0.5;

  const state = normalizeState(funderState);
  if (!state) {
    return userLocation.isNationalUS ? 0.58 : 0.4;
  }

  if (userLocation.state && userLocation.state === state) return 0.92;
  if (userLocation.region && REGION_BY_STATE[state] === userLocation.region) return 0.72;
  if (userLocation.isNationalUS) return 0.62;
  return 0.34;
}

function toNumericBudgetBand(budgetBand: BudgetBand): number | null {
  switch (budgetBand) {
    case 'under_250k':
      return 1;
    case '250k_1m':
      return 2;
    case '1m_5m':
      return 3;
    case 'over_5m':
      return 4;
    default:
      return null;
  }
}

function sizeSimilarity(userBand: number | null, granteeBand: number | null): number {
  if (!userBand) return 0.55;
  if (!granteeBand) return 0.45;

  const diff = Math.abs(userBand - granteeBand);
  if (diff === 0) return 1;
  if (diff === 1) return 0.68;
  if (diff === 2) return 0.26;
  return 0.08;
}

function parseVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vec = value.filter((v) => typeof v === 'number') as number[];
  return vec.length ? vec : null;
}

function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) return null;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return clamp01((cosine + 1) / 2);
}

async function fetchMissionEmbedding(input: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) return null;

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
    return null;
  }

  const json = await res.json();
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) return null;
  const vec = embedding.filter((v: unknown) => typeof v === 'number') as number[];
  return vec.length ? vec : null;
}

function buildInFilter(ids: string[]): string {
  const quoted = ids.map((id) => `"${id.replace(/"/g, '')}"`);
  return encodeURIComponent(`(${quoted.join(',')})`);
}

function normalizeBudgetBand(input: unknown): BudgetBand {
  if (input === 'under_250k' || input === '250k_1m' || input === '1m_5m' || input === 'over_5m' || input === 'prefer_not_to_say') {
    return input;
  }
  return 'prefer_not_to_say';
}

function normalizeKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '')
    .filter((item) => item.length > 0)
    .slice(0, 15);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

function coerceStringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((v) => typeof v === 'string') as string[] : [];
}

function grantMatchReasons(
  grant: ScoredGrant,
  userLocation: UserLocation,
  userBand: number | null,
): string[] {
  const reasons: string[] = [];

  if (grant.missionScore >= 0.6) {
    reasons.push('Similar program area');
  }

  if (grant.locationScore >= 0.95) {
    reasons.push('Same state served');
  } else if (grant.locationScore >= 0.72) {
    reasons.push('Same region served');
  } else if (grant.locationScore >= 0.62 && userLocation.hasLocationInput) {
    reasons.push('Same country served');
  }

  if (userBand && grant.sizeScore >= 0.95) {
    reasons.push('Similar budget band');
  } else if (userBand && grant.sizeScore >= 0.65) {
    reasons.push('Adjacent budget band');
  }

  if (reasons.length === 0) {
    reasons.push('Recent grant shows partial mission overlap');
  }

  return reasons.slice(0, 2);
}

function baselineMissionScore(userTokens: Set<string>, funder: FunderRow): number {
  const focus = coerceStringArray(funder.focus_areas).join(' ');
  const corpus = [funder.name, funder.description || '', focus, funder.ntee_code || ''].join(' ');
  const funderTokens = tokenize(corpus);
  const score = lexicalSimilarity(userTokens, funderTokens);
  if (score > 0) return score;
  return 0.22;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers });
  }

  try {
    const body = await req.json();

    const mission = typeof body?.mission === 'string' ? body.mission.trim() : '';
    const locationServed = typeof body?.locationServed === 'string' ? body.locationServed.trim() : '';
    const keywords = normalizeKeywords(body?.keywords);
    const budgetBand = normalizeBudgetBand(body?.budgetBand);
    const forceRefresh = !!body?.forceRefresh;

    if (!mission) {
      return new Response(JSON.stringify({ error: 'mission is required' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const cacheKey = hashKey(mission, locationServed, keywords, budgetBand);

    if (!forceRefresh) {
      const cacheRes = await sbFetch(
        `search_cache?mission_hash=eq.${encodeURIComponent(cacheKey)}&select=results,created_at&limit=1`,
      );
      const cached = await cacheRes.json();
      if (cached?.length) {
        const age = Date.now() - new Date(cached[0].created_at).getTime();
        if (age < CACHE_TTL_MS) {
          return new Response(JSON.stringify({ results: cached[0].results, cached: true }), {
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
      }
    }

    const fundersRes = await sbFetch(
      `funders?select=id,name,type,description,focus_areas,ntee_code,city,state,` +
      `website,contact_url,programs_url,apply_url,news_url,total_giving,asset_amount,` +
      `grant_range_min,grant_range_max,contact_name,contact_title,contact_email,next_step` +
      `&order=total_giving.desc.nullslast&limit=${FOUNDATION_SCAN_LIMIT}`,
    );

    const funders = await fundersRes.json() as FunderRow[];

    if (!funders.length) {
      return new Response(JSON.stringify({ results: [], cached: false }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const userTokens = tokenize(`${mission} ${keywords.join(' ')}`);
    const userLocation = parseUserLocation(locationServed);
    const userBudgetBandNumeric = toNumericBudgetBand(budgetBand);
    const userMissionEmbedding = await fetchMissionEmbedding(`${mission} ${keywords.join(' ')}`.trim());

    const prelim = funders.map((funder) => {
      const missionScore = baselineMissionScore(userTokens, funder);
      const locationScore = funderLocationBaseline(userLocation, funder.state);
      const baseline = clamp01(
        missionScore * SCORING_WEIGHTS.baselineMission
        + locationScore * SCORING_WEIGHTS.baselineLocation,
      );
      return {
        funder,
        baseline,
      };
    });

    const candidateFunders = prelim
      .sort((a, b) => {
        if (b.baseline !== a.baseline) return b.baseline - a.baseline;
        const givingA = a.funder.total_giving || 0;
        const givingB = b.funder.total_giving || 0;
        return givingB - givingA;
      })
      .slice(0, CANDIDATE_LIMIT);

    const candidateIds = candidateFunders.map((f) => f.funder.id);

    const grantsByFoundation = new Map<string, GrantRow[]>();
    const featuresByFoundation = new Map<string, HistoryFeatureRow>();

    if (candidateIds.length) {
      const selectColumns = userMissionEmbedding
        ? 'foundation_id,grant_year,grant_amount,grantee_name,grantee_state,grantee_country,purpose_text,ntee_code,mission_signal_text,grantee_budget_band,mission_embedding'
        : 'foundation_id,grant_year,grant_amount,grantee_name,grantee_state,grantee_country,purpose_text,ntee_code,mission_signal_text,grantee_budget_band';

      const inFilter = buildInFilter(candidateIds);

      const [grantsRes, featuresRes] = await Promise.all([
        sbFetch(
          `foundation_grants?select=${selectColumns}` +
          `&foundation_id=in.${inFilter}` +
          `&grant_year=gte.${MIN_GRANT_YEAR}` +
          `&order=grant_year.desc,grant_amount.desc` +
          `&limit=50000`,
        ),
        sbFetch(
          `foundation_history_features?select=foundation_id,grants_last_5y_count,data_completeness_score,median_grantee_budget_band` +
          `&foundation_id=in.${inFilter}`,
        ),
      ]);

      const grants = await grantsRes.json() as GrantRow[];
      const features = await featuresRes.json() as HistoryFeatureRow[];

      for (const row of grants) {
        const arr = grantsByFoundation.get(row.foundation_id) || [];
        arr.push(row);
        grantsByFoundation.set(row.foundation_id, arr);
      }

      for (const feature of features) {
        featuresByFoundation.set(feature.foundation_id, feature);
      }
    }

    const results = candidateFunders
      .map(({ funder, baseline }) => {
        const grants = grantsByFoundation.get(funder.id) || [];
        const feature = featuresByFoundation.get(funder.id);

        const scoredGrants: ScoredGrant[] = grants.map((grant) => {
          const textSignal = [grant.mission_signal_text || '', grant.purpose_text || '', grant.ntee_code || '', grant.grantee_name || ''].join(' ');
          const textTokens = tokenize(textSignal);
          const lexical = lexicalSimilarity(userTokens, textTokens);

          const grantEmbedding = parseVector(grant.mission_embedding);
          const embeddingSimilarity = userMissionEmbedding && grantEmbedding
            ? cosineSimilarity(userMissionEmbedding, grantEmbedding)
            : null;

          const missionScore = embeddingSimilarity ?? (lexical > 0 ? lexical : 0.2);
          const locScore = locationSimilarity(userLocation, grant.grantee_state, grant.grantee_country);
          const sizeScore = sizeSimilarity(userBudgetBandNumeric, grant.grantee_budget_band);

          const recencyYears = Math.max(0, new Date().getUTCFullYear() - (grant.grant_year || MIN_GRANT_YEAR));
          const recencyMultiplier = Math.max(
            SCORING_WEIGHTS.recencyFloor,
            1 - recencyYears * SCORING_WEIGHTS.recencySlope,
          );

          const score = clamp01(
            (
              missionScore * SCORING_WEIGHTS.grantMission
              + locScore * SCORING_WEIGHTS.grantLocation
              + sizeScore * SCORING_WEIGHTS.grantSize
            ) * recencyMultiplier,
          );

          return {
            grant,
            score,
            missionScore,
            locationScore: locScore,
            sizeScore,
          };
        }).sort((a, b) => b.score - a.score);

        const topGrants = scoredGrants.slice(0, 3);
        const topForAverage = scoredGrants.slice(0, SCORING_WEIGHTS.topGrantAverageN);
        const historyScore = topForAverage.length
          ? topForAverage.reduce((sum, row) => sum + row.score, 0) / topForAverage.length
          : 0;

        const grantsWithBand = scoredGrants.filter((g) => Number.isInteger(g.grant.grantee_budget_band));
        const oversizedCount = grantsWithBand.filter((g) =>
          userBudgetBandNumeric
          && g.grant.grantee_budget_band
          && g.grant.grantee_budget_band >= userBudgetBandNumeric + 2,
        ).length;

        const oversizedRate = grantsWithBand.length ? oversizedCount / grantsWithBand.length : 0;
        let sizePenalty = userBudgetBandNumeric
          ? oversizedRate * SCORING_WEIGHTS.sizePenaltyMultiplier
          : 0;

        if (userBudgetBandNumeric && feature?.median_grantee_budget_band && feature.median_grantee_budget_band >= userBudgetBandNumeric + 2) {
          sizePenalty += SCORING_WEIGHTS.medianBandPenalty;
        }

        const dataCompleteness = typeof feature?.data_completeness_score === 'number'
          ? clamp01(feature.data_completeness_score)
          : clamp01(Math.min(scoredGrants.length / 20, 1) * 0.4);

        const historyCoverage = clamp01((feature?.grants_last_5y_count || scoredGrants.length) / 12);
        const historyWeightRaw =
          SCORING_WEIGHTS.historyWeightMin
          + historyCoverage * SCORING_WEIGHTS.historyCoverageBoost;

        const limitedGrantHistoryData =
          scoredGrants.length < SCORING_WEIGHTS.limitedDataMinGrants
          || (feature?.grants_last_5y_count || 0) < SCORING_WEIGHTS.limitedDataMinGrants
          || dataCompleteness < SCORING_WEIGHTS.limitedDataMinCompleteness;

        const historyWeight = limitedGrantHistoryData
          ? Math.min(historyWeightRaw, SCORING_WEIGHTS.historyWeightMaxLimited)
          : Math.min(historyWeightRaw, SCORING_WEIGHTS.historyWeightMax);

        let fitScore = clamp01(
          baseline * (1 - historyWeight)
          + historyScore * historyWeight
          + dataCompleteness * SCORING_WEIGHTS.dataCompletenessBonus
          - sizePenalty,
        );

        if (!scoredGrants.length) {
          fitScore = clamp01(baseline * SCORING_WEIGHTS.fallbackBaselineMultiplier);
        }

        const similaritySummary = topGrants.map((row) => ({
          name: row.grant.grantee_name,
          year: row.grant.grant_year || null,
          amount: row.grant.grant_amount,
          match_reasons: grantMatchReasons(row, userLocation, userBudgetBandNumeric),
        }));

        const factorLines: string[] = [];

        if (historyScore >= 0.72 && topGrants.length > 0) {
          factorLines.push(`Strong overlap with recent grantees like ${topGrants[0].grant.grantee_name}.`);
        } else if (historyScore >= 0.56 && topGrants.length > 0) {
          factorLines.push('Moderate overlap with prior grantees in the last 5 years.');
        }

        if (userBudgetBandNumeric && sizePenalty <= 0.05 && grantsWithBand.length > 0) {
          factorLines.push('Historical grantee sizes align with your selected budget band.');
        } else if (userBudgetBandNumeric && sizePenalty >= 0.14) {
          factorLines.push('Past grantees skew larger than your selected budget band.');
        }

        const bestLocationScore = topGrants.length
          ? Math.max(...topGrants.map((g) => g.locationScore))
          : funderLocationBaseline(userLocation, funder.state);

        if (bestLocationScore >= 0.9) {
          factorLines.push('Geographic priorities strongly overlap with your service area.');
        } else if (bestLocationScore >= 0.68) {
          factorLines.push('Some geographic overlap with your service area.');
        }

        if (limitedGrantHistoryData) {
          factorLines.push('Limited grant history data; ranking relies more on mission and location alignment.');
        }

        const fitExplanation = uniqueStrings(factorLines).slice(0, 2).join(' ')
          || 'Mission and focus-area alignment drove this ranking.';

        const next = deriveNextStep(funder);
        const nextStepUrl = resolveNextStepUrl(next.type, funder);

        return {
          ...funder,
          score: Number(fitScore.toFixed(4)),
          fit_score: Number(fitScore.toFixed(4)),
          reason: fitExplanation,
          fit_explanation: fitExplanation,
          limited_grant_history_data: limitedGrantHistoryData,
          similar_past_grantees: similaritySummary,
          next_step: next.text,
          next_step_type: next.type,
          next_step_url: nextStepUrl,
        };
      })
      .sort((a, b) => {
        if ((b.fit_score || 0) !== (a.fit_score || 0)) {
          return (b.fit_score || 0) - (a.fit_score || 0);
        }
        return (b.total_giving || 0) - (a.total_giving || 0);
      })
      .slice(0, RESULTS_N);

    await sbFetch('search_cache', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        mission_hash: cacheKey,
        mission_text: mission,
        results,
        created_at: new Date().toISOString(),
      }),
    });

    return new Response(JSON.stringify({ results, cached: false }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('match-funders error:', err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
});
