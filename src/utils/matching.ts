import { BudgetBand, Funder } from '../types';
import { getEdgeFunctionHeaders } from '../lib/supabase';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/match-funders`;

export interface MatchResponse {
  results: Funder[];
  cached: boolean;
  error?: string;
}

export async function findMatches(
  mission: string,
  locationServed?: string,
  keywords: string[] = [],
  budgetBand: BudgetBand = 'prefer_not_to_say',
  forceRefresh = false
): Promise<MatchResponse> {
  const headers = await getEdgeFunctionHeaders();
  const res = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mission, locationServed, keywords, budgetBand, forceRefresh }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error (${res.status})`);
  }

  return res.json();
}

export function formatGrantRange(funder: Funder): string {
  if (!funder.grant_range_min && !funder.grant_range_max) return 'Unknown';
  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${(n / 1000).toFixed(0)}K`;
  if (funder.grant_range_min && funder.grant_range_max) {
    return `${fmt(funder.grant_range_min)} – ${fmt(funder.grant_range_max)}`;
  }
  return funder.grant_range_max ? `Up to ${fmt(funder.grant_range_max)}` : '';
}

export function formatTotalGiving(amount: number | null): string {
  if (!amount) return 'N/A';
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B/yr`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M/yr`;
  return `$${(amount / 1000).toFixed(0)}K/yr`;
}
