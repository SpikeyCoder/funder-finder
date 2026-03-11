/**
 * match-funders - Supabase Edge Function
 *
 * Receives { mission, locationServed, keywords, budgetBand, forceRefresh, peerNonprofits }.
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
const MIN_RESULT_FIT_SCORE = 0.1;
const MIN_GRANT_YEAR = new Date().getUTCFullYear() - 5;
const SCORING_VERSION = 'grantee-fit-v8';
const PROPUBLICA_API_BASE = 'https://projects.propublica.org/nonprofits/api/v2';
const PROPUBLICA_ORG_BASE = 'https://projects.propublica.org/nonprofits/organizations';
const PROPUBLICA_FULL_TEXT_SEARCH = 'https://projects.propublica.org/nonprofits/full_text_search';
const PROPUBLICA_FULL_TEXT_BASE = 'https://projects.propublica.org/nonprofits/full_text';
const PEER_LIVE_QUERY_MIN_RESULTS = 3;
const PEER_LIVE_QUERY_MAX_FOUNDATIONS = 12;
const PEER_LIVE_QUERY_MAX_FILINGS_PER_FOUNDATION = 1;
const PEER_LIVE_QUERY_TIMEOUT_MS = 25000;
const PEER_FULL_TEXT_MAX_QUERY_TERMS = 8;
const PEER_FULL_TEXT_MAX_CANDIDATES = 80;
const PEER_FULL_TEXT_MAX_FETCHES = 20;
const PEER_FULL_TEXT_MAX_PAGES_PER_QUERY = 2;
const PEER_DB_MAX_GRANTS = 50000;
const PEER_DB_EIN_BATCH_SIZE = 20;
const PEER_DB_EIN_QUERY_LIMIT = 12000;
const PEER_DB_NAME_QUERY_LIMIT = 3000;
const PEER_DB_TIMEOUT_FALLBACK_FOUNDER_LIMIT = 220;
const PEER_DB_TIMEOUT_FALLBACK_BATCH_SIZE = 60;
const PEER_DB_TIMEOUT_FALLBACK_QUERY_LIMIT = 1000;

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
  noBudgetFitPenalty: 0.24,
  lowBudgetFitPenalty: 0.08,
  excludeBaselinePenalty: 0.24,
  excludeGrantPenalty: 0.28,
  excludeHistoryPenalty: 0.14,
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

const PEER_NAME_SUFFIX_WORDS = new Set([
  'the', 'inc', 'llc', 'ltd', 'nfp', 'co', 'corp', 'corporation', 'company',
  'foundation', 'fund', 'trust', 'association', 'society', 'group', 'services',
  'service', 'organization', 'org',
]);

type BudgetBand = 'under_250k' | '250k_1m' | '1m_5m' | 'over_5m' | 'prefer_not_to_say';

interface FunderRow {
  id: string;
  name: string;
  type: string;
  foundation_ein: string | null;
  description: string | null;
  focus_areas: string[] | null;
  ntee_code: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  contact_url: string | null;
  programs_url: string | null;
  apply_url: string | null;
  discovered_apply_url: string | null;
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
  id: string;
  foundation_id: string;
  grant_year: number;
  grant_amount: number | null;
  grantee_name: string;
  grantee_ein: string | null;
  grantee_city: string | null;
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

interface FilingRow {
  foundation_id: string;
}

interface UserLocation {
  city: string | null;
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
  exclusionOverlap: number;
}

interface PeerProfile {
  input: string;
  canonicalName: string;
  normalizedName: string;
  tokenSignature: string[];
  ein: string | null;
  city: string | null;
  state: string | null;
}

interface PeerFullTextCandidate {
  foundationEin: string;
  objectId: string;
  formName: 'IRS990ScheduleI' | 'IRS990PF';
}

interface ParsedScheduleIGrant {
  grantee_name: string;
  grantee_ein: string | null;
  grantee_city: string | null;
  grantee_state: string | null;
  grantee_country: string | null;
  grant_amount: number | null;
  purpose_text: string | null;
}

interface ParsedScheduleIPage {
  taxYear: number | null;
  filerName: string | null;
  filerCity: string | null;
  filerState: string | null;
  grants: ParsedScheduleIGrant[];
}

interface PeerFullTextMatchSet {
  foundationEin: string;
  foundationName: string | null;
  foundationCity: string | null;
  foundationState: string | null;
  foundationCode: number | null;
  subsectionCode: number | null;
  grants: GrantRow[];
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

// ── Concept synonym expansion for exclusion filtering ──────────────────
// Maps root concepts to related terms that should also trigger exclusion.
// When a user excludes "food insecurity", we should also catch orgs whose
// names/missions mention "feeding", "hunger", "nutrition", "meal", etc.
const CONCEPT_SYNONYMS: Record<string, string[]> = {
  food: ['feed', 'hunger', 'hungry', 'nutrition', 'meal', 'pantry', 'grocery', 'nourish', 'cuisine', 'culinary', 'diet', 'eat', 'kitchen', 'soup'],
  housing: ['shelter', 'homeless', 'hous', 'rent', 'evict', 'tenant', 'landlord', 'dwelling', 'domicil', 'unhoused', 'unshelter'],
  health: ['medical', 'clinic', 'hospital', 'wellness', 'healthcare', 'disease', 'illness', 'patient', 'treatment', 'therapy', 'diagnos'],
  education: ['school', 'teach', 'learn', 'academic', 'student', 'literacy', 'tutor', 'scholar', 'classroom', 'curriculum'],
  environment: ['climate', 'conservation', 'ecological', 'wildlife', 'nature', 'green', 'sustain', 'pollut', 'emission', 'renewable'],
  animal: ['wildlife', 'pet', 'veterinar', 'shelter', 'humane', 'spay', 'neuter', 'rescue', 'canine', 'feline', 'equine'],
  art: ['music', 'theater', 'theatre', 'dance', 'perform', 'gallery', 'museum', 'creative', 'cultural', 'orchestra', 'symphony', 'opera'],
  religion: ['church', 'faith', 'worship', 'ministry', 'congregation', 'parish', 'mosque', 'synagogue', 'temple', 'spiritual'],
  veteran: ['military', 'armed force', 'servicemember', 'combat', 'deployment'],
  disability: ['handicap', 'accessible', 'impair', 'blind', 'deaf', 'wheelchair', 'adaptive'],
  addiction: ['substance', 'recovery', 'sober', 'rehab', 'detox', 'alcohol', 'drug', 'opioid'],
  immigrant: ['refugee', 'migrant', 'asylum', 'resettl', 'newcomer', 'undocument'],
};

// NTEE code prefixes that map to excluded concept areas
const CONCEPT_NTEE_PREFIXES: Record<string, string[]> = {
  food: ['K'],         // Food, Agriculture & Nutrition
  housing: ['L'],      // Housing & Shelter
  health: ['E', 'F', 'G', 'H'], // Health, Mental Health, Disease, Medical Research
  education: ['B'],    // Education
  environment: ['C', 'D'], // Environment, Animal-Related
  animal: ['D'],       // Animal-Related
  art: ['A'],          // Arts, Culture, Humanities
  religion: ['X'],     // Religion-Related
};

/**
 * Expands exclusion tokens with concept synonyms.
 * For each token in the exclusion set, if it matches a concept key or is a
 * synonym of a concept, adds all related synonyms to the returned set.
 * This ensures "food insecurity" also catches "Feeding America", "hunger relief", etc.
 */
function expandExclusionTokens(baseTokens: Set<string>): Set<string> {
  const expanded = new Set(baseTokens);
  for (const token of baseTokens) {
    // Check if the token matches a concept key directly
    for (const [concept, synonyms] of Object.entries(CONCEPT_SYNONYMS)) {
      const conceptStem = stem(concept);
      if (token === conceptStem || token === concept) {
        // Add all synonym stems
        for (const syn of synonyms) expanded.add(stem(syn));
        expanded.add(conceptStem);
      }
      // Check if the token matches any synonym → pull in the whole concept family
      for (const syn of synonyms) {
        if (token === stem(syn) || token === syn) {
          expanded.add(conceptStem);
          for (const s of synonyms) expanded.add(stem(s));
          break;
        }
      }
    }
  }
  return expanded;
}

/**
 * Returns NTEE prefixes that should be excluded based on exclusion tokens.
 */
function getExcludedNteePrefixes(baseTokens: Set<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const token of baseTokens) {
    for (const [concept, nteePrefixes] of Object.entries(CONCEPT_NTEE_PREFIXES)) {
      const conceptStem = stem(concept);
      if (token === conceptStem || token === concept) {
        for (const p of nteePrefixes) prefixes.add(p);
      }
      // Also check synonyms
      const synonyms = CONCEPT_SYNONYMS[concept];
      if (synonyms) {
        for (const syn of synonyms) {
          if (token === stem(syn)) {
            for (const p of nteePrefixes) prefixes.add(p);
            break;
          }
        }
      }
    }
  }
  return prefixes;
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

