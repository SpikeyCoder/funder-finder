import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Building2, Users, Loader2, SearchX, AlertCircle } from 'lucide-react';
import { OrgSearchResult } from '../types';
import { searchOrganizations } from '../utils/matching';
import { fmtDollar } from './InsightCharts';

interface OrgSearchProps {
  autoFocus?: boolean;
  placeholder?: string;
  initialQuery?: string;
}

export default function OrgSearch({ autoFocus = false, placeholder = 'Search funders & recipients by name or EIN...', initialQuery = '' }: OrgSearchProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<OrgSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // Outcome of the latest completed search, so a miss or a failure is shown
  // instead of the dropdown silently staying closed.
  const [status, setStatus] = useState<'idle' | 'results' | 'empty' | 'error'>('idle');
  // The query `status` describes, which lags `query` while a search is pending.
  const [searchedQuery, setSearchedQuery] = useState('');
  const [retryNonce, setRetryNonce] = useState(0);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Set when the user closes the dropdown (Escape / outside click) so a search
  // still in flight doesn't pop it back open; cleared when they type or refocus.
  const dismissedRef = useRef(false);

  // Whitespace-only edits shouldn't abort and resend an identical search.
  const trimmedQuery = query.trim();

  useEffect(() => {
    // The highlighted row belongs to the previous results.
    setSelectedIdx(-1);

    if (trimmedQuery.length < 2) {
      setResults([]);
      setStatus('idle');
      setLoading(false);
      setShowDropdown(false);
      return;
    }

    setLoading(true);
    // Aborted by the cleanup when the query changes, a retry starts or the
    // component unmounts, so a stale response never lands.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const searched = trimmedQuery;
      try {
        const data = await searchOrganizations(searched, 15, controller.signal);
        if (controller.signal.aborted) return;
        setSearchedQuery(searched);
        setResults(data);
        setStatus(data.length > 0 ? 'results' : 'empty');
      } catch {
        if (controller.signal.aborted) return;
        setSearchedQuery(searched);
        setResults([]);
        setStatus('error');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          // A slow response shouldn't pop the panel back up after Escape or an
          // outside click.
          if (!dismissedRef.current) setShowDropdown(true);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery, retryNonce]);

  // Close dropdown on outside click
  useEffect(() => {
    // Also counts before the first response has opened the dropdown.
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inputRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      // Dragging the page scrollbar doesn't blur the input; it isn't a
      // dismissal. (Scrollbars sit outside the viewport's client area.)
      const root = document.documentElement;
      if (e.clientX >= root.clientWidth || e.clientY >= root.clientHeight) return;
      dismissedRef.current = true;
      setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const reopenDropdown = () => {
    dismissedRef.current = false;
    if (status !== 'idle') setShowDropdown(true);
  };

  const handleSelect = (result: OrgSearchResult) => {
    setShowDropdown(false);
    setQuery('');
    if (result.entity_type === 'funder') {
      navigate(`/funder/${result.id}`);
    } else {
      navigate(`/recipient/${result.id}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Escape counts even before the first response opens the dropdown.
    if (e.key === 'Escape') {
      dismissedRef.current = true;
      setShowDropdown(false);
      return;
    }
    // Once the text differs from the query these rows came from, they're stale;
    // don't act on a keyboard highlight the user may not be looking at. Both
    // values come from this render, so a fast Enter can't slip past (a
    // `loading` flag set in an effect lags by a render). A mouse click on a
    // visible row is an explicit choice and still works.
    if (!showDropdown || searchedQuery !== trimmedQuery) return;
    if (status !== 'results') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      handleSelect(results[selectedIdx]);
    }
  };

  return (
    <div className="relative w-full">
      <div className="relative">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => { dismissedRef.current = false; setQuery(e.target.value); }}
          onFocus={reopenDropdown}
          // Clicking an already-focused input doesn't fire focus; reopen too.
          onMouseDown={reopenDropdown}
          // Moving focus to another control (e.g. Tab) counts as dismissing, so
          // a late response doesn't open the panel over it. A blur with no new
          // focus target — hiding the mobile keyboard — doesn't: results
          // should still appear.
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && !dropdownRef.current?.contains(next)) dismissedRef.current = true;
          }}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label="Search by organization name or EIN"
          className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-11 pr-10 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-600 transition-colors"
        />
        {loading && (
          <Loader2 size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 animate-spin" />
        )}
      </div>

      {/* Persistent live region: screen readers announce changes inside a
          region that already exists, not one mounted along with its text. */}
      <div role="status" aria-live="polite" className="sr-only">
        {/* Includes the query so a new search with the same count is still
            announced. */}
        {status === 'empty' && `No organizations match ${searchedQuery}`}
        {status === 'error' && `Search for ${searchedQuery} is temporarily unavailable.`}
        {status === 'results' &&
          `${results.length} organization${results.length === 1 ? '' : 's'} found for ${searchedQuery}`}
      </div>

      {showDropdown && status !== 'idle' && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-2 bg-[#161b22] border border-[#30363d] rounded-xl shadow-xl overflow-hidden max-h-80 overflow-y-auto"
        >
          {status === 'empty' && (
            <div className="flex items-start gap-3 px-4 py-4 text-left">
              <SearchX size={16} className="text-gray-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-white">No organizations match &ldquo;{searchedQuery}&rdquo;</p>
                <p className="text-xs text-gray-400 mt-1">
                  Try a shorter name, a different spelling, or search by EIN.
                </p>
              </div>
            </div>
          )}
          {status === 'error' && (
            <div className="flex items-start gap-3 px-4 py-4 text-left">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-white">
                  Search for &ldquo;{searchedQuery}&rdquo; is temporarily unavailable.
                </p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    // Clear the error while the retry runs; the input's spinner
                    // shows progress, and focus there lets the result reopen.
                    setStatus('idle');
                    inputRef.current?.focus();
                    setRetryNonce((n) => n + 1);
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300 mt-1 underline disabled:opacity-50 disabled:no-underline"
                >
                  Try again
                </button>
              </div>
            </div>
          )}
          {status === 'results' && results.map((r, idx) => (
            <button
              key={`${r.entity_type}-${r.id}`}
              onClick={() => handleSelect(r)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#21262d] transition-colors ${
                idx === selectedIdx ? 'bg-[#21262d]' : ''
              } ${idx > 0 ? 'border-t border-[#30363d]/50' : ''}`}
            >
              <div className="shrink-0">
                {r.entity_type === 'funder' ? (
                  <Building2 size={16} className="text-blue-400" />
                ) : (
                  <Users size={16} className="text-green-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{r.name}</p>
                <p className="text-xs text-gray-400">
                  {r.state && `${r.state} · `}
                  {r.entity_type === 'funder' ? 'Funder' : 'Recipient'}
                  {r.grant_count > 0 && ` · ${r.grant_count} grants`}
                  {r.ein && ` · EIN ${r.ein}`}
                </p>
              </div>
              {r.total_funding > 0 && (
                <span className="text-xs text-gray-400 shrink-0">{fmtDollar(r.total_funding)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
