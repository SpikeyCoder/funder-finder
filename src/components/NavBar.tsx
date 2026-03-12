import { useNavigate, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import LoginModal from './LoginModal';

export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading, signOut } = useAuth();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks = [
    { label: 'Find Funders', path: '/mission' },
    { label: 'Browse Database', path: '/search' },
    { label: 'Saved', path: '/saved' },
  ];

  const isActive = (path: string) => location.pathname === path;

  return (
    <>
      <nav className="w-full bg-[#0d1117] border-b border-[#1b2130]">
        <div className="max-w-6xl mx-auto flex items-center justify-between h-16 px-6">
          {/* Logo */}
          <button
            onClick={() => navigate('/')}
            className="text-white font-bold text-lg tracking-tight shrink-0 hover:opacity-80 transition-opacity"
          >
            FunderMatch
          </button>

          {/* Center nav links — desktop */}
          <div className="hidden md:flex items-center gap-1">
            {navLinks.map(link => (
              <button
                key={link.path}
                onClick={() => navigate(link.path)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  isActive(link.path)
                    ? 'text-white bg-white/[0.08]'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                {link.label}
              </button>
            ))}
          </div>

          {/* Right actions — desktop */}
          <div className="hidden md:flex items-center gap-3 shrink-0">
            {!loading && (
              user ? (
                <>
                  <span className="text-xs text-gray-500 max-w-[160px] truncate">
                    {user.email}
                  </span>
                  <button
                    onClick={signOut}
                    className="text-sm font-medium text-white bg-white/[0.08] border border-white/[0.12] rounded-lg px-5 py-2 hover:bg-white/[0.14] transition-colors"
                  >
                    Sign Out
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowLoginModal(true)}
                  className="text-sm font-medium text-white bg-white/[0.08] border border-white/[0.12] rounded-lg px-5 py-2 hover:bg-white/[0.14] transition-colors"
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
            {navLinks.map(link => (
              <button
                key={link.path}
                onClick={() => { navigate(link.path); setMobileOpen(false); }}
                className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                  isActive(link.path)
                    ? 'text-white bg-white/[0.08]'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                {link.label}
              </button>
            ))}
            <div className="pt-2 border-t border-[#1b2130] mt-2">
              {!loading && (
                user ? (
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-xs text-gray-500 truncate">{user.email}</span>
                    <button
                      onClick={() => { signOut(); setMobileOpen(false); }}
                      className="text-sm font-medium text-gray-300 hover:text-white transition-colors"
                    >
                      Sign Out
                    </button>
                  </div>
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
          </div>
        )}
      </nav>

      {showLoginModal && (
        <LoginModal onClose={() => setShowLoginModal(false)} />
      )}
    </>
  );
}