function normalizedEin(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

// ── Real-time grant page discovery ──────────────────────────────────────────
// Adapted from scripts/enrich-subpages.js — lightweight homepage scanner that
// finds grant application / LOI pages by scoring <a> tag hrefs + anchor text.

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

/**
 * Fetch a homepage's HTML with a tight timeout.
 * Returns null on any failure — caller treats as "no discovery".
 */
async function fetchHomepageHtml(url: string, timeoutMs = 3000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FunderFinder/1.0; +https://fundermatch.org)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;
    // Limit body read to avoid huge pages
    const text = await res.text();
    return text.length > 500_000 ? text.slice(0, 500_000) : text;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Scan homepage HTML for grant-related links, return the best URL or null.
 */
function discoverGrantPageUrl(html: string, baseUrl: string): string | null {
  const funderDomain = extractDomain(baseUrl);
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
    try { resolvedUrl = new URL(rawHref, baseUrl).href; } catch { continue; }

    // Must be same domain
    const linkDomain = extractDomain(resolvedUrl);
    if (!linkDomain) continue;
    if (!linkDomain.includes(funderDomain) && !funderDomain.includes(linkDomain)) continue;

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

/**
 * Batch-discover grant page URLs for funders missing apply_url.
 * Processes in chunks of 6 concurrently, returns Map<funderId, discoveredUrl>.
 */
async function discoverGrantUrlsInBatch(
  funders: { id: string; website: string }[],
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (funders.length === 0) return results;

  const CHUNK_SIZE = 6;
  for (let i = 0; i < funders.length; i += CHUNK_SIZE) {
    const chunk = funders.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(
      chunk.map(async (f) => {
        const url = f.website.startsWith('http') ? f.website : `https://${f.website}`;
        const html = await fetchHomepageHtml(url);
        if (!html) return null;
        const discovered = discoverGrantPageUrl(html, url);
        return discovered ? { id: f.id, url: discovered } : null;
      }),
    );
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        results.set(result.value.id, result.value.url);
      }
    }
  }
  return results;
}

/**
 * Fire-and-forget: cache newly discovered grant page URLs back to the DB.
 * Non-blocking — errors are caught and logged, never thrown.
 */
function cacheDiscoveredUrls(
  discoveredUrls: Map<string, string>,
  supabaseUrl: string,
  supabaseKey: string,
): void {
  if (discoveredUrls.size === 0) return;
  for (const [id, url] of discoveredUrls) {
    fetch(`${supabaseUrl}/rest/v1/funders?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ discovered_apply_url: url }),
    }).catch((e) => console.warn(`cache discovered_apply_url failed for ${id}:`, e));
  }
}

function propublicaFoundationUrl(funder: FunderRow): string {
  const ein = normalizedEin(funder.foundation_ein);
  if (ein) {
    return `https://projects.propublica.org/nonprofits/organizations/${ein}`;
  }
  return `https://projects.propublica.org/nonprofits/search?utf8=%E2%9C%93&q=${encodeURIComponent(funder.name)}`;
}

function resolveNextStepUrl(type: string, funder: FunderRow): string | null {
  const chain: (string | null | undefined)[] = (() => {
    switch (type) {
      case 'apply':
        return [funder.apply_url, funder.discovered_apply_url, funder.programs_url, funder.website];
      case 'programs':
        return [funder.programs_url, funder.apply_url, funder.discovered_apply_url, funder.website];
      case 'contact':
        return [funder.contact_url, funder.website];
      case 'homepage':
        return [funder.website];
      case 'propublica':
        return [propublicaFoundationUrl(funder)];
      default:
        return [funder.website];
    }
  })();

  for (const url of chain) {
    const resolved = toExternalUrl(url);
    if (resolved) return resolved;
  }
  return propublicaFoundationUrl(funder);
}

function deriveNextStep(funder: FunderRow): { text: string; type: string } {
  // Priority: apply_url → discovered_apply_url → programs_url → contact → website → propublica
  // This ensures nonprofits see actionable grant pages, not IRS links.

  const nextStepText = funder.next_step?.trim();

  // If the DB has a stored next_step, check if it references IRS/guidestar — override those
  if (nextStepText) {
    const hasLegacyDirectoryFallback = /\bguidestar\b|\birs\b.*\bsearch\b|apps\.irs\.gov/i.test(nextStepText);
    if (!hasLegacyDirectoryFallback) {
      // Keep the human-written text but assign the best available type
      if (funder.apply_url) return { text: nextStepText, type: 'apply' };
      if (funder.discovered_apply_url) return { text: nextStepText, type: 'apply' };
      if (funder.programs_url) return { text: nextStepText, type: 'programs' };
      if (funder.contact_url || funder.contact_email) return { text: nextStepText, type: 'contact' };
      if (funder.website) return { text: nextStepText, type: 'homepage' };
      return { text: nextStepText, type: 'propublica' };
    }
    // Legacy IRS/guidestar text — fall through to derive a better next step
  }

  // 1. Direct grant application / LOI page (from batch enrichment)
  if (funder.apply_url) {
    return {
      type: 'apply',
      text: 'Review current grant guidelines and submit an LOI tailored to this funder\'s priorities.',
    };
  }

  // 2. Discovered grant page (from real-time homepage scan)
  if (funder.discovered_apply_url) {
    return {
      type: 'apply',
      text: 'Visit this funder\'s grant page to review application requirements and submission process.',
    };
  }

  // 3. Programs / focus areas page
  if (funder.programs_url) {
    return {
      type: 'programs',
      text: 'Review program focus areas and recent grants to identify the strongest alignment before outreach.',
    };
  }

  // 4. Contact page
  if (funder.contact_url || funder.contact_email) {
    return {
      type: 'contact',
      text: 'Share a brief mission summary and ask whether your program aligns with current funding priorities.',
    };
  }

  // 5. Bare website (homepage)
  if (funder.website) {
    return {
      type: 'homepage',
      text: 'Visit the foundation\'s website to explore funding priorities and find application details.',
    };
  }

  // 6. ProPublica fallback (last resort)
  return {
    type: 'propublica',
    text: 'Review this foundation profile on ProPublica Nonprofit Explorer to confirm recent grants and filing details.',
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
    return { city: null, state: null, region: null, isNationalUS: false, isGlobal: false, hasLocationInput: false };
  }

  const text = raw.toLowerCase();
  const isGlobal = /\b(global|international|worldwide|world)\b/.test(text);
  const isNationalUS = /\b(national|nationwide|united states|u\.s\.|u\.s|usa|us)\b/.test(text);

  let city: string | null = null;
  let state: string | null = null;

  const cityStateMatch = raw.match(/^([^,]+),\s*([^,]+)$/);
  if (cityStateMatch) {
    const cityPart = cityStateMatch[1].trim();
    const statePart = cityStateMatch[2].trim().toLowerCase();
    const stateFromPart = STATE_NAME_TO_CODE[statePart] || (REGION_BY_STATE[statePart.toUpperCase()] ? statePart.toUpperCase() : null);
    if (stateFromPart && cityPart.length >= 2 && !/\b(national|global|international|rural|statewide)\b/i.test(cityPart)) {
      city = cityPart.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, ' ').trim();
      state = stateFromPart;
    }
  }

  if (!state) {
    for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
      if (text.includes(name)) {
        state = code;
        break;
      }
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
    city,
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

function normalizeCity(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || null;
}

function grantMatchesCityRequirement(userLocation: UserLocation, granteeCity: string | null, granteeState: string | null): boolean {
  // If no city specified, all grants pass
  if (!userLocation.city) return true;
  // If the user specified a state, allow all grantees in the same state
  // (not just the exact city). This prevents excluding valid regional matches.
  if (userLocation.state) {
    const state = normalizeState(granteeState);
    if (state && state === userLocation.state) return true;
  }
  // Also allow exact city match regardless
  const city = normalizeCity(granteeCity);
  if (city && city === userLocation.city) return true;
  // Reject grants with no location data or mismatched state/city
  return false;
}

function locationSimilarity(userLocation: UserLocation, granteeCity: string | null, granteeState: string | null, granteeCountry: string | null): number {
  if (userLocation.isGlobal) return 1;
  if (!userLocation.hasLocationInput) return 0.5;

  const state = normalizeState(granteeState);
  const country = (granteeCountry || '').trim().toUpperCase();
  const isUS = !country || country === 'US' || country === 'USA' || country === 'UNITED STATES';

  if (userLocation.city) {
    const city = normalizeCity(granteeCity);
    // Exact city + state match is the best
    if (city && city === userLocation.city && (!userLocation.state || (state && state === userLocation.state))) return 1;
    // Same state but different/unknown city — still a strong regional signal
    if (userLocation.state && state && state === userLocation.state) return 0.82;
  }

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

function maxSingleGrantForBudgetBand(budgetBand: BudgetBand): number | null {
  switch (budgetBand) {
    case 'under_250k':
      return 25_000;
    case '250k_1m':
      return 100_000;
    case '1m_5m':
      return 500_000;
    case 'over_5m':
      return 500_000;
    default:
      return null;
  }
}

function grantPassesUserCap(grant: GrantRow, maxGrantAmount: number | null): boolean {
  if (!maxGrantAmount) return true;
  return typeof grant.grant_amount === 'number'
    && Number.isFinite(grant.grant_amount)
    && grant.grant_amount > 0
    && grant.grant_amount <= maxGrantAmount;
}

function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
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

function normalizePeerNonprofits(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 3)
    .slice(0, 20);
  return uniqueStrings(cleaned);
}

function ilikeSafeToken(value: string): string {
  return value
    .replace(/[%_*(),'"`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNameForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePeerInput(raw: string): string {
  const extractedUrl = (raw.match(/https?:\/\/[^\s)]+/i) || [null])[0];
  const withoutUrls = raw
    .replace(/\(https?:\/\/[^\s)]+\)/gi, ' ')
    .replace(/https?:\/\/[^\s)]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (withoutUrls) return withoutUrls;
  if (!extractedUrl) return '';

  try {
    const hostname = new URL(extractedUrl).hostname.replace(/^www\./i, '');
    const hostWithoutTld = hostname.split('.').slice(0, -1).join('.') || hostname;
    return hostWithoutTld.replace(/[._-]+/g, ' ').trim();
  } catch {
    return '';
  }
}

function peerNameTokens(value: string): string[] {
  const normalized = normalizeNameForMatch(value);
  if (!normalized) return [];
  const tokens = normalized.split(' ').filter((token) => token.length >= 2);
  const trimmed = tokens.filter((token) => !PEER_NAME_SUFFIX_WORDS.has(token));
  return (trimmed.length ? trimmed : tokens).slice(0, 8);
}

function peerIlikePattern(value: string): string | null {
  const tokens = peerNameTokens(value).map((token) => ilikeSafeToken(token));
  if (!tokens.length) return null;
  return `*${tokens.join('*')}*`;
}

function overlapRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const bSet = new Set(b);
  let overlap = 0;
  for (const token of a) {
    if (bSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(a.length, b.length);
}

function pickBestPeerOrg(
  organizations: Array<Record<string, unknown>>,
  queryTokens: string[],
  userLocation: UserLocation,
): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;

  for (const org of organizations) {
    const name = typeof org?.name === 'string' ? org.name : '';
    if (!name) continue;
    const orgTokens = peerNameTokens(name);
    const overlap = overlapRatio(queryTokens, orgTokens);
    if (overlap <= 0) continue;

    const orgState = normalizeState(typeof org?.state === 'string' ? org.state : null);
    const orgCity = normalizeCity(typeof org?.city === 'string' ? org.city : null);

    let score = overlap * 4;
    if (userLocation.state && orgState && userLocation.state === orgState) score += 2;
    if (userLocation.city && orgCity && userLocation.city === orgCity) score += 1.5;

    const subseccd = typeof org?.subseccd === 'number' ? org.subseccd : null;
    if (subseccd === 3) score += 0.25;

    if (score > bestScore) {
      bestScore = score;
      best = org;
    }
  }

  return best;
}

async function resolvePeerProfiles(
  peerInputs: string[],
  userLocation: UserLocation,
): Promise<PeerProfile[]> {
  // Resolve all peer profiles in PARALLEL (was sequential)
  const resolveOne = async (rawInput: string): Promise<PeerProfile | null> => {
    const cleaned = normalizePeerInput(rawInput);
    if (!cleaned) return null;

    const cleanedTokens = peerNameTokens(cleaned);
    if (!cleanedTokens.length) return null;

    let canonicalName = cleaned;
    let ein: string | null = null;
    let city: string | null = null;
    let state: string | null = null;

    try {
      const url = `${PROPUBLICA_API_BASE}/search.json?q=${encodeURIComponent(cleaned)}`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
        },
      });
      if (res.ok) {
        const json = await res.json();
        const organizations = Array.isArray(json?.organizations) ? json.organizations : [];
        const best = pickBestPeerOrg(organizations, cleanedTokens, userLocation);
        if (best) {
          canonicalName = typeof best.name === 'string' && best.name.trim() ? best.name.trim() : canonicalName;
          ein = normalizedEin(String(best.ein || ''));
          city = typeof best.city === 'string' ? best.city : null;
          state = normalizeState(typeof best.state === 'string' ? best.state : null);
        }
      }
    } catch {
      // Best-effort only.
    }

    return {
      input: rawInput,
      canonicalName,
      normalizedName: normalizeNameForMatch(canonicalName),
      tokenSignature: peerNameTokens(canonicalName),
      ein,
      city,
      state,
    };
  };

  const resolved = await Promise.all(peerInputs.map(resolveOne));
  const profiles = resolved.filter((p): p is PeerProfile => p !== null);

  const dedupedByEin = new Map<string, PeerProfile>();
  const dedupedByName = new Map<string, PeerProfile>();
  for (const profile of profiles) {
    if (profile.ein) {
      if (!dedupedByEin.has(profile.ein)) dedupedByEin.set(profile.ein, profile);
      continue;
    }
    if (!dedupedByName.has(profile.normalizedName)) dedupedByName.set(profile.normalizedName, profile);
  }

  return [...dedupedByEin.values(), ...dedupedByName.values()];
}

function grantMatchesPeerLocation(userLocation: UserLocation, grant: GrantRow): boolean {
  if (!userLocation.hasLocationInput) return true;

  if (userLocation.city) {
    return grantMatchesCityRequirement(userLocation, grant.grantee_city, grant.grantee_state);
  }

  if (userLocation.state) {
    const grantState = normalizeState(grant.grantee_state);
    return !!grantState && grantState === userLocation.state;
  }

  return true;
}

function grantMatchesPeerProfile(grant: GrantRow, profile: PeerProfile): boolean {
  const grantEin = normalizedEin(grant.grantee_ein);
  if (profile.ein && grantEin && profile.ein === grantEin) return true;

  const grantNameNorm = normalizeNameForMatch(grant.grantee_name || '');
  if (!grantNameNorm) return false;
  if (!profile.tokenSignature.length) return false;

  return profile.tokenSignature.every((token) => grantNameNorm.includes(token));
}

function matchedPeerNamesForGrant(
  grant: GrantRow,
  peerProfiles: PeerProfile[],
  userLocation: UserLocation,
): string[] {
  const matchedProfiles = peerProfiles.filter((profile) => grantMatchesPeerProfile(grant, profile));
  if (!matchedProfiles.length) return [];

  // Exact EIN matches should survive even when filing rows omit city/state fields.
  const grantEin = normalizedEin(grant.grantee_ein);
  const hasExactEinMatch = !!grantEin && matchedProfiles.some((profile) => profile.ein === grantEin);
  if (!hasExactEinMatch && !grantMatchesPeerLocation(userLocation, grant)) return [];

  return matchedProfiles.map((profile) => profile.canonicalName);
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [values];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

function isSupabaseStatementTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('57014') || message.toLowerCase().includes('statement timeout');
}

