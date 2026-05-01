import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, LogIn, Loader } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import NavBar from '../components/NavBar';

// OAuth provider button definitions (shared with LoginModal)
const PROVIDERS = [
  {
    key: 'google' as const,
    label: 'Continue with Google',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      </svg>
    ),
  },
  {
    key: 'linkedin' as const,
    label: 'Continue with LinkedIn',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#0A66C2" aria-hidden="true">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
    ),
  },
  {
    key: 'microsoft' as const,
    label: 'Continue with Microsoft',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
        <path d="M11.4 2H2v9.4h9.4V2z" fill="#F25022" />
        <path d="M22 2h-9.4v9.4H22V2z" fill="#7FBA00" />
        <path d="M11.4 12.6H2V22h9.4v-9.4z" fill="#00A4EF" />
        <path d="M22 12.6h-9.4V22H22v-9.4z" fill="#FFB900" />
      </svg>
    ),
  },
] as const;

export default function LoginPage() {
  useEffect(() => {
    document.title = 'Sign In | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Sign in to FunderMatch to access saved funders, projects, and grant tools.';
  }, []);

  const navigate = useNavigate();
  const { user, signInWithGoogle, signInWithLinkedIn, signInWithMicrosoft } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [useMagicLink, setUseMagicLink] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  // Redirect if already authenticated
  useEffect(() => {
    if (user) {
      const redirectUrl = sessionStorage.getItem('authRedirect') || '/dashboard';
      sessionStorage.removeItem('authRedirect');
      navigate(redirectUrl);
    }
  }, [user, navigate]);

  const handleOAuth = async (key: 'google' | 'linkedin' | 'microsoft') => {
    setError('');
    setLoadingProvider(key);
    try {
      if (key === 'google') await signInWithGoogle();
      else if (key === 'linkedin') await signInWithLinkedIn();
      else await signInWithMicrosoft();
    } catch {
      setError('Something went wrong. Please try again.');
      setLoadingProvider(null);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        setLoading(false);
        return;
      }
      const redirectUrl = sessionStorage.getItem('authRedirect') || '/dashboard';
      sessionStorage.removeItem('authRedirect');
      navigate(redirectUrl);
    } catch {
      setError('An unexpected error occurred');
      setLoading(false);
    }
  };

  const handleMagicLinkLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({ email });
      if (otpError) {
        setError(otpError.message);
        setLoading(false);
        return;
      }
      setMagicLinkSent(true);
      setLoading(false);
    } catch {
      setError('An unexpected error occurred');
      setLoading(false);
    }
  };

  return (
    <>
      <NavBar />
      <main id="main-content" className="min-h-screen bg-[#0d1117] flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-8">
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-white mb-2">Welcome back</h1>
              <p className="text-gray-400">Sign in to your FunderMatch account</p>
            </div>

            {/* OAuth Buttons */}
            <div className="space-y-3 mb-6">
              {PROVIDERS.map(({ key, label, icon }) => (
                <button
                  key={key}
                  onClick={() => handleOAuth(key)}
                  disabled={loadingProvider !== null || loading}
                  className="w-full flex items-center justify-center gap-3 bg-white text-gray-900 font-medium rounded-xl px-4 py-3 text-sm hover:bg-gray-100 transition-colors disabled:opacity-60"
                >
                  {loadingProvider === key ? <Loader size={18} className="animate-spin" /> : icon}
                  {label}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="relative mb-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#30363d]" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-[#161b22] text-gray-400">Or continue with email</span>
              </div>
            </div>

            {magicLinkSent && (
              <div className="mb-6 p-4 bg-green-900/20 border border-green-700 rounded-lg">
                <p className="text-green-400 text-sm">Check your email for a login link. You can close this page.</p>
              </div>
            )}

            {error && (
              <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {!magicLinkSent && (
              <form onSubmit={useMagicLink ? handleMagicLinkLogin : handlePasswordLogin} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-white mb-2">Email address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      placeholder="you@nonprofit.org"
                      className="w-full pl-10 pr-4 py-2.5 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {!useMagicLink && (
                  <div>
                    <label htmlFor="password" className="block text-sm font-medium text-white mb-2">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                      <input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        placeholder="Enter your password"
                        className="w-full pl-10 pr-4 py-2.5 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full mt-2 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
                >
                  {loading ? (
                    <><Loader className="w-5 h-5 animate-spin" /> Signing in...</>
                  ) : (
                    <><LogIn className="w-5 h-5" /> {useMagicLink ? 'Send magic link' : 'Sign in'}</>
                  )}
                </button>

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => { setUseMagicLink(!useMagicLink); setPassword(''); setError(''); }}
                    className="text-sm text-blue-400 hover:text-blue-300"
                  >
                    {useMagicLink ? 'Sign in with password instead' : 'Sign in with magic link'}
                  </button>
                </div>
              </form>
            )}

            <div className="mt-6 text-center">
              <p className="text-gray-400 text-sm">
                Don't have an account?{' '}
                <Link to="/signup" className="text-blue-400 hover:text-blue-300 font-medium">Sign up</Link>
              </p>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
