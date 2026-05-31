import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';
import { Download, Filter, TrendingUp, DollarSign, Target, Award, Clock, BarChart3, PieChart, Plus, Check, AlertTriangle, Trash2, X } from 'lucide-react';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const REPORTS_URL = `${SUPABASE_URL}/functions/v1/reports-portfolio`;
const GENERATE_URL = `${SUPABASE_URL}/functions/v1/generate-report`;
const COMPLIANCE_URL = `${SUPABASE_URL}/functions/v1/compliance`;

interface KPIs {
  total_grants: number;
  proposals_submitted: number;
  win_rate: number;
  total_awarded: number;
  pending_ask: number;
  avg_grant_size: number;
}

interface PipelineItem { name: string; color: string; count: number; amount: number; }
interface ProjectItem { name: string; count: number; awarded: number; pending: number; }
interface TimelineItem { quarter: string; submitted: number; awarded: number; }
interface ComplianceSummary { total: number; compliant: number; upcoming: number; overdue: number; }
interface ComplianceRequirement {
  id: string;
  user_id: string;
  grant_id: string | null;
  project_id: string | null;
  requirement_text: string;
  category: string | null;
  due_date: string | null;
  status: 'pending' | 'in_progress' | 'submitted' | 'approved' | string;
  priority: string | null;
  notes: string | null;
  completed_at: string | null;
  is_overdue?: boolean;
}
interface FunderTypeItem { type: string; count: number; amount: number; }

