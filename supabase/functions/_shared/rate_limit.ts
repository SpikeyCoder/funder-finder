/**
 * Per-IP sliding-window rate limiter for FunderMatch Edge Functions.
 *
 * Originally lifted from the inline implementations in `calendar-feed/index.ts`
 * (PR #62, finding FM-2026-05-09-01) and `log-search-signal/index.ts` so that
 * public, unauthenticated entry points share a single implementation and a
 * consistent threshold.
 *
 * ── FM-2026-07-29-04: rewritten. The previous version did nothing. ───────────
 *
 * That version kept counters in a module-level `Map`. That only works if the
 * Deno isolate is reused between requests — and on this project it is not.
 * Measured 2026-07-29 against a deployed function: eight rapid sequential
 * requests each returned a DIFFERENT module-scope boot id and a per-isolate hit
 * count of 1. With the limit deliberately set to 3, every request was allowed:
 *
 *   req 1 boot=1762e9a1 hits=1 allow=true   req 5 boot=7685edb2 hits=1 allow=true
 *   req 2 boot=278b821c hits=1 allow=true   req 6 boot=f928783d hits=1 allow=true
 *   req 3 boot=b35ef3fc hits=1 allow=true   req 7 boot=5411ba25 hits=1 allow=true
 *   req 4 boot=faea351c hits=1 allow=true   req 8 boot=16d27326 hits=1 allow=true
 *
 * Note what was NOT wrong with it: the caller IP resolved correctly — the Edge
 * runtime does supply `x-forwarded-for` — and its docstring openly accepted
 * "per-isolate accuracy". The flaw is that per-isolate accuracy degrades to ZERO
 * limiting when isolates are per-request. It read correctly, reviewed clean, and
 * enforced nothing, which is why it survived a pen-test.
 *
 * The counter now lives in Postgres — the one store every isolate shares — via
 * `public.check_rate_limit`, which decides atomically inside a single
 * INSERT .. ON CONFLICT so two isolates arriving together cannot both observe a
 * stale count. See migration 20260729040000.
 *
 * COST: this adds one database round-trip per request to every caller. That is
 * the deliberate trade for having a limit that actually exists. The statement is
 * a single indexed upsert on a small table.
 *
 * FAIL-OPEN. If the caller cannot be identified, or the limiter itself errors,
 * the request is allowed. A database blip must not take down a public endpoint;
 * the upstream guards (token entropy, RLS, JWT) still apply. Failures are logged
 * rather than swallowed silently.
 *
 * The public API is unchanged, so call sites did not need editing:
 *
 *   import { ipRateLimit } from "../_shared/rate_limit.ts";
 *
 *   const limited = await ipRateLimit(req);
 *   if (!limited.allow) return limited.response;
 *
 * CWE-770 (Allocation of Resources Without Limits or Throttling).
 */

const DEFAULT_LIMIT = 60;             // requests per window
const DEFAULT_WINDOW_MS = 60_000;     // 1 minute

interface RateLimitOptions {
  /** Maximum requests per window. Defaults to 60. */
  limit?: number;
  /** Window size in milliseconds. Defaults to 60_000 (1 min). */
  windowMs?: number;
  /**
   * Namespace so two endpoints keep separate buckets (e.g. share-link vs.
   * calendar-feed). Forms part of the durable bucket key.
   */
  namespace?: string;
  /**
   * Extra response headers to merge into the 429 (typically CORS headers from
   * the calling function, so the browser can actually read the rejection).
   */
  extraHeaders?: Record<string, string>;
}

interface RateLimitDecision {
  allow: boolean;
  response?: Response;
}

/**
 * Resolve the caller's IP. Cloudflare sets `cf-connecting-ip` to the single
 * true client address, which is unambiguous; `x-forwarded-for` is a
 * comma-separated chain (and on this project repeats the client), so its
 * leftmost entry is the fallback. Returns `null` when no IP can be determined.
 */
function callerIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  const real = req.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();

  return null;
}

/**
 * Per-IP sliding-window rate limit backed by Postgres. Returns
 * `{ allow: false, response }` when the caller has exceeded the limit; the
 * response is a fully-formed 429 with Retry-After. Otherwise `{ allow: true }`.
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
  if (!ip) return { allow: true }; // unidentifiable caller: fail open

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    console.error("ipRateLimit: SUPABASE_URL / SERVICE_ROLE_KEY unset — failing open");
    return { allow: true };
  }

  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  let allowed = true;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/check_rate_limit`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_key: `${namespace}:${ip}`,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      }),
    });

    if (!res.ok) {
      console.error("ipRateLimit: check_rate_limit failed", res.status, await res.text());
      return { allow: true }; // fail open
    }

    allowed = (await res.json()) !== false;
  } catch (err) {
    console.error("ipRateLimit: check_rate_limit threw", err);
    return { allow: true }; // fail open
  }

  if (allowed) return { allow: true };

  const headers: Record<string, string> = {
    "Retry-After": String(windowSeconds),
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  };
  return {
    allow: false,
    response: new Response("Too Many Requests", { status: 429, headers }),
  };
}

/**
 * Previously cleared the in-process bucket Map between tests. The counters now
 * live in Postgres, so there is no in-process state to reset. Retained as a
 * no-op so existing imports keep compiling; delete the bucket rows directly if
 * a test needs a clean slate.
 */
export function _resetBuckets(): void {
  /* no-op — counters are durable, see public.rate_limit_hits */
}
