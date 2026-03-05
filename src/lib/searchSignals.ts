import { BudgetBand } from '../types';
import { getEdgeFunctionHeaders } from './supabase';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SIGNAL_ENDPOINT = `${SUPABASE_URL}/functions/v1/log-search-signal`;
const SEARCH_SESSION_ID_KEY = 'ff_search_session_id';
const SCORING_VERSION = 'grantee-fit-v7';

export type SearchSignalEventType =
  | 'search_results_loaded'
  | 'results_refreshed'
  | 'result_saved'
  | 'result_unsaved'
  | 'result_outbound_click'
  | 'result_view_details';

export interface SearchSignalEventInput {
  eventType: SearchSignalEventType;
  searchRunId: string;
  sessionId: string;
  missionHash: string;
  budgetBand: BudgetBand;
  locationServed?: string;
  keywords?: string[];
  foundationId?: string;
  foundationRank?: number;
  fitScore?: number | null;
  resultCount?: number;
  metadata?: Record<string, unknown>;
}

function fallbackRandomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return fallbackRandomId();
}

export function getOrCreateSearchSessionId(): string {
  const existing = sessionStorage.getItem(SEARCH_SESSION_ID_KEY);
  if (existing) return existing;
  const created = randomId();
  sessionStorage.setItem(SEARCH_SESSION_ID_KEY, created);
  return created;
}

export function computeMissionHash(
  mission: string,
  locationServed: string,
  keywords: string[],
  budgetBand: BudgetBand,
): string {
  const normalized = [
    SCORING_VERSION,
    mission.trim().toLowerCase(),
    locationServed.trim().toLowerCase(),
    [...keywords].map((k) => k.trim().toLowerCase()).sort().join('|'),
    budgetBand,
  ].join('||');

  let h = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    h = Math.imul(31, h) + normalized.charCodeAt(i) | 0;
  }
  return h.toString(36);
}

export function fireAndForgetSignal(input: SearchSignalEventInput): void {
  void logSearchSignal(input);
}

export async function logSearchSignal(input: SearchSignalEventInput): Promise<void> {
  try {
    const headers = await getEdgeFunctionHeaders();
    await fetch(SIGNAL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event_id: randomId(),
        event_type: input.eventType,
        search_run_id: input.searchRunId,
        session_id: input.sessionId,
        mission_hash: input.missionHash,
        budget_band: input.budgetBand,
        location_served: input.locationServed || null,
        keywords: input.keywords || [],
        foundation_id: input.foundationId || null,
        foundation_rank: input.foundationRank ?? null,
        fit_score: typeof input.fitScore === 'number' ? input.fitScore : null,
        result_count: input.resultCount ?? null,
        metadata: input.metadata || {},
        scoring_version: SCORING_VERSION,
        source: 'web',
      }),
      keepalive: true,
    });
  } catch {
    // Never interrupt UX if logging fails.
  }
}
