import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, SUPABASE_CUSTOM_DOMAIN } from '../lib/supabase';
import { BudgetBand, Funder, FunderStatus, SavedFunderEntry } from '../types';

// The OAuth redirect URL must match what is registered in Supabase dashboard
// and in each OAuth provider's allowed redirect URIs.
const REDIRECT_URL = 'https://fundermatch.org/';

// ── Profile type ─────────────────────────────────────────────────────────────

export interface UserProfile {
  mission_statement: string | null;
  location_served: string | null;
  budget_range: BudgetBand | null;
  organization_name: string | null;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;

  /** Sign in with an OAuth provider. Saves pendingFunder first so it is
   *  auto-saved after the redirect completes. */
  signInWithGoogle: (pendingFunder?: Funder) => Promise<void>;
  signInWithLinkedIn: (pendingFunder?: Funder) => Promise<void>;
  signInWithMicrosoft: (pendingFunder?: Funder) => Promise<void>;
  signOut: () => Promise<void>;

  /** Funder the user tried to save before being prompted to log in.
   *  Cleared after it has been saved post-login. */
  pendingFunder: Funder | null;
  clearPendingFunder: () => void;

  /** Set to a path (e.g. '/saved') after a pending funder is auto-saved
   *  post-login. Consumed by AnimatedRoutes to trigger navigation. */
  postLoginRedirect: string | null;
  clearPostLoginRedirect: () => void;

  /** Persist a funder to the database for the current user. */
  saveFunderToDB: (funder: Funder) => Promise<void>;
  /** Remove a funder from the database for the current user. */
  unsaveFunderFromDB: (funderId: string) => Promise<void>;
  /** Fetch all saved funders for the current user from the database. */
  fetchSavedFunders: () => Promise<Funder[]>;
  /** Fetch saved funder IDs only (lightweight, used for badge indicators). */
  fetchSavedIds: () => Promise<string[]>;
  /** Fetch saved funders with status and notes. */
  fetchSavedEntries: () => Promise<SavedFunderEntry[]>;
  /** Update status and/or notes for a saved funder. */
  updateSavedFunder: (funderId: string, updates: { status?: FunderStatus; notes?: string }) => Promise<void>;

