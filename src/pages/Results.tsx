import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, BookmarkCheck, ChevronRight, Copy, Download, RefreshCw, Loader2 } from 'lucide-react';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';
import GlossaryTooltip from '../components/GlossaryTooltip';
import { findMatches, formatGrantRange, formatTotalGiving } from '../utils/matching';
import { BudgetBand, Funder } from '../types';

import { useAuth } from '../contexts/AuthContext';
import LoginModal from '../components/LoginModal';
import {
  computeMissionHash,
  fireAndForgetSignal,
  getOrCreateSearchSessionId,
  randomId,
  SearchSignalEventType,
} from '../lib/searchSignals';

const BUDGET_BAND_LABEL: Record<BudgetBand, string> = {
  under_250k: 'Under $250K',
  '250k_1m': '$250K - $1M',
  '1m_5m': '$1M - $5M',
  over_5m: '$5M+',
  prefer_not_to_say: 'Prefer not to say',
};

interface SearchTelemetryContext {
  searchRunId: string;
  sessionId: string;
  missionHash: string;
  locationServed: string;
  budgetBand: BudgetBand;
  keywords: string[];
  rankByFoundationId: Record<string, { rank: number; fitScore: number | null }>;
}

function isBudgetBand(value: unknown): value is BudgetBand {
  return value === 'under_250k'
    || value === '250k_1m'
    || value === '1m_5m'
    || value === 'over_5m'
    || value === 'prefer_not_to_say';
}