async function fetchPeerGrantsFromDatabase(
  peerProfiles: PeerProfile[],
  userLocation: UserLocation,
): Promise<{ grants: GrantRow[]; stats: Record<string, number> }> {
  const stats = {
    queries_attempted: 0,
    queries_succeeded: 0,
    queries_timed_out: 0,
    queries_failed: 0,
    rows_loaded: 0,
    timed_out_name_profiles: 0,
    timeout_fallback_candidate_foundations: 0,
    timeout_fallback_rows: 0,
  };
  const grantsByKey = new Map<string, GrantRow>();
  const selectColumns =
    'id,foundation_id,grant_year,grant_amount,grantee_name,grantee_ein,grantee_city,grantee_state,' +
    'grantee_country,purpose_text,ntee_code,mission_signal_text,grantee_budget_band';
  const orderAndYear = `&grant_year=gte.${MIN_GRANT_YEAR}&order=grant_year.desc,grant_amount.desc`;
  const basePath = `foundation_grants?select=${selectColumns}${orderAndYear}`;

  const appendRows = (rows: GrantRow[]) => {
    for (const row of rows) {
      if (grantsByKey.size >= PEER_DB_MAX_GRANTS) break;
      const key = row.id || [
        row.foundation_id,
        row.grant_year,
        normalizedEin(row.grantee_ein) || '',
        normalizeNameForMatch(row.grantee_name),
        row.grant_amount ?? '',
      ].join('|');
      if (!grantsByKey.has(key)) grantsByKey.set(key, row);
    }
  };

  const runQuery = async (path: string): Promise<GrantRow[]> => {
    stats.queries_attempted += 1;
    try {
      const res = await sbFetch(path);
      const rows = await res.json() as GrantRow[];
      stats.queries_succeeded += 1;
      stats.rows_loaded += rows.length;
      return rows;
    } catch (error) {
      if (isSupabaseStatementTimeout(error)) {
        stats.queries_timed_out += 1;
      } else {
        stats.queries_failed += 1;
      }
      return [];
    }
  };

  // --- PARALLEL EIN batch queries ---
  const eins = uniqueStrings(peerProfiles.map((profile) => profile.ein || ''));
  const einBatches = chunkArray(eins, PEER_DB_EIN_BATCH_SIZE).filter((b) => b.length > 0);
  const einBatchResults = await Promise.all(
    einBatches.map((batch) => {
      const inFilter = buildInFilter(batch);
      return runQuery(`${basePath}&grantee_ein=in.${inFilter}&limit=${PEER_DB_EIN_QUERY_LIMIT}`);
    }),
  );
  for (const rows of einBatchResults) {
    if (grantsByKey.size >= PEER_DB_MAX_GRANTS) break;
    appendRows(rows);
  }

  // --- PARALLEL name-based queries ---
  const nameQueries = peerProfiles
    .map((profile) => {
      const pattern = peerIlikePattern(profile.canonicalName);
      if (!pattern) return null;
      const scopedState = profile.state || userLocation.state || null;
      let queryPath = `${basePath}&grantee_name=ilike.${encodeURIComponent(pattern)}`;
      if (scopedState) queryPath += `&grantee_state=eq.${encodeURIComponent(scopedState)}`;
      queryPath += `&limit=${PEER_DB_NAME_QUERY_LIMIT}`;
      return { profile, queryPath };
    })
    .filter((q): q is { profile: PeerProfile; queryPath: string } => q !== null);

  const nameResults = await Promise.all(
    nameQueries.map(async ({ profile, queryPath }) => {
      let rows: GrantRow[] = [];
      let timedOut = false;
      stats.queries_attempted += 1;
      try {
        const res = await sbFetch(queryPath);
        rows = await res.json() as GrantRow[];
        stats.queries_succeeded += 1;
        stats.rows_loaded += rows.length;
      } catch (error) {
        if (isSupabaseStatementTimeout(error)) {
          stats.queries_timed_out += 1;
          timedOut = true;
        } else {
          stats.queries_failed += 1;
        }
      }
      return { profile, rows, timedOut };
    }),
  );

  const timedOutNameProfiles: PeerProfile[] = [];
  for (const { profile, rows, timedOut } of nameResults) {
    if (grantsByKey.size >= PEER_DB_MAX_GRANTS) break;
    appendRows(rows);
    if (timedOut) timedOutNameProfiles.push(profile);
  }

  if (timedOutNameProfiles.length && grantsByKey.size < PEER_DB_MAX_GRANTS) {
    const locationHints = uniqueStrings(timedOutNameProfiles.flatMap((profile) => {
      const hints: string[] = [];
      if (profile.city && profile.state) {
        hints.push(`${profile.city}||${profile.state}`);
      }
      if (profile.state) {
        hints.push(`||${profile.state}`);
      }
      return hints;
    }));

    if (!locationHints.length && userLocation.state) {
      const city = userLocation.city || '';
      locationHints.push(`${city}||${userLocation.state}`);
    }

    const baseFunderSelect = 'id,total_giving,city,state';
    const candidateFoundationIds = new Set<string>();

    const sampleAcross = (rows: FunderRow[], max: number): FunderRow[] => {
      if (rows.length <= max) return rows;
      const sampled: FunderRow[] = [];
      for (let i = 0; i < max; i += 1) {
        const idx = Math.floor((i * rows.length) / max);
        sampled.push(rows[idx]);
      }
      return sampled;
    };

    for (const hint of locationHints.slice(0, 3)) {
      if (candidateFoundationIds.size >= PEER_DB_TIMEOUT_FALLBACK_FOUNDER_LIMIT) break;
      const [cityPart, statePart] = hint.split('||');
      if (!statePart) continue;

      const stateFilter = `&state=eq.${encodeURIComponent(statePart)}`;
      const cityFilter = cityPart
        ? `&city=ilike.*${encodeURIComponent(ilikeSafeToken(cityPart))}*`
        : '';

      try {
        const [givingRes, nameRes] = await Promise.all([
          sbFetch(
            `funders?select=${baseFunderSelect}&type=eq.foundation${stateFilter}${cityFilter}` +
            `&order=total_giving.desc.nullslast&limit=220`,
          ),
          sbFetch(
            `funders?select=${baseFunderSelect}&type=eq.foundation${stateFilter}${cityFilter}` +
            `&order=name.asc&limit=220`,
          ),
        ]);
        const givingRows = await givingRes.json() as FunderRow[];
        const nameRows = await nameRes.json() as FunderRow[];
        const selected = [
          ...givingRows.slice(0, 130),
          ...sampleAcross(nameRows, 90),
        ];
        for (const row of selected) {
          if (candidateFoundationIds.size >= PEER_DB_TIMEOUT_FALLBACK_FOUNDER_LIMIT) break;
          if (!row?.id) continue;
          candidateFoundationIds.add(row.id);
        }
      } catch {
        // Best-effort fallback only.
      }
    }

    const tokenClauses = uniqueStrings(
      timedOutNameProfiles.flatMap((profile) =>
        profile.tokenSignature
          .filter((token) => token.length >= 3)
          .map((token) => `grantee_name.ilike.*${ilikeSafeToken(token)}*`),
      ),
    ).slice(0, 10);

    stats.timed_out_name_profiles = timedOutNameProfiles.length;
    stats.timeout_fallback_candidate_foundations = candidateFoundationIds.size;

    if (tokenClauses.length && candidateFoundationIds.size) {
      const batchQuery = async (ids: string[]): Promise<GrantRow[]> => {
        if (!ids.length || grantsByKey.size >= PEER_DB_MAX_GRANTS) return [];
        const inFilter = buildInFilter(ids);
        const queryPath =
          `${basePath}&foundation_id=in.${inFilter}` +
          `&or=${encodeURIComponent(`(${tokenClauses.join(',')})`)}` +
          `&limit=${PEER_DB_TIMEOUT_FALLBACK_QUERY_LIMIT}`;

        stats.queries_attempted += 1;
        try {
          const res = await sbFetch(queryPath);
          const rows = await res.json() as GrantRow[];
          stats.queries_succeeded += 1;
          stats.rows_loaded += rows.length;
          return rows;
        } catch (error) {
          if (isSupabaseStatementTimeout(error) && ids.length > 20) {
            stats.queries_timed_out += 1;
            const mid = Math.ceil(ids.length / 2);
            const [left, right] = await Promise.all([
              batchQuery(ids.slice(0, mid)),
              batchQuery(ids.slice(mid)),
            ]);
            return [...left, ...right];
          }
          if (isSupabaseStatementTimeout(error)) {
            stats.queries_timed_out += 1;
          } else {
            stats.queries_failed += 1;
          }
          return [];
        }
      };

      // --- PARALLEL fallback batch queries ---
      const fallbackBatches = chunkArray(
        [...candidateFoundationIds],
        PEER_DB_TIMEOUT_FALLBACK_BATCH_SIZE,
      );
      const fallbackResults = await Promise.all(
        fallbackBatches.map((batch) => batchQuery(batch)),
      );
      for (const rows of fallbackResults) {
        if (grantsByKey.size >= PEER_DB_MAX_GRANTS) break;
        stats.timeout_fallback_rows += rows.length;
        appendRows(rows);
      }
    }
  }

  return {
    grants: [...grantsByKey.values()],
    stats,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

function coerceStringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((v) => typeof v === 'string') as string[] : [];
}

const ORGANIZATION_HINT_WORDS = new Set([
  'academy', 'agency', 'alliance', 'arts', 'association', 'bank', 'board', 'bureau', 'camp', 'care',
  'center', 'centre', 'charity', 'children', 'church', 'city', 'clinic', 'coalition', 'college', 'commission',
  'committee', 'community', 'company', 'corp', 'corporation', 'council', 'county', 'department', 'district',
  'education', 'enterprise', 'fellowship', 'foundation', 'fund', 'group', 'health', 'hospital', 'institute',
  'library', 'llc', 'ltd', 'ministries', 'ministry', 'museum', 'network', 'nonprofit', 'office', 'organization',
  'partners', 'partnership', 'program', 'project', 'relief', 'research', 'school', 'service', 'services',
  'society', 'systems', 'team', 'theater', 'theatre', 'trust', 'university',
]);

function missionSignalText(grant: GrantRow): string {
  return [grant.mission_signal_text || '', grant.purpose_text || '', grant.ntee_code || '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMissionEvidence(grant: GrantRow): boolean {
  const signal = missionSignalText(grant);
  return signal.length >= 16;
}

function isLikelyIndividualGrantee(grant: GrantRow): boolean {
  if (normalizedEin(grant.grantee_ein)) return false;

  const normalized = grant.grantee_name
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;

  const lower = normalized.toLowerCase();
  const tokens = lower.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (/[0-9&/]/.test(lower)) return false;

  if (tokens.some((token) => ORGANIZATION_HINT_WORDS.has(token))) return false;
  if (tokens.some((token) => token.length <= 1 || token.length > 16)) return false;
  if (!tokens.every((token) => /^[a-z'-]+$/.test(token))) return false;

  // Name-like pattern with no EIN and no mission evidence => likely an individual.
  if (!hasMissionEvidence(grant)) return true;

  return false;
}

function isEligibleOrganizationGrant(grant: GrantRow): boolean {
  if (isLikelyIndividualGrantee(grant)) return false;
  return hasMissionEvidence(grant);
}

function extractYearAnchors(html: string): Array<{ idx: number; year: number }> {
  const anchors: Array<{ idx: number; year: number }> = [];
  const re = /id=['"]filing(\d{4})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    anchors.push({ idx: m.index, year: Number.parseInt(m[1], 10) });
  }
  return anchors;
}

function findYearForIndex(yearAnchors: Array<{ idx: number; year: number }>, idx: number): number | null {
  let year: number | null = null;
  for (const y of yearAnchors) {
    if (y.idx <= idx) year = y.year;
    else break;
  }
  return year;
}

function extractObjectIdsFromOrgPage(html: string): Array<{ objectId: string; taxYear: number; xmlUrl: string }> {
  const yearAnchors = extractYearAnchors(html);
  const entries: Array<{ objectId: string; taxYear: number; xmlUrl: string }> = [];
  const re = /data-href="\/nonprofits\/organizations\/\d+\/(\d+)\/([^"\/?#]+)"/g;
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const objectId = m[1];
    const formName = m[2];
    if (formName !== 'IRS990PF') continue;
    if (seen.has(objectId)) continue;
    seen.add(objectId);

    const year = findYearForIndex(yearAnchors, m.index);
    if (!year || year < MIN_GRANT_YEAR) continue;

    entries.push({
      objectId,
      taxYear: year,
      xmlUrl: `https://projects.propublica.org/nonprofits/download-xml?object_id=${objectId}`,
    });
  }

  return entries;
}

function sanitizeXml(xml: string): string {
  return xml
    .replace(/<\/?[a-zA-Z0-9_]+:/g, (tag) => tag.replace(':', ''))
    .replace(/\r/g, '');
}

function pickTag(block: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

function parseGrantBlocksFromXml(xml: string): Array<Omit<GrantRow, 'id' | 'foundation_id'>> {
  const grants: Array<Omit<GrantRow, 'id' | 'foundation_id'>> = [];
  const re = /<GrantOrContributionPdDurYrGrp>([\s\S]*?)<\/GrantOrContributionPdDurYrGrp>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const granteeName =
      pickTag(block, 'BusinessNameLine1Txt')
      || pickTag(block, 'RecipientPersonNm')
      || pickTag(block, 'RecipientBusinessName')
      || null;
    if (!granteeName) continue;

    const grantAmount = asNumber(pickTag(block, 'Amt'));
    const purposeText = pickTag(block, 'GrantOrContributionPurposeTxt');
    const city = pickTag(block, 'CityNm');
    const state = pickTag(block, 'StateAbbreviationCd');
    const country = pickTag(block, 'CountryCd');
    const recipientEin = normalizedEin(pickTag(block, 'EIN'));

    grants.push({
      grant_year: MIN_GRANT_YEAR,
      grant_amount: grantAmount,
      grantee_name: granteeName,
      grantee_ein: recipientEin,
      grantee_city: city,
      grantee_state: state,
      grantee_country: country || (state ? 'US' : null),
      purpose_text: purposeText,
      ntee_code: null,
      mission_signal_text: purposeText,
      grantee_budget_band: null,
    });
  }

  return grants;
}

function asNumber(value: string | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    });
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function parseLooseAmount(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function parseTaxYearFromObjectId(objectId: string): number | null {
  if (!/^\d{4}/.test(objectId)) return null;
  const filingYear = Number.parseInt(objectId.slice(0, 4), 10);
  if (!Number.isFinite(filingYear) || filingYear < 2000 || filingYear > 2100) return null;
  return filingYear - 1;
}

function parseTaxYearFromFullTextHtml(html: string, objectId: string): number | null {
  const titleYear = html.match(/<title>\s*TY\s+(\d{4})\s+Form/i)?.[1];
  if (titleYear) {
    const parsed = Number.parseInt(titleYear, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return parseTaxYearFromObjectId(objectId);
}

function extractPeerFullTextCandidates(searchHtml: string): PeerFullTextCandidate[] {
  const candidates: PeerFullTextCandidate[] = [];
  const seen = new Set<string>();
  const linkRe = /(href|data-href)="\/nonprofits\/organizations\/(\d{9})\/(\d+)\/(IRS990ScheduleI|IRS990PF)"/g;
  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(searchHtml)) !== null) {
    const foundationEin = normalizedEin(m[2]);
    const objectId = m[3];
    const formName = m[4] as 'IRS990ScheduleI' | 'IRS990PF';
    if (!foundationEin) continue;

    const key = `${foundationEin}:${objectId}:${formName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      foundationEin,
      objectId,
      formName,
    });
  }

  return candidates;
}

function extractPeerFullTextNextPath(searchHtml: string): string | null {
  const relMatch = searchHtml.match(/<link[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (relMatch?.[1]) return decodeHtmlEntities(relMatch[1]);

  const anchorMatch = searchHtml.match(
    /<a[^>]+href="([^"]*\/nonprofits\/full_text_search[^"]*page=\d+[^"]*)"[^>]*>\s*(?:Next|›)\s*<\/a>/i,
  );
  if (anchorMatch?.[1]) return decodeHtmlEntities(anchorMatch[1]);

  return null;
}

function parseScheduleIFullTextPage(html: string, objectId: string): ParsedScheduleIPage {
  const spanRe = /<span[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
  const spans: Array<{ id: string; text: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = spanRe.exec(html)) !== null) {
    const id = m[1];
    const text = decodeHtmlEntities(stripHtml(m[2])).replace(/\s+/g, ' ').trim();
    if (!id || !text) continue;
    spans.push({ id, text });
  }

  const filerName = spans.find((span) =>
    /\/ReturnHeader\[1\]\/Filer\[1\]\/BusinessName\[1\]\/BusinessNameLine1Txt\[1\]$/i.test(span.id),
  )?.text || null;
  const filerCity = spans.find((span) =>
    /\/ReturnHeader\[1\]\/Filer\[1\]\/USAddress\[1\]\/CityNm\[1\]$/i.test(span.id),
  )?.text || null;
  const filerState = spans.find((span) =>
    /\/ReturnHeader\[1\]\/Filer\[1\]\/USAddress\[1\]\/StateAbbreviationCd\[1\]$/i.test(span.id),
  )?.text || null;

  const rowMap = new Map<number, Partial<ParsedScheduleIGrant>>();
  for (const span of spans) {
    const idxMatch = span.id.match(/\/RecipientTable\[(\d+)\]\//i);
    if (!idxMatch) continue;
    const idx = Number.parseInt(idxMatch[1], 10);
    if (!Number.isFinite(idx)) continue;

    const row = rowMap.get(idx) || {};
    if (/\/RecipientBusinessName\[1\]\/BusinessNameLine1Txt\[1\]$/i.test(span.id)) {
      row.grantee_name = span.text;
    } else if (/\/RecipientEIN\[1\]$/i.test(span.id)) {
      row.grantee_ein = normalizedEin(span.text);
    } else if (/\/USAddress\[1\]\/CityNm\[1\]$/i.test(span.id)) {
      row.grantee_city = span.text;
    } else if (/\/USAddress\[1\]\/StateAbbreviationCd\[1\]$/i.test(span.id)) {
      row.grantee_state = span.text;
    } else if (/\/ForeignAddress\[1\]\/CountryCd\[1\]$/i.test(span.id)) {
      row.grantee_country = span.text.toUpperCase();
    } else if (/\/CashGrantAmt\[1\]$/i.test(span.id)) {
      row.grant_amount = parseLooseAmount(span.text);
    } else if (/\/PurposeOfGrantTxt\[1\]$/i.test(span.id)) {
      row.purpose_text = span.text;
    }

    rowMap.set(idx, row);
  }

  const grants: ParsedScheduleIGrant[] = [];
  for (const row of rowMap.values()) {
    const granteeName = (row.grantee_name || '').trim();
    if (!granteeName) continue;
    grants.push({
      grantee_name: granteeName,
      grantee_ein: row.grantee_ein || null,
      grantee_city: row.grantee_city || null,
      grantee_state: row.grantee_state || null,
      grantee_country: row.grantee_country || (row.grantee_state ? 'US' : null),
      grant_amount: typeof row.grant_amount === 'number' ? row.grant_amount : null,
      purpose_text: row.purpose_text || null,
    });
  }

  return {
    taxYear: parseTaxYearFromFullTextHtml(html, objectId),
    filerName,
    filerCity,
    filerState,
    grants,
  };
}

async function fetchOrganizationSummaryByEin(
  foundationEin: string,
): Promise<{
  name: string | null;
  city: string | null;
  state: string | null;
  foundationCode: number | null;
  subsectionCode: number | null;
}> {
  try {
    const res = await fetch(`${PROPUBLICA_API_BASE}/organizations/${foundationEin}.json`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
      },
    });
    if (!res.ok) {
      return { name: null, city: null, state: null, foundationCode: null, subsectionCode: null };
    }
    const json = await res.json();
    const org = json?.organization || {};
    return {
      name: typeof org?.name === 'string' ? org.name : null,
      city: typeof org?.city === 'string' ? org.city : null,
      state: typeof org?.state === 'string' ? org.state : null,
      foundationCode: typeof org?.foundation_code === 'number' ? org.foundation_code : null,
      subsectionCode: typeof org?.subsection_code === 'number' ? org.subsection_code : null,
    };
  } catch {
    return { name: null, city: null, state: null, foundationCode: null, subsectionCode: null };
  }
}

async function fetchPeerMatchesViaFullTextSearch(
  peerProfiles: PeerProfile[],
  userLocation: UserLocation,
  deadlineMs: number,
): Promise<PeerFullTextMatchSet[]> {
  const queryTerms = uniqueStrings(peerProfiles.flatMap((profile) => {
    const terms: string[] = [];
    if (profile.ein) {
      terms.push(profile.ein);
      terms.push(`${profile.ein.slice(0, 2)}-${profile.ein.slice(2)}`);
    }
    terms.push(profile.canonicalName);
    terms.push(normalizePeerInput(profile.input));
    return terms;
  }))
    .filter((term) => term.length >= 3)
    .slice(0, PEER_FULL_TEXT_MAX_QUERY_TERMS);

  if (!queryTerms.length) return [];

  // --- PARALLEL full text search across all query terms ---
  const candidateMap = new Map<string, PeerFullTextCandidate>();

  const searchOneTerm = async (term: string): Promise<PeerFullTextCandidate[]> => {
    const results: PeerFullTextCandidate[] = [];
    const query = /\s/.test(term) ? `"${term}"` : term;
    let nextUrl: string | null = `${PROPUBLICA_FULL_TEXT_SEARCH}?q=${encodeURIComponent(query)}`;

    for (let page = 1; page <= PEER_FULL_TEXT_MAX_PAGES_PER_QUERY; page++) {
      if (!nextUrl) break;
      if (Date.now() > deadlineMs) break;

      try {
        const res = await fetch(nextUrl, {
          headers: {
            Accept: 'text/html',
            'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
          },
        });
        if (!res.ok) break;

        const html = await res.text();
        const candidates = extractPeerFullTextCandidates(html);
        for (const candidate of candidates) results.push(candidate);

        const nextPath = extractPeerFullTextNextPath(html);
        nextUrl = nextPath
          ? nextPath.startsWith('http')
            ? nextPath
            : `https://projects.propublica.org${nextPath}`
          : null;
      } catch {
        break;
      }
    }
    return results;
  };

  const termResults = await Promise.all(queryTerms.map(searchOneTerm));
  for (const candidates of termResults) {
    for (const candidate of candidates) {
      const key = `${candidate.foundationEin}:${candidate.objectId}:${candidate.formName}`;
      if (candidateMap.has(key)) continue;
      candidateMap.set(key, candidate);
      if (candidateMap.size >= PEER_FULL_TEXT_MAX_CANDIDATES) break;
    }
    if (candidateMap.size >= PEER_FULL_TEXT_MAX_CANDIDATES) break;
  }

  // --- PARALLEL candidate fetches with concurrency limit of 6 ---
  const matchesByEin = new Map<string, PeerFullTextMatchSet>();
  const seenGrantKeys = new Set<string>();

  type CandidateFetchResult = {
    candidate: PeerFullTextCandidate;
    parsedTaxYear: number | null;
    parsedGrants: ParsedScheduleIGrant[];
    filerName: string | null;
    filerCity: string | null;
    filerState: string | null;
  };

  const fetchOneCandidate = async (candidate: PeerFullTextCandidate): Promise<CandidateFetchResult | null> => {
    try {
      let parsedTaxYear: number | null = null;
      let parsedGrants: ParsedScheduleIGrant[] = [];
      let filerName: string | null = null;
      let filerCity: string | null = null;
      let filerState: string | null = null;

      if (candidate.formName === 'IRS990PF') {
        const xmlRes = await fetch(
          `https://projects.propublica.org/nonprofits/download-xml?object_id=${candidate.objectId}`,
          {
            headers: {
              Accept: 'application/xml,text/xml,text/html',
              'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
            },
          },
        );
        if (!xmlRes.ok) return null;
        const rawXml = await xmlRes.text();
        if (!rawXml.trim().startsWith('<?xml')) return null;

        parsedTaxYear = parseTaxYearFromObjectId(candidate.objectId);
        parsedGrants = parseGrantBlocksFromXml(sanitizeXml(rawXml)).map((grant) => ({
          grantee_name: grant.grantee_name,
          grantee_ein: grant.grantee_ein,
          grantee_city: grant.grantee_city,
          grantee_state: grant.grantee_state,
          grantee_country: grant.grantee_country,
          grant_amount: grant.grant_amount,
          purpose_text: grant.purpose_text,
        }));
      } else {
        const fullTextRes = await fetch(
          `${PROPUBLICA_FULL_TEXT_BASE}/${candidate.objectId}/${candidate.formName}`,
          {
            headers: {
              Accept: 'text/html',
              'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
            },
          },
        );
        if (!fullTextRes.ok) return null;
        const fullTextHtml = await fullTextRes.text();
        const parsed = parseScheduleIFullTextPage(fullTextHtml, candidate.objectId);
        parsedTaxYear = parsed.taxYear;
        parsedGrants = parsed.grants;
        filerName = parsed.filerName;
        filerCity = parsed.filerCity;
        filerState = parsed.filerState;
      }

      return { candidate, parsedTaxYear, parsedGrants, filerName, filerCity, filerState };
    } catch {
      return null;
    }
  };

  // Concurrency-limited parallel fetch (max 6 at a time)
  const candidateList = [...candidateMap.values()].slice(0, PEER_FULL_TEXT_MAX_FETCHES);
  const CONCURRENCY = 6;
  const fetchResults: (CandidateFetchResult | null)[] = [];
  for (let i = 0; i < candidateList.length; i += CONCURRENCY) {
    if (Date.now() > deadlineMs) break;
    const chunk = candidateList.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(fetchOneCandidate));
    fetchResults.push(...chunkResults);
  }

  for (const result of fetchResults) {
    if (!result) continue;
    const { candidate, parsedTaxYear, parsedGrants, filerName, filerCity, filerState } = result;
    if (!parsedTaxYear || parsedTaxYear < MIN_GRANT_YEAR) continue;
    if (!parsedGrants.length) continue;

    for (const parsedGrant of parsedGrants) {
      const grantRowBase: GrantRow = {
        id: `live:ft:${candidate.foundationEin}:${candidate.objectId}:${parsedGrant.grantee_name}`,
        foundation_id: `ein:${candidate.foundationEin}`,
        grant_year: parsedTaxYear,
        grant_amount: parsedGrant.grant_amount,
        grantee_name: parsedGrant.grantee_name,
        grantee_ein: parsedGrant.grantee_ein,
        grantee_city: parsedGrant.grantee_city,
        grantee_state: parsedGrant.grantee_state,
        grantee_country: parsedGrant.grantee_country,
        purpose_text: parsedGrant.purpose_text,
        ntee_code: null,
        mission_signal_text: parsedGrant.purpose_text,
        grantee_budget_band: null,
      };

      if (isLikelyIndividualGrantee(grantRowBase)) continue;
      if (!matchedPeerNamesForGrant(grantRowBase, peerProfiles, userLocation).length) continue;

      const dedupeKey = [
        candidate.foundationEin,
        parsedTaxYear,
        normalizedEin(grantRowBase.grantee_ein) || '',
        normalizeNameForMatch(grantRowBase.grantee_name),
        grantRowBase.grant_amount || '',
      ].join('|');
      if (seenGrantKeys.has(dedupeKey)) continue;
      seenGrantKeys.add(dedupeKey);

      const entry = matchesByEin.get(candidate.foundationEin) || {
        foundationEin: candidate.foundationEin,
        foundationName: filerName,
        foundationCity: filerCity,
        foundationState: filerState,
        foundationCode: null,
        subsectionCode: null,
        grants: [],
      };
      const grantIndex = entry.grants.length + 1;
      entry.grants.push({
        ...grantRowBase,
        id: `live:ft:${candidate.foundationEin}:${candidate.objectId}:${grantIndex}`,
      });
      if (!entry.foundationName && filerName) entry.foundationName = filerName;
      if (!entry.foundationCity && filerCity) entry.foundationCity = filerCity;
      if (!entry.foundationState && filerState) entry.foundationState = filerState;
      matchesByEin.set(candidate.foundationEin, entry);
    }
  }

  // --- PARALLEL organization summaries ---
  const entriesNeedingSummary = [...matchesByEin.values()].slice(0, 20);
  const summaries = await Promise.all(
    entriesNeedingSummary.map((entry) => fetchOrganizationSummaryByEin(entry.foundationEin)),
  );
  for (let i = 0; i < entriesNeedingSummary.length; i++) {
    const entry = entriesNeedingSummary[i];
    const summary = summaries[i];
    if (!entry.foundationName && summary.name) entry.foundationName = summary.name;
    if (!entry.foundationCity && summary.city) entry.foundationCity = summary.city;
    if (!entry.foundationState && summary.state) entry.foundationState = summary.state;
    if (entry.foundationCode === null && typeof summary.foundationCode === 'number') {
      entry.foundationCode = summary.foundationCode;
    }
    if (entry.subsectionCode === null && typeof summary.subsectionCode === 'number') {
      entry.subsectionCode = summary.subsectionCode;
    }
  }

  const isFoundationLike = (entry: PeerFullTextMatchSet): boolean => {
    const name = (entry.foundationName || '').toLowerCase();
    const nameHint = /\bfoundation\b|\bfund\b|\btrust\b|\bgrant\b|\bphilanthrop/i.test(name);
    return (entry.foundationCode !== null && entry.foundationCode > 0) || nameHint;
  };

  return [...matchesByEin.values()]
    .filter((entry) => entry.grants.length > 0)
    .filter((entry) => isFoundationLike(entry));
}

async function fetchLivePeerGrantsForFoundation(
  foundation: FunderRow,
  peerProfiles: PeerProfile[],
  userLocation: UserLocation,
  deadlineMs: number,
): Promise<GrantRow[]> {
  const foundationEin = normalizedEin(foundation.foundation_ein || foundation.id);
  if (!foundationEin) return [];

  if (Date.now() > deadlineMs) return [];

  try {
    const orgRes = await fetch(`${PROPUBLICA_ORG_BASE}/${foundationEin}`, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
      },
    });
    if (!orgRes.ok) return [];
    const orgHtml = await orgRes.text();
    const filings = extractObjectIdsFromOrgPage(orgHtml)
      .sort((a, b) => b.taxYear - a.taxYear)
      .slice(0, PEER_LIVE_QUERY_MAX_FILINGS_PER_FOUNDATION);

    const matched: GrantRow[] = [];
    let localIndex = 0;

    for (const filing of filings) {
      if (Date.now() > deadlineMs) break;
      const xmlRes = await fetch(filing.xmlUrl, {
        headers: {
          Accept: 'application/xml,text/xml,text/html',
          'User-Agent': 'FunderMatchBot/1.0 (+https://fundermatch.org)',
        },
      });
      if (!xmlRes.ok) continue;
      const rawXml = await xmlRes.text();
      if (!rawXml.trim().startsWith('<?xml')) continue;

      const grants = parseGrantBlocksFromXml(sanitizeXml(rawXml));
      for (const grant of grants) {
        const grantRow: GrantRow = {
          id: `live:${foundation.id}:${filing.objectId}:${localIndex++}`,
          foundation_id: foundation.id,
          grant_year: filing.taxYear,
          grant_amount: grant.grant_amount,
          grantee_name: grant.grantee_name,
          grantee_ein: grant.grantee_ein,
          grantee_city: grant.grantee_city,
          grantee_state: grant.grantee_state,
          grantee_country: grant.grantee_country,
          purpose_text: grant.purpose_text,
          ntee_code: grant.ntee_code,
          mission_signal_text: grant.mission_signal_text,
          grantee_budget_band: grant.grantee_budget_band,
        };

        if (isLikelyIndividualGrantee(grantRow)) continue;
        if (!matchedPeerNamesForGrant(grantRow, peerProfiles, userLocation).length) continue;

        matched.push(grantRow);
      }
    }

    return matched;
  } catch {
    return [];
  }
}

