import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Save, Loader, Users, RefreshCw, Plus, Download, Upload, X, CheckCircle, Clock, AlertTriangle, ExternalLink, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';
import type { PipelineStatus, TrackedGrant, GrantTask } from '../types';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const MATCH_FUNDERS_URL = `${SUPABASE_URL}/functions/v1/match-funders`;
const SUGGEST_PEERS_URL = `${SUPABASE_URL}/functions/v1/suggest-peers`;
const TRACKED_GRANTS_URL = `${SUPABASE_URL}/functions/v1/tracked-grants`;
const PIPELINE_STATUSES_URL = `${SUPABASE_URL}/functions/v1/pipeline-statuses`;
const GRANT_TASKS_URL = `${SUPABASE_URL}/functions/v1/grant-tasks`;

interface PeerOrg {
  name: string;
  ein?: string;
  state?: string;
  ntee_code?: string;
  total_revenue?: number | null;
  shared_funders?: number;
}

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
  funder_name?: string;
  match_score: number;
  match_reasons?: any;
  gives_to_peers: boolean;
  computed_at: string;
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

// Format currency amounts
function fmtCurrency(amount: number | null | undefined): string {
  if (!amount) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export default function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [matches, setMatches] = useState<ProjectMatch[]>([]);
  const [trackedGrants, setTrackedGrants] = useState<TrackedGrant[]>([]);
  const [pipelineStatuses, setPipelineStatuses] = useState<PipelineStatus[]>([]);
  const [peers, setPeers] = useState<PeerOrg[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [projectLoading, setProjectLoading] = useState(true);
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [trackerLoading, setTrackerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [computing, setComputing] = useState(false);

  // Grant detail drawer
  const [selectedGrant, setSelectedGrant] = useState<TrackedGrant | null>(null);
  const [grantTasks, setGrantTasks] = useState<GrantTask[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // External grant modal
  const [addGrantOpen, setAddGrantOpen] = useState(false);
  const [newGrant, setNewGrant] = useState({ funder_name: '', grant_title: '', amount: '', deadline: '', grant_url: '', notes: '', status_slug: 'researching' });

  // CSV import modal
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [csvMapping, setCsvMapping] = useState<Record<string, string>>({});
  const [csvStep, setCsvStep] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Task creation
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDueDate, setNewTaskDueDate] = useState('');

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
      setMatchesLoading(false);

      // Load tracked grants and pipeline statuses
      loadTrackerData();

      // Load peer organizations
      loadPeers(projectData);
    } catch (err) {
      console.error('Error loading project:', err);
      setError('Failed to load project data.');
    } finally {
      setProjectLoading(false);
      setMatchesLoading(false);
    }
  };

  const loadTrackerData = useCallback(async () => {
    setTrackerLoading(true);
    try {
      const headers = await getEdgeFunctionHeaders();

      // Load pipeline statuses
      const statusRes = await fetch(PIPELINE_STATUSES_URL, { headers });
      if (statusRes.ok) {
        const statuses = await statusRes.json();
        setPipelineStatuses(statuses);
      }

      // Load tracked grants for this project
      const grantsRes = await fetch(`${TRACKED_GRANTS_URL}?project_id=${id}`, { headers });
      if (grantsRes.ok) {
        const data = await grantsRes.json();
        setTrackedGrants(data.grants || []);
      }
    } catch (err) {
      console.error('Error loading tracker:', err);
    } finally {
      setTrackerLoading(false);
    }
  }, [id]);

  const loadPeers = async (proj: Project) => {
    setPeersLoading(true);
    try {
      const mission = proj.description || proj.name;
      const states = proj.location_scope?.map(l => l.state) || [];
      const locationServed = states.length > 0 ? states.join(', ') : undefined;
      let budgetBand: string = 'prefer_not_to_say';
      if (proj.budget_min || proj.budget_max) {
        const amt = proj.budget_max || proj.budget_min || 0;
        if (amt <= 50000) budgetBand = 'under_50k';
        else if (amt <= 250000) budgetBand = '50k_250k';
        else if (amt <= 1000000) budgetBand = '250k_1m';
        else if (amt <= 5000000) budgetBand = '1m_5m';
        else budgetBand = 'over_5m';
      }

      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(SUGGEST_PEERS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ mission, locationServed, budgetBand }),
      });

      if (!res.ok) { setPeers([]); return; }

      const data = await res.json();
      const peerDetails: Array<{ name: string; state: string; city: string }> = data.peerDetails || [];
      const peerNames: string[] = Array.isArray(data.peers) ? data.peers : [];

      if (peerNames.length === 0) { setPeers([]); return; }

      const enriched: PeerOrg[] = [];
      for (let i = 0; i < peerNames.length; i++) {
        const peerName = peerNames[i];
        const detail = peerDetails[i];
        const safeName = peerName.replace(/'/g, "''");
        let matched: any = null;
        const peerState = detail?.state || '';

        if (peerState) {
          const { data: stateMatches } = await supabase
            .from('recipient_organizations')
            .select('ein, name, primary_state, ntee_code, total_funding, funder_count')
            .ilike('name', `%${safeName}%`).eq('primary_state', peerState)
            .order('funder_count', { ascending: false }).limit(1);
          if (stateMatches?.length) matched = stateMatches[0];
        }
        if (!matched && states.length > 0) {
          const { data: stateMatches } = await supabase
            .from('recipient_organizations')
            .select('ein, name, primary_state, ntee_code, total_funding, funder_count')
            .ilike('name', `%${safeName}%`).in('primary_state', states)
            .order('funder_count', { ascending: false }).limit(1);
          if (stateMatches?.length) matched = stateMatches[0];
        }
        if (!matched) {
          const { data: anyMatches } = await supabase
            .from('recipient_organizations')
            .select('ein, name, primary_state, ntee_code, total_funding, funder_count')
            .ilike('name', `%${safeName}%`)
            .order('funder_count', { ascending: false }).limit(1);
          if (anyMatches?.length) matched = anyMatches[0];
        }

        enriched.push(matched ? {
          name: matched.name || peerName, ein: matched.ein, state: matched.primary_state,
          ntee_code: matched.ntee_code, total_revenue: matched.total_funding, shared_funders: matched.funder_count || 0,
        } : { name: peerName, state: peerState || undefined });
      }
      setPeers(enriched);
    } catch (err) {
      console.error('Error loading peers:', err);
      setPeers([]);
    } finally {
      setPeersLoading(false);
    }
  };

  const computeMatches = async (proj?: Project) => {
    const p = proj || project;
    if (!p || !id) return;
    try {
      setComputing(true); setMatchesLoading(true); setError(null);
      const headers = await getEdgeFunctionHeaders();
      const states = p.location_scope?.map(l => l.state) || [];
      const keywords = p.keywords || [];
      const fieldsOfWork = p.fields_of_work || [];

      const res = await fetch(MATCH_FUNDERS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          mission: p.description || p.name,
          locationServed: states.join(', ') || undefined,
          keywords: keywords.length > 0 ? keywords : fieldsOfWork.length > 0 ? fieldsOfWork : undefined,
          budgetBand: p.budget_min ? `${p.budget_min}-${p.budget_max || ''}` : undefined,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Match computation failed (${res.status})`);
      }

      const data = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];

      if (results.length > 0) {
        await supabase.from('project_matches').delete().eq('project_id', id);
        const rows = results.slice(0, 50).map((r: any) => ({
          project_id: id,
          funder_ein: r.foundation_ein || r.id || '',
          funder_name: r.name || r.foundation_ein || '',
          match_score: Math.round((r.fit_score || 0) * 100),
          match_reasons: r.fit_explanation || null,
          gives_to_peers: (r.peer_match_count || 0) > 0,
          computed_at: new Date().toISOString(),
        }));
        const validRows = rows.filter((r: any) => r.funder_ein);
        if (validRows.length > 0) {
          const { error: insertError } = await supabase.from('project_matches').insert(validRows);
          if (insertError?.message?.includes('funder_name')) {
            const fallbackRows = validRows.map(({ funder_name, ...rest }: any) => rest);
            await supabase.from('project_matches').insert(fallbackRows);
          }
        }
      }

      const { data: matchesData } = await supabase
        .from('project_matches').select('*').eq('project_id', id).order('match_score', { ascending: false });
      setMatches(matchesData || []);
    } catch (err: any) {
      console.error('Error computing matches:', err);
      setError(err.message || 'Failed to compute matches.');
    } finally {
      setComputing(false); setMatchesLoading(false);
    }
  };

  // Save a funder to the tracker (tracked_grants)
  const handleSaveFunder = async (funderEin: string, funderName: string) => {
    if (trackedGrants.some(tg => tg.funder_ein === funderEin)) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(TRACKED_GRANTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          project_id: id,
          funder_ein: funderEin,
          funder_name: funderName,
          source: 'ai_match',
          status_slug: 'researching',
        }),
      });
      if (res.ok) {
        await loadTrackerData();
      }
    } catch (err) {
      console.error('Error saving funder:', err);
    }
  };

  // Update grant status
  const handleUpdateGrantStatus = async (grantId: string, statusId: string) => {
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(TRACKED_GRANTS_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ id: grantId, status_id: statusId }),
      });
      setTrackedGrants(prev => prev.map(g => g.id === grantId ? { ...g, status_id: statusId, pipeline_statuses: pipelineStatuses.find(s => s.id === statusId) ? { name: pipelineStatuses.find(s => s.id === statusId)!.name, slug: pipelineStatuses.find(s => s.id === statusId)!.slug, color: pipelineStatuses.find(s => s.id === statusId)!.color, is_terminal: pipelineStatuses.find(s => s.id === statusId)!.is_terminal } : g.pipeline_statuses } : g));
    } catch (err) {
      console.error('Error updating grant status:', err);
    }
  };

  // Update grant fields
  const handleUpdateGrant = async (grantId: string, updates: Partial<TrackedGrant>) => {
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(TRACKED_GRANTS_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ id: grantId, ...updates }),
      });
      setTrackedGrants(prev => prev.map(g => g.id === grantId ? { ...g, ...updates } : g));
      if (selectedGrant?.id === grantId) setSelectedGrant(prev => prev ? { ...prev, ...updates } : prev);
    } catch (err) {
      console.error('Error updating grant:', err);
    }
  };

  // Delete grant
  const handleDeleteGrant = async (grantId: string) => {
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(`${TRACKED_GRANTS_URL}?grant_id=${grantId}`, { method: 'DELETE', headers });
      setTrackedGrants(prev => prev.filter(g => g.id !== grantId));
      if (selectedGrant?.id === grantId) { setSelectedGrant(null); setDrawerOpen(false); }
    } catch (err) {
      console.error('Error deleting grant:', err);
    }
  };

  // Add external grant
  const handleAddExternalGrant = async () => {
    if (!newGrant.funder_name.trim()) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(TRACKED_GRANTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          project_id: id,
          funder_name: newGrant.funder_name.trim(),
          grant_title: newGrant.grant_title.trim() || null,
          amount: newGrant.amount || null,
          deadline: newGrant.deadline || null,
          grant_url: newGrant.grant_url.trim() || null,
          notes: newGrant.notes.trim() || null,
          status_slug: newGrant.status_slug,
          is_external: true,
          source: 'manual',
        }),
      });
      if (res.ok) {
        setAddGrantOpen(false);
        setNewGrant({ funder_name: '', grant_title: '', amount: '', deadline: '', grant_url: '', notes: '', status_slug: 'researching' });
        await loadTrackerData();
      }
    } catch (err) {
      console.error('Error adding grant:', err);
    }
  };

  // Open grant detail drawer
  const openGrantDetail = async (grant: TrackedGrant) => {
    setSelectedGrant(grant);
    setDrawerOpen(true);
    // Load tasks
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(`${GRANT_TASKS_URL}?grant_id=${grant.id}`, { headers });
      if (res.ok) {
        const tasks = await res.json();
        setGrantTasks(tasks);
      }
    } catch (err) {
      console.error('Error loading tasks:', err);
    }
  };

  // Add task to grant
  const handleAddTask = async () => {
    if (!newTaskTitle.trim() || !selectedGrant) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(GRANT_TASKS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          tracked_grant_id: selectedGrant.id,
          project_id: id,
          title: newTaskTitle.trim(),
          due_date: newTaskDueDate || null,
        }),
      });
      if (res.ok) {
        const task = await res.json();
        setGrantTasks(prev => [...prev, task]);
        setNewTaskTitle('');
        setNewTaskDueDate('');
      }
    } catch (err) {
      console.error('Error adding task:', err);
    }
  };

  // Toggle task status
  const handleToggleTask = async (taskId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'done' ? 'todo' : 'done';
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(GRANT_TASKS_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ id: taskId, status: newStatus }),
      });
      setGrantTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus as any } : t));
    } catch (err) {
      console.error('Error toggling task:', err);
    }
  };

  // CSV Import
  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) return;
      const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
      const rows = lines.slice(1).map(line => {
        const values = line.match(/(".*?"|[^,]+)/g) || [];
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = (values[i] || '').replace(/^"|"$/g, '').trim(); });
        return row;
      });
      setCsvData(rows);
      // Auto-detect mapping
      const mapping: Record<string, string> = {};
      const lowerHeaders = headers.map(h => h.toLowerCase());
      if (lowerHeaders.some(h => h.includes('funder') || h.includes('organization'))) {
        mapping.funder_name = headers[lowerHeaders.findIndex(h => h.includes('funder') || h.includes('organization'))];
      }
      if (lowerHeaders.some(h => h.includes('title') || h.includes('grant'))) {
        mapping.grant_title = headers[lowerHeaders.findIndex(h => h.includes('title'))];
      }
      if (lowerHeaders.some(h => h.includes('amount'))) {
        mapping.amount = headers[lowerHeaders.findIndex(h => h.includes('amount'))];
      }
      if (lowerHeaders.some(h => h.includes('deadline') || h.includes('date'))) {
        mapping.deadline = headers[lowerHeaders.findIndex(h => h.includes('deadline') || h.includes('date'))];
      }
      if (lowerHeaders.some(h => h.includes('status'))) {
        mapping.status = headers[lowerHeaders.findIndex(h => h.includes('status'))];
      }
      if (lowerHeaders.some(h => h.includes('note'))) {
        mapping.notes = headers[lowerHeaders.findIndex(h => h.includes('note'))];
      }
      if (lowerHeaders.some(h => h.includes('url') || h.includes('link'))) {
        mapping.url = headers[lowerHeaders.findIndex(h => h.includes('url') || h.includes('link'))];
      }
      setCsvMapping(mapping);
      setCsvStep(2);
    };
    reader.readAsText(file);
  };

  const handleCsvImport = async () => {
    if (csvData.length === 0) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const rows = csvData.map(row => ({
        funder_name: row[csvMapping.funder_name] || 'Unknown Funder',
        grant_title: row[csvMapping.grant_title] || null,
        amount: row[csvMapping.amount] || null,
        deadline: row[csvMapping.deadline] || null,
        status: row[csvMapping.status] || null,
        notes: row[csvMapping.notes] || null,
        url: row[csvMapping.url] || null,
      }));

      const res = await fetch(TRACKED_GRANTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ import: true, project_id: id, rows }),
      });

      if (res.ok) {
        const result = await res.json();
        setCsvImportOpen(false);
        setCsvData([]);
        setCsvStep(1);
        await loadTrackerData();
        alert(`Imported ${result.imported} grants${result.errors?.length ? ` (${result.errors.length} errors)` : ''}`);
      }
    } catch (err) {
      console.error('CSV import error:', err);
    }
  };

  // CSV Export
  const handleCsvExport = async () => {
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(`${TRACKED_GRANTS_URL}?project_id=${id}&export=true`, { headers });
      if (res.ok) {
        const csv = await res.text();
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${project?.name || 'grants'}_export.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Export error:', err);
    }
  };

  // Download CSV template
  const downloadCsvTemplate = () => {
    const template = 'Funder Name,Grant Title,Amount,Deadline (YYYY-MM-DD),Status,Notes,URL\nExample Foundation,Community Grant 2026,50000,2026-06-15,Researching,"Follow up in April",https://example.org/apply';
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fundermatch_import_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveProject = async () => {
    if (!editName.trim()) { setError('Project name is required'); return; }
    try {
      setSaving(true); setError(null);
      const locationScope = editStates.length > 0 ? editStates.map(s => ({ state: s })) : null;
      const { error: updateError } = await supabase.from('projects').update({
        name: editName.trim(), description: editDesc.trim() || null,
        location_scope: locationScope,
        fields_of_work: editNtee.length > 0 ? editNtee : null,
        funding_types: editFundingTypes.length > 0 ? editFundingTypes : null,
        budget_min: editBudgetMin ? parseInt(editBudgetMin) : null,
        budget_max: editBudgetMax ? parseInt(editBudgetMax) : null,
      }).eq('id', id);
      if (updateError) throw updateError;
      await loadProjectData();
      computeMatches().catch(err => console.warn('Match re-computation failed:', err));
    } catch (err) {
      console.error('Error saving project:', err);
      setError('Failed to save project.');
    } finally {
      setSaving(false);
    }
  };

  if (loading || projectLoading) {
    return (<><NavBar /><main className="min-h-screen bg-[#0d1117] pt-20 flex items-center justify-center"><Loader className="animate-spin text-gray-400" size={24} /></main></>);
  }
  if (!project) {
    return (<><NavBar /><main className="min-h-screen bg-[#0d1117] pt-20 px-4 flex items-center justify-center"><div className="text-gray-400">Project not found</div></main></>);
  }

  const getStatusById = (statusId: string) => pipelineStatuses.find(s => s.id === statusId);

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
                  {tab === 'tracker' && trackedGrants.length > 0 && (
                    <span className="ml-2 text-xs bg-[#30363d] text-gray-300 px-1.5 py-0.5 rounded-full">{trackedGrants.length}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* MATCHES TAB */}
          {activeTab === 'matches' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-gray-400">
                  {matches.length > 0 ? `${matches.length} matched funder${matches.length !== 1 ? 's' : ''}` : ''}
                </p>
                <button onClick={() => computeMatches()} disabled={computing}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                  <RefreshCw size={16} className={computing ? 'animate-spin' : ''} />
                  {computing ? 'Computing...' : matches.length > 0 ? 'Refresh Matches' : 'Compute Matches'}
                </button>
              </div>
              {matchesLoading && !computing ? (
                <div className="flex items-center justify-center py-12"><Loader className="animate-spin text-gray-400" size={24} /></div>
              ) : computing ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <Loader className="animate-spin text-blue-400 mx-auto mb-3" size={24} />
                  <p className="text-gray-400 mb-2">Computing matches...</p>
                  <p className="text-gray-500 text-sm">This may take a moment as we analyze funder compatibility.</p>
                </div>
              ) : matches.length === 0 ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <p className="text-gray-400 mb-2">No matches computed yet.</p>
                  <p className="text-gray-500 text-sm">Click "Compute Matches" above or update your project criteria in Settings.</p>
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
                            <td className="px-6 py-4 text-white">{m.funder_name || m.funder_ein}</td>
                            <td className="px-6 py-4">
                              <span className={`text-xs font-medium px-2 py-1 rounded-full ${Number(m.match_score) >= 70 ? 'bg-green-900/30 text-green-400' : Number(m.match_score) >= 40 ? 'bg-yellow-900/30 text-yellow-400' : 'bg-gray-800 text-gray-400'}`}>
                                {Math.round(Number(m.match_score))}%
                              </span>
                            </td>
                            <td className="px-6 py-4 text-gray-400">{m.gives_to_peers ? 'Yes' : '—'}</td>
                            <td className="px-6 py-4 text-right">
                              <button onClick={(e) => { e.stopPropagation(); handleSaveFunder(m.funder_ein, m.funder_name || m.funder_ein); }}
                                disabled={trackedGrants.some(tg => tg.funder_ein === m.funder_ein)}
                                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-sm font-medium transition-colors">
                                {trackedGrants.some(tg => tg.funder_ein === m.funder_ein) ? 'Tracked' : 'Track'}
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

          {/* TRACKER TAB — Phase 3 Enhanced */}
          {activeTab === 'tracker' && (
            <div>
              {/* Tracker toolbar */}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <button onClick={() => setAddGrantOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
                  <Plus size={16} /> Add Grant
                </button>
                <button onClick={() => { setCsvImportOpen(true); setCsvStep(1); }}
                  className="flex items-center gap-2 px-3 py-2 bg-[#161b22] border border-[#30363d] hover:border-[#484f58] text-gray-300 rounded-lg text-sm transition-colors">
                  <Upload size={14} /> Import CSV
                </button>
                <button onClick={handleCsvExport} disabled={trackedGrants.length === 0}
                  className="flex items-center gap-2 px-3 py-2 bg-[#161b22] border border-[#30363d] hover:border-[#484f58] text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50">
                  <Download size={14} /> Export CSV
                </button>
                <span className="text-sm text-gray-500 ml-auto">
                  {trackedGrants.length} grant{trackedGrants.length !== 1 ? 's' : ''} tracked
                </span>
              </div>

              {/* Pipeline status summary */}
              {trackedGrants.length > 0 && pipelineStatuses.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-6">
                  {pipelineStatuses.map(status => {
                    const count = trackedGrants.filter(g => g.status_id === status.id).length;
                    if (count === 0) return null;
                    return (
                      <div key={status.id} className="flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border border-[#30363d] rounded-full">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: status.color }} />
                        <span className="text-sm text-gray-300">{status.name}</span>
                        <span className="text-xs text-gray-500">{count}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {trackerLoading ? (
                <div className="flex items-center justify-center py-12"><Loader className="animate-spin text-gray-400" size={24} /></div>
              ) : trackedGrants.length === 0 ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <p className="text-gray-400 mb-2">No grants tracked yet.</p>
                  <p className="text-gray-500 text-sm">Save funders from Matches, add grants manually, or import from CSV.</p>
                </div>
              ) : (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-[#0d1117] border-b border-[#30363d]">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Funder / Grant</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Amount</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Deadline</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Source</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#30363d]">
                        {trackedGrants.map(grant => {
                          const statusInfo = grant.pipeline_statuses || getStatusById(grant.status_id);
                          const isOverdue = grant.deadline && new Date(grant.deadline) < new Date() && !statusInfo?.is_terminal;
                          return (
                            <tr key={grant.id} className="hover:bg-[#0d1117] transition-colors cursor-pointer" onClick={() => openGrantDetail(grant)}>
                              <td className="px-4 py-3">
                                <div className="text-blue-400 hover:text-blue-300 text-sm font-medium">{grant.funder_name}</div>
                                {grant.grant_title && <div className="text-xs text-gray-500 mt-0.5">{grant.grant_title}</div>}
                              </td>
                              <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                                <select
                                  value={grant.status_id}
                                  onChange={e => handleUpdateGrantStatus(grant.id, e.target.value)}
                                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm"
                                  style={{ color: statusInfo?.color || '#fff' }}
                                >
                                  {pipelineStatuses.map(s => (
                                    <option key={s.id} value={s.id} style={{ color: s.color }}>{s.name}</option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-4 py-3 text-gray-300 text-sm">{fmtCurrency(grant.amount)}</td>
                              <td className="px-4 py-3">
                                {grant.deadline ? (
                                  <span className={`text-sm ${isOverdue ? 'text-red-400 font-medium' : 'text-gray-300'}`}>
                                    {isOverdue && <AlertTriangle size={12} className="inline mr-1" />}
                                    {new Date(grant.deadline).toLocaleDateString()}
                                  </span>
                                ) : <span className="text-gray-600 text-sm">—</span>}
                              </td>
                              <td className="px-4 py-3 text-gray-500 text-xs uppercase">{grant.source}</td>
                              <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-1">
                                  {grant.funder_ein && (
                                    <button onClick={() => navigate(`/funder/${grant.funder_ein}`)} className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors" title="View funder">
                                      <ExternalLink size={14} />
                                    </button>
                                  )}
                                  <button onClick={() => handleDeleteGrant(grant.id)} className="p-1.5 text-gray-500 hover:text-red-400 transition-colors" title="Remove">
                                    <Trash2 size={14} />
                                  </button>
                                </div>
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
          )}

          {/* PEERS TAB */}
          {activeTab === 'peers' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-gray-400">
                  {peers.length > 0 ? `${peers.length} peer organization${peers.length !== 1 ? 's' : ''} with similar missions` : ''}
                </p>
                <button onClick={() => project && loadPeers(project)} disabled={peersLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                  <RefreshCw size={16} className={peersLoading ? 'animate-spin' : ''} />
                  {peersLoading ? 'Finding Peers...' : 'Refresh Peers'}
                </button>
              </div>
              {peersLoading ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <Loader className="animate-spin text-blue-400 mx-auto mb-3" size={24} />
                  <p className="text-gray-400 mb-2">Finding peer organizations...</p>
                  <p className="text-gray-500 text-sm">Analyzing grant records to find nonprofits with similar missions.</p>
                </div>
              ) : peers.length === 0 ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <Users size={32} className="mx-auto text-gray-500 mb-3" />
                  <p className="text-gray-400 mb-2">No peer organizations found.</p>
                  <p className="text-gray-500 text-sm">Try updating your project description and location in Settings, then click "Refresh Peers".</p>
                </div>
              ) : (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-[#0d1117] border-b border-[#30363d]">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Organization</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">State</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Category</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-400 uppercase">Funders</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#30363d]">
                        {peers.map((peer, idx) => (
                          <tr key={peer.ein || `peer-${idx}`} className="hover:bg-[#0d1117] transition-colors cursor-pointer" onClick={() => peer.ein && navigate(`/recipient/${peer.ein}`)}>
                            <td className="px-6 py-4 text-blue-400 hover:text-blue-300 font-medium text-sm">{peer.name}</td>
                            <td className="px-6 py-4 text-gray-400 text-sm">{peer.state || '—'}</td>
                            <td className="px-6 py-4 text-gray-400 text-sm">
                              {NTEE_CATEGORIES.find(c => peer.ntee_code?.startsWith(c.code))?.label || peer.ntee_code || '—'}
                            </td>
                            <td className="px-6 py-4 text-right text-gray-300 text-sm">{peer.shared_funders ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SETTINGS TAB */}
          {activeTab === 'settings' && (
            <div className="max-w-3xl space-y-6">
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

              <button onClick={handleSaveProject} disabled={saving}
                className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
                <Save size={18} />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Add Grant Modal */}
      {addGrantOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setAddGrantOpen(false)}>
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Add Grant to Tracker</h3>
              <button onClick={() => setAddGrantOpen(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Funder Name *</label>
                <input type="text" value={newGrant.funder_name} onChange={e => setNewGrant(p => ({ ...p, funder_name: e.target.value }))} placeholder="e.g. Ford Foundation"
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Grant Title</label>
                <input type="text" value={newGrant.grant_title} onChange={e => setNewGrant(p => ({ ...p, grant_title: e.target.value }))} placeholder="e.g. Community Innovation Fund 2026"
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Amount</label>
                  <input type="number" value={newGrant.amount} onChange={e => setNewGrant(p => ({ ...p, amount: e.target.value }))} placeholder="50000"
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Deadline</label>
                  <input type="date" value={newGrant.deadline} onChange={e => setNewGrant(p => ({ ...p, deadline: e.target.value }))}
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">URL</label>
                <input type="url" value={newGrant.grant_url} onChange={e => setNewGrant(p => ({ ...p, grant_url: e.target.value }))} placeholder="https://..."
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Status</label>
                <select value={newGrant.status_slug} onChange={e => setNewGrant(p => ({ ...p, status_slug: e.target.value }))}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm">
                  {pipelineStatuses.map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Notes</label>
                <textarea value={newGrant.notes} onChange={e => setNewGrant(p => ({ ...p, notes: e.target.value }))} rows={2}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <button onClick={handleAddExternalGrant} disabled={!newGrant.funder_name.trim()}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors">
                Add Grant
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSV Import Modal */}
      {csvImportOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setCsvImportOpen(false)}>
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-2xl p-6 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Import Grants from CSV</h3>
              <button onClick={() => setCsvImportOpen(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>

            {csvStep === 1 && (
              <div className="space-y-4">
                <p className="text-sm text-gray-400">Upload a CSV file with your grant tracking data. We'll help you map columns.</p>
                <button onClick={downloadCsvTemplate} className="text-sm text-blue-400 hover:text-blue-300 underline">Download CSV Template</button>
                <div className="border-2 border-dashed border-[#30363d] rounded-lg p-8 text-center">
                  <Upload size={32} className="mx-auto text-gray-500 mb-3" />
                  <p className="text-gray-400 mb-3">Drag and drop your CSV file, or click to browse</p>
                  <input ref={fileInputRef} type="file" accept=".csv" onChange={handleCsvFile} className="hidden" />
                  <button onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
                    Choose File
                  </button>
                </div>
              </div>
            )}

            {csvStep === 2 && (
              <div className="space-y-4">
                <p className="text-sm text-gray-400">{csvData.length} rows found. Review column mapping:</p>
                <div className="grid grid-cols-2 gap-3">
                  {['funder_name', 'grant_title', 'amount', 'deadline', 'status', 'notes', 'url'].map(field => (
                    <div key={field}>
                      <label className="block text-xs text-gray-500 mb-1 capitalize">{field.replace('_', ' ')}</label>
                      <select value={csvMapping[field] || ''} onChange={e => setCsvMapping(p => ({ ...p, [field]: e.target.value }))}
                        className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-white text-sm">
                        <option value="">— Skip —</option>
                        {csvData.length > 0 && Object.keys(csvData[0]).map(col => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                {csvData.length > 0 && (
                  <div className="overflow-x-auto border border-[#30363d] rounded-lg max-h-48">
                    <table className="w-full text-xs">
                      <thead className="bg-[#0d1117]">
                        <tr>
                          {Object.keys(csvData[0]).map(col => (
                            <th key={col} className="px-3 py-2 text-left text-gray-400 font-medium">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#30363d]">
                        {csvData.slice(0, 5).map((row, i) => (
                          <tr key={i}>
                            {Object.values(row).map((val, j) => (
                              <td key={j} className="px-3 py-1.5 text-gray-300 truncate max-w-[150px]">{String(val)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex justify-end gap-3">
                  <button onClick={() => { setCsvStep(1); setCsvData([]); }}
                    className="px-4 py-2 bg-[#0d1117] border border-[#30363d] text-gray-300 rounded-lg text-sm">Back</button>
                  <button onClick={handleCsvImport} disabled={!csvMapping.funder_name}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                    Import {csvData.length} Grants
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Grant Detail Drawer */}
      {drawerOpen && selectedGrant && (
        <div className="fixed inset-0 bg-black/40 z-50 flex justify-end" onClick={() => setDrawerOpen(false)}>
          <div className="w-full max-w-md bg-[#161b22] border-l border-[#30363d] h-full overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold text-white">{selectedGrant.funder_name}</h3>
                  {selectedGrant.grant_title && <p className="text-sm text-gray-400 mt-1">{selectedGrant.grant_title}</p>}
                </div>
                <button onClick={() => setDrawerOpen(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
              </div>

              {/* Status */}
              <div className="mb-4">
                <label className="block text-xs text-gray-500 mb-1">Status</label>
                <select value={selectedGrant.status_id}
                  onChange={e => { handleUpdateGrantStatus(selectedGrant.id, e.target.value); setSelectedGrant(prev => prev ? { ...prev, status_id: e.target.value } : prev); }}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm">
                  {pipelineStatuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              {/* Details grid */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Amount</label>
                  <p className="text-white text-sm">{fmtCurrency(selectedGrant.amount)}</p>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Deadline</label>
                  <p className="text-white text-sm">{selectedGrant.deadline ? new Date(selectedGrant.deadline).toLocaleDateString() : '—'}</p>
                </div>
                {selectedGrant.grant_url && (
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">URL</label>
                    <a href={selectedGrant.grant_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm truncate block">{selectedGrant.grant_url}</a>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div className="mb-6">
                <label className="block text-xs text-gray-500 mb-1">Notes</label>
                <textarea
                  value={selectedGrant.notes || ''}
                  onChange={e => setSelectedGrant(prev => prev ? { ...prev, notes: e.target.value } : prev)}
                  onBlur={() => selectedGrant && handleUpdateGrant(selectedGrant.id, { notes: selectedGrant.notes } as any)}
                  rows={3}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  placeholder="Add notes..."
                />
              </div>

              {/* Tasks Section */}
              <div className="border-t border-[#30363d] pt-4">
                <h4 className="text-sm font-semibold text-white mb-3">Tasks</h4>

                {/* Task list */}
                <div className="space-y-2 mb-4">
                  {grantTasks.length === 0 && <p className="text-xs text-gray-500">No tasks yet.</p>}
                  {grantTasks.map(task => (
                    <div key={task.id} className={`flex items-start gap-2 p-2 rounded-lg ${task.is_overdue ? 'bg-red-900/10 border border-red-900/30' : 'bg-[#0d1117]'}`}>
                      <button onClick={() => handleToggleTask(task.id, task.status)}
                        className={`mt-0.5 flex-shrink-0 ${task.status === 'done' ? 'text-green-400' : 'text-gray-500 hover:text-gray-300'}`}>
                        <CheckCircle size={16} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${task.status === 'done' ? 'line-through text-gray-500' : 'text-white'}`}>{task.title}</p>
                        {task.due_date && (
                          <p className={`text-xs mt-0.5 ${task.is_overdue ? 'text-red-400' : 'text-gray-500'}`}>
                            <Clock size={10} className="inline mr-1" />
                            Due {new Date(task.due_date).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add task */}
                <div className="flex gap-2">
                  <input type="text" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                    placeholder="Add a task..." onKeyDown={e => e.key === 'Enter' && handleAddTask()}
                    className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500" />
                  <input type="date" value={newTaskDueDate} onChange={e => setNewTaskDueDate(e.target.value)}
                    className="bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-white text-sm w-[130px]" />
                  <button onClick={handleAddTask} disabled={!newTaskTitle.trim()}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm transition-colors">
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