function formatGrantAmount(amount: number | null | undefined): string {
  if (!amount || !Number.isFinite(amount)) return 'Amount not disclosed';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

function parsePeerNonprofitsInput(input: string): string[] {
  const values = input
    .split(/[\n,;]+/)
    .map((value) => value.trim().replace(/\s+/g, ' '))
    .filter((value) => value.length >= 3);
  return [...new Set(values)].slice(0, 20);
}

export default function Results() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, saveFunderToDB, unsaveFunderFromDB, fetchSavedIds } = useAuth();

  // Use router state if available, fall back to sessionStorage (survives page reloads)
  const state = location.state || {};
  const mission: string = state.mission || sessionStorage.getItem('ff_mission') || '';
  const locationServed: string = state.locationServed || sessionStorage.getItem('ff_location') || '';
  const keywords: string[] = state.keywords ?? JSON.parse(sessionStorage.getItem('ff_keywords') || '[]');
  const budgetBandFromState = state.budgetBand;
  const budgetBandFromStorage = sessionStorage.getItem('ff_budget_band');
  const budgetBand: BudgetBand = isBudgetBand(budgetBandFromState)
    ? budgetBandFromState
    : (isBudgetBand(budgetBandFromStorage) ? budgetBandFromStorage : 'prefer_not_to_say');
  const peerNonprofitsFromState: string[] = Array.isArray(state.peerNonprofits)
    ? state.peerNonprofits.filter((value: unknown) => typeof value === 'string')
    : [];

  // Restore cached results on back-navigation so the page doesn't re-fetch
  const RESULTS_CACHE_KEY = 'ff_results_cache_v2';
  const cachedResultsOnMount = (() => {
    try {
      const raw = sessionStorage.getItem(RESULTS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Only use cache if the search params match
      if (parsed.mission === mission && parsed.locationServed === locationServed) {
        return parsed.results as Funder[];
      }
    } catch { /* ignore */ }
    return null;
  })();

  const [matches, setMatches] = useState<Funder[]>(cachedResultsOnMount ?? []);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cachedResultsOnMount);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState(!!cachedResultsOnMount);
  const [grantSizeFilter, setGrantSizeFilter] = useState<'any' | 'small' | 'medium' | 'large'>('any');
  const [hideDAFs, setHideDAFs] = useState(true);
  const [hideUniversities, setHideUniversities] = useState(false);
  const [peerSearchInput, setPeerSearchInput] = useState<string>(peerNonprofitsFromState.join('\n'));
  const [activePeerNonprofits, setActivePeerNonprofits] = useState<string[]>(peerNonprofitsFromState);
  const [suggestedPeers, setSuggestedPeers] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState<'score' | 'grant_amount' | 'total_giving' | 'name'>('score');
  const [funderTypeFilter, setFunderTypeFilter] = useState<'all' | 'foundation' | 'corporate' | 'community'>('all');
  const [stateFilter, setStateFilter] = useState<string>('');
  const RESULTS_PER_PAGE = 20;
  const autoPeerSearchDoneRef = useRef(false);
  const usedCacheOnMountRef = useRef(!!cachedResultsOnMount);
  const searchTelemetryRef = useRef<SearchTelemetryContext | null>(null);
  const searchSessionIdRef = useRef<string>(getOrCreateSearchSessionId());

  // Login modal state
  const [loginModalFunder, setLoginModalFunder] = useState<Funder | null>(null);
  const [showPeerEditor, setShowPeerEditor] = useState(false);
  const keywordKey = keywords.join('|');
  const peerKey = activePeerNonprofits.join('|');
  const isPeerSearchMode = activePeerNonprofits.length > 0;

  // Page title
  useEffect(() => {
    document.title = 'Funder Matches | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Your AI-ranked list of foundations, DAFs, and corporate giving programs matched to your nonprofit\'s mission.';
  }, []);

  const logResultSignal = (
    eventType: SearchSignalEventType,
    funder: Funder,
    metadata: Record<string, unknown> = {},
  ) => {
    const ctx = searchTelemetryRef.current;
    if (!ctx) return;
    const rankContext = ctx.rankByFoundationId[funder.id];
    fireAndForgetSignal({
      eventType,
      searchRunId: ctx.searchRunId,
      sessionId: ctx.sessionId,
      missionHash: ctx.missionHash,
      budgetBand: ctx.budgetBand,
      locationServed: ctx.locationServed,
      keywords: ctx.keywords,
      foundationId: funder.id,
      foundationRank: rankContext?.rank,
      fitScore: rankContext?.fitScore ?? null,
      metadata,
    });
  };

  const loadMatches = async (forceRefresh = false, peerNonprofitsOverride?: string[]) => {
    const peerNonprofits = peerNonprofitsOverride ?? activePeerNonprofits;
    const isPeerSearch = peerNonprofits.length > 0;

    if (!mission && !isPeerSearch) {
      setError('No mission found — please go back and enter your mission statement.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await findMatches(
        mission,
        locationServed,
        keywords,
        budgetBand,
        forceRefresh,
        peerNonprofits,
      );
      const rankedResults = response.results || [];
      const searchRunId = randomId();
      const telemetryBudgetBand: BudgetBand = isPeerSearch ? 'prefer_not_to_say' : budgetBand;
      const telemetryLocationServed = isPeerSearch ? '' : locationServed;
      const telemetryKeywords = isPeerSearch ? [] : keywords;
      const missionHash = isPeerSearch
        ? computeMissionHash(`peer:${peerNonprofits.join('|').toLowerCase()}`, '', [], 'prefer_not_to_say')
        : computeMissionHash(mission, locationServed, keywords, budgetBand);
      const rankByFoundationId: Record<string, { rank: number; fitScore: number | null }> = {};

      rankedResults.forEach((funder, idx) => {
        const fitScore = typeof funder.fit_score === 'number'
          ? funder.fit_score
          : (typeof funder.score === 'number' ? funder.score : null);
        rankByFoundationId[funder.id] = { rank: idx + 1, fitScore };
      });

      searchTelemetryRef.current = {
        searchRunId,
        sessionId: searchSessionIdRef.current,
        missionHash,
        locationServed: telemetryLocationServed,
        budgetBand: telemetryBudgetBand,
        keywords: telemetryKeywords,
        rankByFoundationId,
      };

      fireAndForgetSignal({
        eventType: forceRefresh ? 'results_refreshed' : 'search_results_loaded',
        searchRunId,
        sessionId: searchSessionIdRef.current,
        missionHash,
        budgetBand: telemetryBudgetBand,
        locationServed: telemetryLocationServed,
        keywords: telemetryKeywords,
        resultCount: rankedResults.length,
        metadata: {
          cached: response.cached,
          peer_nonprofits: isPeerSearch ? peerNonprofits : [],
          search_mode: isPeerSearch ? 'peer_nonprofits' : 'mission',
          top_result_ids: rankedResults.slice(0, 10).map((row) => row.id),
        },
      });

      setMatches(rankedResults);
      setCached(isPeerSearch ? false : response.cached);

      // Cache results so back-navigation doesn't trigger a re-fetch
      try {
        sessionStorage.setItem(RESULTS_CACHE_KEY, JSON.stringify({
          mission, locationServed, results: rankedResults,
        }));
      } catch { /* sessionStorage full or unavailable — ignore */ }

      // If server returned suggested peers, adopt them in the UI
      if (response.peers?.length && !peerNonprofits.length) {
        setSuggestedPeers(response.peers);
        setPeerSearchInput(response.peers.join('\n'));
        autoPeerSearchDoneRef.current = true;
        setActivePeerNonprofits(response.peers);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load matches');
    } finally {
      setLoading(false);
    }
  };

  const runPeerSearch = () => {
    const peers = parsePeerNonprofitsInput(peerSearchInput);
    if (!peers.length) {
      setError('Enter at least one peer nonprofit (3+ characters) and try again.');
      return;
    }
    setGrantSizeFilter('any');
    setSuggestedPeers(peers);        // Update displayed peer chips to reflect edits
    setActivePeerNonprofits(peers);
  };

  const clearPeerSearch = () => {
    setGrantSizeFilter('any');
    setSuggestedPeers([]);            // Clear displayed peer chips
    setActivePeerNonprofits([]);
    setPeerSearchInput('');
  };

  // Load saved IDs — only authenticated users have a saved list. Anonymous
  // users see no saved state until they sign in (no localStorage fallback).
  const loadSavedIds = async () => {
    if (user) {
      try {
        const ids = await fetchSavedIds();
        setSavedIds(ids);
        return;
      } catch {
        setSavedIds([]);
        return;
      }
    }
    setSavedIds([]);
  };

  // Single-call flow: match-funders now handles peer suggestion internally.
  // Just call loadMatches() once — it will return peers + results in one response.
  useEffect(() => {
    loadSavedIds();

    // Guard: if the auto-peer search just completed and set activePeerNonprofits,
    // the peerKey dependency will change and re-trigger this effect. Skip that re-run.
    if (autoPeerSearchDoneRef.current) {
      autoPeerSearchDoneRef.current = false;
      return;
    }

    // Skip re-fetching on mount if we restored cached results (back-navigation)
    if (usedCacheOnMountRef.current) {
      usedCacheOnMountRef.current = false;
      return;
    }

    setCurrentPage(1);
    loadMatches();
  }, [mission, locationServed, budgetBand, keywordKey, peerKey, user]);

  const toggleSave = async (funder: Funder) => {
    // Auth gate — anonymous users must sign in to save. The funder is stashed
    // in the LoginModal flow so it is auto-saved to Supabase after login.
    if (!user) {
      setLoginModalFunder(funder);
      return;
    }

    const alreadySaved = savedIds.includes(funder.id);
    if (alreadySaved) {
      try {
        await unsaveFunderFromDB(funder.id);
        setSavedIds(prev => prev.filter(i => i !== funder.id));
        logResultSignal('result_unsaved', funder);
      } catch (e) {
        console.error('Failed to unsave from DB:', e);
      }
    } else {
      try {
        await saveFunderToDB(funder);
        setSavedIds(prev => [...prev, funder.id]);
        logResultSignal('result_saved', funder);
      } catch (e) {
        console.error('Failed to save to DB:', e);
      }
    }
  };

  const copyEmail = (email: string, id: string) => {
    navigator.clipboard.writeText(email);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const exportCSV = () => {
    const rows = [
      ['Rank', 'Score', 'Name', 'Type', 'State', 'Total Giving', 'Grant Range', 'Contact', 'Email', 'Website', 'Next Step', 'Why It Matches'],
      ...matches.map((f, i) => [
        i + 1,
        f.score ? Math.round(f.score * 100) + '%' : '',
        f.name,
        f.type,
        f.state || '',
        formatTotalGiving(f.total_giving),
        formatGrantRange(f),
        `${f.contact_name || ''} ${f.contact_title ? `(${f.contact_title})` : ''}`.trim(),
        f.contact_email || '',
        f.website || '',
        f.next_step || '',
        f.reason || '',
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'funder-matches.csv';
    a.click();
  };

  // Exclude donor-advised funds (DAFs) — these are pass-through vehicles, not direct grantmakers
  const DAF_NAMES = new Set([
    // Major brokerage/financial DAF sponsors
    'FIDELITY INVESTMENTS CHARITABLE GIFT FUND',
    'FIDELITY INVESTMENTS CHARITABLE GIFT FUND INC',
    'SCHWAB CHARITABLE FUND',
    'VANGUARD CHARITABLE ENDOWMENT PROGRAM',
    'NATIONAL PHILANTHROPIC TRUST',
    'GS DONOR ADVISED PHILANTHROPY FUND',
    'GOLDMAN SACHS PHILANTHROPY FUND',
    'BNY MELLON CHARITABLE GIFT FUND',
    'RAYMOND JAMES CHARITABLE ENDOWMENT FUND',
    'AMERICAN ENDOWMENT FOUNDATION',
    'THE AYCO CHARITABLE FOUNDATION',
    'THE US CHARITABLE GIFT TRUST',
    'MORGAN STANLEY GLOBAL IMPACT FUNDING TRUST INC',
    // Online giving platforms / corporate giving vehicles
    'THE BLACKBAUD GIVING FUND',
    'AMERICAN ONLINE GIVING FOUNDATION INC',
    'NETWORK FOR GOOD',
    'BRIGHT FUNDS FOUNDATION',
    'BENEVITY COMMUNITY IMPACT FUND',
    'MIGHTYCAUSE CHARITABLE FOUNDATION',
    'CHARITIES AID FOUNDATION AMERICA',
    'FRONTSTREAM GLOBAL FUND',
    'UNITED CHARITABLE',
    'FOUNDATION SOURCE CHARITABLE GIFT FUND INC',
    // Faith-based DAF sponsors
    'NATIONAL CHRISTIAN FOUNDATION',
    'NATIONAL CHRISTIAN FOUNDATION INC',
    'NATIONAL CHRISTIAN CHARITABLE FOUNDATION',
    'NATIONAL CHRISTIAN CHARITABLE FOUNDATION INC',
    'NATL CHRISTIAN CHARITABLE FDN INC',
    'NCF GIVING INC',
    'JEWISH COMMUNAL FUND',
    'EVERENCE FOUNDATION INC',
    'BARNABAS FOUNDATION',
    // Community foundation DAF sponsors
    'SILICON VALLEY COMMUNITY FOUNDATION',
    'GREATER HORIZONS',
    'ARLINGTON COMMUNITY FOUNDATION',
    // Other DAF sponsors
    'RENAISSANCE CHARITABLE FOUNDATION INC',
    'DONORS TRUST',
    'DONORS TRUST INC',
    'IMPACTASSETSINC',
    'THE SIGNATRY CHARITABLE CORPORATION',
    'THE SIGNATRY CHARITABLE TRUST',
    'SERVANT FOUNDATION',
    'DECHOMAI FOUNDATION INC',
    'AMERICAN GIFT FUND',
    'KIDVANTAGE',
    'GIVE BACK FOUNDATION',
    'GIVE BACK FOUNDATION INC',
    'STRATEGIC GRANT PARTNERS INC',
    // Round 4: Additional DAFs caught in testing
    'GIVE LIVELY FOUNDATION INC',
    'ROCKEFELLER PHILANTHROPY ADVISORS INC',
    'PAYPAL CHARITABLE GIVING FUND',
    'THRIVENT CHARITABLE IMPACT & INVESTING',
    'T ROWE PRICE PROGRAM FOR CHARITABLE',
    'DAFFY CHARITABLE FUND',
    'THE GOLDMAN SACHS CHARITABLE GIFT FUND',
    'FREEWILL IMPACT FUND',
  ]);
  const isDAF = (name: string) => {
    const upper = name.toUpperCase();
    return DAF_NAMES.has(upper) ||
      /\bdonor[\s-]advised\b/i.test(name) ||
      /\bglobal impact funding trust\b/i.test(name) ||
      /\bnational christian (charitable )?foundation\b/i.test(name) ||
      /\bcharitable giving fund\b/i.test(name) ||
      /\bcharitable gift fund\b/i.test(name);
  };

  // University detection — NTEE B40-B50 range or name heuristic
  const isUniversity = (f: Funder) => {
    if (f.ntee_code) {
      const code = f.ntee_code.toUpperCase();
      if (/^B4[0-9]|^B5[0-9]/.test(code)) return true;
    }
    return /\buniversity\b|\bcollege\b|\bcommunity college\b/i.test(f.name);
  };

  // Deduplicate entries that share the same EIN (keep the one with higher score)
  const deduplicatedMatches = (() => {
    const einMap = new Map<string, Funder>();
    for (const f of matches) {
      const ein = f.foundation_ein;
      if (!ein) { einMap.set(f.id, f); continue; }
      const existing = einMap.get(ein);
      if (!existing || (f.fit_score ?? f.score ?? 0) > (existing.fit_score ?? existing.score ?? 0)) {
        einMap.set(ein, f);
      }
    }
    return [...einMap.values()];
  })();

  // Grant size filter — uses grant_range_max as primary signal, falls back to grant_range_min
  const filteredMatches = deduplicatedMatches
    .filter(f => !hideDAFs || (f.type !== 'daf' && !isDAF(f.name)))
    .filter(f => !hideUniversities || !isUniversity(f))
    .filter(f => {
      if (grantSizeFilter === 'any') return true;
      const effectiveMax = f.grant_range_max ?? f.grant_range_min;
      if (effectiveMax === null) return false; // no grant range data → exclude from size-specific filters
      if (grantSizeFilter === 'small')  return effectiveMax <= 25_000;
      if (grantSizeFilter === 'medium') return effectiveMax > 25_000 && effectiveMax <= 250_000;
      if (grantSizeFilter === 'large')  return effectiveMax > 250_000;
      return true;
    })
    .filter(f => {
      if (funderTypeFilter === 'all') return true;
      const t = (f.type || '').toLowerCase();
      if (funderTypeFilter === 'foundation') return t.includes('foundation') || t.includes('private');
      if (funderTypeFilter === 'corporate') return t.includes('corporate') || t.includes('company');
      if (funderTypeFilter === 'community') return t.includes('community');
      return true;
    })
    .filter(f => {
      if (!stateFilter) return true;
      return (f.state || '').toLowerCase() === stateFilter.toLowerCase();
    })
    .sort((a, b) => {
      if (sortBy === 'score') return (b.score ?? b.fit_score ?? 0) - (a.score ?? a.fit_score ?? 0);
      if (sortBy === 'grant_amount') return (b.grant_range_max ?? b.grant_range_min ?? 0) - (a.grant_range_max ?? a.grant_range_min ?? 0);
      if (sortBy === 'total_giving') return (b.total_giving ?? 0) - (a.total_giving ?? 0);
      if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
      return 0;
    });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredMatches.length / RESULTS_PER_PAGE));
  const paginatedMatches = filteredMatches.slice(
    (currentPage - 1) * RESULTS_PER_PAGE,
    currentPage * RESULTS_PER_PAGE,
  );

  const GRANT_SIZE_FILTERS: { key: 'any' | 'small' | 'medium' | 'large'; label: string }[] = [
    { key: 'any',    label: 'Any size' },
    { key: 'small',  label: '< $25K' },
    { key: 'medium', label: '$25K – $250K' },
    { key: 'large',  label: '$250K+' },
  ];

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <div className="max-w-3xl mx-auto px-6 pt-10 pb-12">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold">Your Funder Matches</h1>
            {!loading && (
              <>
                <p className="text-gray-400 mt-1">
                  {isPeerSearchMode
                    ? `Found ${filteredMatches.length} foundations with recent grants to your peer nonprofits`
                    : `Found ${filteredMatches.length} funders aligned with your mission`}
                  {!isPeerSearchMode && cached && <span className="ml-2 text-xs text-gray-300">(cached)</span>}
                </p>
                {!isPeerSearchMode && (
                  <p className="text-xs text-gray-400 mt-1">
                    Budget band: {BUDGET_BAND_LABEL[budgetBand]}
                  </p>
                )}
                {keywords.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    Excluded terms: {keywords.join(', ')}
                  </p>
                )}
              </>
            )}
          </div>
          {!loading && matches.length > 0 && (
            <button
              onClick={exportCSV}
              className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
            >
              <Download size={16} />
              Export
            </button>
          )}
        </div>

        {!loading && (
          <button
            onClick={() => navigate('/mission', { state: { mission, locationServed, keywords, budgetBand, peerNonprofits: activePeerNonprofits } })}
            className="flex items-center gap-1 text-gray-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} />
            Update Search
          </button>
        )}

        {/* Auto-identified peer nonprofits (shown when peers were auto-detected) */}
        {isPeerSearchMode && suggestedPeers.length > 0 && (
          <>
            <div className="mt-4 mb-4 bg-[#0f1d2e] border border-[#1f3a5f] rounded-2xl p-4">
              <p className="text-sm font-semibold text-blue-300">Peer nonprofits identified</p>
              <p className="text-xs text-gray-400 mt-1">
                These organizations share a similar mission, geography, and budget. Results below show funders that have historically supported them.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {suggestedPeers.map((peer) => (
                  <span
                    key={peer}
                    className="inline-flex items-center bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-1.5 text-xs text-gray-200"
                  >
                    {peer}
                  </span>
                ))}
              </div>
              {!showPeerEditor && (
                <button
                  onClick={() => setShowPeerEditor(true)}
                  className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Edit peers
                </button>
              )}
            </div>
            {/* Result count shown directly under peer box */}
            {!loading && filteredMatches.length > 0 && (
              <p className="mt-2 text-sm text-gray-400">
                Found {filteredMatches.length} foundation{filteredMatches.length === 1 ? '' : 's'} with recent grants to your peer nonprofits
              </p>
            )}
          </>
        )}

        {/* Manual peer lookup - hidden by default, toggled via "Edit peers" */}
        {showPeerEditor && (
          <div className="mt-4 mb-6 bg-[#161b22] border border-[#30363d] rounded-2xl p-4">
            <p className="text-sm font-semibold text-blue-300">Edit peer nonprofits</p>
            <p className="text-xs text-gray-400 mt-1">
              Adjust the peer list to customize which funders appear. One per line or comma-separated.
            </p>
            <textarea
              value={peerSearchInput}
              onChange={(event) => setPeerSearchInput(event.target.value)}
              placeholder={'Example: Greater Chicago Food Depository\nAustin Bat Cave\nGirls Who Code'}
              className="mt-3 w-full min-h-[96px] rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                onClick={() => { runPeerSearch(); setShowPeerEditor(false); }}
                className="bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-blue-500 transition-colors"
              >
                Update results
              </button>
              <button
                onClick={() => setShowPeerEditor(false)}
                className="border border-[#30363d] text-gray-300 text-sm px-4 py-2 rounded-xl hover:bg-[#21262d] transition-colors"
              >
                Cancel
              </button>
              {isPeerSearchMode && (
                <button
                  onClick={() => { clearPeerSearch(); setShowPeerEditor(false); }}
                  className="border border-[#30363d] text-gray-300 text-sm px-4 py-2 rounded-xl hover:bg-[#21262d] transition-colors"
                >
                  Back to mission matching
                </button>
              )}
            </div>
          </div>
        )}

        {/* Grant size filter pills */}
        {!loading && !error && matches.length > 0 && !isPeerSearchMode && (
          <div className="flex items-center gap-2 mt-4 mb-8 flex-wrap">
            <span className="text-xs text-gray-300 mr-1">Grant size:</span>
            {GRANT_SIZE_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => { setGrantSizeFilter(key); setCurrentPage(1); }}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  grantSizeFilter === key
                    ? 'bg-blue-600 border-blue-500 text-white font-semibold'
                    : 'border-[#30363d] text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
            <span className="text-[#30363d] mx-1">|</span>
            <button
              onClick={() => { setHideDAFs(!hideDAFs); setCurrentPage(1); }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                hideDAFs
                  ? 'bg-blue-600 border-blue-500 text-white font-semibold'
                  : 'border-[#30363d] text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}
            >
              Hide DAFs <GlossaryTooltip term="DAF" />
            </button>
            <button
              onClick={() => { setHideUniversities(!hideUniversities); setCurrentPage(1); }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                hideUniversities
                  ? 'bg-blue-600 border-blue-500 text-white font-semibold'
                  : 'border-[#30363d] text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}
            >
              Hide Universities
            </button>
            {(grantSizeFilter !== 'any' || hideUniversities || deduplicatedMatches.length < matches.length) && (
              <span className="text-xs text-gray-300 ml-1">
                — showing {filteredMatches.length} of {deduplicatedMatches.length}{deduplicatedMatches.length < matches.length ? ` (${matches.length - deduplicatedMatches.length} duplicates removed)` : ''}
              </span>
            )}
          </div>
        )}


        {/* Sort and additional filters */}
        {!loading && !error && matches.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <div className="flex items-center gap-1.5">
              <label htmlFor="sort-select" className="text-xs text-gray-300">Sort by:</label>
              <select id="sort-select" value={sortBy} onChange={(e) => { setSortBy(e.target.value as typeof sortBy); setCurrentPage(1); }} className="text-xs bg-[#0d1117] border border-[#30363d] text-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="score">Match Score</option>
                <option value="grant_amount">Grant Amount</option>
                <option value="total_giving">Total Giving</option>
                <option value="name">Name (A–Z)</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor="type-filter" className="text-xs text-gray-300">Type:</label>
              <select id="type-filter" value={funderTypeFilter} onChange={(e) => { setFunderTypeFilter(e.target.value as typeof funderTypeFilter); setCurrentPage(1); }} className="text-xs bg-[#0d1117] border border-[#30363d] text-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="all">All Types</option>
                <option value="foundation">Foundation</option>
                <option value="corporate">Corporate</option>
                <option value="community">Community</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor="state-filter" className="text-xs text-gray-300">State:</label>
              <input id="state-filter" type="text" value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setCurrentPage(1); }} placeholder="e.g. CA" maxLength={2} className="text-xs bg-[#0d1117] border border-[#30363d] text-gray-200 rounded-lg px-2 py-1.5 w-16 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
        )}

        {/* Loading state */}
        <div role="status" aria-live="polite">
        {loading && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <Loader2 size={40} className="animate-spin mb-4 text-blue-400" />
            <p className="text-lg font-medium">
              {isPeerSearchMode ? 'Finding foundations based on peer nonprofit grant history...' : 'Analyzing your mission and fit signals...'}
            </p>
            <p className="text-sm mt-2">
              {isPeerSearchMode ? 'Using only 990 grant history from the last 5 years' : 'Ranking by mission, geography, and similar prior grantees'}
            </p>
          </div>
        )}
        </div>

        {/* Error state */}
        {!loading && error && (
          <div className="bg-red-900/20 border border-red-800 rounded-2xl p-8 text-center">
            <p className="text-red-400 font-semibold mb-2">Something went wrong</p>
            <p className="text-gray-400 text-sm mb-4">{error}</p>
            <button
              onClick={() => loadMatches(true)}
              className="flex items-center gap-2 mx-auto border border-red-800 text-red-400 rounded-xl px-4 py-2 text-sm hover:bg-red-900/30 transition-colors"
            >
              <RefreshCw size={14} />
              Try Again
            </button>
          </div>
        )}

        {/* No results */}
        {!loading && !error && filteredMatches.length === 0 && (
          <div className="text-center py-24 text-gray-400">
            {grantSizeFilter !== 'any' && matches.length > 0 ? (
              <>
                <p className="text-2xl mb-3">No funders in this size range</p>
                <p className="mb-4 text-sm">Try a different grant size filter or view all results.</p>
                <button
                  onClick={() => { setGrantSizeFilter('any'); setCurrentPage(1); }}
                  className="bg-white text-gray-900 font-semibold px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors"
                >
                  Show All Sizes
                </button>
              </>
            ) : (
              <>
                {isPeerSearchMode ? (
                  <>
                    <p className="text-2xl mb-3">No peer-based matches found</p>
                    <p className="mb-4 text-sm">Try alternate nonprofit names or abbreviations for your peer list.</p>
                  </>
                ) : (
                  <>
                    <p className="text-2xl mb-3">No funders found</p>
                    <p className="mb-4 text-sm">The database may be empty. Run the ingestion script first.</p>
                    <button
                      onClick={() => navigate('/mission', { state: { mission, locationServed, keywords, budgetBand } })}
                      className="bg-white text-gray-900 font-semibold px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors"
                    >
                      Update Mission
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Funder Cards */}
        {!loading && !error && filteredMatches.length > 0 && (
          <div className="space-y-6">
            {paginatedMatches.map((funder, index) => {
              const globalIndex = (currentPage - 1) * RESULTS_PER_PAGE + index;
              const isSaved = savedIds.includes(funder.id);
              const fitScore = funder.fit_score ?? funder.score;
              const scorePercent = typeof fitScore === 'number' ? Math.round(fitScore * 100) : null;
              const fitExplanation = funder.fit_explanation || funder.reason;
              return (
                <div key={funder.id} className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">
                  <div className="flex items-start gap-3 mb-3">
                    <span className="text-blue-400 font-bold text-lg">#{globalIndex + 1}</span>
                    <div className="flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="text-xl font-bold">{funder.name}</h2>
                        {scorePercent !== null && (
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${scorePercent >= 80 ? 'bg-green-900/40 text-green-400' : scorePercent >= 60 ? 'bg-blue-900/40 text-blue-400' : 'bg-gray-800 text-gray-400'}`}>
                            {scorePercent}% fit score <GlossaryTooltip term="fit score" />
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-2">
                        <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full capitalize">
                          {funder.type}
                        </span>
                        {funder.state && (
                          <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full">
                            {funder.city ? `${funder.city}, ${funder.state}` : funder.state}
                          </span>
                        )}
                        {funder.total_giving && (
                          <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full">
                            {formatTotalGiving(funder.total_giving)} in grants
                          </span>
                        )}
                        {/* Data freshness indicator */}
                        {(() => {
                          const latestYear = funder.similar_past_grantees?.reduce(
                            (max, g) => (g.year && g.year > max ? g.year : max), 0
                          ) ?? 0;
                          const currentYear = new Date().getFullYear();
                          const isStale = latestYear > 0 && (currentYear - latestYear) > 2;
                          if (latestYear > 0) return (
                            <span className={`inline-block text-xs px-3 py-1 rounded-full border ${
                              isStale
                                ? 'bg-amber-900/30 border-amber-700 text-amber-300'
                                : 'bg-[#21262d] border-[#30363d] text-gray-300'
                            }`}>
                              {isStale ? '⚠ ' : ''}Data as of {latestYear}
                            </span>
                          );
                          if (funder.limited_grant_history_data) return (
                            <span className="inline-block bg-amber-900/30 border border-amber-700 text-amber-300 text-xs px-3 py-1 rounded-full">
                              ⚠ Limited data
                            </span>
                          );
                          return null;
                        })()}
                      </div>
                    </div>
                  </div>

                  {/* Fit explanation */}
                  {fitExplanation && (
                    <div className="mb-4 bg-[#0d1117] border border-blue-900/50 rounded-xl px-4 py-3">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-xs text-blue-400 font-semibold">Why this foundation fits</p>
                        {funder.limited_grant_history_data && (
                          <span className="text-[10px] px-2 py-1 rounded-full bg-amber-900/40 text-amber-300 border border-amber-800">
                            Limited grant history data
                          </span>
                        )}
                      </div>
                      <p className="text-gray-300 text-sm">{fitExplanation}</p>
                    </div>
                  )}

                  {/* Similar prior grantees */}
                  {funder.similar_past_grantees && funder.similar_past_grantees.length > 0 && (
                    <div className="mb-4 bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3">
                      <p className="text-xs text-blue-400 font-semibold mb-3">Similar past grantees</p>
                      <div className="space-y-3">
                        {funder.similar_past_grantees.slice(0, 3).map((grantee, idx) => (
                          <div key={`${funder.id}-grantee-${idx}`} className="border border-[#30363d] rounded-lg p-3 bg-[#111723]">
                            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                              {grantee.ein ? (
                                <button
                                  onClick={() => navigate(`/recipient/${grantee.ein}`)}
                                  className="text-sm font-semibold text-blue-400 hover:text-blue-300 hover:underline text-left transition-colors"
                                  title="View this organization's profile"
                                >
                                  {grantee.name} →
                                </button>
                              ) : (
                                <p className="text-sm font-semibold text-white">{grantee.name}</p>
                              )}
                              <p className="text-xs text-gray-300">
                                {(grantee.year ? String(grantee.year) : 'Year n/a')} · {formatGrantAmount(grantee.amount)}
                              </p>
                            </div>
                            {grantee.match_reasons.length > 0 && (
                              <ul className="list-disc ml-4 text-xs text-gray-300 space-y-1">
                                {grantee.match_reasons.slice(0, 2).map((reason, reasonIdx) => (
                                  <li key={`${funder.id}-grantee-${idx}-reason-${reasonIdx}`}>{reason}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Focus areas */}
                  {funder.focus_areas && funder.focus_areas.length > 0 && (
                    <div className="mb-4">
                      <div className="flex flex-wrap gap-2">
                        {funder.focus_areas.map(tag => (
                          <span key={tag} className="bg-[#21262d] text-gray-400 text-xs px-3 py-1 rounded-full capitalize">
                            {tag.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Grant range */}
                  {(funder.grant_range_min || funder.grant_range_max) && (
                    <p className="text-sm text-gray-400 mb-4">
                      <strong className="text-white">Typical grant range:</strong> {formatGrantRange(funder)}
                    </p>
                  )}

                  {/* Warm intro via LinkedIn */}
                  <div className="bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mb-4 text-sm">
                    <span className="text-gray-400">Best next step: </span>
                    <a
                      href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(funder.name)}&currentCompany=${encodeURIComponent(funder.name)}&network=%5B%22F%22%2C%22S%22%5D`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => logResultSignal('result_outbound_click', funder, { url: 'linkedin_search' })}
                      className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors inline-flex items-center gap-1.5"
                    >
                      <span className="break-words">Find your connections at {funder.name}</span>
                      <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                    </a>
                  </div>

                  <div className="flex gap-3">
                    {funder.contact_email && (
                      <button
                        onClick={() => copyEmail(funder.contact_email!, funder.id)}
                        className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#21262d] transition-colors"
                      >
                        <Copy size={14} />
                        {copied === funder.id ? 'Copied!' : 'Copy Email'}
                      </button>
                    )}
                    <button
                      onClick={() => toggleSave(funder)}
                      className={`flex items-center gap-2 border rounded-xl px-4 py-2 text-sm transition-colors ${isSaved ? 'border-blue-600 text-blue-400 bg-blue-900/20' : 'border-[#30363d] hover:bg-[#21262d]'}`}
                    >
                      {isSaved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
                      {isSaved ? 'Saved' : 'Save'}
                    </button>
                    <button
                      onClick={() => {
                        logResultSignal('result_view_details', funder);
                        navigate(`/funder/${funder.id}`, { state: { funder, mission, keywords, budgetBand } });
                      }}
                      className="flex items-center gap-2 bg-white text-gray-900 font-semibold rounded-xl px-4 py-2 text-sm hover:bg-gray-100 transition-colors ml-auto"
                    >
                      View Details
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 pt-4">
                <button
                  onClick={() => {
                    setCurrentPage((p) => Math.max(1, p - 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  disabled={currentPage <= 1}
                  className="px-4 py-2 rounded-lg bg-[#21262d] text-gray-300 text-sm font-medium hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ← Previous
                </button>
                <span className="text-gray-400 text-sm">
                  Page {currentPage} of {totalPages}
                  {' '}({(currentPage - 1) * RESULTS_PER_PAGE + 1}–{Math.min(currentPage * RESULTS_PER_PAGE, filteredMatches.length)} of {filteredMatches.length})
                </span>
                <button
                  onClick={() => {
                    setCurrentPage((p) => Math.min(totalPages, p + 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  disabled={currentPage >= totalPages}
                  className="px-4 py-2 rounded-lg bg-[#21262d] text-gray-300 text-sm font-medium hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next →
                </button>
              </div>
            )}

            {/* Refresh button at bottom */}
            <div className="flex justify-center pt-4">
              <button
                onClick={() => loadMatches(true)}
                className="flex items-center gap-2 text-gray-300 hover:text-white text-sm transition-colors"
              >
                <RefreshCw size={14} />
                {isPeerSearchMode ? 'Refresh results (re-run peer lookup)' : 'Refresh results (re-run AI matching)'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Login modal — shown when an anonymous user tries to save. The
          pending funder is auto-saved to Supabase after sign-in. */}
      {loginModalFunder && (
        <LoginModal pendingFunder={loginModalFunder} onClose={() => setLoginModalFunder(null)} />
      )}

      <Footer />
    </div>
  );
                  }
