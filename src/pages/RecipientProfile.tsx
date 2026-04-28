import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, MapPin, Calendar, Building2, Users, Bookmark, BookmarkCheck, GraduationCap, DollarSign } from 'lucide-react';
import { RecipientProfile as RecipientProfileType, PeerEntry, Funder, GeoEntry } from '../types';
import { fetchRecipientProfile, fetchPeers } from '../utils/matching';
import { GeoBarChart, StatCard, fmtDollar } from '../components/InsightCharts';
import { useAuth } from '../contexts/AuthContext';
// localStorage storage utils removed — all save/unsave goes through Supabase with auth
import LoginModal from '../components/LoginModal';
import NavBar from '../components/NavBar';
import Toast from '../components/Toast';

export default function RecipientProfile() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, saveFunderToDB, unsaveFunderFromDB, fetchSavedIds } = useAuth();

  const [profile, setProfile] = useState<RecipientProfileType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [pendingBulkFunders, setPendingBulkFunders] = useState<Funder[]>([]);
  const [filterDafs, setFilterDafs] = useState(false);
  const [filterUniversities, setFilterUniversities] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Sync saved funder IDs — from DB for authenticated users only.
  // Anonymous users see no saved state — saving requires sign-in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (user) {
        try {
          const ids = await fetchSavedIds();
          if (!cancelled) setSavedIds(new Set(ids));
        } catch {
          if (!cancelled) setSavedIds(new Set());
        }
      } else {
        if (!cancelled) setSavedIds(new Set());
      }
    })();
    return () => { cancelled = true; };
  }, [user, fetchSavedIds]);

  const toggleSave = async (e: React.MouseEvent, funderId: string, funderName: string) => {
    e.stopPropagation(); // prevent row click navigation

    // Require auth for all save/unsave actions
    if (!user) {
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
      setPendingBulkFunders([minimalFunder]);
      setShowLoginModal(true);
      return;
    }

    if (savedIds.has(funderId)) {
      try {
        await unsaveFunderFromDB(funderId);
        setSavedIds(prev => { const next = new Set(prev); next.delete(funderId); return next; });
      } catch (err) {
        console.error('Failed to unsave funder', funderId, err);
      }
    } else {
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
      try {
        await saveFunderToDB(minimalFunder);
        setSavedIds(prev => new Set(prev).add(funderId));
      } catch (err) {
        console.error('Failed to save funder', funderId, err);
      }
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
      <>
        <NavBar />
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
      </>
    );
  }

  if (error || !profile) {
    return (
      <>
        <NavBar />
        <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
          <div className="text-center">
            <p className="text-2xl font-bold mb-4">Recipient not found</p>
            <p className="text-gray-400 text-sm mb-6">{error || 'No data available for this organization.'}</p>
            <button onClick={() => navigate('/search')} className="text-blue-400 hover:underline">Search organizations</button>
          </div>
        </div>
      </>
    );
  }

  // Build funder state geographic data for bar chart
  const funderStateGeo: GeoEntry[] = (() => {
    const stateMap = new Map<string, number>();
    let totalWithState = 0;
    for (const f of profile.topFunders) {
      const st = f.funderState;
      if (st) {
        stateMap.set(st, (stateMap.get(st) || 0) + f.grantCount);
        totalWithState += f.grantCount;
      }
    }
    if (totalWithState === 0) return [];
    return Array.from(stateMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([st, count]) => ({
        state: st,
        grantCount: count,
        totalAmount: 0,
        pctOfGrants: Math.round((count / totalWithState) * 100),
      }));
  })();

  // Helper: detect university/college names
  const isUniversityOrCollege = (name: string): boolean => {
    const lower = name.toLowerCase();
    return (
      lower.includes('university') ||
      lower.includes('college') ||
      lower.includes(' univ ') ||
      lower.endsWith(' univ') ||
      lower.includes('universidad') ||
      lower.includes('institute of technology') ||
      lower.includes('polytechnic')
    );
  };

  // Count universities in peers for filter label
  const uniCount = peers.filter(p => isUniversityOrCollege(p.name || '')).length;

  // Filter peers based on university toggle
  const visiblePeers = filterUniversities
    ? peers.filter(p => !isUniversityOrCollege(p.name || ''))
    : peers;

  // Determine budget display: prefer expenses, fall back to revenue
  const budgetAmount = profile.budget?.totalExpenses ?? profile.budget?.totalRevenue ?? null;
  const budgetLabel = profile.budget?.totalExpenses != null ? 'Total Expenses' : 'Total Revenue';

  return (
    <>
      <NavBar />
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
          <div className="grid grid-cols-2 gap-3 mb-3">
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

          {/* 990 Budget from latest filing */}
          {profile.budget && budgetAmount != null && (
            <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4 mb-3">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign size={14} className="text-purple-400" />
                <p className="text-xs text-gray-400">
                  Annual Budget (990 Filing{profile.budget.taxYear ? `, ${profile.budget.taxYear}` : ''})
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">{budgetLabel}</p>
                <p className="text-lg font-bold text-purple-400">{fmtDollar(budgetAmount)}</p>
              </div>
            </div>
          )}

          <hr className="border-[#30363d] mb-6" />

  
          {/* Funder States Bar Chart */}
          {funderStateGeo.length > 0 && (
            <>
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <MapPin size={16} className="text-blue-400" />
                Where Funders Are Based
              </h2>
              <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4 mb-2">
                <GeoBarChart data={funderStateGeo} />
              </div>
              <p className="text-xs text-gray-500 mb-6">Based on top funders by grant volume</p>
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
                  disabled={bulkBusy}
                  onClick={async () => {
                    if (bulkBusy) return;
                    const unsaved = visibleFunders.filter(f => !savedIds.has(f.funderId));
                    if (unsaved.length === 0) return;

                    const minimalFunders: Funder[] = unsaved.map(f => ({
                      id: f.funderId, name: f.funderName, type: 'foundation',
                      description: null, focus_areas: [], ntee_code: null,
                      city: null, state: null, website: null,
                      total_giving: f.totalAmount ?? null, asset_amount: null,
                      grant_range_min: null, grant_range_max: null,
                      contact_name: null, contact_title: null, contact_email: null,
                      next_step: null,
                    }));

                    if (!user) {
                      // Require auth — stash funders for post-login auto-save to
                      // Supabase, then prompt sign-in. Nothing is persisted locally.
                      setPendingBulkFunders(minimalFunders);
                      setShowLoginModal(true);
                      return;
                    }

                    setBulkBusy(true);
                    let successCount = 0;
                    try {
                      for (const f of minimalFunders) {
                        try {
                          await saveFunderToDB(f);
                          successCount += 1;
                        } catch (err) {
                          console.error('Failed to save funder', f.id, err);
                        }
                      }
                      setSavedIds(prev => {
                        const next = new Set(prev);
                        minimalFunders.forEach(f => next.add(f.id));
                        return next;
                      });
                      setToastMsg(
                        successCount === minimalFunders.length
                          ? `Added ${successCount} funder${successCount === 1 ? '' : 's'} to your prospects`
                          : `Added ${successCount} of ${minimalFunders.length} funders — some failed to save`
                      );
                    } finally {
                      setBulkBusy(false);
                    }
                  }}
                  className="mt-3 w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl py-2.5 transition-colors flex items-center justify-center gap-2"
                >
                  <Bookmark size={14} />
                  {bulkBusy
                    ? 'Adding…'
                    : `Add All ${visibleFunders.filter(f => !savedIds.has(f.funderId)).length} Funders to My Prospects`}
                </button>
              )}
            </>
            );
          })()}

          {/* Similar Recipients (Peers) */}
          {(peers.length > 0 || peersLoading) && (
            <>
              <hr className="border-[#30363d] my-6" />
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Users size={16} className="text-cyan-400" />
                Similar Organizations
              </h2>
              {/* University/college filter */}
              {uniCount > 0 && !peersLoading && (
                <button
                  onClick={() => setFilterUniversities(prev => !prev)}
                  className={`mb-3 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors flex items-center gap-1.5 ${
                    filterUniversities
                      ? 'bg-purple-900/30 border-purple-700/50 text-purple-400 hover:bg-purple-900/50'
                      : 'bg-[#21262d] border-[#30363d] text-gray-400 hover:text-gray-200 hover:border-gray-500'
                  }`}
                >
                  <GraduationCap size={12} />
                  {filterUniversities ? `Showing without universities (${uniCount} hidden)` : 'Filter out universities & colleges'}
                </button>
              )}
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
                      {visiblePeers.map((p, i) => (
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
                  <p className="text-xs text-gray-500 mt-2">Based on NTEE classification, geography, and funding patterns</p>
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
      {showLoginModal && (
        <LoginModal
          pendingFunders={pendingBulkFunders.length > 0 ? pendingBulkFunders : undefined}
          onClose={() => {
            setShowLoginModal(false);
            setPendingBulkFunders([]);
          }}
        />
      )}
      {toastMsg && (
        <Toast
          message={toastMsg}
          action={{
            label: 'View saved',
            onClick: () => { setToastMsg(null); navigate('/saved'); },
          }}
          onClose={() => setToastMsg(null)}
        />
      )}
    </div>
    </>
  );
}
