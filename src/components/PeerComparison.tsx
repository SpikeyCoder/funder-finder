import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowRight, Trophy, Minus } from 'lucide-react';
import { RecipientProfile, PeerEntry } from '../types';
import { fetchRecipientProfile } from '../utils/matching';
import { fmtDollar } from './InsightCharts';

/**
 * FM-IC-PEER-001 — Head-to-head peer comparison.
 *
 * Closes the Instrumentl competitive-gap audit finding: peers were listed in a
 * "Similar Organizations" table but there was no side-by-side view letting a
 * user compare their org against a specific peer. This modal fetches the full
 * RecipientProfile for the selected peer and renders both organizations
 * column-by-column across the funding metrics FunderMatch already surfaces
 * (total funding, grants received, distinct funders, active years, IRS 990
 * revenue/expenses, focus areas).
 *
 * No backend changes are required: it reuses fetchRecipientProfile, the same
 * edge function the org profile page already calls.
 */

// IRS NTEE major-group letter → plain-language label. Mirrors the mapping in
// FilterPanel so focus areas read the same way across the app.
const NTEE_LABELS: Record<string, string> = {
  A: 'Arts, Culture & Humanities',
  B: 'Education',
  C: 'Environment',
  D: 'Animal Related',
  E: 'Health',
  F: 'Mental Health',
  G: 'Disease & Medical Disciplines',
  H: 'Medical Research',
  I: 'Crime & Law Enforcement',
  J: 'Employment',
  K: 'Food, Agriculture & Nutrition',
  L: 'Housing & Shelter',
  M: 'Public Safety & Disaster Prep',
  N: 'Recreation & Sports',
  O: 'Youth Development',
  P: 'Human Services',
  Q: 'International Affairs',
  R: 'Civil Rights & Social Action',
  S: 'Community Improvement',
  T: 'Philanthropy & Voluntarism',
  U: 'Science & Technology',
  V: 'Social Sciences',
  W: 'Public & Societal Benefit',
  X: 'Religion Related',
  Y: 'Mutual Benefit',
  Z: 'Unknown',
};

function nteeLabel(code: string): string {
  if (!code) return '—';
  return NTEE_LABELS[code[0].toUpperCase()] || code;
}