function grantMatchReasons(
  grant: ScoredGrant,
  userLocation: UserLocation,
  userBand: number | null,
  maxGrantAmount: number | null,
): string[] {
  const reasons: string[] = [];

  if (grant.missionScore >= 0.6) {
    reasons.push('Similar program area');
  }

  const isSameCity = !!(
    userLocation.city
    && normalizeCity(grant.grant.grantee_city)
    && normalizeCity(grant.grant.grantee_city) === userLocation.city
  );
  if (isSameCity) {
    reasons.push('Same city served');
  } else if (grant.locationScore >= 0.95) {
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

  if (maxGrantAmount && grantPassesUserCap(grant.grant, maxGrantAmount)) {
    reasons.push('Grant size is <=10% of your budget');
  }

  if (reasons.length === 0) {
    reasons.push('Recent grant shows partial mission overlap');
  }

  return reasons.slice(0, 2);
}

function funderCorpusTokens(funder: FunderRow): Set<string> {
  const focus = coerceStringArray(funder.focus_areas).join(' ');
  const corpus = [funder.name, funder.description || '', focus, funder.ntee_code || ''].join(' ');
  return tokenize(corpus);
}

function baselineMissionScore(userTokens: Set<string>, funderTokens: Set<string>): number {
  const score = lexicalSimilarity(userTokens, funderTokens);
  if (score > 0) return score;
  return 0.22;
}

// === Inline suggest-peers logic ===

const SUGGEST_PEER_STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','shall','should','may','might',
  'can','could','that','which','who','whom','this','these','those','it',
  'its','we','our','us','they','their','them','he','she','his','her',
  'not','no','nor','so','as','if','than','then','too','very','just',
  'about','also','into','over','such','through','during','before','after',
  'above','below','between','under','again','further','once','here',
  'there','when','where','why','how','all','each','every','both','few',
  'more','most','other','some','any','only','own','same','up','down',
  'out','off','while','because','until','what',
  'provide','providing','program','programs','services','service','support',
  'community','communities','organization','organizations','mission',
  'help','helps','helping','people','individuals','including','based',
  'area','areas','work','working','dedicated','committed','focus','focused',
  'focuses','serve','serving','served','across','within','offer','offering',
  'offers','ensure','promote','create','address','need','needs','access',
  'improve','improving','build','building','develop','developing',
  'desc','complex','use','achieve','achieving','highest','high','well',
  'serious','new','make','making','effort','efforts','range','able',
  'various','many','also','great','good','best','way','ways','like',
  'year','years','since','part','being','through','comprehensive',
  'potential','goal','goals','strive','striving','seek','seeking',
]);