export default function ReportsPage() {
  useEffect(() => {
    document.title = 'Reports | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Reporting tools for grant cycles, pipeline status, and outcomes.';
  }, []);

  const { user, loading } = useAuth();
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [pipeline, setPipeline] = useState<PipelineItem[]>([]);
  const [byProject, setByProject] = useState<ProjectItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [compliance, setCompliance] = useState<ComplianceSummary | null>(null);
  // FM-IC-RPT-002: full requirements workflow
  const [requirements, setRequirements] = useState<ComplianceRequirement[]>([]);
  const [reqLoading, setReqLoading] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);
  const [showAddReq, setShowAddReq] = useState(false);
  const [newReqText, setNewReqText] = useState('');
  const [newReqCategory, setNewReqCategory] = useState<string>('report');
  const [newReqDueDate, setNewReqDueDate] = useState('');
  const [newReqPriority, setNewReqPriority] = useState<string>('medium');
  const [byFunderType, setByFunderType] = useState<FunderTypeItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterPeriod, setFilterPeriod] = useState('all');
  const [filterProject, setFilterProject] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  useEffect(() => {
    if (!loading && user) { loadReport(); loadRequirements(); }
  }, [user, loading]);

  const loadReport = async () => {
    try {
      setIsLoading(true);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(REPORTS_URL, { headers });
      if (res.ok) {
        const data = await res.json();
        setKpis(data.kpis);
        setPipeline(data.pipeline || []);
        setByProject(data.byProject || []);
        setTimeline(data.timeline || []);
        setCompliance(data.compliance);
        setByFunderType(data.byFunderType || []);
      }
    } catch (err) {
      console.error('Error loading report:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportCSV = async () => {
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ format: 'csv' }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fundermatch-report-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
      }
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  const handleExportPDF = () => {
    window.print();
  };

  const fmt = (n: number) => n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `$${(n / 1000).toFixed(0)}K` : `$${n.toLocaleString()}`;
  const maxPipelineCount = Math.max(...pipeline.map(p => p.count), 1);
  const maxProjectAmt = Math.max(...byProject.map(p => p.awarded + p.pending), 1);

  if (loading) return null;


  // ── FM-IC-RPT-002: Compliance requirements CRUD ─────────────────────
  const loadRequirements = async () => {
    try {
      setReqLoading(true);
      setReqError(null);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(COMPLIANCE_URL, { headers });
      if (res.ok) {
        const data = await res.json();
        setRequirements(Array.isArray(data) ? data : []);
      } else {
        setReqError('Failed to load requirements');
      }
    } catch (err) {
      console.error(err);
      setReqError('Failed to load requirements');
    } finally {
      setReqLoading(false);
    }
  };

  const addRequirement = async () => {
    if (!newReqText.trim()) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(COMPLIANCE_URL, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirement_text: newReqText.trim(),
          category: newReqCategory,
          due_date: newReqDueDate || null,
          priority: newReqPriority,
          status: 'pending',
        }),
      });
      if (res.ok) {
        setNewReqText(''); setNewReqDueDate(''); setShowAddReq(false);
        await loadRequirements();
      } else {
        setReqError('Could not add requirement');
      }
    } catch (err) { console.error(err); setReqError('Could not add requirement'); }
  };

  const updateRequirementStatus = async (id: string, status: string) => {
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(COMPLIANCE_URL, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      if (res.ok) {
        // optimistic local update
        setRequirements(rs => rs.map(r => r.id === id ? { ...r, status } : r));
      }
    } catch (err) { console.error(err); }
  };

  const deleteRequirement = async (id: string) => {
    if (!confirm('Delete this requirement?')) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(`${COMPLIANCE_URL}?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', headers,
      });
      if (res.ok) setRequirements(rs => rs.filter(r => r.id !== id));
    } catch (err) { console.error(err); }
  };


  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <main id="main-content" className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold">Reports</h1>
            <p className="text-gray-400 text-sm mt-1">Portfolio performance and analytics</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)}
              className="bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-white">
              <option value="all">All Time</option>
              <option value="year">This Year</option>
              <option value="quarter">This Quarter</option>
              <option value="month">This Month</option>
            </select>
            <select value={filterProject} onChange={e => setFilterProject(e.target.value)}
              className="bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-white">
              <option value="all">All Projects</option>
              {byProject.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-white">
              <option value="all">All Statuses</option>
              {pipeline.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <button onClick={handleExportCSV}
              className="flex items-center gap-2 px-4 py-2 bg-[#161b22] border border-[#30363d] hover:border-blue-500 rounded-lg text-sm transition-colors">
              <Download size={16} /> Export CSV
            </button>
            <button onClick={handleExportPDF}
              className="flex items-center gap-2 px-4 py-2 bg-[#161b22] border border-[#30363d] hover:border-blue-500 rounded-lg text-sm transition-colors">
              <Filter size={16} /> Export PDF
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-gray-500">Loading report data...</div>
        ) : (
          <>
            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
              {[
                { label: 'Total Grants', value: kpis?.total_grants || 0, icon: <BarChart3 size={18} />, color: 'text-blue-400' },
                { label: 'Submitted', value: kpis?.proposals_submitted || 0, icon: <Target size={18} />, color: 'text-purple-400' },
                { label: 'Win Rate', value: `${kpis?.win_rate || 0}%`, icon: <TrendingUp size={18} />, color: 'text-green-400' },
                { label: 'Total Awarded', value: fmt(kpis?.total_awarded || 0), icon: <Award size={18} />, color: 'text-yellow-400' },
                { label: 'Pending Ask', value: fmt(kpis?.pending_ask || 0), icon: <Clock size={18} />, color: 'text-orange-400' },
                { label: 'Avg Grant Size', value: fmt(kpis?.avg_grant_size || 0), icon: <DollarSign size={18} />, color: 'text-emerald-400' },
              ].map(kpi => (
                <div key={kpi.label} className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                  <div className={`mb-2 ${kpi.color}`}>{kpi.icon}</div>
                  <p className="text-xl font-bold text-white">{kpi.value}</p>
                  <p className="text-xs text-gray-400">{kpi.label}</p>
                </div>
              ))}
            </div>

            <div className="grid md:grid-cols-2 gap-6 mb-8">
              {/* Pipeline Breakdown */}
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><PieChart size={16} /> Pipeline Breakdown</h3>
                <div className="space-y-3">
                  {pipeline.map(item => (
                    <div key={item.name}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-300">{item.name}</span>
                        <span className="text-gray-400">{item.count} grant{item.count !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="h-2 bg-[#0d1117] rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{
                          width: `${(item.count / maxPipelineCount) * 100}%`,
                          backgroundColor: item.color,
                        }} />
                      </div>
                    </div>
                  ))}
                  {pipeline.length === 0 && <p className="text-gray-500 text-sm">No data yet</p>}
                </div>
              </div>

              {/* Funding by Project */}
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><BarChart3 size={16} /> Funding by Project</h3>
                <div className="space-y-3">
                  {byProject.map(proj => (
                    <div key={proj.name}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-300">{proj.name}</span>
                        <span className="text-gray-400">{fmt(proj.awarded)} awarded</span>
                      </div>
                      <div className="h-2 bg-[#0d1117] rounded-full overflow-hidden flex">
                        <div className="h-full bg-green-500 transition-all" style={{ width: `${(proj.awarded / maxProjectAmt) * 100}%` }} />
                        <div className="h-full bg-yellow-500/50 transition-all" style={{ width: `${(proj.pending / maxProjectAmt) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                  {byProject.length === 0 && <p className="text-gray-500 text-sm">No data yet</p>}
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-8">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><TrendingUp size={16} /> Quarterly Timeline</h3>
              {timeline.length > 0 ? (
                <div className="flex items-end gap-2 h-32">
                  {timeline.map(q => {
                    const max = Math.max(...timeline.map(t => Math.max(t.submitted, t.awarded)), 1);
                    return (
                      <div key={q.quarter} className="flex-1 flex flex-col items-center gap-1">
                        <div className="flex gap-0.5 items-end w-full justify-center" style={{ height: '80px' }}>
                          <div className="w-3 bg-blue-500 rounded-t" style={{ height: `${(q.submitted / max) * 80}px` }} />
                          <div className="w-3 bg-green-500 rounded-t" style={{ height: `${(q.awarded / max) * 80}px` }} />
                        </div>
                        <p className="text-[10px] text-gray-400">{q.quarter}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No timeline data yet</p>
              )}
              <div className="flex gap-4 mt-3 text-xs text-gray-400">
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-500 rounded" /> Submitted</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded" /> Awarded</span>
              </div>
            </div>

            {/* Funding by Funder Type */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-8">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><PieChart size={16} /> Funding by Funder Type</h3>
              <div className="space-y-3">
                {byFunderType.length > 0 ? byFunderType.map(item => (
                  <div key={item.type}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-300">{item.type}</span>
                      <span className="text-gray-400">{item.count} grant{item.count !== 1 ? 's' : ''} · {fmt(item.amount)}</span>
                    </div>
                    <div className="h-2 bg-[#0d1117] rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-indigo-500 transition-all" style={{
                        width: `${(item.count / Math.max(...byFunderType.map(b => b.count), 1)) * 100}%`,
                      }} />
                    </div>
                  </div>
                )) : <p className="text-gray-500 text-sm">No funder type data available</p>}
              </div>
            </div>

            {/* Compliance Summary */}
            {compliance && (
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5">
                <h3 className="text-sm font-semibold mb-4">Compliance Summary</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center"><p className="text-lg font-bold">{compliance.total}</p><p className="text-xs text-gray-400">Total</p></div>
                  <div className="text-center"><p className="text-lg font-bold text-green-400">{compliance.compliant}</p><p className="text-xs text-gray-400">Compliant</p></div>
                  <div className="text-center"><p className="text-lg font-bold text-yellow-400">{compliance.upcoming}</p><p className="text-xs text-gray-400">Upcoming</p></div>
                  <div className="text-center"><p className="text-lg font-bold text-red-400">{compliance.overdue}</p><p className="text-xs text-gray-400">Overdue</p></div>
                </div>
              </div>
            )}

            {/* FM-IC-RPT-002: Post-award reporting requirements workflow */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold">Reporting requirements</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Track post-award reports, financial filings, and grantee deliverables.</p>
                </div>
                <button
                  onClick={() => setShowAddReq(v => !v)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium"
                >
                  {showAddReq ? <><X size={12} /> Cancel</> : <><Plus size={12} /> Add requirement</>}
                </button>
              </div>

              {showAddReq && (
                <div className="mb-4 p-3 bg-[#0d1117] border border-[#30363d] rounded-lg space-y-2">
                  <input
                    type="text"
                    value={newReqText}
                    onChange={(e) => setNewReqText(e.target.value)}
                    placeholder="e.g. Submit Q1 financial report to funder"
                    className="w-full bg-[#161b22] border border-[#30363d] rounded px-3 py-2 text-sm text-white placeholder-gray-500"
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <select value={newReqCategory} onChange={(e) => setNewReqCategory(e.target.value)}
                      className="bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-200">
                      <option value="report">Report</option>
                      <option value="financial">Financial</option>
                      <option value="narrative">Narrative</option>
                      <option value="evaluation">Evaluation</option>
                      <option value="other">Other</option>
                    </select>
                    <input type="date" value={newReqDueDate} onChange={(e) => setNewReqDueDate(e.target.value)}
                      className="bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-200" />
                    <select value={newReqPriority} onChange={(e) => setNewReqPriority(e.target.value)}
                      className="bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-200">
                      <option value="low">Low priority</option>
                      <option value="medium">Medium priority</option>
                      <option value="high">High priority</option>
                    </select>
                  </div>
                  <button onClick={addRequirement} disabled={!newReqText.trim()}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-green-600/40 text-white rounded text-xs font-medium">
                    Save
                  </button>
                </div>
              )}

              {reqError && <p className="text-xs text-red-400 mb-2">{reqError}</p>}

              {reqLoading ? (
                <p className="text-xs text-gray-500">Loading requirements…</p>
              ) : requirements.length === 0 ? (
                <p className="text-xs text-gray-500">No reporting requirements tracked yet. Add one above.</p>
              ) : (
                <div className="space-y-2">
                  {requirements.map(r => {
                    const overdue = r.is_overdue;
                    const done = ['submitted', 'approved'].includes(r.status);
                    return (
                      <div key={r.id} className={`flex items-center gap-3 p-3 rounded-lg border ${
                        done ? 'bg-green-600/5 border-green-700/40'
                        : overdue ? 'bg-red-600/5 border-red-700/40'
                        : 'bg-[#0d1117] border-[#30363d]'}`}>
                        <button
                          onClick={() => updateRequirementStatus(r.id, done ? 'pending' : 'submitted')}
                          aria-label={done ? 'Mark pending' : 'Mark submitted'}
                          className={`w-5 h-5 rounded flex items-center justify-center border ${
                            done ? 'bg-green-600 border-green-600 text-white' : 'border-[#484f58]'
                          }`}
                        >
                          {done && <Check size={12} />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm ${done ? 'line-through text-gray-500' : 'text-white'}`}>
                            {r.requirement_text}
                          </p>
                          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                            {r.category && <span className="capitalize">{r.category}</span>}
                            {r.due_date && (
                              <span className={overdue && !done ? 'text-red-400 font-medium' : ''}>
                                {overdue && !done && <AlertTriangle size={10} className="inline mr-0.5" />}
                                Due {new Date(r.due_date).toLocaleDateString()}
                              </span>
                            )}
                            {r.priority && (
                              <span className={
                                r.priority === 'high' ? 'text-orange-400'
                                : r.priority === 'low' ? 'text-gray-500'
                                : 'text-yellow-400'
                              }>{r.priority} priority</span>
                            )}
                          </div>
                        </div>
                        <select
                          value={r.status}
                          onChange={(e) => updateRequirementStatus(r.id, e.target.value)}
                          className="bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200"
                          aria-label="Requirement status"
                        >
                          <option value="pending">Pending</option>
                          <option value="in_progress">In progress</option>
                          <option value="submitted">Submitted</option>
                          <option value="approved">Approved</option>
                        </select>
                        <button onClick={() => deleteRequirement(r.id)}
                          aria-label="Delete requirement"
                          className="text-gray-500 hover:text-red-400">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
