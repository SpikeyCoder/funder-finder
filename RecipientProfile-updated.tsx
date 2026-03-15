import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, MapPin, Calendar, Building2, Users, Bookmark, BookmarkCheck } from 'lucide-react';
import { RecipientProfile as RecipientProfileType, PeerEntry, Funder } from '../types';
import { fetchRecipientProfile, fetchPeers } from '../utils/matching';
import { GivingTrendsChart, StatCard, fmtDollar } from '../components/InsightCharts';
import { useAuth } from '../contexts/AuthContext';
import { isSaved, saveFunder, unsaveFunder } from '../utils/storage';
import LoginModal from '../components/LoginModal';

export default function RecipientProfile() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useAuth(); // hook available for future auth-aware save logic

  const [profile, setProfile] = useState<RecipientProfileType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [filterDafs, setFilterDafs] = useState(false);

  // Sync saved funder IDs from localStorage
  useEffect(() => {
    const ids = new Set((JSON.parse(localStorage.getItem('savedFunders_v2') || '[]') as Funder[]).map(f => f.id));
    setSavedIds(ids);
  }, []);

  const toggleSave = (e: React.MouseEvent, funderId: string, funderName: string) => {
    e.stopPropagation(); // prevent row click navigation
    if (isSaved(funderId)) {
      unsaveFunder(funderId);
      setSavedIds(prev => { const next = new Set(prev); next.delete(funderId); return next; });
    } else {
      // Build a minimal Funder object from the available data
      const entry = profile?.topFunders.find(f => f.funderId === funderId);
      const minimalFunder: Funder = {
        id: funderId,
        name: funderName,
        type: 'foundation',
        description: null,
        focus_areas: [],
        ntee_code: null,
        city: null,
        state: null,
        website: null,
        total_giving: entry?.totalAmount ?? null,
        asset_amount: null,
        grant_range_min: null,
        grant_range_max: null,
        contact_name: null,
        contact_title: null,
        contact_email: null,
        next_step: null,
      };
      saveFunder(minimalFunder);
      setSavedIds(prev => new Set(prev).add(funderId));
    }
  };

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    // id could be a UUID (from OrgSearch) or an EIN (from peer links)
    const isUuid = id.includes('-') && id.length > 20;
    fetchRecipientProfile(isUuid ? id : undefined, isUuid ? undefined : id)
      .then(data => { if (!cancelled) setProfile(data); })
      .catch(err => { if (!cancelled) setError(err.message || 'Failed to load profile'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [id]);

  // Fetch similar recipients (peers) once we have the profile
  useEffect(() => {
    if (!profile?.id) return;
    let cancelled = false;
    setPeersLoading(true);
    fetchPeers('recipient', profile.id)
      .then(data => { if (!cancelled) setPeers(data); })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setPeersLoading(false); });
    return () => { cancelled = true; };
  }, [profile?.id]);

  useEffect(() => {
    const name = profile?.name ? `${profile.name} | FunderMatch` : 'Recipient Profile | FunderMatch';
    document.title = name;
  }, [profile]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
        <div className="animate-pulse space-y-4 w-full max-w-2xl px-6">
          <div className="h-8 bg-[#21262d] rounded w-64" />
          <div className="h-4 bg-[#21262d] rounded w-40" />
          <div className="grid grid-cols-2 gap-3 mt-6">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-20 bg-[#21262d] rounded-xl" />)}
          </div>
          <div className="h-48 bg-[#21262d] rounded-xl mt-4" />
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-2xl font-bold mb-4">Recipient not found</p>
          <p className="text-gray-400 text-sm mb-6">{error || 'No data available for this organization.'}</p>
          <button onClick={() => navigate('/search')} className="text-blue-400 hover:underline">Search organizations</button>
        </div>
      </div>
    );
  }

  // Adapt yearlyTrends to the YearTrend shape expected by GivingTrendsChart
  const chartData = profile.yearlyTrends.map(t => ({
    year: t.year,
    grantCount: t.grantCount,
    totalAmount: t.totalAmount,
    avgGrant: t.grantCount > 0 ? Math.round(t.totalAmount / t.grantCount) : 0,
  }));

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-8 transition-colors"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-8">
          {/* Header */}
          <div className="mb-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block bg-green-900/30 border border-green-800/50 text-green-400 text-xs px-2.5 py-0.5 rounded-full">
                Grant Recipient
              </span>
              {profile.ein && (
                <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-400 text-xs px-2.5 py-0.5 rounded-full">
                  EIN {profile.ein}
                </span>
              )}
            </div>
            <h1 className="text-3xl font-bold mt-2">{profile.name}</h1>
          </div>

          {(profile.location.city || profile.location.state) && (
            <div className="flex items-center gap-2 text-gray-400 mb-6">
              <MapPin size={14} />
              <span className="text-sm">{[profile.location.city, profile.location.state].filter(Boolean).join(', ')}</span>
            </div>
          )}

          <hr className="border-[#30363d] mb-6" />

          {/* Funding Summary */}
          <h2 className="text-lg font-semibold mb-3">Funding Summary</h2>
          <div className="grid grid-cols-2 gap-3 mb-6">
            <StatCard label="Total Funding" value={fmtDollar(profile.fundingSummary.totalFunding)} color="text-green-400" />
            <StatCard label="Total Grants" value={profile.fundingSummary.grantCount.toLocaleString()} />
            <StatCard label="Unique Funders" value={profile.fundingSummary.funderCount.toLocaleString()} color="text-blue-400" />
            <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
              <p className="text-xs text-gray-400 mb-1">Active Years</p>
              <div className="flex items-center gap-1.5">
                <Calendar size={14} className="text-gray-500" />
                <p className="text-lg font-bold text-white">
                  {profile.fundingSummary.firstGrantYear || '?'} – {profile.fundingSummary.lastGrantYear || '?'}
                </p>
              </div>
            </div>
          </div>
          <hr className="border-[#30363d] mb-6" />

          {/* Funding Trends Chart */}
          {chartData.length > 0 && (
            <>
              <h2 className="text-lg font-semibold mb-3">Funding Trends</h2>
              <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4 mb-2">
                <GivingTrendsChart data={chartData} />
              </div>
              <p className="text-xs text-gray-500 mb-6">Source: IRS 990-PF filings, 2015–present</p>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Top Funders — FEAT-002: prominent CTA to save funders */}
          {profile.topFunders.length > 0 && (() => {
            const visibleFunders = filterDafs
              ? profile.topFunders.filter(f => !f.isDaf).slice(0, 15)
              : profile.topFunders.slice(0, 15);
            const dafCount = profile.topFunders.filter(f => f.isDaf).length;
            return (
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Top Funders</h2>
                <span className="text-xs text-gray-500">Click bookmark to add to your prospects</span>
              </div>
              {dafCount > 0 && (
                <button
                  onClick={() => setFilterDafs(prev => !prev)}
                  className={`mb-3 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                    filterDafs
                      ? 'bg-amber-900/30 border-amber-700/50 text-amber-400 hover:bg-amber-900/50'
                      : 'bg-[#21262d] border-[#30363d] text-gray-400 hover:text-gray-200 hover:border-gray-500'
                  }`}
                >
                  {filterDafs ? `Showing without DAFs (${dafCount} hidden)` : 'Filter out Donor Advised Funds'}
                </button>
              )}
              <div className="overflow-x-auto mb-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-xs border-b border-[#30363d]">
                      <th className="text-left py-2 pr-3">Funder</th>
                      <th className="text-right py-2 px-2">Total</th>
                      <th className="text-right py-2 px-2">Grants</th>
                      <th className="text-right py-2 px-2">Last</th>
                      <th className="py-2 pl-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFunders.map((f, i) => (
                      <tr
                        key={`${f.funderId}-${i}`}
                        className="border-b border-[#30363d]/50 hover:bg-[#21262d]/30 cursor-pointer"
                        onClick={() => navigate(`/funder/${f.funderId}`)}
                      >
                        <td className="py-2 pr-3 max-w-[200px]">
                          <div className="flex items-center gap-2">
                            <Building2 size={12} className={f.isDaf ? 'text-amber-400 shrink-0' : 'text-blue-400 shrink-0'} />
                            <span className="text-gray-200 truncate">{f.funderName}</span>
                            {f.isDaf && <span className="text-[10px] text-amber-400/70 bg-amber-900/20 border border-amber-800/30 px-1.5 py-0.5 rounded shrink-0">DAF</span>}
                          </div>
                        </td>
                        <td className="py-2 px-2 text-right text-gray-300 whitespace-nowrap">{fmtDollar(f.totalAmount)}</td>
                        <td className="py-2 px-2 text-right text-gray-400">{f.grantCount}</td>
                        <td className="py-2 px-2 text-right text-gray-400">{f.lastYear}</td>
                        <td className="py-2 pl-2 text-center">
                          <button
                            onClick={(e) => toggleSave(e, f.funderId, f.funderName)}
                            className="p-1 rounded hover:bg-white/10 transition-colors"
                            title={savedIds.has(f.funderId) ? 'Remove from saved' : 'Save funder'}
                          >
                            {savedIds.has(f.funderId) ? (
                              <BookmarkCheck size={14} className="text-blue-400" />
                            ) : (
                              <Bookmark size={14} className="text-gray-500 hover:text-gray-300" />
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* FEAT-002: Prominent bulk-save CTA */}
              {visibleFunders.filter(f => !savedIds.has(f.funderId)).length > 0 && (
                <button
                  onClick={() => {
                    const unsaved = visibleFunders.filter(f => !savedIds.has(f.funderId));
                    const newIds = new Set(savedIds);
                    unsaved.forEach(f => {
                      const minimalFunder: Funder = {
                        id: f.funderId, name: f.funderName, type: 'foundation',
                        description: null, focus_areas: [], ntee_code: null,
                        city: null, state: null, website: null,
                        total_giving: f.totalAmount ?? null, asset_amount: null,
                        grant_range_min: null, grant_range_max: null,
                        contact_name: null, contact_title: null, contact_email: null,
                        next_step: null,
                      };
                      saveFunder(minimalFunder);
                      newIds.add(f.funderId);
                    });
                    setSavedIds(newIds);
                  }}
                  className="mt-3 w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl py-2.5 transition-colors flex items-center justify-center gap-2"
                >
                  <Bookmark size={14} />
                  Add All {visibleFunders.filter(f => !savedIds.has(f.funderId)).length} Funders to My Prospects
                </button>
              )}
            </>
            );
          })()}

          {/* Similar Recipients (Peers) */}
          {/* Decode common HTML entities that may be stored in DB names */}
          {/* Safety net in case upstream data contains &amp; etc. */}
          {(peers.length > 0 || peersLoading) && (
            <>
              <hr className="border-[#30363d] my-6" />
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Users size={16} className="text-cyan-400" />
                Similar Organizations
              </h2>
              {peersLoading ? (
                <div className="space-y-2">
                  {[1,2,3].map(i => <div key={i} className="h-12 bg-[#21262d] rounded-xl animate-pulse" />)}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-400 text-xs border-b border-[#30363d]">
                        <th className="text-left py-2 pr-3">Organization</th>
                        <th className="text-right py-2 px-2">State</th>
                        <th className="text-right py-2 px-2">Total Funding</th>
                        <th className="text-right py-2 pl-2">Similarity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {peers.map((p, i) => (
                        <tr
                          key={`${p.id}-${i}`}
                          className="border-b border-[#30363d]/50 hover:bg-[#21262d]/30 cursor-pointer"
                          onClick={() => navigate(`/recipient/${p.id}`)}
                        >
                          <td className="py-2 pr-3 text-gray-200 max-w-[200px] truncate">{p.name?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')}</td>
                          <td className="py-2 px-2 text-right text-gray-400">{p.state || '—'}</td>
                          <td className="py-2 px-2 text-right text-gray-300 whitespace-nowrap">
                            {p.totalFunding ? fmtDollar(p.totalFunding) : '—'}
                          </td>
                          <td className="py-2 pl-2 text-right">
                            <span className={`text-xs font-medium ${p.score >= 0.3 ? 'text-green-400' : p.score >= 0.15 ? 'text-yellow-400' : 'text-gray-400'}`}>
                              {Math.round(p.score * 100)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-xs text-gray-500 mt-2">Based on mission keyword similarity from grant purpose descriptions</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Bottom nav */}
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => navigate('/search')}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            ← Back to Search
          </button>
          <button
            onClick={() => navigate('/mission')}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            Find Matching Funders
          </button>
        </div>
      </div>
      {showLoginModal && <LoginModal onClose={() => setShowLoginModal(false)} />}
    </div>
  );
}
