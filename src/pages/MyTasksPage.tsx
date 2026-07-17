import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader, CheckCircle, Clock, AlertTriangle, Plus, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';
import type { GrantTask, PortfolioGrant } from '../types';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const GRANT_TASKS_URL = `${SUPABASE_URL}/functions/v1/grant-tasks`;
const PORTFOLIO_URL = `${SUPABASE_URL}/functions/v1/portfolio`;
const TEAM_INVITE_URL = `${SUPABASE_URL}/functions/v1/team-invite`;

interface GroupedTasks {
  overdue: GrantTask[];
  today: GrantTask[];
  this_week: GrantTask[];
  later: GrantTask[];
  no_date: GrantTask[];
  completed: GrantTask[];
}

export default function MyTasksPage() {
  useEffect(() => {
    document.title = 'My Tasks | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Personal task list across every grant project you contribute to.';
  }, []);

  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<GroupedTasks>({ overdue: [], today: [], this_week: [], later: [], no_date: [], completed: [] });

  // FM-IC-DLN-003: create + assign tasks directly from the standalone tasks page.
  const [showComposer, setShowComposer] = useState(false);
  const [grants, setGrants] = useState<PortfolioGrant[]>([]);
  const [memberEmails, setMemberEmails] = useState<string[]>([]);
  const [composerLoading, setComposerLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [formGrantId, setFormGrantId] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  const [formAssignee, setFormAssignee] = useState('');

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(`${GRANT_TASKS_URL}?my_tasks=true`, { headers });
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
      }
    } catch (err) {
      console.error('Error loading tasks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user) loadTasks();
  }, [user, authLoading, loadTasks]);

  // Lazily fetch tracked grants (for the grant selector) and team members
  // (for the assignee suggestions) the first time the composer opens.
  const openComposer = async () => {
    setShowComposer(true);
    setCreateError('');
    if (grants.length === 0) {
      setComposerLoading(true);
      try {
        const headers = await getEdgeFunctionHeaders();
        const [pRes, tRes] = await Promise.all([
          fetch(PORTFOLIO_URL, { headers }),
          fetch(`${TEAM_INVITE_URL}?include_projects=true`, { headers }).catch(() => null),
        ]);
        if (pRes.ok) {
          const pData = await pRes.json();
          const list: PortfolioGrant[] = pData.grants || pData || [];
          setGrants(list);
          if (list.length > 0) setFormGrantId(list[0].id);
        }
        if (tRes && tRes.ok) {
          const tData = await tRes.json();
          const emails: string[] = (tData.members || [])
            .map((m: { email?: string }) => m.email)
            .filter((e: string | undefined): e is string => !!e);
          setMemberEmails(emails);
        }
      } catch (err) {
        console.error('Error loading task composer data:', err);
      } finally {
        setComposerLoading(false);
      }
    }
  };

  const resetForm = () => {
    setFormTitle('');
    setFormDueDate('');
    setFormAssignee('');
    setCreateError('');
  };

  const handleCreateTask = async () => {
    if (!formGrantId) { setCreateError('Select a grant to attach this task to.'); return; }
    if (!formTitle.trim()) { setCreateError('Enter a task title.'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(GRANT_TASKS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          tracked_grant_id: formGrantId,
          title: formTitle.trim(),
          due_date: formDueDate || null,
          assignee_email: formAssignee.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCreateError(data?.error || 'Failed to create task.');
        return;
      }
      resetForm();
      setShowComposer(false);
      await loadTasks();
    } catch (err) {
      console.error('Error creating task:', err);
      setCreateError('Failed to create task.');
    } finally {
      setCreating(false);
    }
  };

  const toggleTask = async (taskId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'done' ? 'todo' : 'done';
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(GRANT_TASKS_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ id: taskId, status: newStatus }),
      });
      // Reload to re-sort
      await loadTasks();
    } catch (err) {
      console.error('Error toggling task:', err);
    }
  };

  if (authLoading || loading) {
    return (<><NavBar /><main id="main-content" className="min-h-screen bg-[#0d1117] pt-20 flex items-center justify-center"><Loader className="animate-spin text-gray-400" size={24} /></main></>);
  }

  const allEmpty = Object.values(tasks).every(arr => arr.length === 0);
  const inputClass = 'w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500';

  const renderSection = (title: string, items: GrantTask[], icon: React.ReactNode, color: string) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          {icon}
          <h2 className={`text-sm font-semibold ${color}`}>{title}</h2>
          <span className="text-xs text-gray-400 bg-[#0d1117] px-2 py-0.5 rounded-full">{items.length}</span>
        </div>
        <div className="space-y-2">
          {items.map(task => (
            <div key={task.id}
              className={`flex items-start gap-3 p-3 bg-[#161b22] border rounded-lg transition-colors hover:border-[#484f58] ${
                task.is_overdue ? 'border-red-900/50' : 'border-[#30363d]'
              }`}
            >
              <button onClick={() => toggleTask(task.id, task.status)}
                aria-label={task.status === 'done' ? `Mark task "${task.title}" as not done` : `Mark task "${task.title}" as done`}
                aria-pressed={task.status === 'done'}
                className={`mt-0.5 flex-shrink-0 ${task.status === 'done' ? 'text-green-400' : 'text-gray-400 hover:text-gray-300'}`}>
                <CheckCircle size={18} aria-hidden="true" />
              </button>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${task.status === 'done' ? 'line-through text-gray-400' : 'text-white'}`}>{task.title}</p>
                <div className="flex flex-wrap items-center gap-3 mt-1">
                  {task.tracked_grants && (
                    <span className="text-xs text-gray-400">{task.tracked_grants.funder_name}{task.tracked_grants.grant_title ? ` — ${task.tracked_grants.grant_title}` : ''}</span>
                  )}
                  {task.projects && (
                    <button type="button" aria-label={`Open project ${task.projects.name}`} className="text-xs text-blue-400 cursor-pointer hover:text-blue-300 hover:underline text-left" onClick={() => navigate(`/projects/${task.project_id}/tracker`)}>
                      {task.projects.name}
                    </button>
                  )}
                  {task.assignee_email && (
                    <span className="text-xs text-purple-400">@ {task.assignee_email}</span>
                  )}
                  {task.due_date && (
                    <span className={`text-xs flex items-center gap-1 ${task.is_overdue ? 'text-red-400' : 'text-gray-400'}`}>
                      <Clock size={10} />
                      {new Date(task.due_date).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      <NavBar />
      <main id="main-content" className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-3xl font-bold text-white">My Tasks</h1>
            <button onClick={openComposer}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
              <Plus size={16} /> New Task
            </button>
          </div>

          {/* FM-IC-DLN-003: create + assign task composer */}
          {showComposer && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-white">Create a task</h2>
                <button onClick={() => { setShowComposer(false); resetForm(); }} aria-label="Close task composer"
                  className="text-gray-400 hover:text-gray-300"><X size={18} /></button>
              </div>
              {composerLoading ? (
                <div className="flex items-center justify-center py-8"><Loader className="animate-spin text-gray-400" size={20} /></div>
              ) : grants.length === 0 ? (
                <div className="text-sm text-gray-400 py-4">
                  You need at least one tracked grant before adding a task. Track a grant from your matches, then come back here.
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="task-form-grant" className="block text-xs font-medium text-gray-400 mb-1">Grant</label>
                    <select id="task-form-grant" value={formGrantId} onChange={e => setFormGrantId(e.target.value)} className={inputClass}>
                      {grants.map(g => (
                        <option key={g.id} value={g.id}>
                          {g.funder_name}{g.grant_title ? ` — ${g.grant_title}` : ''}{g.project_name ? ` (${g.project_name})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="task-form-title" className="block text-xs font-medium text-gray-400 mb-1">Task</label>
                    <input id="task-form-title" type="text" value={formTitle} onChange={e => setFormTitle(e.target.value)}
                      placeholder="e.g. Draft letter of inquiry" className={inputClass}
                      onKeyDown={e => { if (e.key === 'Enter') handleCreateTask(); }} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="task-form-due" className="block text-xs font-medium text-gray-400 mb-1">Due date</label>
                      <input id="task-form-due" type="date" value={formDueDate} onChange={e => setFormDueDate(e.target.value)} className={inputClass} />
                    </div>
                    <div>
                      <label htmlFor="task-form-assignee" className="block text-xs font-medium text-gray-400 mb-1">Assign to (team member email)</label>
                      <input id="task-form-assignee" type="email" list="ff-team-emails" value={formAssignee} onChange={e => setFormAssignee(e.target.value)}
                        placeholder="teammate@org.org" className={inputClass} />
                      <datalist id="ff-team-emails">
                        {memberEmails.map(em => <option key={em} value={em} />)}
                      </datalist>
                    </div>
                  </div>
                  {createError && <p className="text-sm text-red-400">{createError}</p>}
                  <div className="flex items-center gap-3">
                    <button onClick={handleCreateTask} disabled={creating}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors">
                      {creating ? (<><Loader className="animate-spin" size={16} /> Creating...</>) : (<><Plus size={16} /> Create task</>)}
                    </button>
                    <button onClick={() => { setShowComposer(false); resetForm(); }}
                      className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {allEmpty ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
              <CheckCircle size={32} className="mx-auto text-gray-400 mb-3" />
              <p className="text-gray-400 mb-2">No tasks yet.</p>
              <p className="text-gray-400 text-sm">Create a task with the “New Task” button above, or add tasks to tracked grants from a project tracker.</p>
            </div>
          ) : (
            <>
              {renderSection('Overdue', tasks.overdue, <AlertTriangle size={14} className="text-red-400" />, 'text-red-400')}
              {renderSection('Due Today', tasks.today, <Clock size={14} className="text-yellow-400" />, 'text-yellow-400')}
              {renderSection('Due This Week', tasks.this_week, <Clock size={14} className="text-blue-400" />, 'text-blue-400')}
              {renderSection('Due Later', tasks.later, <Clock size={14} className="text-gray-400" />, 'text-gray-400')}
              {renderSection('No Due Date', tasks.no_date, <Clock size={14} className="text-gray-400" />, 'text-gray-400')}
              {renderSection('Completed', tasks.completed, <CheckCircle size={14} className="text-green-400" />, 'text-green-400')}
            </>
          )}
        </div>
      </main>
    </>
  );
}
