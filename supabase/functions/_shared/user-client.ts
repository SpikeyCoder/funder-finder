/**
 * User-scoped Supabase client factory for Phase 1 Edge Function migration.
 *
 * Extracts the JWT from the Authorization header, verifies it via
 * `supabase.auth.getUser(token)` with bounded retries, enforces audience
 * pinning (`aud === "authenticated"`) and anonymous-token rejection
 * (`is_anonymous !== true`), and returns a Supabase client scoped to that
 * user along with the verified user object.
 *
 * Why HTTP verification with retries:
 *   The /auth/v1/user endpoint is occasionally fronted by an HTML error
 *   page (gateway 5xx, rate limiting), which causes supabase-js to throw
 *   "Unexpected token '<', '<html>...' is not valid JSON" — surfaced to
 *   users on the Tracker tab as "JWT verification failed: ...". A small
 *   retry loop with backoff absorbs those transient failures while
 *   keeping the auth service as the source of truth (so password resets,
 *   bans, and key rotations take effect immediately).
 *
 * Why the audience / is_anonymous checks (pen-test 2026-05-10 finding
 * FM-2026-05-10-01):
 *   Without an explicit `aud === "authenticated"` check we would accept
 *     * service-role JWTs (`aud: "service_role"`) — defense-in-depth
 *       against an accidental browser-side service-role key exposure;
 *     * anonymous-auth JWTs if Supabase Anonymous Sign-Ins is ever
 *       enabled at the project level (mints `is_anonymous: true` with
 *       audience "authenticated", so the audience check alone isn't
 *       enough — we reject `is_anonymous === true` explicitly);
 *     * cross-environment token reuse if SUPABASE_JWT_SECRET ever leaks
 *       between environments.
 *
 * Usage:
 *   const { supabase, user } = await createUserScopedClient(req);
 *   const { data } = await supabase.from('table').select('*');
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const EXPECTED_AUDIENCE = 'authenticated';
const MAX_VERIFY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;

interface UserScopedClientResult {
  supabase: ReturnType<typeof createClient>;
  // The full user object returned by supabase.auth.getUser, narrowed to
  // the fields we actually rely on. Kept loose to stay forward-compatible
  // with new fields supabase-js adds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls supabase.auth.getUser(token) with a small retry loop to absorb
 * transient gateway errors (HTML responses, 5xx) from /auth/v1/user.
 *
 * Authentication failures (invalid signature, expired token, etc.) are
 * surfaced by supabase-js as a structured AuthApiError without throwing —
 * those are returned immediately and not retried. We only retry when the
 * call itself throws (network / parse error) or when the returned error
 * looks like a transient infrastructure failure rather than a real auth
 * rejection.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verifyJWTWithRetry(supabase: any, token: string): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error) {
        const status = (error as { status?: number }).status;
        const message = String((error as { message?: string }).message ?? '');
        const looksTransient =
          (typeof status === 'number' && status >= 500) ||
          message.includes('Unexpected token') ||
          message.includes('<html') ||
          message.includes('fetch failed') ||
          message.includes('network');
        if (looksTransient && attempt < MAX_VERIFY_ATTEMPTS) {
          lastError = error;
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
          continue;
        }
        throw new Error(
          `JWT verification failed: ${message || 'unknown auth error'}`,
        );
      }
      if (!data || !data.user) {
        throw new Error('JWT verification failed: user not found');
      }
      return data.user;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_VERIFY_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('JWT verification failed')) {
        throw err;
      }
      throw new Error(`JWT verification failed: ${message}`);
    }
  }
  // Unreachable in practice — the loop either returns or throws — but
  // keeps the type checker happy.
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`JWT verification failed: ${message}`);
}

/**
 * Enforces audience pinning and anonymous-token rejection on the user
 * object returned by supabase.auth.getUser.
 *
 * Supabase mints user JWTs with `aud: "authenticated"` and service-role
 * JWTs with `aud: "service_role"`. We only accept "authenticated" here,
 * since the user-scoped client surface is for end-user requests. We
 * additionally reject `is_anonymous === true` so that enabling Supabase
 * Anonymous Sign-Ins at the project level cannot silently widen the
 * authentication boundary of every migrated Edge Function.
 *
 * Pen-test 2026-05-10 finding FM-2026-05-10-01.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enforceAudienceAndIdentity(user: any): void {
  if (user.aud !== EXPECTED_AUDIENCE) {
    throw new Error(
      `JWT verification failed: unexpected audience ${String(user.aud)}`,
    );
  }
  if (user.is_anonymous === true) {
    throw new Error('JWT verification failed: anonymous tokens not accepted');
  }
}

/**
 * Creates a user-scoped Supabase client from the Authorization header.
 *
 * @param req - The Deno.serve Request object
 * @returns Promise with { supabase, user } where supabase is scoped to the user's JWT
 * @throws Error if Authorization header is missing, malformed, or the JWT cannot be verified
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

  const user = await verifyJWTWithRetry(supabase, token);
  enforceAudienceAndIdentity(user);

  return { supabase, user };
}

/**
 * Alternative: Extract JWT from request and verify without creating a
 * long-lived user-scoped client. Useful for validation-only scenarios or
 * when you need the token separately.
 */
export async function extractAndVerifyJWT(
  req: Request,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ user: any; token: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL environment variable not set');
  }
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseAnonKey) {
    throw new Error('SUPABASE_ANON_KEY environment variable not set');
  }

  const token = extractToken(req);
  const tempClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const user = await verifyJWTWithRetry(tempClient, token);
  enforceAudienceAndIdentity(user);

  return { user, token };
}
