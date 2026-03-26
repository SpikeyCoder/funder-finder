import { BudgetBand, Funder, FunderInsights, OrgSearchResult, PeerEntry, RecipientProfile } from '../types';
import { getEdgeFunctionHeaders } from '../lib/supabase';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/match-funders`;
const SUGGEST_PEERS_URL = `${SUPABASE_URL}/functions/v1/suggest-peers`;
const FUNDER_INSIGHTS_URL = `${SUPABASE_URL}/functions/v1/get-funder-990-insights`;
const SEARCH_ORGS_URL = `${SUPABASE_URL}/functions/v1/search-organizations`;
const RECIPIENT_PROFILE_URL = `${SUPABASE_URL}/functions/v1/get-recipient-profile`;
const COMPUTE_PEERS_URL = `${SUPABASE_URL}/functions/v1/compute-peers`;

/**
 * Fetch a single funder row from the `funders` table by its EIN (primary key).
 * Uses the Supabase REST API (PostgREST) directly — no edge function needed.
 */
export async function fetchFunderByEin(ein: string): Promise<Funder | null> {
  const headers = await getEdgeFunctionHeaders('application/json', { useAnonOnly: true });
  const url = `${SUPABASE_URL}/rest/v1/funders?id=eq.${encodeURIComponent(ein)}&limit=1`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const rows: Funder[] = await res.json();
  return rows.length > 0 ? rows[0] : null;
}

export interface MatchResponse {
  results: Funder[];
  cached: boolean;
  error?: string;
  peers?: string[];
}

export async function findMatches(
  mission: string,
  locationServed?: string,
  keywords: string[] = [],
  budgetBand: BudgetBand = 'prefer_not_to_say',
  forceRefresh = false,
  peerNonprofits: string[] = []
): Promise<MatchResponse> {
  const headers = await getEdgeFunctionHeaders('application/json', { useAnonOnly: true });
  const res = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mission, locationServed, keywords, budgetBand, forceRefresh, peerNonprofits }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error (${res.status})`);
  }

  return res.json();
}

export interface SuggestPeersResponse {
  peers: string[];
  error?: string;
}

export async function suggestPeers(
  mission: string,
  locationServed?: string,
  budgetBand: BudgetBand = 'prefer_not_to_say',
): Promise<SuggestPeersResponse> {
  const headers = await getEdgeFunctionHeaders('application/json', { useAnonOnly: true });
  const res = await fetch(SUGGEST_PEERS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mission, locationServed, budgetBand }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { peers: [], error: body.error || `Server error (${res.status})` };
  }

  const data = await res.json();
  return { peers: Array.isArray(data.peers) ? data.peers : [] };
}

export async function fetchFunderInsights(funderId: string): Promise<FunderInsights> {
  const headers = await getEdgeFunctionHeaders('application/json', { useAnonOnly: true });
  const res = await fetch(FUNDER_INSIGHTS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ funderId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error (${res.status})`);
  }

  return res.json();
}

export async function searchOrganizations(query: string, limit = 15): Promise<OrgSearchResult[]> {
  const headers = await getEdgeFunctionHeaders('application/json', { useAnonOnly: true });
  const res = await fetch(SEARCH_ORGS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, limit }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error (${res.status})`);
  }

  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

export async function fetchRecipientProfile(
  recipientId?: string,
  ein?: string,
): Promise<RecipientProfile> {
  const headers = await getEdgeFunctionHeaders('application/json', { useAnonOnly: true });
  const res = await fetch(RECIPIENT_PROFILE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ recipientId, ein }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error (${res.status})`);
  }

  return res.json();
}

export async function fetchPeers(
  entityType: 'funder' | 'recipient',
  entityId: string,
): Promise<PeerEntry[]> {
  const headers = await getEdgeFunctionHeaders('application/json', { useAnonOnly: true });
  const res = await fetch(COMPUTE_PEERS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ entityType, entityId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error (${res.status})`);
  }

  const data = await res.json();
  return Array.isArray(data.peers) ? data.peers : [];
}

export function formatGrantRange(funder: Funder): string {
  if (!funder.grant_range_min && !funder.grant_range_max) return 'Unknown';
  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${(n / 1000).toFixed(0)}K`;
  if (funder.grant_range_min && funder.grant_range_max) {
    return `${fmt(funder.grant_range_min)} - ${fmt(funder.grant_range_max)}`;
  }
  return funder.grant_range_max ? `Up to ${fmt(funder.grant_range_max)}` : '';
}

export function formatTotalGiving(amount: number | null): string {
  if (!amount) return 'N/A';
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B/yr`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M/yr`;
  return `$${(amount / 1000).toFixed(0)}K/yr`;
}
