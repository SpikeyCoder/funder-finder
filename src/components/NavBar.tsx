import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

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
      <nav aria-label="Main navigation" className="sticky top-0 z-40 w-full bg-[#0d1117] border-b border-[#1b2130]">
        <div className="max-w-6xl mx-auto flex items-center justify-between h-16 px-6">
          <Link to="/" className="text-white font-bold text-lg tracking-tight shrink-0 hover:opacity-80 transition-opacity">FunderMatch</Link>
          <div className="hidden md:flex items-center gap-1">
            <Link to="/mission" className={linkClass('/mission')}>Find Funders</Link>
            {!loading && user && (
              <Link to="/saved" className={linkClass('/saved')}>Saved Funders</Link>
            )}
            <Link to="/browse" className={linkClass('/browse')}>Browse Grants</Link>
            <Link to="/search" className={linkClass('/search')}>Search</Link>
            {!loading && (user ? (
              <>
                <Link to="/dashboard" className={linkClass('/dashboard')}>Dashboard</Link>
                <Link to="/portfolio" className={linkClass('/portfolio')}>Portfolio</Link>
                <Link to="/tasks" className={linkClass('/tasks')}>Tasks</Link>
                <div ref={accountRef} className="relative ml-2">
                  <button onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen} aria-haspopup="true" className="flex items-center gap-1.5 px-4 py-2 min-h-[44px] text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors">
                    <span className="max-w-[140px] truncate">{user.email?.split('@')[0]}</span>
                    <ChevronDown size={14} className={`transition-transform ${accountOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {accountOpen && (
                    <div className="absolute right-0 top-full mt-1 w-56 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl py-1 z-50" role="menu">
                      <div className="px-4 py-2.5 border-b border-[#30363d]"><p className="text-xs text-gray-500 truncate">{user.email}</p></div>
                      <button role="menuitem" onClick={() => { navigate('/import'); setAccountOpen(false); }} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors">Import Data</button>
                      <button role="menuitem" onClick={() => { navigate('/settings/team'); setAccountOpen(false); }} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors">Team</button>
                      <button role="menuitem" onClick={() => { navigate('/settings'); setAccountOpen(false); }} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors">Settings</button>
                      <button role="menuitem" onClick={() => { signOut(); setAccountOpen(false); }} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors">Sign Out</button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Link to="/login" className="px-4 py-2 min-h-[44px] flex items-center text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors">Sign In</Link>
            ))}
          </div>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="md:hidden text-gray-400 hover:text-white p-2 -mr-2 transition-colors" aria-label="Toggle menu" aria-expanded={mobileOpen}>
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
        {mobileOpen && (
          <div className="md:hidden border-t border-[#1b2130] bg-[#0d1117] px-6 pb-4 pt-2 space-y-1">
            <Link to="/mission" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/mission') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Find Funders</Link>
            {!loading && user && (
              <Link to="/saved" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/saved') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Saved Funders</Link>
            )}
            <Link to="/browse" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/browse') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Browse Grants</Link>
            <Link to="/search" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/search') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Search</Link>
            {!loading && (user ? (
              <>
                <Link to="/dashboard" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/dashboard') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Dashboard</Link>
                <Link to="/portfolio" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/portfolio') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Portfolio</Link>
                <Link to="/tasks" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/tasks') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Tasks</Link>
                <div className="pt-2 border-t border-[#1b2130] mt-2 space-y-1">
                  <Link to="/import" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/import') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Import Data</Link>
                  <Link to="/settings/team" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/settings/team') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Team</Link>
                  <Link to="/settings" onClick={() => setMobileOpen(false)} className={`block w-full text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${isActive('/settings') && !isActive('/settings/team') ? 'text-white bg-white/[0.08]' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'}`}>Settings</Link>
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-xs text-gray-500 truncate">{user.email}</span>
                    <button onClick={() => { signOut(); setMobileOpen(false); }} className="text-sm font-medium text-gray-300 hover:text-white transition-colors">Sign Out</button>
                  </div>
                </div>
              </>
            ) : (
              <Link to="/login" onClick={() => setMobileOpen(false)} className="block w-full text-left px-3 py-2.5 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors">Sign In</Link>
            ))}
          </div>
        )}
      </nav>
    </>
  );
}
