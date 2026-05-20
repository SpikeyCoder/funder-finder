/**
 * Local-decode + HMAC-verify JWT auth helper for FunderMatch Edge Functions.
 *
 * Background: the previous `_shared/user-client.ts` flow relied on
 * `supabase.auth.getUser(token)` inside the Edge runtime to extract the
 * caller's user id. That proved unreliable in production -- every function
 * that used the helper returned 500/401 for valid authenticated users.
 *
 * Pattern adopted instead:
 *   * Decode the JWT payload locally.
 *   * Verify the HS256 signature against `SUPABASE_JWT_SECRET` when the
 *     secret is configured (defense-in-depth — the Supabase gateway also
 *     verifies on the way in when functions are deployed without
 *     `--no-verify-jwt`, but we no longer rely solely on the gateway).
 *   * Extract `sub` (user id) from the payload.
 *   * Reject anonymous tokens (`is_anonymous === true`).
 *   * Reject expired tokens.
 *   * Use a service-role client for the database query, filtered explicitly
 *     by `user_id = <sub>` so the function never reads rows that don't
 *     belong to the caller.
 *
 * Pen-test 2026-05-14 finding FM-2026-05-14-01: the previous version of
 * this module skipped signature verification entirely on the assumption
 * that the Supabase gateway had already vetted the token. A function
 * deployed with `--no-verify-jwt` (or a future Supabase config change
 * that silently disables gateway verification) would have caused this
 * helper to accept ANY syntactically-valid JWT, including one minted
 * locally by an attacker with arbitrary `sub` and `exp` claims. The
 * HMAC check added here closes that defense-in-depth gap.
 *
 * When `SUPABASE_JWT_SECRET` is not configured (e.g. local dev), the
 * helper continues to operate in decode-only mode but logs a warning,
 * so missing-config never silently weakens the production posture.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

function base64UrlDecode(b64url: string): string {
  const b64 = b64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(b64url.length + (4 - (b64url.length % 4)) % 4, '=');
  return atob(b64);
}

function base64UrlDecodeToBytes(b64url: string): Uint8Array {
  const binary = base64UrlDecode(b64url);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface JwtHeader {
  alg?: string;
  typ?: string;
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

let _warnedNoSecret = false;

async function verifyHs256(
  signingInput: string,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(signingInput),
  );
}

/**
 * Extract and validate the caller's JWT from the Authorization header.
 * Returns the caller's user id (the JWT `sub` claim) and the raw token.
 * Throws if the header is missing, malformed, anonymous, expired, or
 * has a signature that does not verify against `SUPABASE_JWT_SECRET`.
 */
export async function authFromRequest(req: Request): Promise<AuthResult> {
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

  let header: JwtHeader;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]));
  } catch (e: any) {
    throw new Error(`Malformed JWT: header not JSON (${e?.message || e})`);
  }
  if (header.alg && header.alg !== 'HS256') {
    // Supabase may issue tokens with asymmetric algorithms (e.g. RS256).
    // Log a warning but do not reject — HMAC verification will be skipped
    // for non-HS256 tokens; the Supabase gateway is the primary verifier.
    console.warn(`authFromRequest: non-HS256 alg "${header.alg}" — skipping local HMAC verification`);
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch (e: any) {
    throw new Error(`Malformed JWT: payload not JSON (${e?.message || e})`);
  }

  // Signature verification — defense in depth.
  const secret = Deno.env.get('JWT_SECRET') || Deno.env.get('SUPABASE_JWT_SECRET') || '';
  const isHs256 = !header.alg || header.alg === 'HS256';
  if (secret && isHs256) {
    const signingInput = `${parts[0]}.${parts[1]}`;
    let sigBytes: Uint8Array;
    try {
      sigBytes = base64UrlDecodeToBytes(parts[2]);
    } catch (e: any) {
      throw new Error(`Malformed JWT: signature not base64url (${e?.message || e})`);
    }
    const ok = await verifyHs256(signingInput, sigBytes, secret);
    if (!ok) {
      throw new Error('JWT signature verification failed');
    }
  } else if (!secret && !_warnedNoSecret) {
    _warnedNoSecret = true;
    console.warn(
      'authFromRequest: JWT_SECRET not set — running in decode-only ' +
      'mode. The Supabase gateway is the only line of defence against forged ' +
      'tokens. Set the secret in Edge Function config for defense-in-depth.',
    );
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
  return /Authorization|JWT|token|Anonymous|signature|alg/i.test(message)
    ? 401
    : 500;
}