  /** User profile (mission, location, budget) — loaded on auth. */
  userProfile: UserProfile | null;
  /** Whether the profile has been loaded from DB (false during initial fetch). */
  profileLoaded: boolean;
  /** Save/update profile fields to the DB and update local state. */
  saveUserProfile: (fields: Partial<UserProfile>) => Promise<void>;
  /** Reload profile from DB. */
  refreshUserProfile: () => Promise<void>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

const PENDING_FUNDER_KEY = 'ff_pending_funder';
// Durable fallback: set before OAuth redirect, read by AnimatedRoutes on mount.
// Survives the page reload that comes with OAuth without relying on React state timing.
const REDIRECT_AFTER_LOGIN_KEY = 'ff_redirect_after_login';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingFunder, setPendingFunder] = useState<Funder | null>(null);
  const [postLoginRedirect, setPostLoginRedirect] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // Ref so callbacks inside onAuthStateChange can read latest values
  const pendingFunderRef = useRef<Funder | null>(null);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const storePendingFunder = (funder?: Funder) => {
    if (!funder) return;
    sessionStorage.setItem(PENDING_FUNDER_KEY, JSON.stringify(funder));
    // Also write the redirect target so AnimatedRoutes can read it directly
    // from sessionStorage on mount — this survives the OAuth page reload even
    // if the SIGNED_IN event fires before any React subscriber is registered.
    sessionStorage.setItem(REDIRECT_AFTER_LOGIN_KEY, '/saved');
    setPendingFunder(funder);
    pendingFunderRef.current = funder;
  };

  const loadPendingFunder = (): Funder | null => {
    try {
      const raw = sessionStorage.getItem(PENDING_FUNDER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const clearPendingFunder = useCallback(() => {
    sessionStorage.removeItem(PENDING_FUNDER_KEY);
    setPendingFunder(null);
    pendingFunderRef.current = null;
  }, []);

  const clearPostLoginRedirect = useCallback(() => {
    setPostLoginRedirect(null);
  }, []);

  // ── DB operations ────────────────────────────────────────────────────────────

  const saveFunderToDB = useCallback(async (funder: Funder) => {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const { error } = await supabase.from('saved_funders').upsert(
      { user_id: userId, funder_id: funder.id, funder_data: funder },
      { onConflict: 'user_id,funder_id' }
    );
    if (error) throw error;
  }, []);

  const saveFunderToDBWithUser = useCallback(async (funder: Funder, userId: string) => {
    const { error } = await supabase.from('saved_funders').upsert(
      { user_id: userId, funder_id: funder.id, funder_data: funder },
      { onConflict: 'user_id,funder_id' }
    );
    if (error) throw error;
  }, []);

  const unsaveFunderFromDB = useCallback(async (funderId: string) => {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) return;
    const { error } = await supabase
      .from('saved_funders')
      .delete()
      .eq('user_id', userId)
      .eq('funder_id', funderId);
    if (error) throw error;
  }, []);

  const fetchSavedFunders = useCallback(async (): Promise<Funder[]> => {
    const { data, error } = await supabase
      .from('saved_funders')
      .select('funder_data, saved_at')
      .order('saved_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row: any) => row.funder_data as Funder);
  }, []);

  const fetchSavedIds = useCallback(async (): Promise<string[]> => {
    const { data, error } = await supabase
      .from('saved_funders')
      .select('funder_id');
    if (error) throw error;
    return (data ?? []).map((row: any) => row.funder_id as string);
  }, []);

  const fetchSavedEntries = useCallback(async (): Promise<SavedFunderEntry[]> => {
    const { data, error } = await supabase
      .from('saved_funders')
      .select('funder_data, status, notes, saved_at')
      .order('saved_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row: any) => ({
      funder: row.funder_data as Funder,
      status: (row.status ?? 'researching') as FunderStatus,
      notes: row.notes ?? '',
      savedAt: row.saved_at ?? '',
    }));
  }, []);

  const updateSavedFunder = useCallback(async (
    funderId: string,
    updates: { status?: FunderStatus; notes?: string }
  ) => {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const { error } = await supabase
      .from('saved_funders')
      .update(updates)
      .eq('user_id', userId)
      .eq('funder_id', funderId);
    if (error) throw error;
  }, []);

  // ── User profile ─────────────────────────────────────────────────────────────

  const loadUserProfile = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('mission_statement, location_served, budget_range, organization_name')
        .eq('id', userId)
        .maybeSingle();
      if (error) { console.warn('Failed to load profile:', error); return; }
      if (data) {
        setUserProfile({
          mission_statement: data.mission_statement ?? null,
          location_served: data.location_served ?? null,
          budget_range: data.budget_range ?? null,
          organization_name: data.organization_name ?? null,
        });
      }
    } finally {
      setProfileLoaded(true);
    }
  }, []);

  const saveUserProfile = useCallback(async (fields: Partial<UserProfile>) => {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const { error } = await supabase
      .from('user_profiles')
      .upsert({ id: userId, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) throw error;
    // Update local state optimistically
    setUserProfile(prev => prev ? { ...prev, ...fields } : {
      mission_statement: null, location_served: null, budget_range: null, organization_name: null,
      ...fields,
    });
  }, []);

  const refreshUserProfile = useCallback(async () => {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) return;
    await loadUserProfile(userId);
  }, [loadUserProfile]);

  // ── OAuth sign-in ────────────────────────────────────────────────────────────

  const signInWith = async (
    provider: 'google' | 'linkedin_oidc' | 'azure',
    pendingFunderArg?: Funder
  ) => {
    // Stash the pending funder in sessionStorage before the OAuth redirect
    storePendingFunder(pendingFunderArg);

    // Get the OAuth URL without redirecting. The Supabase client builds the
    // authorize URL using the default project domain. We then swap it to the
    // branded custom domain so users see "auth.fundermatch.org" on the
    // provider consent screen instead of the raw Supabase project ID.
    // API calls (including the PKCE token exchange) still go through the
    // default domain which has reliable CORS support.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: REDIRECT_URL,
        skipBrowserRedirect: true,
      },
    });
    if (error) throw error;

    if (data?.url) {
      // Swap to the branded custom domain for Google & LinkedIn so users see
      // "auth.fundermatch.org" on the consent screen. Skip the swap for
      // Microsoft/Azure — Azure's callback routing causes OAuth state cookie
      // mismatches when the authorize and callback domains differ.
      const branded = provider === 'azure'
        ? data.url
        : data.url.replace(
            'tgtotjvdubhjxzybmdex.supabase.co',
            new URL(SUPABASE_CUSTOM_DOMAIN).hostname,
          );
      window.location.href = branded;
    }
  };

  const signInWithGoogle = (pendingFunder?: Funder) => signInWith('google', pendingFunder);
  const signInWithLinkedIn = (pendingFunder?: Funder) => signInWith('linkedin_oidc', pendingFunder);
  const signInWithMicrosoft = (pendingFunder?: Funder) => signInWith('azure', pendingFunder);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  // ── Session bootstrap & auth state changes ────────────────────────────────────

  useEffect(() => {
    // Load the pending funder that may have been stored before an OAuth redirect
    const stored = loadPendingFunder();
    if (stored) {
      setPendingFunder(stored);
      pendingFunderRef.current = stored;
    }

    // Get the initial session (handles the OAuth redirect fragment automatically)
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      // Load profile for authenticated user
      if (session?.user) loadUserProfile(session.user.id);
      else setProfileLoaded(true);
    });

    // Listen for future auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        setSession(newSession);
        setUser(newSession?.user ?? null);

        // Clear profile on sign-out
        if (!newSession?.user) {
          setUserProfile(null);
          setProfileLoaded(true);
        }

        // After a successful sign-in, auto-save any pending funder.
        //
        // We check BOTH 'SIGNED_IN' and 'INITIAL_SESSION' because Supabase v2
        // processes the OAuth auth code during client initialisation (before any
        // React component has mounted).  That means the SIGNED_IN event fires
        // with zero subscribers; by the time onAuthStateChange is registered in
        // useEffect, Supabase replays the session as INITIAL_SESSION instead.
        // Checking both events ensures we catch the pending funder regardless of
        // which event arrives first.  The `if (pending)` guard prevents spurious
        // saves for ordinary page-loads where no pending funder exists.
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && newSession?.user) {
          const pending = pendingFunderRef.current ?? loadPendingFunder();
          if (pending) {
            try {
              await saveFunderToDBWithUser(pending, newSession.user.id);
            } catch (e) {
              console.warn('Failed to auto-save pending funder after login:', e);
            } finally {
              clearPendingFunder();
              // Signal the router to navigate to /saved whether or not the DB
              // save succeeded — the funder may already be persisted from a
              // previous attempt, and the user should always land on their list.
              setPostLoginRedirect('/saved');
            }
          }
          // Load user profile on sign-in
          loadUserProfile(newSession.user.id);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [clearPendingFunder, saveFunderToDBWithUser, loadUserProfile]);

  // ── Value ─────────────────────────────────────────────────────────────────────

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signInWithGoogle,
        signInWithLinkedIn,
        signInWithMicrosoft,
        signOut,
        pendingFunder,
        clearPendingFunder,
        postLoginRedirect,
        clearPostLoginRedirect,
        saveFunderToDB,
        unsaveFunderFromDB,
        fetchSavedFunders,
        fetchSavedIds,
        fetchSavedEntries,
        updateSavedFunder,
        userProfile,
        profileLoaded,
        saveUserProfile,
        refreshUserProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
