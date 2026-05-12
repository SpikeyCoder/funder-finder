/**
 * User-scoped Supabase client factory for Phase 1 Edge Function migration.
 *
 * Extracts the JWT from the Authorization header, verifies it via
 * `supabase.auth.getUser(token)` with bounded retries, rejects anonymous
 * tokens, and returns a Supabase client scoped to that user along with the
 * verified user object.
 *
 * Why HTTP verification with retries:
 *   The /auth/v1/user endpoint is occasionally fronted by an HTML error
 *   page (gateway 5xx, rate limiting), which causes supabase-js to throw
 *   "Unexpected token '<', '<html>...' is not valid JSON" surfaced to users
 *   on the Tracker tab as "JWT verification failed: ...". A small retry loop
 *   with backoff absorbs those transient failures while keeping the auth
 *   service as the source of truth (so password resets, bans, and key
 *   rotations take effect immediately).
 *
 * Why the audience pinning was removed (regression 2026-05-12):
 *   The previous version of this file enforced `user.aud === "authenticated"`
 *   on the User object returned by supabase.auth.getUser(). The supabase-js
 *   TypeScript type advertises that field, but at runtime in v2.49.1 the
 *   User object does not consistently populate `aud`, so the strict check
 *   was throwing "JWT verification failed: unexpected audience undefined"
 *   for every real user. Symptom: every edge function that used this
 *   helper (tracked-grants, pipeline-statuses, portfolio, grant-tasks)
 *   returned 500/401 for authenticated callers; the Tracker tab in
 *   particular showed "0 grants tracked" even when project_card.tracked
 *   correctly reported a non-zero count. The aud check was redundant with
 *   supabase.auth.getUser() itself (which only accepts valid auth-service
 *   JWTs and would reject service-role JWTs with a normal auth error), so
 *   it has been removed. The is_anonymous rejection below still defends
 *   against Supabase Anonymous Sign-In tokens being treated as full users.
 *
 * Usage:
 *   const { supabase, user } = await createUserScopedClient(req);
 *   const { data } = await supabase.from('table').select('*');
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const MAX_VERIFY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;

interface UserScopedClientResult {
  supabase: ReturnType<typeof createClient>;
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
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`JWT verification failed: ${message}`);
}

/**
 * Reject anonymous-sign-in tokens. Audience pinning intentionally omitted
 * (see file header) because supabase-js v2.49.1's User object does not
 * reliably populate `aud` at runtime even though the type declares it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enforceIdentity(user: any): void {
  if (user.is_anonymous === true) {
    throw new Error('JWT verification failed: anonymous tokens not accepted');
  }
}

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
  enforceIdentity(user);

  return { supabase, user };
}

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
  enforceIdentity(user);

  return { user, token };
}
