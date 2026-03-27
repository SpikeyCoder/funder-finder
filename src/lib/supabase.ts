import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';

// Custom domain used only for OAuth branding (browser redirects).
// API calls still go through the default Supabase domain for reliability.
export const SUPABASE_CUSTOM_DOMAIN = 'https://auth.fundermatch.org';
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
    // getSession() returns the cached session which may have an expired access_token.
    // Check the expiry and refresh proactively so edge functions don't get a 401.
    const { data } = await supabase.auth.getSession();
    const session = data.session;

    if (session) {
      const expiresAt = session.expires_at ?? 0; // epoch seconds
      const nowSecs = Math.floor(Date.now() / 1000);
      const bufferSecs = 60; // refresh if <60 s left

      if (expiresAt - nowSecs < bufferSecs) {
        // Token expired or about to — force a refresh
        const { data: refreshed } = await supabase.auth.refreshSession();
        accessToken = refreshed.session?.access_token || SUPABASE_ANON_KEY;
      } else {
        accessToken = session.access_token;
      }
    }
  }

  return {
    'Content-Type': contentType,
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
  };
}
