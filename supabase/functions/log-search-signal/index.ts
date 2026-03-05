/**
 * log-search-signal - Supabase Edge Function
 *
 * Stores interaction events used for offline supervised tuning.
 * This endpoint is intentionally log-only; it never updates live ranking weights.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
  'http://localhost:5173',
]);

const VALID_EVENT_TYPES = new Set([
  'search_results_loaded',
  'results_refreshed',
  'result_saved',
  'result_unsaved',
  'result_outbound_click',
  'result_view_details',
]);

const VALID_BUDGET_BANDS = new Set([
  'under_250k',
  '250k_1m',
  '1m_5m',
  'over_5m',
  'prefer_not_to_say',
]);

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

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return atob(padded);
  } catch {
    return null;
  }
}

function parseAuthUserId(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payloadStr = base64UrlDecode(parts[1]);
  if (!payloadStr) return null;
  try {
    const payload = JSON.parse(payloadStr);
    if (payload?.role === 'authenticated' && typeof payload?.sub === 'string') return payload.sub;
    return null;
  } catch {
    return null;
  }
}

function normalizeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .slice(0, 24);
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();

    const eventType = normalizeString(body?.event_type, 64);
    if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
      return new Response(JSON.stringify({ error: 'Invalid event_type' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const searchRunId = normalizeString(body?.search_run_id, 128);
    const sessionId = normalizeString(body?.session_id, 128);
    const missionHash = normalizeString(body?.mission_hash, 128);
    if (!searchRunId || !sessionId || !missionHash) {
      return new Response(JSON.stringify({ error: 'search_run_id, session_id, and mission_hash are required' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const budgetBandRaw = normalizeString(body?.budget_band, 32);
    const budgetBand = budgetBandRaw && VALID_BUDGET_BANDS.has(budgetBandRaw) ? budgetBandRaw : null;
    const locationServed = normalizeString(body?.location_served, 180);
    const foundationId = normalizeString(body?.foundation_id, 120);
    const scoringVersion = normalizeString(body?.scoring_version, 64);
    const source = normalizeString(body?.source, 24) || 'web';
    const eventId = normalizeString(body?.event_id, 128) || crypto.randomUUID();
    const keywords = normalizeKeywords(body?.keywords);

    const foundationRankRaw = normalizeFiniteNumber(body?.foundation_rank);
    const foundationRank = foundationRankRaw && Number.isInteger(foundationRankRaw) && foundationRankRaw >= 1 && foundationRankRaw <= 200
      ? foundationRankRaw
      : null;

    const fitScoreRaw = normalizeFiniteNumber(body?.fit_score);
    const fitScore = fitScoreRaw !== null && fitScoreRaw >= 0 && fitScoreRaw <= 1
      ? Number(fitScoreRaw.toFixed(4))
      : null;

    const resultCountRaw = normalizeFiniteNumber(body?.result_count);
    const resultCount = resultCountRaw !== null && Number.isInteger(resultCountRaw) && resultCountRaw >= 0
      ? resultCountRaw
      : null;

    const metadata = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

    const authorization = req.headers.get('authorization');
    const userId = parseAuthUserId(authorization);

    const xForwardedFor = normalizeString(req.headers.get('x-forwarded-for'), 256);
    const ipHash = xForwardedFor ? await sha256Hex(xForwardedFor) : null;
    const userAgent = normalizeString(req.headers.get('user-agent'), 256);

    await sbFetch('search_signal_events?on_conflict=event_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        event_id: eventId,
        event_type: eventType,
        search_run_id: searchRunId,
        session_id: sessionId,
        mission_hash: missionHash,
        budget_band: budgetBand,
        location_served: locationServed,
        keywords,
        foundation_id: foundationId,
        foundation_rank: foundationRank,
        fit_score: fitScore,
        result_count: resultCount,
        metadata,
        user_id: userId,
        scoring_version: scoringVersion,
        source,
        ip_hash: ipHash,
        user_agent: userAgent,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('log-search-signal error:', err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
});
