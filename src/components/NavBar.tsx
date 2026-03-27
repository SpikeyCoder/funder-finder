import { useNavigate, useLocation } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';
import { Menu, X, ChevronDown, Heart } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading, signOut } = useAuth();
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

  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path + '/');

  const linkClass = (path: string) =>
    `px-4 py-2 min-h-[44px] flex items-center text-sm font-medium rounded-lg transition-colors ${
      isActive(path)
        ? 'text-white bg-white/[0.08]'
        : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
    }`;

  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-blue-600 focus:text-white focus:px-4 focus:py-2 focus:rounded">
        Skip to main content
      </a>
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
            <button onClick={() => navigate('/browse')} className={linkClass('/browse')}>
              Browse Grants
            </button>
            <button onClick={() => navigate('/search')} className={linkClass('/search')}>
              Search
            </button>

            {!loading && (
              user ? (
                <>
                  <button onClick={() => navigate('/saved')} className={linkClass('/saved')}>
                    <Heart size={14} className="mr-1.5" />
                    Saved
                  </button>
                  <button onClick={() => navigate('/dashboard')} className={linkClass('/dashboard')}>
                    Dashboard
                  </button>
                  <button onClick={() => navigate('/portfolio')} className={linkClass('/portfolio')}>
                    Portfolio
                  </button>
                  <button onClick={() => navigate('/tasks')} className={linkClass('/tasks')}>
                    Tasks
                  </button>

                  {/* Account dropdown */}
                  <div ref={accountRef} className="relative ml-2">
                    <button
                      onClick={() => setAccountOpen(!accountOpen)}
                      className="flex items-center gap-1.5 px-4 py-2 min-h-[44px] text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
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
                          onClick={() => { navigate('/settings/team'); setAccountOpen(false); }}
                          className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                        >
                          Team
                        </button>
                        <button
                          onClick={() => { navigate('/settings'); setAccountOpen(false); }}
                          className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                        >
                          Settings
                        </button>
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
                  onClick={() => navigate('/login')}
                  className="px-4 py-2 min-h-[44px] flex items-center text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
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
              onClick={() => { navigate('/browse'); setMobileOpen(false); }}
              className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                isActive('/browse') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Browse Grants
            </button>
            <button
              onClick={() => { navigate('/search'); setMobileOpen(false); }}
              className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                isActive('/search') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Search
            </button>

            {!loading && (
              user ? (
                <>
                  <button
                    onClick={() => { navigate('/saved'); setMobileOpen(false); }}
                    className={`w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                      isActive('/saved') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    <Heart size={14} />
                    Saved Funders
                  </button>
                  <button
                    onClick={() => { navigate('/dashboard'); setMobileOpen(false); }}
                    className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                      isActive('/dashboard') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    Dashboard
                  </button>
                  <button
                    onClick={() => { navigate('/portfolio'); setMobileOpen(false); }}
                    className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                      isActive('/portfolio') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    Portfolio
                  </button>
                  <button
                    onClick={() => { navigate('/tasks'); setMobileOpen(false); }}
                    className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                      isActive('/tasks') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    Tasks
                  </button>
                  <div className="pt-2 border-t border-[#1b2130] mt-2 space-y-1">
                    <button
                      onClick={() => { navigate('/settings/team'); setMobileOpen(false); }}
                      className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                        isActive('/settings/team') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                      }`}
                    >
                      Team
                    </button>
                    <button
                      onClick={() => { navigate('/settings'); setMobileOpen(false); }}
                      className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                        isActive('/settings') && !isActive('/settings/team') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                      }`}
                    >
                      Settings
                    </button>
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
                  onClick={() => { navigate('/login'); setMobileOpen(false); }}
                  className="block w-full text-left px-3 py-2.5 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
                >
                  Sign In
                </button>
              )
            )}
          </div>
        )}
      </nav>

    </>
  );
}
