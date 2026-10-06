import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Funder } from '../types';

interface LoginModalProps {
  /** Funder the user tried to save before hitting the modal — will be auto-saved after login. */
  pendingFunder?: Funder;
  /** Bulk variant: list of funders ("Add All to My Prospects") to auto-save after login. */
  pendingFunders?: Funder[];
  onClose: () => void;
}

// Provider button definitions
const PROVIDERS = [
  {
    key: 'google' as const,
    label: 'Continue with Google',
    icon: (
      // Google "G" icon (SVG)
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
        <path
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          fill="#4285F4"
        />
        <path
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          fill="#34A853"
        />
        <path
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          fill="#FBBC05"
        />
        <path
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          fill="#EA4335"
        />
      </svg>
    ),
  },
  // LinkedIn login hidden — account disabled (re-enable by uncommenting)
  {
    key: 'microsoft' as const,
    label: 'Continue with Microsoft',
    icon: (
      // Microsoft Windows logo (4 colored squares)
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
        <path d="M11.4 2H2v9.4h9.4V2z" fill="#F25022" />
        <path d="M22 2h-9.4v9.4H22V2z" fill="#7FBA00" />
        <path d="M11.4 12.6H2V22h9.4v-9.4z" fill="#00A4EF" />
        <path d="M22 12.6h-9.4V22H22v-9.4z" fill="#FFB900" />
      </svg>
    ),
  },
] as const;

export default function LoginModal({ pendingFunder, pendingFunders, onClose }: LoginModalProps) {
  const { signInWithGoogle, signInWithMicrosoft } = useAuth();
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleProvider = async (key: 'google' | 'microsoft') => {
    setError(null);
    setLoadingProvider(key);
    try {
      if (key === 'google') await signInWithGoogle(pendingFunder, pendingFunders);
      else await signInWithMicrosoft(pendingFunder, pendingFunders);
      // OAuth redirect will take over — no need to close the modal
    } catch (e) {
      setError('Something went wrong. Please try again.');
      setLoadingProvider(null);
    }
  };

  return createPortal(
    // Backdrop — rendered into document.body so CSS transforms on ancestor
    // elements (e.g. page-fade-in) don't break position: fixed on mobile.
    // items-start + pt-6 anchors the card to the top of the viewport.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm px-4 pt-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        className="relative w-full max-w-sm bg-[#161b22] border border-[#30363d] rounded-2xl p-8 shadow-2xl"
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-300 hover:text-white transition-colors"
          aria-label="Close"
        >
          <X size={20} />
        </button>

        {/* Bookmark icon */}
        <div className="flex justify-center mb-5">
          <div className="bg-blue-900/30 border border-blue-800/50 rounded-xl p-3">
            <svg viewBox="0 0 24 24" className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </div>
        </div>

        {/* Heading */}
        <h2 id="login-modal-title" className="text-xl font-bold text-white text-center mb-2">
          {pendingFunders && pendingFunders.length > 1
            ? `Save ${pendingFunders.length} funders to your prospects`
            : 'Save funders for later'}
        </h2>
        <p className="text-gray-400 text-sm text-center mb-6">
          Create an account or log in to save funders and access your list anytime, on any device.
        </p>

        {/* Provider buttons */}
        <div className="space-y-3">
          {PROVIDERS.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => handleProvider(key)}
              disabled={loadingProvider !== null}
              className="oauth-provider-btn w-full flex items-center justify-center gap-3 bg-white text-gray-900 font-medium rounded-xl px-4 py-3 text-sm border border-[#30363d] hover:bg-gray-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loadingProvider === key ? (
                <Loader2 size={18} className="animate-spin text-gray-600" />
              ) : (
                icon
              )}
              {label}
            </button>
          ))}
        </div>

        {/* Error message */}
        {error && (
          <p role="alert" aria-live="assertive" className="mt-4 text-xs text-red-400 text-center">{error}</p>
        )}

        {/* Not now */}
        <button
          onClick={onClose}
          className="mt-5 w-full text-sm text-gray-300 hover:text-white transition-colors"
        >
          Not now
        </button>
      </div>
    </div>,
    document.body
  );
}
