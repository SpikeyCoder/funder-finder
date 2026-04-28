/**
 * QuickSaveButton
 *
 * Save/unsave toggle that requires authentication. Anonymous users see a
 * LoginModal; the funder is auto-saved post-login. Authenticated users persist
 * to Supabase via AuthContext. No localStorage fallback.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Funder } from '../types';
import Toast from './Toast';
import LoginModal from './LoginModal';

interface QuickSaveButtonProps {
  /** Minimal funder data needed for saving.  On Browse the full Funder object
   *  may not be available, so we accept a partial and fill defaults. */
  funder: Funder;
  className?: string;
  /** Compact mode renders a smaller button (for table rows). */
  compact?: boolean;
}

const QuickSaveButton: React.FC<QuickSaveButtonProps> = ({ funder, className = '', compact = false }) => {
  const { user, saveFunderToDB, unsaveFunderFromDB, fetchSavedIds } = useAuth();
  const navigate = useNavigate();

  const [saved, setSaved] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [busy, setBusy] = useState(false);

  // Initial saved state — from Supabase for authenticated users; never from
  // localStorage. Anonymous users see the unsaved state until they log in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (user) {
        try {
          const ids = await fetchSavedIds();
          if (!cancelled) setSaved(ids.includes(funder.id));
        } catch {
          if (!cancelled) setSaved(false);
        }
      } else {
        setSaved(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, funder.id, fetchSavedIds]);

  const toggle = useCallback(async () => {
    if (busy) return;

    // Auth gate — anonymous users must sign in to save. The funder is stashed
    // in the LoginModal flow so it is auto-saved to Supabase after login.
    if (!user) {
      setShowLogin(true);
      return;
    }

    setBusy(true);
    try {
      if (saved) {
        await unsaveFunderFromDB(funder.id);
        setSaved(false);
      } else {
        await saveFunderToDB(funder);
        setSaved(true);
        setToastMsg('Funder saved!');
      }
    } catch (err) {
      console.error('Save toggle failed:', err);
    } finally {
      setBusy(false);
    }
  }, [user, saved, funder, busy, saveFunderToDB, unsaveFunderFromDB]);

  const baseClasses = compact
    ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors min-h-[36px]'
    : 'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors';

  const colorClasses = saved
    ? 'border border-blue-600 text-blue-400 bg-blue-900/20 hover:bg-blue-900/30'
    : 'border border-[#30363d] text-gray-300 hover:bg-[#21262d]';

  return (
    <>
      <button
        onClick={toggle}
        disabled={busy}
        className={`${baseClasses} ${colorClasses} disabled:opacity-50 ${className}`}
      >
        {saved ? <BookmarkCheck size={compact ? 14 : 16} /> : <Bookmark size={compact ? 14 : 16} />}
        {saved ? 'Saved' : 'Save'}
      </button>

      {toastMsg && (
        <Toast
          message={toastMsg}
          action={{ label: 'View saved', onClick: () => { setToastMsg(null); navigate('/saved'); } }}
          onClose={() => setToastMsg(null)}
        />
      )}

      {showLogin && (
        <LoginModal
          pendingFunder={funder}
          onClose={() => setShowLogin(false)}
        />
      )}
    </>
  );
};

export default QuickSaveButton;