function decodeName(name: string): string {
  return (name || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function activeYears(p: RecipientProfile): string {
  const a = p.fundingSummary?.firstGrantYear;
  const b = p.fundingSummary?.lastGrantYear;
  if (a && b) return a === b ? `${a}` : `${a}–${b}`;
  return a ? `${a}` : b ? `${b}` : '—';
}

function locationOf(p: RecipientProfile): string {
  const city = p.location?.city;
  const state = p.location?.state;
  if (city && state) return `${city}, ${state}`;
  return state || city || '—';
}

type Better = 'left' | 'right' | 'none';

interface MetricRow {
  label: string;
  left: string;
  right: string;
  // numeric basis used only to decide which side to highlight; undefined => no highlight
  leftNum?: number | null;
  rightNum?: number | null;
}

function buildRows(a: RecipientProfile, b: RecipientProfile): MetricRow[] {
  const fa = a.fundingSummary;
  const fb = b.fundingSummary;
  return [
    { label: 'Location', left: locationOf(a), right: locationOf(b) },
    {
      label: 'Total Funding (lifetime)',
      left: fa?.totalFunding ? fmtDollar(fa.totalFunding) : '—',
      right: fb?.totalFunding ? fmtDollar(fb.totalFunding) : '—',
      leftNum: fa?.totalFunding ?? null,
      rightNum: fb?.totalFunding ?? null,
    },
    {
      label: 'Grants Received',
      left: fa?.grantCount != null ? fa.grantCount.toLocaleString() : '—',
      right: fb?.grantCount != null ? fb.grantCount.toLocaleString() : '—',
      leftNum: fa?.grantCount ?? null,
      rightNum: fb?.grantCount ?? null,
    },
    {
      label: 'Distinct Funders',
      left: fa?.funderCount != null ? fa.funderCount.toLocaleString() : '—',
      right: fb?.funderCount != null ? fb.funderCount.toLocaleString() : '—',
      leftNum: fa?.funderCount ?? null,
      rightNum: fb?.funderCount ?? null,
    },
    { label: 'Active Years', left: activeYears(a), right: activeYears(b) },
    {
      label: 'Annual Revenue (990)',
      left: a.budget?.totalRevenue ? fmtDollar(a.budget.totalRevenue) : '—',
      right: b.budget?.totalRevenue ? fmtDollar(b.budget.totalRevenue) : '—',
      leftNum: a.budget?.totalRevenue ?? null,
      rightNum: b.budget?.totalRevenue ?? null,
    },
    {
      label: 'Annual Expenses (990)',
      left: a.budget?.totalExpenses ? fmtDollar(a.budget.totalExpenses) : '—',
      right: b.budget?.totalExpenses ? fmtDollar(b.budget.totalExpenses) : '—',
      leftNum: a.budget?.totalExpenses ?? null,
      rightNum: b.budget?.totalExpenses ?? null,
    },
    {
      label: 'Focus Areas',
      left: (a.ntee_codes || []).map(nteeLabel).filter(Boolean).join(', ') || '—',
      right: (b.ntee_codes || []).map(nteeLabel).filter(Boolean).join(', ') || '—',
    },
  ];
}

function betterSide(row: MetricRow): Better {
  if (row.leftNum == null || row.rightNum == null) return 'none';
  if (row.leftNum === row.rightNum) return 'none';
  return row.leftNum > row.rightNum ? 'left' : 'right';
}

interface PeerComparisonProps {
  source: RecipientProfile;
  peer: PeerEntry;
  onClose: () => void;
}

export default function PeerComparison({ source, peer, onClose }: PeerComparisonProps) {
  const [peerProfile, setPeerProfile] = useState<RecipientProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRecipientProfile(peer.id)
      .then((data) => {
        if (!cancelled) setPeerProfile(data);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this peer for comparison.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [peer.id]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = peerProfile ? buildRows(source, peerProfile) : [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Head-to-head organization comparison"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[#161b22] border border-[#30363d] rounded-2xl w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d]">
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <Trophy size={16} className="text-amber-400" />
            Head-to-Head Comparison
          </h3>
          <button
            onClick={onClose}
            aria-label="Close comparison"
            className="p-1 hover:bg-[#21262d] rounded-lg transition-colors text-gray-400 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[1.2fr,auto,1.2fr] items-center gap-2 px-5 py-3 border-b border-[#30363d] bg-[#0d1117]">
          <div className="text-sm font-semibold text-cyan-300 truncate" title={decodeName(source.name)}>
            {decodeName(source.name)}
          </div>
          <ArrowRight size={14} className="text-gray-600 mx-auto" />
          <div className="text-sm font-semibold text-purple-300 text-right truncate" title={decodeName(peer.name)}>
            {decodeName(peer.name)}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-5 space-y-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="h-10 bg-[#21262d] rounded-lg animate-pulse" />
              ))}
            </div>
          )}

          {!loading && error && (
            <div className="p-8 text-center text-sm text-gray-400">{error}</div>
          )}

          {!loading && !error && peerProfile && (
            <table className="w-full text-sm">
              <tbody>
                {rows.map((row) => {
                  const winner = betterSide(row);
                  return (
                    <tr key={row.label} className="border-b border-[#30363d]/50">
                      <td
                        className={`py-3 px-5 align-top w-2/5 ${
                          winner === 'left' ? 'text-green-300 font-semibold' : 'text-gray-200'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1">
                          {winner === 'left' && <Trophy size={11} className="text-green-400 shrink-0" />}
                          {row.left}
                        </span>
                      </td>
                      <td className="py-3 px-1 text-center text-[11px] uppercase tracking-wide text-gray-400 whitespace-nowrap align-top">
                        {row.label}
                      </td>
                      <td
                        className={`py-3 px-5 align-top w-2/5 text-right ${
                          winner === 'right' ? 'text-green-300 font-semibold' : 'text-gray-200'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          {row.right}
                          {winner === 'right' && <Trophy size={11} className="text-green-400 shrink-0" />}
                          {winner === 'none' && row.leftNum != null && row.rightNum != null && (
                            <Minus size={11} className="text-gray-600 shrink-0" />
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#30363d] bg-[#0d1117]">
          <p className="text-[11px] text-gray-400">
            Funding figures are derived from IRS 990 filings and grant records. A
            <Trophy size={10} className="inline mx-1 text-green-400" />
            marks the higher value; it reflects scale, not quality of work.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}
