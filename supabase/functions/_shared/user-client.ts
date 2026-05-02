/**
 * User-scoped Supabase client factory for Phase 1 Edge Function migration.
 * 
 * Extracts JWT from Authorization header and creates a Supabase client
 * scoped to the authenticated user. This replaces direct SERVICE_ROLE_KEY
 * usage for operations that should be user-authenticated.
 * 
 * Usage:
 *   const { supabase, user } = await createUserScopedClient(req);
 *   const { data } = await supabase.from('table').select('*');
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

interface UserScopedClientResult {
  supabase: ReturnType<typeof createClient>;
  user: any;
}

/**
 * Creates a user-scoped Supabase client from the Authorization header.
 * 
 * @param req - The Deno.serve Request object
 * @returns Promise with { supabase, user } where supabase is scoped to the user's JWT
 * @throws Error if Authorization header is missing, malformed, or user cannot be verified
 */
export async function createUserScopedClient(
  req: Request
): Promise<UserScopedClientResult> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL environment variable not set');
  }

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

  // Use SUPABASE_ANON_KEY to create client, then verify JWT
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseAnonKey) {
    throw new Error('SUPABASE_ANON_KEY environment variable not set');
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  });

  // Verify the JWT and extract user info
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw new Error(`JWT verification failed: ${error?.message || 'User not found'}`);
  }

  return { supabase, user };
}

/**
 * Alternative: Extract JWT from request and verify without creating client.
 * Useful for validation-only scenarios or when you need the token separately.
 */
export async function extractAndVerifyJWT(req: Request): Promise<{ user: any; token: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL environment variable not set');
  }

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

  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseAnonKey) {
    throw new Error('SUPABASE_ANON_KEY environment variable not set');
  }

  const tempClient = createClient(supabaseUrl, supabaseAnonKey);
  const { data: { user }, error } = await tempClient.auth.getUser(token);

  if (error || !user) {
    throw new Error(`JWT verification failed: ${error?.message || 'User not found'}`);
  }

  return { user, token };
}
