import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader, Download, TrendingUp, Clock, DollarSign, Target, Award, AlertTriangle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';
import type { PortfolioMetrics, PortfolioGrant } from '../types';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const PORTFOLIO_URL = `${SUPABASE_URL}/functions/v1/portfolio`;

function fmtCurrency(amount: number | null | undefined): string {
  if (!amount) return '$0';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

export default function PortfolioPage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null);
  const [pipelineBreakdown, setPipelineBreakdown] = useState<{ name: string; color: string; count: number }[]>([]);
  const [grants, setGrants] = useState<PortfolioGrant[]>([]);
  const [_total, setTotal] = useState(0);

  useEffect(() => {
    if (!authLoading && user) loadPortfolio();
  }, [user, authLoading]);

  const loadPortfolio = async () => {
    setLoading(true);
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(PORTFOLIO_URL, { headers });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data.metrics);
        setPipelineBreakdown(data.pipeline_breakdown || []);
        setGrants(data.grants || []);
        setTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Error loading portfolio:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(`${PORTFOLIO_URL}?export=true`, { headers });
      if (res.ok) {
        const csv = await res.text();
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fundermatch_portfolio_export.csv';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Export error:', err);
    }
  };

  if (authLoading || loading) {
    return (<><NavBar /><main className="min-h-screen bg-[#0d1117] pt-20 flex items-center justify-center"><Loader className="animate-spin text-gray-400" size={24} /></main></>);
  }

  const totalCount = pipelineBreakdown.reduce((s, b) => s + b.count, 0);

  return (
    <>
      <NavBar />
      <main className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-3xl font-bold text-white">Portfolio</h1>
            <button onClick={handleExport} disabled={grants.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-[#161b22] border border-[#30363d] text-gray-300 rounded-lg text-sm hover:border-[#484f58] transition-colors disabled:opacity-50">
              <Download size={16} /> Export CSV
            </button>
          </div>

          {/* Metrics Cards */}
          {metrics && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-400 mb-2">
                  <Target size={14} /> <span className="text-xs">Total Tracked</span>
                </div>
                <p className="text-2xl font-bold text-white">{metrics.total_tracked}</p>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-400 mb-2">
                  <TrendingUp size={14} /> <span className="text-xs">Active</span>
                </div>
                <p className="text-2xl font-bold text-white">{metrics.active_proposals}</p>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-400 mb-2">
                  <DollarSign size={14} /> <span className="text-xs">Pending Ask</span>
                </div>
                <p className="text-2xl font-bold text-white">{fmtCurrency(metrics.pending_ask)}</p>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-400 mb-2">
                  <Award size={14} /> <span className="text-xs">Win Rate</span>
                </div>
                <p className={`text-2xl font-bold ${metrics.win_rate !== null ? (metrics.win_rate >= 50 ? 'text-green-400' : metrics.win_rate >= 25 ? 'text-yellow-400' : 'text-red-400') : 'text-gray-500'}`}>
                  {metrics.win_rate !== null ? `${metrics.win_rate}%` : '-'}
                </p>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-400 mb-2">
                  <DollarSign size={14} /> <span className="text-xs">Awarded</span>
                </div>
                <p className="text-2xl font-bold text-green-400">{fmtCurrency(metrics.total_awarded)}</p>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-400 mb-2">
                  <Clock size={14} /> <span className="text-xs">Upcoming</span>
                </div>
                <p className={`text-2xl font-bold ${metrics.upcoming_deadlines > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
                  {metrics.upcoming_deadlines}
                </p>
              </div>
            </div>
          )}

          {/* Pipeline Breakdown Bar */}
          {pipelineBreakdown.length > 0 && totalCount > 0 && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 mb-8">
              <h2 className="text-sm font-medium text-gray-400 mb-3">Pipeline Overview</h2>
              <div className="flex rounded-full overflow-hidden h-6 bg-[#0d1117]">
                {pipelineBreakdown.map((b, i) => (
                  <div key={i} title={`${b.name}: ${b.count}`}
                    style={{ width: `${(b.count / totalCount) * 100}%`, backgroundColor: b.color }}
                    className="flex items-center justify-center text-xs text-white font-medium transition-all hover:opacity-80"
                  >
                    {b.count > 0 && (b.count / totalCount) > 0.08 ? b.count : ''}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-3 mt-3">
                {pipelineBreakdown.map((b, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: b.color }} />
                    <span className="text-xs text-gray-400">{b.name} ({b.count})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Grants Table */}
          {grants.length === 0 ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
              <p className="text-gray-400 mb-2">No grants tracked yet.</p>
              <p className="text-gray-500 text-sm">Start tracking grants from your project workspace.</p>
              <button onClick={() => navigate('/dashboard')}
                className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
                Go to Dashboard
              </button>
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-[#0d1117] border-b border-[#30363d]">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Project</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Funder / Grant</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Amount</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Deadline</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#30363d]">
                    {grants.map(g => {
                      const isOverdue = g.deadline && new Date(g.deadline) < new Date() && !['awarded', 'rejected'].includes(g.status_slug);
                      return (
                        <tr key={g.id} className="hover:bg-[#0d1117] transition-colors cursor-pointer" onClick={() => navigate(`/projects/${g.project_id}/tracker`)}>
                          <td className="px-4 py-3 text-gray-400 text-sm">{g.project_name}</td>
                          <td className="px-4 py-3">
                            <div className="text-white text-sm font-medium">{g.funder_name}</div>
                            {g.grant_title && <div className="text-xs text-gray-500">{g.grant_title}</div>}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-medium px-2 py-1 rounded-full" style={{ color: g.status_color, backgroundColor: `${g.status_color}20` }}>
                              {g.status_name}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-300 text-sm">{g.amount ? fmtCurrency(g.amount) : '-'}</td>
                          <td className="px-4 py-3">
                            {g.deadline ? (
                              <span className={`text-sm ${isOverdue ? 'text-red-400 font-medium' : 'text-gray-300'}`}>
                                {isOverdue && <AlertTriangle size={12} className="inline mr-1" />}
                                {new Date(g.deadline).toLocaleDateString()}
                              </span>
                            ) : <span className="text-gray-600 text-sm">-</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
