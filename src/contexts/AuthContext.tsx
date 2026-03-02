import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Funder, FunderStatus, SavedFunderEntry } from '../types';

// The OAuth redirect URL must match what is registered in Supabase dashboard
// and in each OAuth provider's allowed redirect URIs.
const REDIRECT_URL = 'https://spikeycoder.github.io/funder-finder/';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingFunder, setPendingFunder] = useState<Funder | null>(null);

  // Ref so callbacks inside onAuthStateChange can read latest values
  const pendingFunderRef = useRef<Funder | null>(null);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const storePendingFunder = (funder?: Funder) => {
    if (!funder) return;
    sessionStorage.setItem(PENDING_FUNDER_KEY, JSON.stringify(funder));
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

  // ── OAuth sign-in ────────────────────────────────────────────────────────────

  const signInWith = async (
    provider: 'google' | 'linkedin_oidc' | 'azure',
    pendingFunderArg?: Funder
  ) => {
    // Stash the pending funder in sessionStorage before the OAuth redirect
    storePendingFunder(pendingFunderArg);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: REDIRECT_URL },
    });
    if (error) throw error;
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
    });

    // Listen for future auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        setSession(newSession);
        setUser(newSession?.user ?? null);

        // After a successful sign-in, auto-save any pending funder
        if (event === 'SIGNED_IN' && newSession?.user) {
          const pending = pendingFunderRef.current ?? loadPendingFunder();
          if (pending) {
            try {
              await saveFunderToDBWithUser(pending, newSession.user.id);
            } catch (e) {
              console.warn('Failed to auto-save pending funder after login:', e);
            } finally {
              clearPendingFunder();
            }
          }
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [clearPendingFunder, saveFunderToDBWithUser]);

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
        saveFunderToDB,
        unsaveFunderFromDB,
        fetchSavedFunders,
        fetchSavedIds,
        fetchSavedEntries,
        updateSavedFunder,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
