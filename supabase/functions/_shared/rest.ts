// PostgREST calls with the service-role key, for Edge Functions that read or
// write their own tables (the key bypasses RLS). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are read per call, so a missing one shows up as
// a failed request rather than a module that can't load.

const DEFAULT_TIMEOUT_MS = 7000;

/** Whether SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set. */
export function restConfigured(): boolean {
  return !!(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
}

/** A PostgREST request. `init` can override the method, body and headers. */
export function rest(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  // Caller headers win, in any form (object, Headers or pairs).
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${key}`);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${Deno.env.get("SUPABASE_URL") || ""}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
    headers,
  });
}

/** A PostgREST request's JSON body; throws (with the status and body) if it failed. */
export async function restJson<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const res = await rest(path, init, timeoutMs);
  if (!res.ok) throw new Error(`REST ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

/**
 * The exact number of rows a query matches (from Content-Range). Throws if
 * the request fails or the count can't be read: a count read as 0 could
 * lift a cap that relies on it.
 */
export async function restCount(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
  const res = await rest(path, { method: "HEAD", headers: { Prefer: "count=exact" } }, timeoutMs);
  if (!res.ok) throw new Error(`REST ${path.split("?")[0]} count ${res.status}`);
  const total = Number(res.headers.get("content-range")?.split("/")[1] ?? NaN);
  if (!Number.isFinite(total)) throw new Error(`REST ${path.split("?")[0]} count unreadable`);
  return total;
}
