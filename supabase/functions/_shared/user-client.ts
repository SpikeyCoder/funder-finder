/**
 * User-scoped Supabase client factory for Phase 1 Edge Function migration.
 *
 * Extracts JWT from Authorization header, verifies it locally with
 * SUPABASE_JWT_SECRET (no HTTP roundtrip), and returns a Supabase client
 * scoped to the authenticated user along with the decoded user object.
 *
 * Why local verification instead of supabase.auth.getUser(token):
 *   The /auth/v1/user endpoint is occasionally fronted by an HTML error
 *   page (gateway 5xx, rate limiting), which causes supabase-js to throw
 *   "Unexpected token '<', '<html>...' is not valid JSON" — surfaced to
 *   users on the Tracker tab as "JWT verification failed: ...". Local
 *   HS256 verification is faster, deterministic, and removes the auth
 *   service as a per-request dependency.
 *
 * Usage:
 *   const { supabase, user } = await createUserScopedClient(req);
 *   const { data } = await supabase.from('table').select('*');
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

interface VerifiedUser {
  id: string;
  aud?: string;
  role?: string;
  email?: string;
  phone?: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  is_anonymous: boolean;
}

interface UserScopedClientResult {
  supabase: ReturnType<typeof createClient>;
  user: VerifiedUser;
}

const TEXT_ENCODER = new TextEncoder();
const EXPECTED_AUDIENCE = 'authenticated';

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + '='.repeat(padLen);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

async function verifyJWTLocally(token: string): Promise<VerifiedUser> {
  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET');
  if (!jwtSecret) {
    throw new Error('SUPABASE_JWT_SECRET environment variable not set');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT verification failed: malformed token');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(bytesToString(base64UrlDecode(headerB64)));
    payload = JSON.parse(bytesToString(base64UrlDecode(payloadB64)));
  } catch {
    throw new Error('JWT verification failed: malformed token');
  }

  if (header.alg !== 'HS256') {
    throw new Error(`JWT verification failed: unsupported algorithm ${String(header.alg)}`);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signature = base64UrlDecode(signatureB64);
  const data = TEXT_ENCODER.encode(`${headerB64}.${payloadB64}`);
  const expected = new Uint8Array(
    await crypto.subtle.sign({ name: 'HMAC', hash: 'SHA-256' }, key, data),
  );

  if (!timingSafeEqual(signature, expected)) {
    throw new Error('JWT verification failed: invalid signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= now) {
    throw new Error('JWT verification failed: token expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new Error('JWT verification failed: token not yet valid');
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('JWT verification failed: missing sub claim');
  }

  // Audience pinning. Supabase mints user JWTs with `aud: "authenticated"`
  // and service-role JWTs with `aud: "service_role"`. We only accept
  // "authenticated" here, since the user-scoped client surface is for
  // end-user requests. This rejects:
  //   * Anonymous-auth JWTs if the project setting is ever enabled
  //     (`signInAnonymously()` mints "authenticated" audience but
  //     `is_anonymous: true`; we additionally reject those below).
  //   * Service-role JWTs accidentally forwarded from the browser.
  //   * Tokens minted for a different audience by an attacker who
  //     somehow obtained the shared SUPABASE_JWT_SECRET (defense-in-
  //     depth against secret reuse across environments).
  // Pen-test 2026-05-10 finding FM-2026-05-10-01.
  if (payload.aud !== EXPECTED_AUDIENCE) {
    throw new Error(
      `JWT verification failed: unexpected audience ${String(payload.aud)}`,
    );
  }
  if (payload.is_anonymous === true) {
    throw new Error('JWT verification failed: anonymous tokens not accepted');
  }

  return {
    id: payload.sub,
    aud: typeof payload.aud === 'string' ? payload.aud : undefined,
    role: typeof payload.role === 'string' ? payload.role : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    phone: typeof payload.phone === 'string' ? payload.phone : undefined,
    app_metadata:
      payload.app_metadata && typeof payload.app_metadata === 'object'
        ? (payload.app_metadata as Record<string, unknown>)
        : {},
    user_metadata:
      payload.user_metadata && typeof payload.user_metadata === 'object'
        ? (payload.user_metadata as Record<string, unknown>)
        : {},
    is_anonymous: payload.is_anonymous === true,
  };
}

function extractToken(req: Request): string {
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
  return token;
}

/**
 * Creates a user-scoped Supabase client from the Authorization header.
 *
 * @param req - The Deno.serve Request object
 * @returns Promise with { supabase, user } where supabase is scoped to the user's JWT
 * @throws Error if Authorization header is missing, malformed, or JWT cannot be verified
 */
export async function createUserScopedClient(
  req: Request,
): Promise<UserScopedClientResult> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL environment variable not set');
  }
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseAnonKey) {
    throw new Error('SUPABASE_ANON_KEY environment variable not set');
  }

  const token = extractToken(req);
  const user = await verifyJWTLocally(token);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return { supabase, user };
}

/**
 * Alternative: Extract JWT from request and verify without creating client.
 * Useful for validation-only scenarios or when you need the token separately.
 */
export async function extractAndVerifyJWT(
  req: Request,
): Promise<{ user: VerifiedUser; token: string }> {
  const token = extractToken(req);
  const user = await verifyJWTLocally(token);
  return { user, token };
}
