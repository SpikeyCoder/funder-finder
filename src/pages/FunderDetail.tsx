import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, BookmarkCheck, Copy, Globe, MapPin, User, Mail, TrendingUp, ChevronDown, ChevronUp, BarChart3, Users, Map, Loader2, FileText, Info } from 'lucide-react';
import { Funder, FunderInsights, PeerEntry } from '../types';
import { isSaved, saveFunder, unsaveFunder } from '../utils/storage';
import { formatGrantRange, formatTotalGiving, fetchFunderInsights, fetchPeers, fetchFunderByEin } from '../utils/matching';
import { useAuth } from '../contexts/AuthContext';
import LoginModal from '../components/LoginModal';
import { GivingTrendsChart, GeoBarChart, GeoHeatMap, StatCard, InsightsSkeleton, fmtDollar } from '../components/InsightCharts';

/** Classify giving trend as increasing / stable / decreasing (FEAT-006) */
function classifyTrend(yearTrend: { year: number; totalAmount: number }[]): { label: string; color: string } | null {
  if (yearTrend.length < 3) return null;
  const sorted = [...yearTrend].sort((a, b) => a.year - b.year);
  const recent = sorted.slice(-3);
  const first = recent[0].totalAmount;
  const last = recent[recent.length - 1].totalAmount;
  if (first === 0 && last === 0) return null;
  const mean = recent.reduce((s, d) => s + d.totalAmount, 0) / recent.length;
  if (mean === 0) return null;
  const pctChange = (last - first) / mean;
  if (pctChange > 0.05) return { label: 'Increasing', color: 'text-green-400 bg-green-900/30 border-green-800/50' };
  if (pctChange < -0.05) return { label: 'Decreasing', color: 'text-red-400 bg-red-900/30 border-red-800/50' };
  return { label: 'Stable', color: 'text-yellow-400 bg-yellow-900/30 border-yellow-800/50' };
}

