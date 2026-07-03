import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader, Download, TrendingUp, Clock, DollarSign, Target, Award, AlertTriangle, Filter, ArrowUpDown, X } from 'lucide-react';
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
  useEffect(() => {
    document.title = 'Portfolio | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'View all of your nonprofit’s active grant projects in one portfolio.';
  }, []);

  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null);
  const [pipelineBreakdown, setPipelineBreakdown] = useState<{ name: string; color: string; count: number }[]>([]);
  const [grants, setGrants] = useState<PortfolioGrant[]>([]);
  const [_total, setTotal] = useState(0);

  // FM-IC-DSC-006 + FM-IC-TRK-006 — cross-project filter + sort
  const [filterProject, setFilterProject] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterDeadlineFrom, setFilterDeadlineFrom] = useState<string>('');
  const [filterDeadlineTo, setFilterDeadlineTo] = useState<string>('');
  const [sortKey, setSortKey] = useState<'deadline' | 'amount' | 'updated' | 'project'>('deadline');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showFilters, setShowFilters] = useState(false);

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
    return (<><NavBar /><main id="main-content" className="min-h-screen bg-[#0d1117] pt-20 flex items-center justify-center"><Loader className="animate-spin text-gray-400" size={24} /></main></>);
  }

  const totalCount = pipelineBreakdown.reduce((s, b) => s + b.count, 0);

  // FM-IC-DSC-006 + FM-IC-TRK-006 — derived filter+sort list
  const projectOptions = Array.from(new Set(grants.map(g => g.project_name))).sort();
  const statusOptions = Array.from(new Set(grants.map(g => g.status_name))).sort();
  const filteredGrants = grants
    .filter(g => filterProject === 'all' || g.project_name === filterProject)
    .filter(g => filterStatus === 'all' || g.status_name === filterStatus)
    .filter(g => {
      if (!filterDeadlineFrom && !filterDeadlineTo) return true;
      if (!g.deadline) return false;
      const d = new Date(g.deadline).getTime();
      if (filterDeadlineFrom && d < new Date(filterDeadlineFrom).getTime()) return false;
      if (filterDeadlineTo && d > new Date(filterDeadlineTo).getTime() + 86400000) return false;
      return true;
    })
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      const nullsLast = (av: any, bv: any) => {
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return 0;
      };
      if (sortKey === 'deadline') {
        const nl = nullsLast(a.deadline, b.deadline); if (nl) return nl;
        return (new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime()) * dir;
      }
      if (sortKey === 'amount') {
        const nl = nullsLast(a.amount, b.amount); if (nl) return nl;
        return ((a.amount ?? 0) - (b.amount ?? 0)) * dir;
      }
      if (sortKey === 'updated') {
        return (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()) * dir;
      }
      // project
      return a.project_name.localeCompare(b.project_name) * dir;
    });
  const hasActiveFilter = filterProject !== 'all' || filterStatus !== 'all' || !!filterDeadlineFrom || !!filterDeadlineTo;
  const clearFilters = () => {
    setFilterProject('all'); setFilterStatus('all');
    setFilterDeadlineFrom(''); setFilterDeadlineTo('');
  };


  return (
    <>
      <NavBar />
      <main id="main-content" className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12">
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
                <p className={`text-2xl font-bold ${metrics.win_rate !== null ? (metrics.win_rate >= 50 ? 'text-green-400' : metrics.win_rate >= 25 ? 'text-yellow-400' : 'text-red-400') : 'text-gray-400'}`}>
                  {metrics.win_rate !== null ? `${metrics.win_rate}%` : '—'}
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
                <p className={`text-2xl font-bold ${metrics.upcoming_deadlines > 0 ? 'text-yellow-400' : 'text-gray-400'}`}>
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

          {/* FM-IC-DSC-006 + FM-IC-TRK-006 — Filter + sort toolbar */}
          {grants.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setShowFilters(v => !v)}
                className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm transition-colors ${
                  hasActiveFilter
                    ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                    : 'bg-[#161b22] border-[#30363d] text-gray-300 hover:border-[#484f58]'
                }`}
                aria-expanded={showFilters}
              >
                <Filter size={14} /> Filters{hasActiveFilter ? ` (${[filterProject !== 'all', filterStatus !== 'all', !!filterDeadlineFrom || !!filterDeadlineTo].filter(Boolean).length})` : ''}
              </button>
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <ArrowUpDown size={14} />
                <span>Sort:</span>
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as any)}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-gray-200"
                  aria-label="Sort grants by"
                >
                  <option value="deadline">Deadline</option>
                  <option value="amount">Amount</option>
                  <option value="updated">Last updated</option>
                  <option value="project">Project</option>
                </select>
                <button
                  onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-gray-300 hover:text-white"
                  aria-label={`Sort direction: ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                >
                  {sortDir === 'asc' ? 'Asc' : 'Desc'}
                </button>
              </div>
              <div className="text-xs text-gray-400 ml-auto">
                Showing {filteredGrants.length} of {grants.length}
              </div>
            </div>
          )}

          {showFilters && grants.length > 0 && (
            <div className="mb-4 bg-[#161b22] border border-[#30363d] rounded-lg p-4 grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label htmlFor="portfolio-filter-project" className="block text-xs font-medium text-gray-400 mb-1">Project</label>
                <select
                  id="portfolio-filter-project"
                  value={filterProject}
                  onChange={(e) => setFilterProject(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm text-gray-200"
                >
                  <option value="all">All projects</option>
                  {projectOptions.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="portfolio-filter-status" className="block text-xs font-medium text-gray-400 mb-1">Status</label>
                <select
                  id="portfolio-filter-status"
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm text-gray-200"
                >
                  <option value="all">All statuses</option>
                  {statusOptions.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="portfolio-filter-deadline-from" className="block text-xs font-medium text-gray-400 mb-1">Deadline from</label>
                <input
                  id="portfolio-filter-deadline-from"
                  type="date"
                  value={filterDeadlineFrom}
                  onChange={(e) => setFilterDeadlineFrom(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm text-gray-200"
                />
              </div>
              <div>
                <label htmlFor="portfolio-filter-deadline-to" className="block text-xs font-medium text-gray-400 mb-1">Deadline to</label>
                <input
                  id="portfolio-filter-deadline-to"
                  type="date"
                  value={filterDeadlineTo}
                  onChange={(e) => setFilterDeadlineTo(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm text-gray-200"
                />
              </div>
              {hasActiveFilter && (
                <div className="md:col-span-4">
                  <button
                    onClick={clearFilters}
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    <X size={12} /> Clear all filters
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Grants Table */}
          {filteredGrants.length === 0 && grants.length > 0 ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
              <p className="text-gray-400 mb-2">No grants match your filters.</p>
              <button onClick={clearFilters} className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">Clear filters</button>
            </div>
          ) : grants.length === 0 ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
              <p className="text-gray-400 mb-2">No grants tracked yet.</p>
              <p className="text-gray-400 text-sm">Start tracking grants from your project workspace.</p>
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
                    {filteredGrants.map(g => {
                      const isOverdue = g.deadline && new Date(g.deadline) < new Date() && !['awarded', 'rejected'].includes(g.status_slug);
                      return (
                        <tr key={g.id} className="hover:bg-[#21262d] transition-colors cursor-pointer" onClick={() => navigate(`/projects/${g.project_id}/tracker`)}>
                          <td className="px-4 py-3 text-gray-400 text-sm">{g.project_name}</td>
                          <td className="px-4 py-3">
                            <div className="text-white text-sm font-medium">{g.funder_name}</div>
                            {g.grant_title && <div className="text-xs text-gray-400">{g.grant_title}</div>}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-medium px-2 py-1 rounded-full" style={{ color: g.status_color, backgroundColor: `${g.status_color}20` }}>
                              {g.status_name}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-300 text-sm">{g.amount ? fmtCurrency(g.amount) : '—'}</td>
                          <td className="px-4 py-3">
                            {g.deadline ? (
                              <span className={`text-sm ${isOverdue ? 'text-red-400 font-medium' : 'text-gray-300'}`}>
                                {isOverdue && <AlertTriangle size={12} className="inline mr-1" />}
                                {new Date(g.deadline).toLocaleDateString()}
                              </span>
                            ) : <span className="text-gray-600 text-sm">—</span>}
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
