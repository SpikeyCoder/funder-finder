import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, MapPin, Calendar, Building2, Users } from 'lucide-react';
import { RecipientProfile as RecipientProfileType, PeerEntry } from '../types';
import { fetchRecipientProfile, fetchPeers } from '../utils/matching';
import { GivingTrendsChart, StatCard, fmtDollar } from '../components/InsightCharts';

export default function RecipientProfile() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<RecipientProfileType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);

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

          {/* Top Funders */}
          {profile.topFunders.length > 0 && (
            <>
              <h2 className="text-lg font-semibold mb-3">Top Funders</h2>
              <div className="overflow-x-auto mb-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-xs border-b border-[#30363d]">
                      <th className="text-left py-2 pr-3">Funder</th>
                      <th className="text-right py-2 px-2">Total</th>
                      <th className="text-right py-2 px-2">Grants</th>
                      <th className="text-right py-2 pl-2">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.topFunders.map((f, i) => (
                      <tr
                        key={`${f.funderId}-${i}`}
                        className="border-b border-[#30363d]/50 hover:bg-[#21262d]/30 cursor-pointer"
                        onClick={() => navigate(`/funder/${f.funderId}`)}
                      >
                        <td className="py-2 pr-3 max-w-[200px]">
                          <div className="flex items-center gap-2">
                            <Building2 size={12} className="text-blue-400 shrink-0" />
                            <span className="text-gray-200 truncate">{f.funderName}</span>
                          </div>
                        </td>
                        <td className="py-2 px-2 text-right text-gray-300 whitespace-nowrap">{fmtDollar(f.totalAmount)}</td>
                        <td className="py-2 px-2 text-right text-gray-400">{f.grantCount}</td>
                        <td className="py-2 pl-2 text-right text-gray-400">{f.lastYear}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Similar Recipients (Peers) */}
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
                        <th className="text-right py-2 px-2">Shared Funders</th>
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
                          <td className="py-2 pr-3 text-gray-200 max-w-[200px] truncate">{p.name}</td>
                          <td className="py-2 px-2 text-right text-gray-400">{p.sharedCount}</td>
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
                  <p className="text-xs text-gray-500 mt-2">Based on shared funders over the last 5 years</p>
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
    </div>
  );
}