function suggestPeerStemWord(word: string): string {
  if (word.length <= 5) return word;
  const suffixes = [
    { suffix: 'nesses', minRoot: 4 }, { suffix: 'ments', minRoot: 4 },
    { suffix: 'ness', minRoot: 4 }, { suffix: 'ment', minRoot: 4 },
    { suffix: 'tion', minRoot: 3 }, { suffix: 'sion', minRoot: 3 },
    { suffix: 'ious', minRoot: 3 }, { suffix: 'eous', minRoot: 3 },
    { suffix: 'able', minRoot: 3 }, { suffix: 'ible', minRoot: 3 },
    { suffix: 'ings', minRoot: 3 }, { suffix: 'ors', minRoot: 4 },
    { suffix: 'ers', minRoot: 4 }, { suffix: 'ing', minRoot: 3 },
    { suffix: 'ive', minRoot: 3 }, { suffix: 'ous', minRoot: 3 },
  ];
  for (const { suffix, minRoot } of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= minRoot) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) return word.slice(0, -1);
  return word;
}

function extractMissionKeywords(missionText: string): string[] {
  const words = missionText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !SUGGEST_PEER_STOP_WORDS.has(w));
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) { if (!seen.has(w)) { seen.add(w); unique.push(w); } }
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const scored = unique.map((w) => ({
    word: w, score: Math.min(w.length, 12) + (freq.get(w) || 1) * 3,
  }));
  scored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
  return scored.map((s) => s.word).slice(0, 8);
}

function normalizeSuggestGranteeName(name: string): string {
  return name.toUpperCase().trim()
    .replace(/\s+(INC\.?|LLC|CORP\.?|GROUP|AND SUBSIDIARIES|CO\.?|ASSOCIATION|ASSOC\.?|OF AMERICA)\s*$/i, '')
    .trim();
}

const SUGGEST_GENERALIST_PATTERNS = [
  /\bUNIVERSIT/i, /\bHOSPITAL\b/i, /\bMEDICAL CENTER/i,
  /\bMEDICAL SCHOOL/i, /\bSCHOOL OF MEDICINE/i, /\bCOLLEGE\b/i,
  /\bFRED HUTCH/i, /\bCANCER (CENTER|RESEARCH)/i, /\bCHILDREN'?S\b/i,
];

