/**
 * Per-IP sliding-window rate limiter for FunderMatch Edge Functions.
 *
 * Lifted from the inline implementations in `calendar-feed/index.ts`
 * (PR #62, finding FM-2026-05-09-01) and `log-search-signal/index.ts`
 * so that public, unauthenticated entry points share a single
 * implementation and a consistent threshold.
 *
 * Threat model: rate-limit complements high-entropy tokens (calendar
 * feeds, share links). Tokens are not brute-forceable online; the
 * limiter exists so a leaked token URL cannot be replayed at line
 * speed against the database, and so abuse signals surface in logs
 * before they reach a SELECT.
 *
 * The limiter is intentionally process-local (Map) — Supabase Edge
 * Functions run on Deno isolates and a region-wide counter is not
 * available without an external store. Per-isolate accuracy is
 * acceptable for the defense-in-depth role this control plays;
 * tighten by moving to a shared store (Upstash, Redis) if/when
 * abuse exceeds the per-isolate threshold.
 *
 * Usage:
 *   import { ipRateLimit } from "../_shared/rate_limit.ts";
 *
 *   const limited = await ipRateLimit(req);
 *   if (!limited.allow) return limited.response;
 *
 * The returned `response` already includes `Retry-After` and a 429
 * body so callers can short-circuit before any DB access.
 */

const DEFAULT_LIMIT = 60;             // requests per window
const DEFAULT_WINDOW_MS = 60_000;     // 1 minute

interface BucketEntry {
  count: number;
  reset: number;
}

interface RateLimitOptions {
  /** Maximum requests per window. Defaults to 60. */
  limit?: number;
  /** Window size in milliseconds. Defaults to 60_000 (1 min). */
  windowMs?: number;
  /**
   * Optional namespace so two endpoints in the same isolate keep
   * separate buckets (e.g. share-link vs. calendar-feed).
   */
  namespace?: string;
  /**
   * Extra response headers to merge into the 429 body (typically
   * CORS headers from the calling function).
   */
  extraHeaders?: Record<string, string>;
}

interface RateLimitDecision {
  allow: boolean;
  response?: Response;
}

const _BUCKETS: Map<string, BucketEntry> = new Map();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the caller's IP from the standard Cloud Run / Supabase
 * Edge headers. Returns `null` if no IP can be determined; callers
 * should treat that as "fail-open" because the upstream guard
 * (token entropy + RLS) still applies.
 */
function callerIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Standard XFF format: "client, proxy1, proxy2". The leftmost
    // non-empty entry is the original client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  return null;
}

/**
 * Per-IP sliding-window rate limit. Returns `{ allow: false, response }`
 * when the caller has exceeded the limit; the response is a fully-formed
 * 429 with Retry-After. Otherwise returns `{ allow: true }` and the
 * caller proceeds with normal handling.
 */
export async function ipRateLimit(
  req: Request,
  options: RateLimitOptions = {},
): Promise<RateLimitDecision> {
  const {
    limit = DEFAULT_LIMIT,
    windowMs = DEFAULT_WINDOW_MS,
    namespace = "default",
    extraHeaders = {},
  } = options;

  const ip = callerIp(req);
  // Fail-open if we cannot identify the caller. This matches the
  // log-search-signal precedent: the SELECT itself is cheap and we
  // do not want to lock out clients behind an unusual proxy chain.
  if (!ip) return { allow: true };

  const ipHash = await sha256Hex(`${namespace}:${ip}`);
  const now = Date.now();
  const slot = _BUCKETS.get(ipHash);

  if (!slot || slot.reset < now) {
    _BUCKETS.set(ipHash, { count: 1, reset: now + windowMs });
    return { allow: true };
  }

  if (slot.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((slot.reset - now) / 1000));
    const headers: Record<string, string> = {
      "Retry-After": String(retryAfter),
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    };
    return {
      allow: false,
      response: new Response("Too Many Requests", { status: 429, headers }),
    };
  }

  slot.count += 1;
  return { allow: true };
}

/**
 * Test-only helper to clear the bucket map between tests. Not exported
 * from the production surface; consumers should ignore this.
 */
export function _resetBuckets(): void {
  _BUCKETS.clear();
}
