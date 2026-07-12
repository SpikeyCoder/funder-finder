/**
 * Centralised CORS allowlist for FunderMatch Edge Functions.
 *
 * Replaces the per-function `Access-Control-Allow-Origin: *` pattern
 * that appeared in 17 functions. The allowlist mirrors the one already
 * used by grant-writer, compute-peers, log-search-signal, and
 * match-funders.
 *
 * Public-by-design endpoints (e.g. share-link's GET-by-token,
 * calendar-feed's .ics output, report-bug from a third-party widget)
 * may pass `{ allowAny: true }` to keep wildcard behaviour, in which
 * case credentials are NOT permitted.
 */

// Dev-only origins are gated behind an explicit env flag so they are never
// part of the *production* CORS allowlist. To develop against deployed Edge
// Functions from a local Vite dev server, set `ALLOW_LOCAL_CORS=true` in the
// function environment (e.g. `supabase functions serve` or a preview deploy).
// In production the flag is unset, so a page served from localhost cannot
// obtain a credentialed cross-origin grant against the Edge Functions.
// (FM-2026-07-12-01)
const DEV_ORIGINS = ["http://localhost:5173"];

const ALLOWED_ORIGINS = new Set<string>([
  "https://fundermatch.org",
  "https://www.fundermatch.org",
  ...(Deno.env.get("ALLOW_LOCAL_CORS") === "true" ? DEV_ORIGINS : []),
]);

interface CorsOptions {
  /**
   * For endpoints that are intentionally public (e.g. share-link by
   * token). Returns `*` for the origin and disables credentials.
   */
  allowAny?: boolean;
  methods?: string;
}

const DEFAULT_HEADERS = "authorization, x-client-info, apikey, content-type";

export function corsHeaders(
  requestOrigin: string | null,
  options: CorsOptions = {},
): Record<string, string> {
  const { allowAny = false, methods = "GET, POST, OPTIONS" } = options;

  if (allowAny) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": DEFAULT_HEADERS,
      "Access-Control-Allow-Methods": methods,
      Vary: "Origin",
    };
  }

  const origin =
    requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : "https://fundermatch.org";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": DEFAULT_HEADERS,
    "Access-Control-Allow-Methods": methods,
    Vary: "Origin",
  };
}

/**
 * Convenience for the very common pattern:
 *   if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
 */
export function preflightResponse(
  request: Request,
  options: CorsOptions = {},
): Response {
  return new Response("ok", { headers: corsHeaders(request.headers.get("origin"), options) });
}
