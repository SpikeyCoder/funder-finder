export type FunderStatus = 'researching' | 'applied' | 'awarded' | 'passed';
export type BudgetBand = 'under_250k' | '250k_1m' | '1m_5m' | 'over_5m' | 'prefer_not_to_say';

export interface SavedFunderEntry {
  funder: Funder;
  status: FunderStatus;
  notes: string;
  savedAt: string;
}

export interface SimilarPastGrantee {
  name: string;
  year: number | null;
  amount: number | null;
  match_reasons: string[];
}

// Matches the Supabase `funders` table schema (snake_case from DB)
export interface Funder {
  id: string;
  name: string;
  type: string; // 'foundation' | 'corporate' | 'daf'
  foundation_ein?: string | null;
  description: string | null;
  focus_areas: string[];
  ntee_code: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  total_giving: number | null;
  asset_amount: number | null;
  grant_range_min: number | null;
  grant_range_max: number | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  next_step: string | null;
  // Added by the Edge Function (Claude ranking)
  score?: number;
  reason?: string;
  next_step_url?: string;
  next_step_type?: string;
  fit_score?: number;
  fit_explanation?: string;
  limited_grant_history_data?: boolean;
  similar_past_grantees?: SimilarPastGrantee[];
  // Subpage URLs (populated by enrich-subpages.js)
  contact_url?: string | null;
  programs_url?: string | null;
  apply_url?: string | null;
  news_url?: string | null;
}

// ── Grant Writer types ────────────────────────────────────────────────────

export type GenerationPhase =
  | 'idle'
  | 'uploading'
  | 'analyzing'
  | 'researching'
  | 'generating'
  | 'done';

export interface UploadedGrantFile {
  name: string;
  path: string;      // Supabase Storage path
  size: number;
  type: string;       // MIME type
}

export interface OrgDetails {
  orgName: string;
  orgDesc: string;
  budget: string;
  targetPop: string;
  geoFocus: string;
  programName: string;
  programDesc: string;
  programBudget: string;
  outcomes: string;
  timeline: string;
}

// ── 990 Intelligence types ──────────────────────────────────────────────────

export interface YearTrend {
  year: number;
  grantCount: number;
  totalAmount: number;
  avgGrant: number;
}

export interface GranteeAnalysis {
  totalGrantees5y: number;
  newGrantees: number;
  repeatGrantees: number;
  pctRepeat: number;
}

export interface GeoEntry {
  state: string;
  grantCount: number;
  totalAmount: number;
  pctOfGrants: number;
}

export interface KeyRecipient {
  granteeEin: string | null;
  granteeName: string;
  grantCount: number;
  totalAmount: number;
  lastYear: number;
}

export interface GrantPurpose {
  purpose: string;
  granteeName: string;
  amount: number | null;
  year: number;
}

export interface FunderInsights {
  funderId: string;
  grantHistory: {
    totalGrants: number;
    totalAmount: number;
    yearTrend: YearTrend[];
  };
  granteeAnalysis: GranteeAnalysis;
  geographicFootprint: GeoEntry[];
  keyRecipients: KeyRecipient[];
  recentGrantPurposes: GrantPurpose[];
  dataQuality: {
    completenessScore: number;
    totalRecords: number;
  };
}

// ── Organization Search & Recipient Profile types ───────────────────────────

export interface OrgSearchResult {
  id: string;
  ein: string | null;
  name: string;
  state: string | null;
  entity_type: 'funder' | 'recipient';
  grant_count: number;
  total_funding: number;
}

export interface RecipientFunderEntry {
  funderId: string;
  funderName: string;
  grantCount: number;
  totalAmount: number;
  lastYear: number;
}

export interface RecipientYearTrend {
  year: number;
  grantCount: number;
  totalAmount: number;
  funderCount: number;
}

export interface RecipientProfile {
  id: string;
  ein: string | null;
  name: string;
  location: { city: string | null; state: string | null };
  fundingSummary: {
    totalFunding: number;
    grantCount: number;
    funderCount: number;
    firstGrantYear: number | null;
    lastGrantYear: number | null;
  };
  yearlyTrends: RecipientYearTrend[];
  topFunders: RecipientFunderEntry[];
  ntee_codes: string[];
}

// ── Peer Intelligence types ─────────────────────────────────────────────────

export interface PeerEntry {
  id: string;
  name: string;
  score: number;
  sharedCount: number;
  state: string | null;
  totalFunding: number | null;
}
