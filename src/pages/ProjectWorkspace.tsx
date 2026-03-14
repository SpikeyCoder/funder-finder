import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Save, Loader } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import NavBar from '../components/NavBar';

interface Project {
  id: string;
  name: string;
  description?: string | null;
  location_scope?: { state: string; county?: string }[] | null;
  fields_of_work?: string[] | null;
  funding_types?: string[] | null;
  keywords?: string[] | null;
  budget_min?: number | null;
  budget_max?: number | null;
  is_default?: boolean;
  created_at: string;
  updated_at: string;
  user_id: string;
}

interface ProjectMatch {
  id: string;
  funder_ein: string;
  match_score: number;
  match_reasons?: any;
  gives_to_peers: boolean;
  computed_at: string;
}

interface SavedFunder {
  id: string;
  funder_ein: string;
  funder_name: string;
  status: 'researching' | 'applied' | 'awarded' | 'passed';
  notes?: string | null;
  source?: string | null;
  added_at: string;
}

const NTEE_CATEGORIES = [
  { code: 'A', label: 'Arts, Culture & Humanities' },
  { code: 'B', label: 'Education' },
  { code: 'C', label: 'Environment' },
  { code: 'D', label: 'Animal Related' },
  { code: 'E', label: 'Health' },
  { code: 'F', label: 'Mental Health / Crisis Intervention' },
  { code: 'G', label: 'Disease, Disorders, Medical' },
  { code: 'H', label: 'Medical Research' },
  { code: 'I', label: 'Crime & Legal' },
  { code: 'J', label: 'Employment' },
  { code: 'K', label: 'Food, Agriculture & Nutrition' },
  { code: 'L', label: 'Housing & Shelter' },
  { code: 'M', label: 'Public Safety' },
  { code: 'N', label: 'Recreation & Sports' },
  { code: 'O', label: 'Youth Development' },
  { code: 'P', label: 'Human Services' },
  { code: 'Q', label: 'International' },
  { code: 'R', label: 'Civil Rights' },
  { code: 'S', label: 'Community Improvement' },
  { code: 'T', label: 'Philanthropy & Grantmaking' },
  { code: 'U', label: 'Science & Technology' },
  { code: 'V', label: 'Social Science' },
  { code: 'W', label: 'Public Policy' },
  { code: 'X', label: 'Religion' },
  { code: 'Y', label: 'Mutual Benefit' },
  { code: 'Z', label: 'Unknown' },
];

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

const FUNDING_TYPES = [
  { value: 'general_operating', label: 'General Operating Support' },
  { value: 'project_program', label: 'Project/Program Support' },
  { value: 'capital', label: 'Capital Support' },
  { value: 'capacity_building', label: 'Capacity Building' },
];

type TabType = 'matches' | 'tracker' | 'peers' | 'settings';

