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
  dataAsOf?: string | null;
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
  isDaf?: boolean;
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

// ── Phase 3: Pipeline & Grant Tracking types ────────────────────────────────

export interface PipelineStatus {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  color: string;
  sort_order: number;
  is_default: boolean;
  is_terminal: boolean;
  created_at: string;
}

export interface TrackedGrant {
  id: string;
  project_id: string;
  user_id: string;
  funder_ein: string | null;
  funder_name: string;
  grant_title: string | null;
  status_id: string;
  amount: number | null;
  deadline: string | null;
  grant_url: string | null;
  notes: string | null;
  source: string;
  is_external: boolean;
  awarded_amount: number | null;
  awarded_date: string | null;
  added_at: string;
  updated_at: string;
  // Joined relations
  pipeline_statuses?: {
    name: string;
    slug: string;
    color: string;
    is_terminal: boolean;
  };
  tasks?: GrantTask[];
  history?: StatusHistoryEntry[];
}

export interface StatusHistoryEntry {
  id: string;
  tracked_grant_id: string;
  from_status_id: string | null;
  to_status_id: string;
  changed_by: string;
  changed_at: string;
  from_status?: { name: string; color: string };
  to_status?: { name: string; color: string };
}

export interface GrantTask {
  id: string;
  tracked_grant_id: string;
  project_id: string;
  user_id: string;
  title: string;
  description: string | null;
  assignee_email: string | null;
  assignee_user_id: string | null;
  due_date: string | null;
  status: 'todo' | 'in_progress' | 'done';
  is_overdue: boolean;
  created_at: string;
  completed_at: string | null;
  // Joined
  tracked_grants?: { funder_name: string; grant_title: string | null; deadline: string | null };
  projects?: { name: string };
}

export interface PortfolioMetrics {
  total_tracked: number;
  active_proposals: number;
  pending_ask: number;
  win_rate: number | null;
  total_awarded: number;
  upcoming_deadlines: number;
}

export interface PortfolioGrant {
  id: string;
  project_id: string;
  project_name: string;
  funder_name: string;
  funder_ein: string | null;
  grant_title: string | null;
  status_name: string;
  status_slug: string;
  status_color: string;
  amount: number | null;
  deadline: string | null;
  source: string;
  added_at: string;
  updated_at: string;
}

export interface CalendarFeed {
  id: string;
  user_id: string;
  project_id: string | null;
  token: string;
  include_tasks: boolean;
  created_at: string;
  last_accessed: string | null;
  feed_url?: string;
  projects?: { name: string };
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  deadline_reminders: number[];
  task_reminders: number[];
  weekly_digest: boolean;
  digest_day: number;
  realtime_matches: boolean;
  email_enabled: boolean;
}

// ── Phase 4: Team Collaboration types ────────────────────────────────────────

export interface OrgMember {
  id: string;
  user_id: string;
  email?: string;
  role: 'admin' | 'editor' | 'viewer';
  status: string;
  created_at: string;
}

export interface ShareableLink {
  id: string;
  project_id: string;
  token: string;
  scope: 'tracker' | 'portfolio' | 'report';
  is_active: boolean;
  view_count: number;
  expires_at: string | null;
  created_at: string;
  projects?: { name: string };
}

// ── Phase 5: Reporting & Compliance types ────────────────────────────────────

export interface ComplianceRequirement {
  id: string;
  tracked_grant_id: string;
  project_id: string;
  type: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: 'upcoming' | 'in_progress' | 'submitted' | 'approved' | 'overdue';
  assignee_email: string | null;
  is_overdue?: boolean;
  completed_at: string | null;
  created_at: string;
}

export interface KnowledgeBaseEntry {
  id: string;
  title: string;
  content: string;
  source_type: string;
  file_name: string | null;
  sections: any[];
  created_at: string;
}

export interface OnboardingProgress {
  id: string;
  user_id: string;
  current_step: number;
  completed_steps: number[];
  skipped: boolean;
  completed_at: string | null;
}

// ── Peer Intelligence types ─────────────────────────────────────────────────

export interface PeerEntry {
  id: string;
  name: string;
  score: number;
  sharedCount?: number;
  matchedMission?: string;
  state: string | null;
  totalFunding: number | null;
}
