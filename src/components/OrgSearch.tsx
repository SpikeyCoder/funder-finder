import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Building2, Users, Loader2 } from 'lucide-react';
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
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setShowDropdown(false);
      return;
    }

    setLoading(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await searchOrganizations(query.trim());
        setResults(data);
        setShowDropdown(data.length > 0);
        setSelectedIdx(-1);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

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
    if (!showDropdown) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      handleSelect(results[selectedIdx]);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  };

  return (
    <div className="relative w-full">
      <div className="relative">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setShowDropdown(true)}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-11 pr-10 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-600 transition-colors"
        />
        {loading && (
          <Loader2 size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 animate-spin" />
        )}
      </div>

      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-2 bg-[#161b22] border border-[#30363d] rounded-xl shadow-xl overflow-hidden max-h-80 overflow-y-auto"
        >
          {results.map((r, idx) => (
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
                <p className="text-xs text-gray-500">
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
