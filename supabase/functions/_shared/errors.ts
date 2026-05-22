/**
 * FM-2026-05-22-01: shared error sanitiser for Edge Function responses.
 *
 * Returning raw `err.message` from supabase-js / Deno runtime to the HTTP
 * client leaks Postgres schema, constraint, and column names, and runtime
 * file paths — CWE-209 (Information Exposure Through an Error Message).
 *
 * `sanitiseError(err, fallback)` logs the full detail server-side (Supabase
 * Function logs capture stderr) and returns a fixed public-facing string.
 *
 * Auth-error paths that surface intentionally-descriptive messages from
 * `authFromRequest` ("JWT expired", "Anonymous tokens not accepted", etc.)
 * are unaffected — those are pre-classified by `statusForAuthError` and
 * carry no schema information.
 */
export function sanitiseError(err: unknown, fallback = "Internal server error"): string {
  try {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[sanitised_error] ${detail}`);
  } catch {
    // never let logging take down the response path
  }
  return fallback;
}
