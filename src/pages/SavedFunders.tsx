import { useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import {
  ArrowLeft, BookmarkX, Download, ChevronRight, Loader2,
  LogOut, PenLine, User as UserIcon, StickyNote, ChevronDown, ChevronUp,
  Users, Building2,
} from 'lucide-react';
import { SavedFunderEntry, FunderStatus, PeerEntry } from '../types';
import { getSavedEntries, unsaveFunder, setFunderMeta } from '../utils/storage';
import { formatTotalGiving, fetchPeers } from '../utils/matching';
import { fmtDollar } from '../components/InsightCharts';
import { useAuth } from '../contexts/AuthContext';
import LoginModal from '../components/LoginModal';

// ── Status config ──────────────────────────────────────────────────────────────

const STATUSES: { key: FunderStatus; label: string; color: string; bg: string; border: string }[] = [
  { key: 'researching', label: 'Researching', color: 'text-blue-300',  bg: 'bg-blue-900/30',  border: 'border-blue-700' },
  { key: 'applied',     label: 'Applied',     color: 'text-amber-300', bg: 'bg-amber-900/30', border: 'border-amber-700' },
  { key: 'awarded',     label: 'Awarded',     color: 'text-green-300', bg: 'bg-green-900/30', border: 'border-green-700' },
  { key: 'passed',      label: 'Passed',      color: 'text-gray-400',  bg: 'bg-gray-800/40',  border: 'border-gray-600' },
];

const STATUS_FILTERS: { key: FunderStatus | 'all'; label: string }[] = [
  { key: 'all',         label: 'All' },
  { key: 'researching', label: 'Researching' },
  { key: 'applied',     label: 'Applied' },
  { key: 'awarded',     label: 'Awarded' },
  { key: 'passed',      label: 'Passed' },
];

// ── Component ──────────────────────────────────────────────────────────────────

export default function SavedFunders() {
  const navigate = useNavigate();
  const { user, signOut, unsaveFunderFromDB, fetchSavedEntries, updateSavedFunder } = useAuth();

  const [entries, setEntries] = useState<SavedFunderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<FunderStatus | 'all'>('all');
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [showLoginModal, setShowLoginModal] = useState(false);

  // FEAT-008: Peer recommendations aggregated from saved funders
  const [peerRecs, setPeerRecs] = useState<(PeerEntry & { recommendedBy: string })[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);

  // Debounce timers for note persistence
  const noteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── Load ──────────────────────────────────────────────────────────────────────

  // Page title
  useEffect(() => {
    document.title = 'My Saved Funders | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Track your funder pipeline, update statuses, take notes, and generate grant applications for each saved funder.';
  }, []);

  useEffect(() => { loadEntries(); }, [user]);

  const loadEntries = async () => {
    setLoading(true);
    try {
      const data = user ? await fetchSavedEntries() : getSavedEntries();
      setEntries(data);
      // Seed the notes draft from loaded data
      const draft: Record<string, string> = {};
      data.forEach(e => { draft[e.funder.id] = e.notes; });
      setNotesDraft(draft);
    } catch (e) {
      console.error('Failed to load saved funders:', e);
      const fallback = getSavedEntries();
      setEntries(fallback);
    }
    setLoading(false);
  };

  // ── Status change ─────────────────────────────────────────────────────────────

  const handleStatusChange = async (funderId: string, status: FunderStatus) => {
    // Optimistic update
    setEntries(prev => prev.map(e =>
      e.funder.id === funderId ? { ...e, status } : e
    ));
    try {
      if (user) {
        await updateSavedFunder(funderId, { status });
      } else {
        setFunderMeta(funderId, { status });
      }
    } catch (e) {
      console.error('Failed to update status:', e);
    }
  };

  // ── Notes ─────────────────────────────────────────────────────────────────────

  const handleNotesChange = (funderId: string, value: string) => {
    setNotesDraft(prev => ({ ...prev, [funderId]: value }));
    // Debounce save: 800ms after last keystroke
    clearTimeout(noteTimers.current[funderId]);
    noteTimers.current[funderId] = setTimeout(() => saveNotes(funderId, value), 800);
  };

  const saveNotes = async (funderId: string, notes: string) => {
    setEntries(prev => prev.map(e =>
      e.funder.id === funderId ? { ...e, notes } : e
    ));
    try {
      if (user) {
        await updateSavedFunder(funderId, { notes });
      } else {
        setFunderMeta(funderId, { notes });
      }
    } catch (e) {
      console.error('Failed to save notes:', e);
    }
  };

  const toggleNotes = (funderId: string) => {
    setExpandedNotes(prev => {
      const next = new Set(prev);
      if (next.has(funderId)) { next.delete(funderId); } else { next.add(funderId); }
      return next;
    });
  };

  // ── Remove ────────────────────────────────────────────────────────────────────

  const remove = async (funderId: string) => {
    if (user) {
      try { await unsaveFunderFromDB(funderId); } catch (e) { console.error(e); }
    } else {
      unsaveFunder(funderId);
    }
    setEntries(prev => prev.filter(e => e.funder.id !== funderId));
  };

  // ── Export ────────────────────────────────────────────────────────────────────

  const exportCSV = () => {
    const rows = [
      ['Name', 'Type', 'State', 'Total Giving', 'Contact', 'Email', 'Website', 'Status', 'Notes'],
      ...entries.map(({ funder: f, status, notes }) => [
        f.name,
        f.type,
        f.state || '',
        formatTotalGiving(f.total_giving),
        `${f.contact_name || ''} ${f.contact_title ? `(${f.contact_title})` : ''}`.trim(),
        f.contact_email || '',
        f.website || '',
        status,
        notes,
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'saved-funders.csv';
    a.click();
  };

  // ── Derived ───────────────────────────────────────────────────────────────────

  const filteredEntries = statusFilter === 'all'
    ? entries
    : entries.filter(e => e.status === statusFilter);

  const countByStatus = (key: FunderStatus) => entries.filter(e => e.status === key).length;

  // FEAT-008: Fetch peer recommendations from top saved funders
  useEffect(() => {
    if (entries.length === 0) { setPeerRecs([]); return; }
    let cancelled = false;
    setPeersLoading(true);

    // Pick up to 5 saved funders to fetch peers for (skip those with status 'passed')
    const activeSaved = entries.filter(e => e.status !== 'passed').slice(0, 5);
    const savedIds = new Set(entries.map(e => e.funder.id));

    Promise.allSettled(
      activeSaved.map(async (entry) => {
        const peers = await fetchPeers('funder', entry.funder.id);
        return peers.map(p => ({ ...p, recommendedBy: entry.funder.name }));
      }),
    ).then(results => {
      if (cancelled) return;
      const allPeers: (PeerEntry & { recommendedBy: string })[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') allPeers.push(...r.value);
      }
      // Deduplicate by id, keeping highest score. Exclude already-saved funders.
      const seen = new Map<string, (typeof allPeers)[0]>();
      for (const p of allPeers) {
        if (savedIds.has(p.id)) continue;
        const existing = seen.get(p.id);
        if (!existing || p.score > existing.score) seen.set(p.id, p);
      }
      const deduped = Array.from(seen.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      setPeerRecs(deduped);
      setPeersLoading(false);
    });

    return () => { cancelled = true; };
  }, [entries]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Saved Funders</h1>
            {!loading && (
              <p className="text-gray-400 mt-1">
                {entries.length} funder{entries.length !== 1 ? 's' : ''} saved
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {entries.length > 0 && (
              <button
                onClick={exportCSV}
                className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
              >
                <Download size={16} />
                Export CSV
              </button>
            )}
            {user ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-sm text-gray-400 border border-[#30363d] rounded-xl px-3 py-2">
                  <UserIcon size={14} />
                  <span className="max-w-[140px] truncate">{user.email}</span>
                </div>
                <button
                  onClick={async () => { await signOut(); loadEntries(); }}
                  className="flex items-center gap-2 border border-[#30363d] rounded-xl px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-[#161b22] transition-colors"
                  title="Sign out"
                >
                  <LogOut size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowLoginModal(true)}
                className="flex items-center gap-2 border border-blue-700 text-blue-400 rounded-xl px-4 py-2 text-sm hover:bg-blue-900/20 transition-colors"
              >
                Log in to sync
              </button>
            )}
          </div>
        </div>

        {/* Anon sync callout */}
        {!user && entries.length > 0 && (
          <div className="mb-6 bg-blue-900/10 border border-blue-800/40 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
            <p className="text-sm text-blue-300">
              Log in to sync your saved funders and pipeline across all your devices.
            </p>
            <button
              onClick={() => setShowLoginModal(true)}
              className="shrink-0 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl px-4 py-2 transition-colors"
            >
              Log in
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-24">
            <Loader2 size={32} className="animate-spin text-blue-400" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-24 text-gray-400">
            <p className="text-2xl mb-3">No saved funders yet</p>
            <p className="mb-6">Save funders from your search results to track them here.</p>
            <button
              onClick={() => navigate('/mission')}
              className="bg-white text-gray-900 font-semibold px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors"
            >
              Find Funders
            </button>
          </div>
        ) : (
          <>
            {/* Pipeline summary bar */}
            <div className="grid grid-cols-4 gap-3 mb-6">
              {STATUSES.map(s => (
                <button
                  key={s.key}
                  onClick={() => setStatusFilter(prev => prev === s.key ? 'all' : s.key)}
                  className={`rounded-xl border p-3 text-center transition-all ${
                    statusFilter === s.key
                      ? `${s.bg} ${s.border} ${s.color}`
                      : 'bg-[#161b22] border-[#30363d] text-gray-400 hover:border-gray-500'
                  }`}
                >
                  <div className="text-2xl font-bold">{countByStatus(s.key)}</div>
                  <div className="text-xs mt-0.5">{s.label}</div>
                </button>
              ))}
            </div>

            {/* Filter pills */}
            <div className="flex items-center gap-2 mb-6 flex-wrap">
              {STATUS_FILTERS.map(f => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    statusFilter === f.key
                      ? 'bg-white text-gray-900 border-white font-semibold'
                      : 'border-[#30363d] text-gray-400 hover:border-gray-500 hover:text-gray-200'
                  }`}
                >
                  {f.label}
                  {f.key !== 'all' && countByStatus(f.key as FunderStatus) > 0 && (
                    <span className="ml-1.5 opacity-60">{countByStatus(f.key as FunderStatus)}</span>
                  )}
                </button>
              ))}
            </div>

            {/* Funder cards */}
            {filteredEntries.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <p>No funders with status "{statusFilter}".</p>
                <button
                  onClick={() => setStatusFilter('all')}
                  className="mt-3 text-sm text-blue-400 hover:text-blue-300"
                >
                  Show all
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredEntries.map(({ funder: f, status, notes }) => {
                  const notesOpen = expandedNotes.has(f.id);
                  return (
                    <div key={f.id} className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">

                      {/* Funder header */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h2 className="text-xl font-bold truncate">{f.name}</h2>
                          <div className="flex flex-wrap gap-2 mt-2">
                            <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full capitalize">
                              {f.type}
                            </span>
                            {f.state && (
                              <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full">
                                {f.city ? `${f.city}, ${f.state}` : f.state}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-400 mt-3">
                            {f.contact_name && (
                              <span>{f.contact_name}{f.contact_title ? `, ${f.contact_title}` : ''}</span>
                            )}
                            {f.total_giving && (
                              <span className="text-green-400">{formatTotalGiving(f.total_giving)} in grants</span>
                            )}
                            {f.contact_email && (
                              <span className="text-blue-400">{f.contact_email}</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Status pills */}
                      <div className="flex items-center gap-2 mt-4 flex-wrap">
                        <span className="text-xs text-gray-300 mr-1">Status:</span>
                        {STATUSES.map(s => (
                          <button
                            key={s.key}
                            onClick={() => handleStatusChange(f.id, s.key)}
                            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                              status === s.key
                                ? `${s.bg} ${s.border} ${s.color} font-semibold`
                                : 'border-[#30363d] text-gray-400 hover:border-gray-400 hover:text-gray-200'
                            }`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>

                      {/* Notes toggle + textarea */}
                      <button
                        onClick={() => toggleNotes(f.id)}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white mt-4 transition-colors"
                      >
                        <StickyNote size={13} />
                        {notes && !notesOpen ? 'Edit note' : 'Notes'}
                        {notesOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>

                      {notesOpen && (
                        <textarea
                          className="mt-2 w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none"
                          rows={3}
                          placeholder="Add notes about this funder, next steps, contacts, deadlines…"
                          value={notesDraft[f.id] ?? notes}
                          onChange={e => handleNotesChange(f.id, e.target.value)}
                        />
                      )}

                      {/* Show note preview when collapsed and has content */}
                      {!notesOpen && notes && (
                        <p className="mt-2 text-xs text-gray-400 italic line-clamp-1">{notes}</p>
                      )}

                      {/* Actions row */}
                      <div className="flex gap-3 mt-4 flex-wrap">
                        <button
                          onClick={() => remove(f.id)}
                          className="flex items-center gap-2 border border-red-900 text-red-400 rounded-xl px-4 py-2 text-sm hover:bg-red-900/20 transition-colors"
                        >
                          <BookmarkX size={14} />
                          Remove
                        </button>
                        {user && (
                          <button
                            onClick={() => navigate('/grant-writer', { state: { funder: f } })}
                            className="flex items-center gap-2 border border-purple-700 text-purple-400 rounded-xl px-4 py-2 text-sm hover:bg-purple-900/20 transition-colors"
                          >
                            <PenLine size={14} />
                            Write Grant
                          </button>
                        )}
                        <button
                          onClick={() => navigate(`/funder/${f.id}`, { state: { funder: f } })}
                          className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#21262d] transition-colors ml-auto"
                        >
                          View Details
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* FEAT-008: Peer Recommendations */}
        {entries.length > 0 && (peerRecs.length > 0 || peersLoading) && (
          <div className="mt-10">
            <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
              <Users size={18} className="text-cyan-400" />
              Discover Similar Funders
            </h2>
            <p className="text-sm text-gray-400 mb-4">
              Based on giving patterns of your saved funders
            </p>
            {peersLoading ? (
              <div className="space-y-2">
                {[1,2,3].map(i => <div key={i} className="h-14 bg-[#21262d] rounded-xl animate-pulse" />)}
              </div>
            ) : (
              <div className="bg-[#161b22] border border-[#30363d] rounded-2xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-xs border-b border-[#30363d]">
                      <th className="text-left py-3 px-4">Funder</th>
                      <th className="text-right py-3 px-2">Total Giving</th>
                      <th className="text-right py-3 px-2">Match</th>
                      <th className="text-left py-3 px-3 hidden sm:table-cell">Similar to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peerRecs.map((p, i) => (
                      <tr
                        key={`${p.id}-${i}`}
                        className="border-b border-[#30363d]/50 hover:bg-[#21262d]/40 cursor-pointer transition-colors"
                        onClick={() => navigate(`/funder/${p.id}`)}
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <Building2 size={13} className="text-blue-400 shrink-0" />
                            <span className="text-gray-200 truncate max-w-[220px]">{p.name}</span>
                            {p.state && <span className="text-gray-500 text-xs shrink-0">{p.state}</span>}
                          </div>
                        </td>
                        <td className="py-3 px-2 text-right text-gray-300 whitespace-nowrap">
                          {p.totalFunding ? fmtDollar(p.totalFunding) : '—'}
                        </td>
                        <td className="py-3 px-2 text-right">
                          <span className={`text-xs font-medium ${p.score >= 0.3 ? 'text-green-400' : p.score >= 0.15 ? 'text-yellow-400' : 'text-gray-400'}`}>
                            {Math.round(p.score * 100)}%
                          </span>
                        </td>
                        <td className="py-3 px-3 text-gray-500 text-xs truncate max-w-[160px] hidden sm:table-cell">
                          {p.recommendedBy}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {showLoginModal && (
        <LoginModal onClose={() => setShowLoginModal(false)} />
      )}
    </div>
  );
}