export default function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [matches, setMatches] = useState<ProjectMatch[]>([]);
  const [savedFunders, setSavedFunders] = useState<SavedFunder[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable fields for settings tab
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editStates, setEditStates] = useState<string[]>([]);
  const [editNtee, setEditNtee] = useState<string[]>([]);
  const [editFundingTypes, setEditFundingTypes] = useState<string[]>([]);
  const [editBudgetMin, setEditBudgetMin] = useState<string>('');
  const [editBudgetMax, setEditBudgetMax] = useState<string>('');

  const activeTab = useMemo<TabType>(() => {
    const path = location.pathname;
    if (path.includes('/tracker')) return 'tracker';
    if (path.includes('/peers')) return 'peers';
    if (path.includes('/settings')) return 'settings';
    return 'matches';
  }, [location.pathname]);

  const handleTabChange = (tab: TabType) => {
    navigate(tab === 'matches' ? `/projects/${id}` : `/projects/${id}/${tab}`);
  };

  useEffect(() => {
    if (!loading && user && id) loadProjectData();
  }, [id, user, loading]);

  const populateEditFields = (p: Project) => {
    setEditName(p.name);
    setEditDesc(p.description || '');
    setEditStates(p.location_scope?.map(l => l.state) || []);
    setEditNtee(p.fields_of_work || []);
    setEditFundingTypes(p.funding_types || []);
    setEditBudgetMin(p.budget_min ? String(p.budget_min) : '');
    setEditBudgetMax(p.budget_max ? String(p.budget_max) : '');
  };

  const loadProjectData = async () => {
    try {
      setProjectLoading(true);
      setError(null);

      const { data: projectData, error: projectError } = await supabase
        .from('projects').select('*').eq('id', id).single();

      if (projectError) throw projectError;
      if (!projectData) { navigate('/dashboard'); return; }

      setProject(projectData);
      populateEditFields(projectData);

      setMatchesLoading(true);
      const { data: matchesData } = await supabase
        .from('project_matches').select('*').eq('project_id', id).order('match_score', { ascending: false });
      setMatches(matchesData || []);

      const { data: savedData } = await supabase
        .from('project_saved_funders').select('*').eq('project_id', id).order('added_at', { ascending: false });
      setSavedFunders(savedData || []);

      setMatchesLoading(false);
    } catch (err) {
      console.error('Error loading project:', err);
      setError('Failed to load project data.');
    } finally {
      setProjectLoading(false);
      setMatchesLoading(false);
    }
  };

  const handleSaveProject = async () => {
    if (!editName.trim()) { setError('Project name is required'); return; }
    try {
      setSaving(true);
      setError(null);
      const locationScope = editStates.length > 0 ? editStates.map(s => ({ state: s })) : null;
      const { error: updateError } = await supabase
        .from('projects')
        .update({
          name: editName.trim(),
          description: editDesc.trim() || null,
          location_scope: locationScope,
          fields_of_work: editNtee.length > 0 ? editNtee : null,
          funding_types: editFundingTypes.length > 0 ? editFundingTypes : null,
          budget_min: editBudgetMin ? parseInt(editBudgetMin) : null,
          budget_max: editBudgetMax ? parseInt(editBudgetMax) : null,
        })
        .eq('id', id);
      if (updateError) throw updateError;
      await loadProjectData();
    } catch (err) {
      console.error('Error saving project:', err);
      setError('Failed to save project.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveFunder = async (funderEin: string, funderName: string) => {
    if (savedFunders.some(sf => sf.funder_ein === funderEin)) return;
    try {
      const { error } = await supabase.from('project_saved_funders').insert({
        project_id: id,
        funder_ein: funderEin,
        funder_name: funderName,
        status: 'researching',
        source: 'ai_match',
      });
      if (error) throw error;
      await loadProjectData();
    } catch (err) {
      console.error('Error saving funder:', err);
    }
  };

  const handleUpdateSavedFunder = async (sfId: string, updates: { status?: string; notes?: string }) => {
    try {
      const { error } = await supabase.from('project_saved_funders').update(updates).eq('id', sfId);
      if (error) throw error;
      setSavedFunders(prev => prev.map(sf => sf.id === sfId ? { ...sf, ...updates } as SavedFunder : sf));
    } catch (err) {
      console.error('Error updating funder:', err);
    }
  };


  if (loading || projectLoading) {
    return (<><NavBar /><main className="min-h-screen bg-[#0d1117] pt-20 flex items-center justify-center"><Loader className="animate-spin text-gray-400" size={24} /></main></>);
  }
  if (!project) {
    return (<><NavBar /><main className="min-h-screen bg-[#0d1117] pt-20 px-4 flex items-center justify-center"><div className="text-gray-400">Project not found</div></main></>);
  }

  return (
    <>
      <NavBar />
      <main className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="flex items-start gap-4 mb-8">
            <button onClick={() => navigate('/dashboard')} className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-[#161b22] transition-colors text-gray-400 hover:text-white">
              <ArrowLeft size={20} />
            </button>
            <div className="flex-1">
              <h1 className="text-3xl font-bold text-white">{project.name}</h1>
              {project.description && <p className="text-gray-400 mt-2">{project.description}</p>}
            </div>
          </div>

          {error && <div className="mb-6 p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200">{error}</div>}

          {/* Tabs */}
          <div className="mb-8 overflow-x-auto">
            <div className="flex gap-2 border-b border-[#30363d] pb-4 min-w-max sm:min-w-0">
              {(['matches', 'tracker', 'peers', 'settings'] as TabType[]).map(tab => (
                <button key={tab} onClick={() => handleTabChange(tab)}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors whitespace-nowrap capitalize ${activeTab === tab ? 'bg-blue-600/20 text-blue-400 border border-blue-500' : 'text-gray-400 hover:text-white'}`}>
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {/* MATCHES TAB */}
          {activeTab === 'matches' && (
            <div>
              {matchesLoading ? (
                <div className="flex items-center justify-center py-12"><Loader className="animate-spin text-gray-400" size={24} /></div>
              ) : matches.length === 0 ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <p className="text-gray-400 mb-2">No matches computed yet.</p>
                  <p className="text-gray-500 text-sm">Match computation runs when you create or update project criteria.</p>
                </div>
              ) : (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-[#0d1117] border-b border-[#30363d]">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Funder</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Match</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Peers</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-400 uppercase">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#30363d]">
                        {matches.map(m => (
                          <tr key={m.id} className="hover:bg-[#0d1117] transition-colors cursor-pointer" onClick={() => navigate(`/funder/${m.funder_ein}`)}>
                            <td className="px-6 py-4 text-white">{m.funder_ein}</td>
                            <td className="px-6 py-4">
                              <span className={`text-xs font-medium px-2 py-1 rounded-full ${Number(m.match_score) >= 70 ? 'bg-green-900/30 text-green-400' : Number(m.match_score) >= 40 ? 'bg-yellow-900/30 text-yellow-400' : 'bg-gray-800 text-gray-400'}`}>
                                {Math.round(Number(m.match_score))}%
                              </span>
                            </td>
                            <td className="px-6 py-4 text-gray-400">{m.gives_to_peers ? 'Yes' : '—'}</td>
                            <td className="px-6 py-4 text-right">
                              <button onClick={(e) => { e.stopPropagation(); handleSaveFunder(m.funder_ein, m.funder_ein); }}
                                disabled={savedFunders.some(sf => sf.funder_ein === m.funder_ein)}
                                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-sm font-medium transition-colors">
                                {savedFunders.some(sf => sf.funder_ein === m.funder_ein) ? 'Saved' : 'Save'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TRACKER TAB */}
          {activeTab === 'tracker' && (
            <div>
              {savedFunders.length === 0 ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <p className="text-gray-400">No saved funders yet. Save funders from the Matches tab or Browse page.</p>
                </div>
              ) : (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-[#0d1117] border-b border-[#30363d]">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Funder</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Notes</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Source</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Added</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#30363d]">
                        {savedFunders.map(sf => (
                          <tr key={sf.id} className="hover:bg-[#0d1117]">
                            <td className="px-6 py-4">
                              <button onClick={() => navigate(`/funder/${sf.funder_ein}`)} className="text-blue-400 hover:text-blue-300 text-sm font-medium">
                                {sf.funder_name}
                              </button>
                            </td>
                            <td className="px-6 py-3">
                              <select value={sf.status} onChange={(e) => handleUpdateSavedFunder(sf.id, { status: e.target.value })}
                                className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-white text-sm">
                                <option value="researching">Researching</option>
                                <option value="applied">Applied</option>
                                <option value="awarded">Awarded</option>
                                <option value="passed">Passed</option>
                              </select>
                            </td>
                            <td className="px-6 py-3">
                              <input type="text" value={sf.notes || ''} placeholder="Add notes..."
                                onChange={(e) => handleUpdateSavedFunder(sf.id, { notes: e.target.value })}
                                className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-white text-sm w-full" />
                            </td>
                            <td className="px-6 py-3 text-gray-500 text-sm">{sf.source || '—'}</td>
                            <td className="px-6 py-3 text-gray-500 text-sm">{new Date(sf.added_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PEERS TAB */}
          {activeTab === 'peers' && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
              <p className="text-gray-400">Peer organizations based on your project's NTEE codes and geography will appear here.</p>
              <p className="text-gray-500 text-sm mt-2">This feature uses the Phase 1 peer matching engine scoped to your project criteria.</p>
            </div>
          )}

          {/* SETTINGS TAB */}
          {activeTab === 'settings' && (
            <div className="max-w-3xl space-y-6">
              {/* Basics */}
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                <h2 className="text-lg font-semibold text-white mb-4">Basic Information</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Project Name</label>
                    <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                      className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Description</label>
                    <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={3}
                      className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500" />
                  </div>
                </div>
              </div>

              {/* Location */}
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                <h2 className="text-lg font-semibold text-white mb-4">Location</h2>
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                  {STATES.map(st => (
                    <label key={st} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={editStates.includes(st)}
                        onChange={e => setEditStates(prev => e.target.checked ? [...prev, st] : prev.filter(s => s !== st))}
                        className="rounded border-[#30363d] bg-[#0d1117] text-blue-600" />
                      <span className="text-sm text-gray-400">{st}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Fields of Work */}
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                <h2 className="text-lg font-semibold text-white mb-4">Fields of Work</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {NTEE_CATEGORIES.map(c => (
                    <label key={c.code} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={editNtee.includes(c.code)}
                        onChange={e => setEditNtee(prev => e.target.checked ? [...prev, c.code] : prev.filter(x => x !== c.code))}
                        className="rounded border-[#30363d] bg-[#0d1117] text-blue-600" />
                      <span className="text-sm text-gray-400">{c.code} - {c.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Funding Types */}
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                <h2 className="text-lg font-semibold text-white mb-4">Funding Types</h2>
                <div className="space-y-2">
                  {FUNDING_TYPES.map(ft => (
                    <label key={ft.value} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={editFundingTypes.includes(ft.value)}
                        onChange={e => setEditFundingTypes(prev => e.target.checked ? [...prev, ft.value] : prev.filter(x => x !== ft.value))}
                        className="rounded border-[#30363d] bg-[#0d1117] text-blue-600" />
                      <span className="text-sm text-gray-400">{ft.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Grant Size Range */}
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                <h2 className="text-lg font-semibold text-white mb-4">Grant Size Range</h2>
                <div className="flex gap-4 items-center">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">Minimum</label>
                    <input type="number" value={editBudgetMin} onChange={e => setEditBudgetMin(e.target.value)} placeholder="e.g. 10000"
                      className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                  <span className="text-gray-500 pt-4">to</span>
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">Maximum</label>
                    <input type="number" value={editBudgetMax} onChange={e => setEditBudgetMax(e.target.value)} placeholder="e.g. 500000"
                      className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                </div>
              </div>

              {/* Save Button */}
              <button onClick={handleSaveProject} disabled={saving}
                className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
                <Save size={18} />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}
        </div>
      </main>
    </>
  );