function formatGrantAmount(amount: number | null | undefined): string {
  if (!amount || !Number.isFinite(amount)) return 'Amount not disclosed';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export default function FunderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { funder: funderFromState, mission = '', keywords = [] } = location.state || {};
  const { user, saveFunderToDB, unsaveFunderFromDB } = useAuth();

  // Use funder passed in navigation state; fall back to API fetch by EIN
  const [funder, setFunder] = useState<Funder | null>(funderFromState || null);
  const [funderLoading, setFunderLoading] = useState(!funderFromState && !!id);

  // If no funder passed via state, fetch from Supabase by EIN
  useEffect(() => {
    if (funder || !id) return;
    let cancelled = false;
    setFunderLoading(true);
    fetchFunderByEin(id)
      .then(data => { if (!cancelled) setFunder(data); })
      .catch(() => { /* leave null — shows not-found */ })
      .finally(() => { if (!cancelled) setFunderLoading(false); });
    return () => { cancelled = true; };
  }, [id, funder]);
  const [saved, setSaved] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);

  // 990 Intelligence state
  const [insights, setInsights] = useState<FunderInsights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    trends: true, grantees: false, geo: false, recipients: false, purposes: false, peers: false,
  });

  const [showAllRecipients, setShowAllRecipients] = useState(false);

  const toggleSection = (key: string) =>
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  // Page title — use funder name when available
  useEffect(() => {
    const name = funder?.name ? `${funder.name} | FunderMatch` : 'Funder Details | FunderMatch';
    document.title = name;
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = funder?.name
      ? `View contact info, mission alignment, and grant details for ${funder.name}. Generate a tailored grant application in seconds.`
      : 'View funder contact info, mission alignment scores, and generate a tailored grant application.';
  }, [funder]);

  useEffect(() => {
    if (id) {
      if (user) {
        // For logged-in users, we check the DB; but a quick sync from the
        // Results page has already loaded savedIds. For simplicity here
        // we fall back to localStorage state which is synced in Results.
        setSaved(isSaved(id));
      } else {
        setSaved(isSaved(id));
      }
    }
  }, [id, user]);

  // Fetch 990 insights when funder loads
  useEffect(() => {
    if (!funder?.id) return;
    let cancelled = false;
    setInsightsLoading(true);
    setInsightsError(null);
    fetchFunderInsights(funder.id)
      .then(data => { if (!cancelled) setInsights(data); })
      .catch(err => { if (!cancelled) setInsightsError(err.message || 'Failed to load insights'); })
      .finally(() => { if (!cancelled) setInsightsLoading(false); });
    return () => { cancelled = true; };
  }, [funder?.id]);

  // Fetch similar funders (peers)
  useEffect(() => {
    if (!funder?.id) return;
    let cancelled = false;
    setPeersLoading(true);
    fetchPeers('funder', funder.id)
      .then(data => { if (!cancelled) setPeers(data); })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setPeersLoading(false); });
    return () => { cancelled = true; };
  }, [funder?.id]);

  if (funderLoading) return (
    <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
      <Loader2 size={28} className="animate-spin text-gray-400" />
    </div>
  );

  if (!funder) return (
    <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
      <div className="text-center">
        <p className="text-2xl font-bold mb-4">Funder not found</p>
        <p className="text-gray-400 text-sm mb-6">This funder may not be in our database yet.</p>
        <button onClick={() => navigate('/search')} className="text-blue-400 hover:underline">Search organizations</button>
      </div>
    </div>
  );

  const toggleSave = async () => {
    if (user) {
      // Authenticated path — use DB
      if (saved) {
        try {
          await unsaveFunderFromDB(funder.id);
          unsaveFunder(funder.id); // keep localStorage in sync
          setSaved(false);
        } catch (e) {
          console.error('Failed to unsave from DB:', e);
        }
      } else {
        try {
          await saveFunderToDB(funder);
          saveFunder(funder); // keep localStorage in sync
          setSaved(true);
        } catch (e) {
          console.error('Failed to save to DB:', e);
        }
      }
    } else {
      // Anonymous path
      if (saved) {
        unsaveFunder(funder.id);
        setSaved(false);
      } else {
        // Show login modal; funder will be auto-saved after OAuth redirect
        setShowLoginModal(true);
      }
    }
  };

  const copyEmail = () => {
    if (!funder.contact_email) return;
    navigator.clipboard.writeText(funder.contact_email);
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => {
            // If there's real navigation history, go back; otherwise fall back to /search
            if (window.history.length > 2) {
              navigate(-1);
            } else {
              navigate('/search');
            }
          }}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-8 transition-colors"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-8">
          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <h1 className="text-3xl font-bold">{funder.name}</h1>
            <button
              onClick={toggleSave}
              className={`flex items-center gap-2 border rounded-xl px-4 py-2 text-sm transition-colors ${saved ? 'border-blue-600 text-blue-400 bg-blue-900/20' : 'border-[#30363d] hover:bg-[#21262d]'}`}
            >
              {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
              {saved ? 'Saved' : 'Save Funder'}
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-sm px-3 py-1 rounded-full capitalize">
              {funder.type}
            </span>
            {funder.ntee_code && (
              <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-400 text-sm px-3 py-1 rounded-full">
                NTEE {funder.ntee_code}
              </span>
            )}
          </div>

          {/* AI match reason */}
          {(funder.fit_explanation || funder.reason) && (
            <div className="mb-6 bg-[#0d1117] border border-blue-900/50 rounded-xl px-4 py-3">
              <p className="text-xs text-blue-400 font-semibold mb-1">Why this funder matches your mission</p>
              <p className="text-gray-300 text-sm">{funder.fit_explanation || funder.reason}</p>
              {funder.score && (
                <p className="text-xs text-gray-300 mt-2">Match score: {Math.round(funder.score * 100)}%</p>
              )}
            </div>
          )}

          {/* Mission / Description (FEAT-003) */}
          {funder.description && (
            <div className="mb-6 bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Info size={14} className="text-gray-400" />
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wide">About this funder</p>
              </div>
              <p className="text-gray-300 text-sm leading-relaxed">{funder.description}</p>
            </div>
          )}

          <hr className="border-[#30363d] mb-6" />

          {/* Similar past grantees */}
          {funder.similar_past_grantees && funder.similar_past_grantees.length > 0 && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Similar Past Grantees</h2>
                <p className="text-xs text-blue-400 font-semibold mb-3">Top 3 related grantees used in your match</p>
                <div className="space-y-3">
                  {funder.similar_past_grantees.slice(0, 3).map((grantee, idx) => (
                    <div key={`${funder.id}-detail-grantee-${idx}`} className="border border-[#30363d] rounded-lg p-3 bg-[#0d1117]">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <p className="text-sm font-semibold text-white">{grantee.name}</p>
                        <p className="text-xs text-gray-300">
                          {(grantee.year ? String(grantee.year) : 'Year n/a')} · {formatGrantAmount(grantee.amount)}
                        </p>
                      </div>
                      {grantee.match_reasons.length > 0 && (
                        <ul className="list-disc ml-4 text-xs text-gray-300 space-y-1">
                          {grantee.match_reasons.slice(0, 2).map((reason, reasonIdx) => (
                            <li key={`${funder.id}-detail-grantee-${idx}-reason-${reasonIdx}`}>{reason}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Focus Areas */}
          {funder.focus_areas && funder.focus_areas.length > 0 && (
            <>
              <div id="focus-areas" className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Focus Areas</h2>
                <div className="flex flex-wrap gap-2">
                  {funder.focus_areas.map(area => (
                    <span key={area} className="bg-[#21262d] border border-[#30363d] text-gray-300 text-sm px-3 py-1 rounded-full capitalize">
                      {area.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Giving Stats */}
          {(funder.total_giving || funder.grant_range_min || funder.grant_range_max) && (
            <>
              <div id="giving" className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Giving Overview</h2>
                <div className="grid grid-cols-2 gap-4">
                  {funder.total_giving && (
                    <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <TrendingUp size={14} className="text-green-400" />
                        <p className="text-xs text-gray-400">Annual Giving</p>
                      </div>
                      <p className="text-white font-semibold">{formatTotalGiving(funder.total_giving)}</p>
                    </div>
                  )}
                  {(funder.grant_range_min || funder.grant_range_max) && (
                    <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
                      <p className="text-xs text-gray-400 mb-1">Typical Grant</p>
                      <p className="text-white font-semibold">{formatGrantRange(funder)}</p>
                    </div>
                  )}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* ── 990 Intelligence Sections ── */}
          {insightsLoading && <InsightsSkeleton />}
          {insightsError && (
            <div className="mb-6 text-sm text-gray-500 italic">
              990 data unavailable: {insightsError}
            </div>
          )}
          {insights && insights.grantHistory.yearTrend.length > 0 && (
            <>
              {/* Section 1: Giving Trends */}
              <div className="mb-6">
                <button
                  onClick={() => toggleSection('trends')}
                  className="flex items-center justify-between w-full mb-3 group"
                >
                  <div className="flex items-center gap-2">
                    <BarChart3 size={16} className="text-blue-400" />
                    <h2 className="text-lg font-semibold">990 Giving Trends</h2>
                    {(() => {
                      const trend = classifyTrend(insights.grantHistory.yearTrend);
                      return trend ? (
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${trend.color}`}>
                          {trend.label}
                        </span>
                      ) : null;
                    })()}
                  </div>
                  {expandedSections.trends ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                </button>
                {expandedSections.trends && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <StatCard label="Total Grants" value={insights.grantHistory.totalGrants.toLocaleString()} />
                      <StatCard label="Total Given" value={fmtDollar(insights.grantHistory.totalAmount)} color="text-blue-400" />
                      <StatCard
                        label="Avg Grant"
                        value={fmtDollar(
                          insights.grantHistory.totalGrants > 0
                            ? insights.grantHistory.totalAmount / insights.grantHistory.totalGrants
                            : 0
                        )}
                      />
                    </div>
                    <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
                      <GivingTrendsChart data={insights.grantHistory.yearTrend} />
                    </div>
                    <p className="text-xs text-gray-500">
                      Data through {insights.dataAsOf || 'IRS 990-PF filings, 2015–present'}
                    </p>
                  </div>
                )}
              </div>
              <hr className="border-[#30363d] mb-6" />

              {/* Section 2: Grantee Patterns */}
              <div className="mb-6">
                <button
                  onClick={() => toggleSection('grantees')}
                  className="flex items-center justify-between w-full mb-3 group"
                >
                  <div className="flex items-center gap-2">
                    <Users size={16} className="text-green-400" />
                    <h2 className="text-lg font-semibold">Grantee Patterns</h2>
                  </div>
                  {expandedSections.grantees ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                </button>
                {expandedSections.grantees && (
                  <div className="grid grid-cols-2 gap-3">
                    <StatCard label="Total Grantees (5yr)" value={insights.granteeAnalysis.totalGrantees5y.toLocaleString()} />
                    <StatCard label="New Grantees" value={insights.granteeAnalysis.newGrantees.toLocaleString()} color="text-green-400" />
                    <StatCard label="Repeat Grantees" value={insights.granteeAnalysis.repeatGrantees.toLocaleString()} color="text-blue-400" />
                    <StatCard
                      label="Repeat Rate"
                      value={`${insights.granteeAnalysis.pctRepeat}%`}
                      color={insights.granteeAnalysis.pctRepeat >= 50 ? 'text-green-400' : 'text-yellow-400'}
                    />
                  </div>
                )}
              </div>
              <hr className="border-[#30363d] mb-6" />

              {/* Section 3: Geographic Footprint */}
              {insights.geographicFootprint.length > 0 && (
                <>
                  <div className="mb-6">
                    <button
                      onClick={() => toggleSection('geo')}
                      className="flex items-center justify-between w-full mb-3 group"
                    >
                      <div className="flex items-center gap-2">
                        <Map size={16} className="text-purple-400" />
                        <h2 className="text-lg font-semibold">Geographic Footprint</h2>
                      </div>
                      {expandedSections.geo ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                    </button>
                    {expandedSections.geo && (
                      <div className="space-y-4">
                        <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
                          <GeoHeatMap data={insights.geographicFootprint} />
                        </div>
                        <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
                          <p className="text-xs text-gray-500 mb-2">Top states by grant count</p>
                          <GeoBarChart data={insights.geographicFootprint} />
                        </div>
                      </div>
                    )}
                  </div>
                  <hr className="border-[#30363d] mb-6" />
                </>
              )}

              {/* Section 4: Key Recipients (FEAT-005: paginated with clickable links) */}
              {insights.keyRecipients.length > 0 && (
                <>
                  <div className="mb-6">
                    <button
                      onClick={() => toggleSection('recipients')}
                      className="flex items-center justify-between w-full mb-3 group"
                    >
                      <div className="flex items-center gap-2">
                        <TrendingUp size={16} className="text-yellow-400" />
                        <h2 className="text-lg font-semibold">Key Recipients</h2>
                        <span className="text-xs text-gray-500">({insights.keyRecipients.length})</span>
                      </div>
                      {expandedSections.recipients ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                    </button>
                    {expandedSections.recipients && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-gray-400 text-xs border-b border-[#30363d]">
                              <th className="text-left py-2 pr-3">Recipient</th>
                              <th className="text-right py-2 px-2">Total</th>
                              <th className="text-right py-2 px-2">Grants</th>
                              <th className="text-right py-2 pl-2">Last</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(showAllRecipients ? insights.keyRecipients : insights.keyRecipients.slice(0, 10)).map((r, i) => (
                              <tr
                                key={`${r.granteeEin || i}`}
                                className="border-b border-[#30363d]/50 hover:bg-[#21262d]/30 cursor-pointer"
                                onClick={() => r.granteeEin && navigate(`/recipient/${r.granteeEin}`)}
                              >
                                <td className="py-2 pr-3 max-w-[200px] truncate">
                                  <span className={r.granteeEin ? 'text-blue-400 hover:underline' : 'text-gray-200'}>{r.granteeName}</span>
                                </td>
                                <td className="py-2 px-2 text-right text-gray-300 whitespace-nowrap">{fmtDollar(r.totalAmount)}</td>
                                <td className="py-2 px-2 text-right text-gray-400">{r.grantCount}</td>
                                <td className="py-2 pl-2 text-right text-gray-400">{r.lastYear}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {insights.keyRecipients.length > 10 && (
                          <button
                            onClick={() => setShowAllRecipients(prev => !prev)}
                            className="mt-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
                          >
                            {showAllRecipients ? 'Show fewer' : `View all ${insights.keyRecipients.length} recipients`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <hr className="border-[#30363d] mb-6" />
                </>
              )}

              {/* Section 5: Recent Grant Purposes (FEAT-001) */}
              {insights.recentGrantPurposes && insights.recentGrantPurposes.length > 0 && (
                <>
                  <div className="mb-6">
                    <button
                      onClick={() => toggleSection('purposes')}
                      className="flex items-center justify-between w-full mb-3 group"
                    >
                      <div className="flex items-center gap-2">
                        <FileText size={16} className="text-orange-400" />
                        <h2 className="text-lg font-semibold">Recent Grant Purposes</h2>
                      </div>
                      {expandedSections.purposes ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                    </button>
                    {expandedSections.purposes && (
                      <div className="space-y-2">
                        {insights.recentGrantPurposes.map((gp, i) => (
                          <div
                            key={`purpose-${i}`}
                            className="bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-3"
                          >
                            <p className="text-sm text-gray-200 leading-relaxed">{gp.purpose}</p>
                            <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-gray-400">
                              <span>{gp.granteeName}</span>
                              {gp.amount != null && gp.amount > 0 && (
                                <span className="text-gray-500">{fmtDollar(gp.amount)}</span>
                              )}
                              <span className="text-gray-500">{gp.year}</span>
                            </div>
                          </div>
                        ))}
                        <p className="text-xs text-gray-500 mt-1">Source: IRS 990-PF grant purpose descriptions</p>
                      </div>
                    )}
                  </div>
                  <hr className="border-[#30363d] mb-6" />
                </>
              )}
            </>
          )}

          {/* Section 5: Similar Funders (Peers) */}
          {(peers.length > 0 || peersLoading) && (
            <>
              <div className="mb-6">
                <button
                  onClick={() => toggleSection('peers')}
                  className="flex items-center justify-between w-full mb-3 group"
                >
                  <div className="flex items-center gap-2">
                    <Users size={16} className="text-cyan-400" />
                    <h2 className="text-lg font-semibold">Similar Funders</h2>
                  </div>
                  {expandedSections.peers ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                </button>
                {expandedSections.peers && (
                  peersLoading ? (
                    <div className="space-y-2">
                      {[1,2,3].map(i => <div key={i} className="h-12 bg-[#21262d] rounded-xl animate-pulse" />)}
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-gray-400 text-xs border-b border-[#30363d]">
                            <th className="text-left py-2 pr-3">Funder</th>
                            <th className="text-right py-2 px-2">Shared Recipients</th>
                            <th className="text-right py-2 px-2">State</th>
                            <th className="text-right py-2 pl-2">Similarity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {peers.map((p, i) => (
                            <tr
                              key={`${p.id}-${i}`}
                              className="border-b border-[#30363d]/50 hover:bg-[#21262d]/30 cursor-pointer"
                              onClick={() => navigate(`/funder/${p.id}`, { state: { funder: { id: p.id, name: p.name, state: p.state } as Funder } })}
                            >
                              <td className="py-2 pr-3 text-gray-200 max-w-[200px] truncate">{p.name}</td>
                              <td className="py-2 px-2 text-right text-gray-400">{p.sharedCount}</td>
                              <td className="py-2 px-2 text-right text-gray-400">{p.state || '—'}</td>
                              <td className="py-2 pl-2 text-right">
                                <span className={`text-xs font-medium ${p.score >= 0.3 ? 'text-green-400' : p.score >= 0.15 ? 'text-yellow-400' : 'text-gray-400'}`}>
                                  {Math.round(p.score * 100)}%
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="text-xs text-gray-500 mt-2">Based on shared grant recipients over the last 5 years</p>
                    </div>
                  )
                )}
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Recommended Next Step */}
          {funder.next_step && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Recommended Next Step</h2>
                <div className="bg-[#0d1117] border border-blue-800 rounded-xl px-5 py-4 text-blue-300">
                  {(() => {
                    // Normalise to a fully-qualified external URL:
                    //  - Strip stale cached GitHub Pages funder paths (e.g. https://...github.io/.../funder/cct.org)
                    //  - Reject internal routes starting with '/'
                    //  - Prepend https:// for bare domains (e.g. cct.org)
                    const STALE_RE = /^https?:\/\/[^/]*\.github\.io\/[^/]+\/funder\//;
                    const toExtUrl = (u: string | null | undefined) => {
                      let s = u?.trim();
                      if (!s) return null;
                      s = s.replace(STALE_RE, '');
                      if (!s || s.startsWith('/')) return null;
                      return s.startsWith('http') ? s : `https://${s}`;
                    };
                    const linkUrl = toExtUrl(funder.next_step_url) ?? toExtUrl(funder.website);
                    return linkUrl ? (
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-blue-200 underline underline-offset-2 transition-colors"
                      >
                        {funder.next_step}
                      </a>
                    ) : (
                      funder.next_step
                    );
                  })()}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Contact Information */}
          <div id="contact" className="mb-2">
            <h2 className="text-lg font-semibold mb-4">Contact Information</h2>
            <div className="space-y-5">
              {(funder.contact_name || funder.contact_title) && (
                <div className="flex items-start gap-3">
                  <User size={18} className="text-gray-400 mt-0.5" />
                  <div>
                    {funder.contact_name && <p className="font-medium">{funder.contact_name}</p>}
                    {funder.contact_title && <p className="text-sm text-gray-400">{funder.contact_title}</p>}
                  </div>
                </div>
              )}

              {funder.contact_email ? (
                <div className="flex items-start gap-3">
                  <Mail size={18} className="text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-gray-300">{funder.contact_email}</p>
                    <button
                      onClick={copyEmail}
                      className="flex items-center gap-1 text-sm border border-[#30363d] rounded-lg px-3 py-1 mt-2 hover:bg-[#21262d] transition-colors"
                    >
                      <Copy size={13} />
                      {copiedEmail ? 'Copied!' : 'Copy Email'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-gray-400">
                  <Mail size={18} />
                  <p className="text-sm">No direct email available</p>
                </div>
              )}

              {(funder.city || funder.state) && (
                <div className="flex items-center gap-3">
                  <MapPin size={18} className="text-gray-400" />
                  <p className="text-gray-300">
                    {[funder.city, funder.state].filter(Boolean).join(', ')}
                  </p>
                </div>
              )}

              {funder.website ? (
                <div className="flex items-center gap-3">
                  <Globe size={18} className="text-gray-400" />
                  <a
                    href={funder.website.startsWith('http') ? funder.website : `https://${funder.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline break-all"
                  >
                    {funder.website} ↗
                  </a>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-gray-400">
                  <Globe size={18} />
                  <p className="text-sm">No website available</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bottom nav */}
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => {
              // If the user arrived from AI matching (mission context exists), return to /results
              // Otherwise fall back to /search
              if (mission) {
                navigate('/results', { state: { mission, keywords } });
              } else if (window.history.length > 2) {
                navigate(-1);
              } else {
                navigate('/search');
              }
            }}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            {mission ? '← Back to Results' : '← Back to Search'}
          </button>
          <button
            onClick={() => navigate('/saved')}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            View Saved Funders
          </button>
        </div>
      </div>

      {/* Login modal — shown when anonymous user tries to save */}
      {showLoginModal && (
        <LoginModal
          pendingFunder={funder}
          onClose={() => setShowLoginModal(false)}
        />
      )}
    </div>
  );
}
