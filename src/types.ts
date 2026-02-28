// Matches the Supabase `funders` table schema (snake_case from DB)
export interface Funder {
  id: string;
  name: string;
  type: string; // 'foundation' | 'corporate' | 'daf'
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
  // Subpage URLs (populated by enrich-subpages.js)
  contact_url?: string | null;
  programs_url?: string | null;
  apply_url?: string | null;
  news_url?: string | null;
}
