import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://auth.fundermatch.org';
// This is the public anon key — safe to expose in browser code
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRndG90anZkdWJoanh6eWJtZGV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTA5NTQsImV4cCI6MjA4NzYyNjk1NH0.Wehk_mEUN0G7qzvYKlKbajL1tJqgFqu1joR1DG0M8cs';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Use sessionStorage so the session is cleared when the browser is closed.
    // Users must log in again each new browser session — localStorage is NOT used.
    storage: window.sessionStorage,
    // Pin the storage key to the project ref so it stays consistent regardless of
    // whether the client URL is the Supabase default or a custom domain.
    storageKey: 'sb-tgtotjvdubhjxzybmdex-auth-token',
    // Still persist within the same browser session (across page reloads / navigation)
    persistSession: true,
    // Automatically refresh tokens before they expire
    autoRefreshToken: true,
    // Detect the OAuth redirect and handle it automatically
    detectSessionInUrl: true,
  },
});

interface EdgeFunctionHeaderOptions {
  useAnonOnly?: boolean;
}

export async function getEdgeFunctionHeaders(
  contentType = 'application/json',
  options: EdgeFunctionHeaderOptions = {},
): Promise<Record<string, string>> {
  const { useAnonOnly = false } = options;
  let accessToken = SUPABASE_ANON_KEY;

  if (!useAnonOnly) {
    const { data } = await supabase.auth.getSession();
    accessToken = data.session?.access_token || SUPABASE_ANON_KEY;
  }

  return {
    'Content-Type': contentType,
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
  };
}
