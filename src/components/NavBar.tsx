import { useNavigate, useLocation } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import LoginModal from './LoginModal';

export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading, signOut } = useAuth();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  // Close account dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    }
    if (accountOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [accountOpen]);

  const isActive = (path: string) => location.pathname === path;

  const linkClass = (path: string) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      isActive(path)
        ? 'text-white bg-white/[0.08]'
        : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
    }`;

  return (
    <>
      <nav className="w-full bg-[#0d1117] border-b border-[#1b2130]">
        <div className="max-w-6xl mx-auto flex items-center justify-between h-16 px-6">
          {/* Logo — left */}
          <button
            onClick={() => navigate('/')}
            className="text-white font-bold text-lg tracking-tight shrink-0 hover:opacity-80 transition-opacity"
          >
            FunderMatch
          </button>

          {/* Nav items — right aligned, desktop */}
          <div className="hidden md:flex items-center gap-1">
            <button onClick={() => navigate('/mission')} className={linkClass('/mission')}>
              Find Funders
            </button>
            <button onClick={() => navigate('/search')} className={linkClass('/search')}>
              Browse Database
            </button>

            {!loading && (
              user ? (
                <>
                  <button onClick={() => navigate('/saved')} className={linkClass('/saved')}>
                    Saved Funders
                  </button>

                  {/* Account dropdown */}
                  <div ref={accountRef} className="relative ml-2">
                    <button
                      onClick={() => setAccountOpen(!accountOpen)}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
                    >
                      <span className="max-w-[140px] truncate">
                        {user.email?.split('@')[0]}
                      </span>
                      <ChevronDown size={14} className={`transition-transform ${accountOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {accountOpen && (
                      <div className="absolute right-0 top-full mt-1 w-56 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl py-1 z-50">
                        <div className="px-4 py-2.5 border-b border-[#30363d]">
                          <p className="text-xs text-gray-500 truncate">{user.email}</p>
                        </div>
                        <button
                          onClick={() => { signOut(); setAccountOpen(false); }}
                          className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                        >
                          Sign Out
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <button
                  onClick={() => setShowLoginModal(true)}
                  className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
                >
                  Sign In
                </button>
              )
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden text-gray-400 hover:text-white p-2 -mr-2 transition-colors"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        {/* Mobile menu */}
        {mobileOpen && (
          <div className="md:hidden border-t border-[#1b2130] bg-[#0d1117] px-6 pb-4 pt-2 space-y-1">
            <button
              onClick={() => { navigate('/mission'); setMobileOpen(false); }}
              className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                isActive('/mission') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Find Funders
            </button>
            <button
              onClick={() => { navigate('/search'); setMobileOpen(false); }}
              className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                isActive('/search') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Browse Database
            </button>

            {!loading && (
              user ? (
                <>
                  <button
                    onClick={() => { navigate('/saved'); setMobileOpen(false); }}
                    className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                      isActive('/saved') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    Saved Funders
                  </button>
                  <div className="pt-2 border-t border-[#1b2130] mt-2">
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-xs text-gray-500 truncate">{user.email}</span>
                      <button
                        onClick={() => { signOut(); setMobileOpen(false); }}
                        className="text-sm font-medium text-gray-300 hover:text-white transition-colors"
                      >
                        Sign Out
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <button
                  onClick={() => { setShowLoginModal(true); setMobileOpen(false); }}
                  className="block w-full text-left px-3 py-2.5 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
                >
                  Sign In
                </button>
              )
            )}
          </div>
        )}
      </nav>

      {showLoginModal && (
        <LoginModal onClose={() => setShowLoginModal(false)} />
      )}
    </>
  );
}