async function suggestPeersInternal(
  mission: string,
  locationServed: string,
  excludedKeywords: string[] = [],
): Promise<string[]> {
  const keywords = extractMissionKeywords(mission);
  if (!keywords.length) return [];

  const { city, state } = (() => {
    const STATE_ABBREVS: Record<string, string> = {
      alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',
      colorado:'CO',connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',
      hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',
      kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',
      michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',
      nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ',
      'new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',
      ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI',
      'south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',
      utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',
      wisconsin:'WI',wyoming:'WY','district of columbia':'DC',
    };
    const VALID_STATES = new Set(Object.values(STATE_ABBREVS));
    const parts = locationServed.split(',').map((p) => p.trim());
    let city = '', state = '';
    if (parts.length >= 2) {
      city = parts[0];
      const stateRaw = parts[parts.length - 1].replace(/\d+/g, '').trim();
      if (stateRaw.length === 2 && VALID_STATES.has(stateRaw.toUpperCase())) state = stateRaw.toUpperCase();
      else if (STATE_ABBREVS[stateRaw.toLowerCase()]) state = STATE_ABBREVS[stateRaw.toLowerCase()];
    } else if (parts.length === 1) {
      const val = parts[0].trim();
      if (val.length === 2 && VALID_STATES.has(val.toUpperCase())) state = val.toUpperCase();
      else if (STATE_ABBREVS[val.toLowerCase()]) state = STATE_ABBREVS[val.toLowerCase()];
      else city = val;
    }
    return { city, state };
  })();

  const searchTerms = keywords.map((kw) => ({ original: kw, stemmed: suggestPeerStemWord(kw) }));

  const runKeywordQuery = async (original: string, stemmed: string) => {
    const stateFilter = state ? `&grantee_state=eq.${encodeURIComponent(state)}` : '';
    const path =
      `foundation_grants?select=grantee_name,grantee_city,purpose_text,ntee_code` +
      `&purpose_text=ilike.*${encodeURIComponent(stemmed)}*` +
      `&purpose_text=not.is.null` +
      `&grant_year=gte.2019` +
      stateFilter +
      `&limit=500`;
    try {
      const res = await sbFetch(path);
      const rows = await res.json() as Array<{ grantee_name: string; grantee_city: string; purpose_text: string | null; ntee_code: string | null }>;
      return { keyword: original, rows };
    } catch {
      return { keyword: original, rows: [] as Array<{ grantee_name: string; grantee_city: string; purpose_text: string | null; ntee_code: string | null }> };
    }
  };

  // Run queries in batches of 2
  const results: Array<{ keyword: string; rows: Array<{ grantee_name: string; grantee_city: string; purpose_text: string | null; ntee_code: string | null }> }> = [];
  for (let i = 0; i < searchTerms.length; i += 2) {
    const batch = searchTerms.slice(i, i + 2);
    const batchResults = await Promise.all(
      batch.map(({ original, stemmed }) => runKeywordQuery(original, stemmed)),
    );
    results.push(...batchResults);
  }

  // Aggregate – also collect purpose texts and NTEE codes per peer for exclusion filtering
  interface PeerData { count: number; matchedKeywords: Set<string>; cityMatch: boolean; displayName: string; purposeTexts: string[]; nteeCodes: Set<string> }
  const peerMap = new Map<string, PeerData>();
  for (const { keyword, rows } of results) {
    for (const row of rows) {
      const rawName = (row.grantee_name || '').trim();
      if (!rawName || rawName.length < 3) continue;
      const key = normalizeSuggestGranteeName(rawName);
      if (!key || key.length < 3) continue;
      let entry = peerMap.get(key);
      if (!entry) {
        entry = { count: 0, matchedKeywords: new Set(), cityMatch: false, displayName: rawName, purposeTexts: [], nteeCodes: new Set() };
        peerMap.set(key, entry);
      }
      entry.count += 1;
      if (rawName.length > entry.displayName.length) entry.displayName = rawName;
      if (!entry.matchedKeywords.has(keyword)) entry.matchedKeywords.add(keyword);
      if (city && (row.grantee_city || '').toUpperCase().includes(city.toUpperCase())) entry.cityMatch = true;
      // Collect purpose text and NTEE codes for concept-based exclusion
      if (row.purpose_text && entry.purposeTexts.length < 10) entry.purposeTexts.push(row.purpose_text);
      if (row.ntee_code) entry.nteeCodes.add(row.ntee_code);
    }
  }

  // Score
  const scoredPeers = [...peerMap.entries()].map(([name, data]) => {
    const kwScore = data.matchedKeywords.size * 10;
    const cityBonus = data.cityMatch ? 10 : 0;
    const grantBonus = Math.min(data.count, 20);
    const isGeneralist = SUGGEST_GENERALIST_PATTERNS.some((p) => p.test(name));
    const score = isGeneralist ? -1 : kwScore + cityBonus + grantBonus;
    return { name: data.displayName, normKey: name, score, kwCount: data.matchedKeywords.size, count: data.count };
  });
  scoredPeers.sort((a, b) => b.score - a.score || b.count - a.count);

  // Build exclusion tokens from excluded keywords for filtering peer suggestions
  // Use expanded concept synonyms so "food insecurity" also catches "Feeding America", etc.
  const baseExclusionTokens = excludedKeywords.length
    ? tokenize(excludedKeywords.join(' '))
    : new Set<string>();
  const exclusionTokensForPeers = baseExclusionTokens.size > 0
    ? expandExclusionTokens(baseExclusionTokens)
    : new Set<string>();
  const excludedNteePrefixes = baseExclusionTokens.size > 0
    ? getExcludedNteePrefixes(baseExclusionTokens)
    : new Set<string>();

  // Deduplicate and format
  const seen = new Set<string>();
  const peers: string[] = [];
  for (const row of scoredPeers) {
    if (peers.length >= 8) break;
    if (row.kwCount < 1 || row.score < 0) continue;

    // Skip peer nonprofits matching excluded concepts via name, purpose text, or NTEE code
    if (exclusionTokensForPeers.size > 0) {
      const peerData = peerMap.get(row.normKey);

      // Check 1: Name contains any expanded exclusion token
      const peerNameTokens = tokenize(row.name);
      let nameHit = false;
      for (const pt of peerNameTokens) {
        if (exclusionTokensForPeers.has(pt)) { nameHit = true; break; }
      }
      if (nameHit) continue;

      // Check 2: NTEE code matches excluded concept area
      if (peerData && excludedNteePrefixes.size > 0) {
        let nteeMatch = false;
        for (const code of peerData.nteeCodes) {
          if (code && excludedNteePrefixes.has(code.charAt(0).toUpperCase())) {
            nteeMatch = true;
            break;
          }
        }
        if (nteeMatch) continue;
      }

      // Check 3: Purpose text of associated grants contains multiple exclusion tokens
      if (peerData && peerData.purposeTexts.length > 0) {
        const combinedPurpose = peerData.purposeTexts.slice(0, 5).join(' ');
        const purposeTokens = tokenize(combinedPurpose);
        let purposeHits = 0;
        for (const pt of purposeTokens) {
          if (exclusionTokensForPeers.has(pt)) purposeHits++;
        }
        if (purposeHits >= 2) continue; // multiple concept matches in grant purposes → skip
      }
    }
    const normKey = row.normKey.replace(/[^A-Z0-9\s]/g, '').trim();
    if (!normKey || normKey.length < 3) continue;
    let isDupe = false;
    for (const s of seen) { if (s.includes(normKey) || normKey.includes(s)) { isDupe = true; break; } }
    if (isDupe) continue;
    seen.add(normKey);
    const displayName = row.name.split(/\s+/).map((w: string) => {
      if (w.length <= 3 && w === w.toUpperCase()) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
    peers.push(displayName);
  }
  return peers;
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
    const keywords = normalizeKeywords(body?.keywords); // exclusion keywords
    let peerNonprofits = normalizePeerNonprofits(body?.peerNonprofits);
    const debugMode = !!body?.debug;
    const budgetBand = normalizeBudgetBand(body?.budgetBand);
    const forceRefresh = !!body?.forceRefresh;

    // Auto-suggest peers when none provided but mission is given
    let suggestedPeers: string[] = [];
    if (!peerNonprofits.length && mission) {
      suggestedPeers = await suggestPeersInternal(mission, locationServed, keywords);
      peerNonprofits = suggestedPeers;
    }
    const isPeerSearch = peerNonprofits.length > 0;

    if (!mission && !isPeerSearch) {
      return new Response(JSON.stringify({ error: 'mission is required' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    if (isPeerSearch) {
      const userLocation = parseUserLocation(locationServed);

      // ── Excluded-keyword filtering for peer nonprofits ──────────────────
      // If the user specified exclusion keywords, remove peer nonprofits whose
      // name significantly overlaps with those terms BEFORE resolving them.
      // Uses expanded concept synonyms so "food insecurity" also catches
      // "Feeding America", "Greater Chicago Food Depository", etc.
      const baseExclusionTokens = keywords.length ? tokenize(keywords.join(' ')) : new Set<string>();
      const exclusionTokens = baseExclusionTokens.size > 0
        ? expandExclusionTokens(baseExclusionTokens)
        : new Set<string>();
      const excludedNtee = baseExclusionTokens.size > 0
        ? getExcludedNteePrefixes(baseExclusionTokens)
        : new Set<string>();
      if (exclusionTokens.size > 0) {
        peerNonprofits = peerNonprofits.filter((peerName) => {
          const peerTokens = tokenize(peerName);
          // With expanded synonym set, check if any peer name token matches any exclusion token
          for (const pt of peerTokens) {
            if (exclusionTokens.has(pt)) return false; // peer name contains excluded concept → remove
          }
          return true;
        });
      }

      if (!peerNonprofits.length) {
        return new Response(JSON.stringify({
          results: [],
          cached: false,
          ...(suggestedPeers.length ? { peers: suggestedPeers } : {}),
        }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      // ────────────────────────────────────────────────────────────────────

      // Peer lookup should return all foundations that funded the peer nonprofits,
      // independent of mission-search location constraints.
      const peerMatchLocation: UserLocation = {
        city: null,
        state: null,
        region: null,
        isNationalUS: false,
        isGlobal: false,
        hasLocationInput: false,
      };
      const peerProfiles = await resolvePeerProfiles(peerNonprofits, userLocation);

      if (!peerProfiles.length) {
        return new Response(JSON.stringify({ results: [], cached: false }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      const peerDebug: Record<string, unknown> = {};
      const { grants: matchedGrantsAll, stats: peerDbStats } = await fetchPeerGrantsFromDatabase(
        peerProfiles,
        userLocation,
      );
      peerDebug.db_query_stats = peerDbStats;

      const grantsByFoundation = new Map<string, Array<GrantRow & { matchedPeers: string[] }>>();
      const peerSetByFoundation = new Map<string, Set<string>>();

      // Helper: check if a grant matches excluded concepts via grantee name, purpose, or NTEE
      const granteeMatchesExclusion = exclusionTokens.size > 0
        ? (granteeName: string, purposeText?: string | null, nteeCode?: string | null) => {
            // Check 1: Grantee name contains any expanded exclusion token
            if (granteeName) {
              const granteeTokens = tokenize(granteeName);
              for (const gt of granteeTokens) {
                if (exclusionTokens.has(gt)) return true;
              }
            }
            // Check 2: NTEE code matches excluded concept area
            if (nteeCode && excludedNtee.size > 0) {
              if (excludedNtee.has(nteeCode.charAt(0).toUpperCase())) return true;
            }
            // Check 3: Purpose text contains significant overlap with exclusion concepts
            if (purposeText) {
              const purposeTokens = tokenize(purposeText);
              let hits = 0;
              for (const pt of purposeTokens) {
                if (exclusionTokens.has(pt)) hits++;
              }
              // For purpose text (longer text), require at least 2 matching tokens
              // to avoid false positives from incidental word overlap
              if (hits >= 2) return true;
            }
            return false;
          }
        : () => false;

      for (const grant of matchedGrantsAll) {
        if (isLikelyIndividualGrantee(grant)) continue;

        // Skip grants to nonprofits matching excluded concepts (name, purpose, NTEE)
        if (granteeMatchesExclusion(grant.grantee_name || '', grant.purpose_text, grant.ntee_code)) continue;

        const matchedPeerNames = matchedPeerNamesForGrant(grant, peerProfiles, peerMatchLocation);

        if (!matchedPeerNames.length) continue;

        const rows = grantsByFoundation.get(grant.foundation_id) || [];
        rows.push({ ...grant, matchedPeers: uniqueStrings(matchedPeerNames) });
        grantsByFoundation.set(grant.foundation_id, rows);

        const peerSet = peerSetByFoundation.get(grant.foundation_id) || new Set<string>();
        for (const peerName of matchedPeerNames) peerSet.add(peerName);
        peerSetByFoundation.set(grant.foundation_id, peerSet);
      }

      let foundationIds = [...grantsByFoundation.keys()];
      let locationCandidates: FunderRow[] = [];
      const syntheticFundersById = new Map<string, FunderRow>();
      const liveMatchedFoundationIds = new Set<string>();
      const baseSelect =
        'id,name,type,foundation_ein,description,focus_areas,ntee_code,city,state,' +
        'website,contact_url,programs_url,apply_url,discovered_apply_url,news_url,total_giving,asset_amount,' +
        'grant_range_min,grant_range_max,contact_name,contact_title,contact_email,next_step';
      let queryCheckRan = false;

      if (foundationIds.length < PEER_LIVE_QUERY_MIN_RESULTS) {
        queryCheckRan = true;
        const deadlineMs = Date.now() + PEER_LIVE_QUERY_TIMEOUT_MS;

        // Early termination: skip full text search if DB already found >= 8 unique foundations
        const skipFullText = foundationIds.length >= 8;
        const fullTextMatches = skipFullText
          ? []
          : await fetchPeerMatchesViaFullTextSearch(
              peerProfiles,
              peerMatchLocation,
              deadlineMs,
            );
        peerDebug.full_text_match_sets = fullTextMatches.length;

        if (fullTextMatches.length) {
          const matchedEins = uniqueStrings(fullTextMatches.map((match) => match.foundationEin));
          const dbFundersByEin = new Map<string, FunderRow[]>();

          if (matchedEins.length) {
            try {
              const fundersByEinRes = await sbFetch(
                `funders?select=${baseSelect}` +
                `&foundation_ein=in.${buildInFilter(matchedEins)}` +
                `&limit=50000`,
              );
              const rows = await fundersByEinRes.json() as FunderRow[];
              for (const row of rows) {
                const ein = normalizedEin(row.foundation_ein);
                if (!ein) continue;
                const group = dbFundersByEin.get(ein) || [];
                group.push(row);
                dbFundersByEin.set(ein, group);
              }
              peerDebug.full_text_db_funder_rows = rows.length;
            } catch {
              // Continue with synthetic records when funders lookup fails.
              peerDebug.full_text_db_lookup_error = true;
            }
          }

          for (const match of fullTextMatches) {
            const candidates = dbFundersByEin.get(match.foundationEin) || [];
            const preferred = candidates.find((row) => row.type === 'foundation');
            let funder = preferred || candidates[0];

            if (!funder) {
              const syntheticId = `pp:${match.foundationEin}`;
              funder = syntheticFundersById.get(syntheticId);
              if (!funder) {
                funder = {
                  id: syntheticId,
                  name: (match.foundationName || `Foundation EIN ${match.foundationEin}`).trim(),
                  type: 'foundation',
                  foundation_ein: match.foundationEin,
                  description: null,
                  focus_areas: [],
                  ntee_code: null,
                  city: match.foundationCity || null,
                  state: normalizeState(match.foundationState) || match.foundationState || null,
                  website: null,
                  contact_url: null,
                  programs_url: null,
                  apply_url: null,
                  news_url: null,
                  total_giving: null,
                  asset_amount: null,
                  grant_range_min: null,
                  grant_range_max: null,
                  contact_name: null,
                  contact_title: null,
                  contact_email: null,
                  next_step: null,
                };
                syntheticFundersById.set(syntheticId, funder);
              }
            }

            const foundationId = funder.id;
            foundationIds.push(foundationId);
            liveMatchedFoundationIds.add(foundationId);

            for (const grant of match.grants) {
              if (granteeMatchesExclusion(grant.grantee_name || '', grant.purpose_text, grant.ntee_code)) continue;
              const matchedPeerNames = matchedPeerNamesForGrant(grant, peerProfiles, peerMatchLocation);
              if (!matchedPeerNames.length) continue;

              const rows = grantsByFoundation.get(foundationId) || [];
              rows.push({
                ...grant,
                foundation_id: foundationId,
                matchedPeers: uniqueStrings(matchedPeerNames),
              });
              grantsByFoundation.set(foundationId, rows);

              const peerSet = peerSetByFoundation.get(foundationId) || new Set<string>();
              for (const peerName of matchedPeerNames) peerSet.add(peerName);
              peerSetByFoundation.set(foundationId, peerSet);
            }
          }
        }
        peerDebug.synthetic_funder_count = syntheticFundersById.size;

        if (foundationIds.length < PEER_LIVE_QUERY_MIN_RESULTS && userLocation.hasLocationInput) {
          const suffix = (() => {
            if (userLocation.city && userLocation.state) {
              return `&state=eq.${encodeURIComponent(userLocation.state)}` +
                `&city=ilike.*${encodeURIComponent(ilikeSafeToken(userLocation.city))}*`;
            }
            if (userLocation.state) {
              return `&state=eq.${encodeURIComponent(userLocation.state)}`;
            }
            return '';
          })();

          const [nameSortedRes, givingSortedRes] = await Promise.all([
            sbFetch(
              `funders?select=${baseSelect}&type=eq.foundation${suffix}` +
              `&order=name.asc&limit=240`,
            ),
            sbFetch(
              `funders?select=${baseSelect}&type=eq.foundation${suffix}` +
              `&order=total_giving.desc.nullslast&limit=120`,
            ),
          ]);

          const nameSorted = await nameSortedRes.json() as FunderRow[];
          const givingSorted = await givingSortedRes.json() as FunderRow[];
          peerDebug.location_candidate_pool = {
            name_sorted: nameSorted.length,
            giving_sorted: givingSorted.length,
          };

          const sampleAcross = (rows: FunderRow[], max: number): FunderRow[] => {
            if (rows.length <= max) return rows;
            const sampled: FunderRow[] = [];
            for (let i = 0; i < max; i += 1) {
              const idx = Math.floor((i * rows.length) / max);
              sampled.push(rows[idx]);
            }
            return sampled;
          };

          const candidateFunders = uniqueStrings([
            ...givingSorted.slice(0, 18).map((f) => f.id),
            ...sampleAcross(nameSorted, 24).map((f) => f.id),
          ]).map((id) => givingSorted.find((f) => f.id === id) || nameSorted.find((f) => f.id === id))
            .filter((funder): funder is FunderRow => !!funder);

          locationCandidates = uniqueStrings(candidateFunders.map((f) => f.id))
            .map((id) => candidateFunders.find((f) => f.id === id))
            .filter((funder): funder is FunderRow => !!funder);
          peerDebug.location_candidates = locationCandidates.length;

          // --- PARALLEL live foundation queries (concurrency limit 6) ---
          const seenCandidateIds = new Set(foundationIds);
          const eligibleFunders = locationCandidates
            .filter((funder) => !seenCandidateIds.has(funder.id))
            .filter((funder) => !!normalizedEin(funder.foundation_ein || funder.id))
            .slice(0, PEER_LIVE_QUERY_MAX_FOUNDATIONS);

          const LIVE_CONCURRENCY = 6;
          for (let i = 0; i < eligibleFunders.length; i += LIVE_CONCURRENCY) {
            if (Date.now() > deadlineMs) break;
            const chunk = eligibleFunders.slice(i, i + LIVE_CONCURRENCY);
            const chunkResults = await Promise.all(
              chunk.map((funder) =>
                fetchLivePeerGrantsForFoundation(funder, peerProfiles, peerMatchLocation, deadlineMs)
                  .then((matches) => ({ funder, matches }))
              ),
            );

            for (const { funder, matches: liveMatches } of chunkResults) {
              if (!liveMatches.length) continue;

              seenCandidateIds.add(funder.id);
              liveMatchedFoundationIds.add(funder.id);
              foundationIds.push(funder.id);

              for (const grant of liveMatches) {
                if (granteeMatchesExclusion(grant.grantee_name || '', grant.purpose_text, grant.ntee_code)) continue;
                const matchedPeerNames = matchedPeerNamesForGrant(grant, peerProfiles, peerMatchLocation);
                if (!matchedPeerNames.length) continue;
                const rows = grantsByFoundation.get(funder.id) || [];
                rows.push({ ...grant, matchedPeers: uniqueStrings(matchedPeerNames) });
                grantsByFoundation.set(funder.id, rows);

                const peerSet = peerSetByFoundation.get(funder.id) || new Set<string>();
                for (const peerName of matchedPeerNames) peerSet.add(peerName);
                peerSetByFoundation.set(funder.id, peerSet);
              }
            }
          }
        }
      }

      foundationIds = uniqueStrings(foundationIds);
      peerDebug.foundation_ids_after_query_check = foundationIds.length;
      if (!foundationIds.length) {
        return new Response(JSON.stringify({
          results: [],
          cached: false,
          query_check_run: queryCheckRan,
          ...(suggestedPeers.length ? { peers: suggestedPeers } : {}),
          ...(debugMode ? { debug: peerDebug } : {}),
        }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      const inFilter = buildInFilter(foundationIds);
      const [fundersRes, filingsRes] = await Promise.all([
        sbFetch(
          `funders?select=id,name,type,foundation_ein,description,focus_areas,ntee_code,city,state,` +
          `website,contact_url,programs_url,apply_url,discovered_apply_url,news_url,total_giving,asset_amount,` +
          `grant_range_min,grant_range_max,contact_name,contact_title,contact_email,next_step` +
          `&id=in.${inFilter}` +
          `&limit=50000`,
        ),
        sbFetch(
          `foundation_filings?select=foundation_id` +
          `&foundation_id=in.${inFilter}` +
          `&parse_status=eq.parsed` +
          `&limit=50000`,
        ),
      ]);

      const funders = await fundersRes.json() as FunderRow[];
      const filings = await filingsRes.json() as FilingRow[];
      const parsedFoundationIds = new Set(filings.map((row) => row.foundation_id));
      const funderById = new Map<string, FunderRow>();
      for (const funder of funders) funderById.set(funder.id, funder);
      for (const candidate of locationCandidates) {
        if (!funderById.has(candidate.id)) funderById.set(candidate.id, candidate);
      }
      for (const synthetic of syntheticFundersById.values()) {
        if (!funderById.has(synthetic.id)) funderById.set(synthetic.id, synthetic);
      }

      // ── Real-time grant page discovery ─────────────────────────────────────
      // For funders with a website but no apply_url or discovered_apply_url,
      // scan their homepage for grant application links (3s timeout per site).
      const fundersNeedingDiscovery = [...funderById.values()]
        .filter((f) => f.website && !f.apply_url && !f.discovered_apply_url)
        .map((f) => ({ id: f.id, website: f.website! }));
      const discoveredUrls = await discoverGrantUrlsInBatch(fundersNeedingDiscovery);
      // Merge discovered URLs into funder objects so deriveNextStep() picks them up
      for (const [id, url] of discoveredUrls) {
        const f = funderById.get(id);
        if (f) f.discovered_apply_url = url;
      }
      // ────────────────────────────────────────────────────────────────────────

      const results = foundationIds
        .map((foundationId) => funderById.get(foundationId))
        .filter((funder): funder is FunderRow => !!funder)
        .filter((funder) => parsedFoundationIds.has(funder.id) || liveMatchedFoundationIds.has(funder.id))
        .map((funder) => {
          const grants = grantsByFoundation.get(funder.id) || [];
          const peerCoverageCount = (peerSetByFoundation.get(funder.id) || new Set()).size;
          const coverage = clamp01(peerCoverageCount / Math.max(peerProfiles.length, 1));
          const grantCountSignal = clamp01(grants.length / 8);
          const fitScore = clamp01(coverage * 0.75 + grantCountSignal * 0.25);

          const granteeBestGrant = new Map<string, GrantRow & { matchedPeers: string[] }>();
          for (const grant of grants) {
            const key = `${normalizedEin(grant.grantee_ein) || ''}|${normalizeNameForMatch(grant.grantee_name)}`;
            const existing = granteeBestGrant.get(key);
            if (!existing) {
              granteeBestGrant.set(key, grant);
              continue;
            }
            const existingYear = existing.grant_year || 0;
            const currentYear = grant.grant_year || 0;
            const existingAmount = existing.grant_amount || 0;
            const currentAmount = grant.grant_amount || 0;
            if (
              currentYear > existingYear
              || (currentYear === existingYear && currentAmount > existingAmount)
            ) {
              granteeBestGrant.set(key, grant);
            }
          }

          const liveGrantCount = grants.filter((grant) => grant.id.startsWith('live:')).length;

          const topGrantees = [...granteeBestGrant.values()]
            .sort((a, b) => {
              if ((b.grant_year || 0) !== (a.grant_year || 0)) return (b.grant_year || 0) - (a.grant_year || 0);
              return (b.grant_amount || 0) - (a.grant_amount || 0);
            })
            .slice(0, 3)
            .map((grant) => ({
              name: grant.grantee_name,
              year: grant.grant_year || null,
              amount: grant.grant_amount,
              match_reasons: [
                grant.matchedPeers.length > 1 ? 'Matches multiple peer nonprofits' : 'Direct peer nonprofit match',
                grant.id.startsWith('live:')
                  ? 'Verified via live 990 query check'
                  : (grant.mission_signal_text || grant.ntee_code
                    ? 'Mission/category evidence available'
                    : 'Matched from 990 grantee history'),
              ],
            }));

          const next = deriveNextStep(funder);
          const nextStepUrl = resolveNextStepUrl(next.type, funder);
          const fitExplanationBase = `Matched ${grants.length} grant${grants.length === 1 ? '' : 's'} in the last 5 years across ${peerCoverageCount} of ${peerProfiles.length} peer nonprofit${peerProfiles.length === 1 ? '' : 's'}.`;
          const fitExplanation = liveGrantCount > 0
            ? `${fitExplanationBase} Includes live 990 query-check results.`
            : fitExplanationBase;

          return {
            ...funder,
            score: Number(fitScore.toFixed(4)),
            fit_score: Number(fitScore.toFixed(4)),
            reason: fitExplanation,
            fit_explanation: fitExplanation,
            limited_grant_history_data: false,
            similar_past_grantees: topGrantees,
            next_step: next.text,
            next_step_type: next.type,
            next_step_url: nextStepUrl,
            peer_match_count: grants.length,
            peer_coverage_count: peerCoverageCount,
            live_990_query_count: liveGrantCount,
          };
        })
        .filter((row) => (row.similar_past_grantees?.length || 0) > 0)
        .sort((a, b) => {
          const scoreDiff = (b.fit_score || 0) - (a.fit_score || 0);
          if (scoreDiff !== 0) return scoreDiff;
          const coverageDiff = (b.peer_coverage_count || 0) - (a.peer_coverage_count || 0);
          if (coverageDiff !== 0) return coverageDiff;
          return (b.peer_match_count || 0) - (a.peer_match_count || 0);
        });

      // Fire-and-forget: cache any newly discovered grant page URLs
      cacheDiscoveredUrls(discoveredUrls, SUPABASE_URL, SUPABASE_KEY);

      return new Response(JSON.stringify({
        results,
        cached: false,
        query_check_run: queryCheckRan,
        ...(suggestedPeers.length ? { peers: suggestedPeers } : {}),
        ...(debugMode ? { debug: peerDebug } : {}),
      }), {
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
      `funders?select=id,name,type,foundation_ein,description,focus_areas,ntee_code,city,state,` +
      `website,contact_url,programs_url,apply_url,discovered_apply_url,news_url,total_giving,asset_amount,` +
      `grant_range_min,grant_range_max,contact_name,contact_title,contact_email,next_step` +
      `&type=neq.daf` +
      `&order=total_giving.desc.nullslast&limit=${FOUNDATION_SCAN_LIMIT}`,
    );

    const funders = await fundersRes.json() as FunderRow[];

    if (!funders.length) {
      return new Response(JSON.stringify({ results: [], cached: false }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const userTokens = tokenize(mission);
    const exclusionTokens = tokenize(keywords.join(' '));
    const userLocation = parseUserLocation(locationServed);
    const userBudgetBandNumeric = toNumericBudgetBand(budgetBand);
    const userMaxGrantAmount = maxSingleGrantForBudgetBand(budgetBand);
    const userMissionEmbedding = await fetchMissionEmbedding(mission);

    const prelim = funders.map((funder) => {
      const funderTokens = funderCorpusTokens(funder);
      const missionScore = baselineMissionScore(userTokens, funderTokens);
      const locationScore = funderLocationBaseline(userLocation, funder.state);
      const exclusionOverlap = exclusionTokens.size ? lexicalSimilarity(exclusionTokens, funderTokens) : 0;
      const exclusionPenalty = exclusionOverlap * SCORING_WEIGHTS.excludeBaselinePenalty;
      const baseline = clamp01(
        missionScore * SCORING_WEIGHTS.baselineMission
        + locationScore * SCORING_WEIGHTS.baselineLocation
        - exclusionPenalty,
      );
      return {
        funder,
        baseline,
        exclusionOverlap,
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
    const foundationsWithParsedFilings = new Set<string>();

    if (candidateIds.length) {
      const selectColumns = userMissionEmbedding
        ? 'id,foundation_id,grant_year,grant_amount,grantee_name,grantee_ein,grantee_city,grantee_state,grantee_country,purpose_text,ntee_code,mission_signal_text,grantee_budget_band,mission_embedding'
        : 'id,foundation_id,grant_year,grant_amount,grantee_name,grantee_ein,grantee_city,grantee_state,grantee_country,purpose_text,ntee_code,mission_signal_text,grantee_budget_band';

      const inFilter = buildInFilter(candidateIds);

      const [grantsRes, featuresRes, filingsRes] = await Promise.all([
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
        sbFetch(
          `foundation_filings?select=foundation_id` +
          `&foundation_id=in.${inFilter}` +
          `&parse_status=eq.parsed` +
          `&limit=50000`,
        ),
      ]);

      const grants = await grantsRes.json() as GrantRow[];
      const features = await featuresRes.json() as HistoryFeatureRow[];
      const filings = await filingsRes.json() as FilingRow[];

      for (const row of grants) {
        const arr = grantsByFoundation.get(row.foundation_id) || [];
        arr.push(row);
        grantsByFoundation.set(row.foundation_id, arr);
      }

      for (const feature of features) {
        featuresByFoundation.set(feature.foundation_id, feature);
      }

      for (const filing of filings) {
        foundationsWithParsedFilings.add(filing.foundation_id);
      }

      const foundationsNeedingFallbackHistory = candidateIds.filter((foundationId) => {
        const recentCount = (grantsByFoundation.get(foundationId) || [])
          .filter((grant) =>
            isEligibleOrganizationGrant(grant)
            && grantMatchesCityRequirement(userLocation, grant.grantee_city, grant.grantee_state)
            && grantPassesUserCap(grant, userMaxGrantAmount),
          )
          .length;
        return recentCount < 3;
      });

      if (foundationsNeedingFallbackHistory.length) {
        const fallbackInFilter = buildInFilter(foundationsNeedingFallbackHistory);
        const fallbackRes = await sbFetch(
          `foundation_grants?select=${selectColumns}` +
          `&foundation_id=in.${fallbackInFilter}` +
          `&grant_year=lt.${MIN_GRANT_YEAR}` +
          `&order=grant_year.desc,grant_amount.desc` +
          `&limit=50000`,
        );
        const fallbackGrants = await fallbackRes.json() as GrantRow[];
        for (const row of fallbackGrants) {
          const arr = grantsByFoundation.get(row.foundation_id) || [];
          if (!arr.some((existing) => existing.id === row.id)) {
            arr.push(row);
          }
          grantsByFoundation.set(row.foundation_id, arr);
        }
      }
    }

    // ── Real-time grant page discovery (mission-based path) ──────────────
    const missionFundersNeedingDiscovery = candidateFunders
      .filter(({ funder: f }) => f.website && !f.apply_url && !f.discovered_apply_url)
      .map(({ funder: f }) => ({ id: f.id, website: f.website! }));
    const missionDiscoveredUrls = await discoverGrantUrlsInBatch(missionFundersNeedingDiscovery);
    for (const [id, url] of missionDiscoveredUrls) {
      const entry = candidateFunders.find((c) => c.funder.id === id);
      if (entry) entry.funder.discovered_apply_url = url;
    }
    // ──────────────────────────────────────────────────────────────────────

    const results = candidateFunders
      .map(({ funder, baseline, exclusionOverlap: baselineExclusionOverlap }) => {
        const grants = grantsByFoundation.get(funder.id) || [];
        const feature = featuresByFoundation.get(funder.id);

        const eligibleGrants = grants.filter((grant) =>
          isEligibleOrganizationGrant(grant)
          && grantMatchesCityRequirement(userLocation, grant.grantee_city, grant.grantee_state),
        );

        const scoredGrantsAll: ScoredGrant[] = eligibleGrants.map((grant) => {
          const textSignal = missionSignalText(grant);
          const textTokens = tokenize(textSignal);
          const lexical = lexicalSimilarity(userTokens, textTokens);
          const exclusionOverlap = exclusionTokens.size ? lexicalSimilarity(exclusionTokens, textTokens) : 0;

          const grantEmbedding = parseVector(grant.mission_embedding);
          const embeddingSimilarity = userMissionEmbedding && grantEmbedding
            ? cosineSimilarity(userMissionEmbedding, grantEmbedding)
            : null;

          const missionScore = embeddingSimilarity ?? (lexical > 0 ? lexical : 0.12);
          const locScore = locationSimilarity(userLocation, grant.grantee_city, grant.grantee_state, grant.grantee_country);
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
            ) * recencyMultiplier
            - exclusionOverlap * SCORING_WEIGHTS.excludeGrantPenalty,
          );

          return {
            grant,
            score,
            missionScore,
            locationScore: locScore,
            sizeScore,
            exclusionOverlap,
          };
        }).sort((a, b) => b.score - a.score);

        const capQualifiedScoredGrants = userMaxGrantAmount
          ? scoredGrantsAll.filter((row) => grantPassesUserCap(row.grant, userMaxGrantAmount))
          : scoredGrantsAll;
        const scoredGrantsForScoring = capQualifiedScoredGrants.length
          ? capQualifiedScoredGrants
          : scoredGrantsAll;
        const topGrantsForDisplay = userMaxGrantAmount
          ? capQualifiedScoredGrants.slice(0, 3)
          : scoredGrantsForScoring.slice(0, 3);
        const topForAverage = scoredGrantsForScoring.slice(0, SCORING_WEIGHTS.topGrantAverageN);
        const historyScore = topForAverage.length
          ? topForAverage.reduce((sum, row) => sum + row.score, 0) / topForAverage.length
          : 0;

        const grantsWithBand = scoredGrantsForScoring.filter((g) => Number.isInteger(g.grant.grantee_budget_band));
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

        if (userMaxGrantAmount) {
          const capQualifiedRatio = scoredGrantsAll.length
            ? capQualifiedScoredGrants.length / scoredGrantsAll.length
            : 0;
          if (capQualifiedScoredGrants.length === 0) {
            sizePenalty += SCORING_WEIGHTS.noBudgetFitPenalty;
          } else if (capQualifiedRatio < 0.2) {
            sizePenalty += SCORING_WEIGHTS.lowBudgetFitPenalty;
          }
        }

        const exclusionHistoryOverlap = topForAverage.length
          ? topForAverage.reduce((sum, row) => sum + row.exclusionOverlap, 0) / topForAverage.length
          : baselineExclusionOverlap;
        sizePenalty += exclusionHistoryOverlap * SCORING_WEIGHTS.excludeHistoryPenalty;

        const dataCompleteness = typeof feature?.data_completeness_score === 'number'
          ? clamp01(feature.data_completeness_score)
          : clamp01(Math.min(scoredGrantsForScoring.length / 8, 1) * 0.8);

        const historyCoverage = clamp01(scoredGrantsForScoring.length / 12);
        const historyWeightRaw =
          SCORING_WEIGHTS.historyWeightMin
          + historyCoverage * SCORING_WEIGHTS.historyCoverageBoost;

        const hasMinimumGrantHistory = topGrantsForDisplay.length >= SCORING_WEIGHTS.limitedDataMinGrants;
        const limitedGrantHistoryData =
          !hasMinimumGrantHistory
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

        if (!scoredGrantsForScoring.length) {
          fitScore = clamp01(baseline * SCORING_WEIGHTS.fallbackBaselineMultiplier);
        }

        const similaritySummary = topGrantsForDisplay.map((row) => ({
          name: row.grant.grantee_name,
          year: row.grant.grant_year || null,
          amount: row.grant.grant_amount,
          match_reasons: grantMatchReasons(row, userLocation, userBudgetBandNumeric, userMaxGrantAmount),
        }));

        const factorLines: string[] = [];

        if (userMaxGrantAmount && topGrantsForDisplay.length >= 3) {
          factorLines.push(`Includes similar grants at or below ${formatUsd(userMaxGrantAmount)} (<=10% of your budget).`);
        } else if (userMaxGrantAmount && capQualifiedScoredGrants.length === 0) {
          factorLines.push(`No similar grants at or below ${formatUsd(userMaxGrantAmount)} (<=10% budget target); this funder was downweighted.`);
        }

        if (keywords.length && exclusionHistoryOverlap >= 0.2) {
          factorLines.push(`Downweighted for overlap with excluded terms: ${keywords.slice(0, 3).join(', ')}.`);
        }

        if (historyScore >= 0.72 && topGrantsForDisplay.length > 0) {
          factorLines.push(`Strong overlap with recent grantees like ${topGrantsForDisplay[0].grant.grantee_name}.`);
        } else if (historyScore >= 0.56 && topGrantsForDisplay.length > 0) {
          factorLines.push('Moderate overlap with prior grantees in the last 5 years.');
        }

        if (userBudgetBandNumeric && sizePenalty <= 0.05 && grantsWithBand.length > 0) {
          factorLines.push('Historical grantee sizes align with your selected budget band.');
        } else if (userBudgetBandNumeric && sizePenalty >= 0.14) {
          factorLines.push('Past grantees skew larger than your selected budget band.');
        }

        const bestLocationScore = topGrantsForDisplay.length
          ? Math.max(...topGrantsForDisplay.map((g) => g.locationScore))
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
      .filter((row) => {
        // Foundations with rich grant history data: require at least 1 similar grantee
        if (foundationsWithParsedFilings.has(row.id)) {
          return (row.similar_past_grantees?.length || 0) >= 1;
        }
        // Foundations without parsed filings: allow if fit_score is strong enough
        // (relies on baseline mission + location alignment)
        return (row.fit_score || 0) >= 0.25;
      })
      .sort((a, b) => {
        if ((b.fit_score || 0) !== (a.fit_score || 0)) {
          return (b.fit_score || 0) - (a.fit_score || 0);
        }
        return (b.total_giving || 0) - (a.total_giving || 0);
      })
      .filter((row) => (row.fit_score || 0) >= MIN_RESULT_FIT_SCORE);

    await sbFetch('search_cache?on_conflict=mission_hash', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        mission_hash: cacheKey,
        mission_text: mission,
        results,
        created_at: new Date().toISOString(),
      }),
    });

    // Fire-and-forget: cache any newly discovered grant page URLs
    cacheDiscoveredUrls(missionDiscoveredUrls, SUPABASE_URL, SUPABASE_KEY);

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
