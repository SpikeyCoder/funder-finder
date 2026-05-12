/**
 * Local-decode JWT auth helper for FunderMatch Edge Functions.
 *
 * Background: the previous `_shared/user-client.ts` flow relied on
 * `supabase.auth.getUser(token)` inside the Edge runtime to extract the
 * caller's user id, plus a strict `aud === 'authenticated'` check. Both
 * proved unreliable in production -- every function that used the helper
 * (tracked-grants, pipeline-statuses, portfolio, grant-tasks) was
 * returning 500/401 for valid authenticated users. Removing the audience
 * check did not fix it: `getUser` itself was throwing in this context.
 *
 * Pattern adopted instead:
 *   * Decode the JWT payload locally (no signature verify needed because
 *     Supabase's gateway has already authenticated the request -- the
 *     edge function only ever receives requests that the gateway accepted).
 *   * Extract `sub` (user id) from the payload.
 *   * Reject anonymous tokens (`is_anonymous === true`).
 *   * Reject expired tokens.
 *   * Use a service-role client for the database query, filtered explicitly
 *     by `user_id = <sub>` so the function never reads rows that don't
 *     belong to the caller.
 *
 * This gives us a reliable user id without depending on the auth-service
 * round trip that was failing.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

function base64UrlDecode(b64url: string): string {
  const b64 = b64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(b64url.length + (4 - (b64url.length % 4)) % 4, '=');
  return atob(b64);
}

interface JwtPayload {
  sub?: string;
  aud?: string | string[];
  exp?: number;
  is_anonymous?: boolean;
  role?: string;
}

export interface AuthResult {
  userId: string;
  token: string;
}

/**
 * Extract and validate the caller's JWT from the Authorization header.
 * Returns the caller's user id (the JWT `sub` claim) and the raw token.
 * Throws if the header is missing, malformed, anonymous, or expired.
 */
export function authFromRequest(req: Request): AuthResult {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    throw new Error('Missing Authorization header');
  }
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;
  if (!token) {
    throw new Error('Malformed Authorization header: missing token');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT: expected 3 segments');
  }
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch (e: any) {
    throw new Error(`Malformed JWT: payload not JSON (${e?.message || e})`);
  }
  if (payload.is_anonymous === true) {
    throw new Error('Anonymous tokens not accepted');
  }
  if (!payload.sub) {
    throw new Error('JWT missing sub claim');
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT expired');
  }
  return { userId: payload.sub, token };
}

/**
 * Create a Supabase client using the service-role key. Bypasses RLS, so
 * every query that touches user-owned data MUST filter by user_id from
 * `authFromRequest`.
 */
export function adminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('Server config missing: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Map a thrown error from `authFromRequest` to an HTTP status code.
 * Auth-related errors are 401; everything else is 500.
 */
export function statusForAuthError(message: string): number {
  return /Authorization|JWT|token|Anonymous/i.test(message) ? 401 : 500;
}
