import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader, CheckCircle, Clock, AlertTriangle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';
import type { GrantTask } from '../types';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const GRANT_TASKS_URL = `${SUPABASE_URL}/functions/v1/grant-tasks`;

interface GroupedTasks {
  overdue: GrantTask[];
  today: GrantTask[];
  this_week: GrantTask[];
  later: GrantTask[];
  no_date: GrantTask[];
  completed: GrantTask[];
}

export default function MyTasksPage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<GroupedTasks>({ overdue: [], today: [], this_week: [], later: [], no_date: [], completed: [] });

  useEffect(() => {
    if (!authLoading && user) loadTasks();
  }, [user, authLoading]);

  const loadTasks = async () => {
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
    return (<><NavBar /><main className="min-h-screen bg-[#0d1117] pt-20 flex items-center justify-center"><Loader className="animate-spin text-gray-400" size={24} /></main></>);
  }

  const allEmpty = Object.values(tasks).every(arr => arr.length === 0);

  const renderSection = (title: string, items: GrantTask[], icon: React.ReactNode, color: string) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          {icon}
          <h2 className={`text-sm font-semibold ${color}`}>{title}</h2>
          <span className="text-xs text-gray-500 bg-[#0d1117] px-2 py-0.5 rounded-full">{items.length}</span>
        </div>
        <div className="space-y-2">
          {items.map(task => (
            <div key={task.id}
              className={`flex items-start gap-3 p-3 bg-[#161b22] border rounded-lg transition-colors hover:border-[#484f58] ${
                task.is_overdue ? 'border-red-900/50' : 'border-[#30363d]'
              }`}
            >
              <button onClick={() => toggleTask(task.id, task.status)}
                className={`mt-0.5 flex-shrink-0 ${task.status === 'done' ? 'text-green-400' : 'text-gray-500 hover:text-gray-300'}`}>
                <CheckCircle size={18} />
              </button>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${task.status === 'done' ? 'line-through text-gray-500' : 'text-white'}`}>{task.title}</p>
                <div className="flex flex-wrap items-center gap-3 mt-1">
                  {task.tracked_grants && (
                    <span className="text-xs text-gray-500">{task.tracked_grants.funder_name}{task.tracked_grants.grant_title ? ` — ${task.tracked_grants.grant_title}` : ''}</span>
                  )}
                  {task.projects && (
                    <span className="text-xs text-blue-400 cursor-pointer hover:text-blue-300" onClick={() => navigate(`/projects/${task.project_id}/tracker`)}>
                      {task.projects.name}
                    </span>
                  )}
                  {task.due_date && (
                    <span className={`text-xs flex items-center gap-1 ${task.is_overdue ? 'text-red-400' : 'text-gray-500'}`}>
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
      <main className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-bold text-white mb-8">My Tasks</h1>

          {allEmpty ? (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
              <CheckCircle size={32} className="mx-auto text-gray-500 mb-3" />
              <p className="text-gray-400 mb-2">No tasks yet.</p>
              <p className="text-gray-500 text-sm">Tasks will appear here when you add them to tracked grants.</p>
            </div>
          ) : (
            <>
              {renderSection('Overdue', tasks.overdue, <AlertTriangle size={14} className="text-red-400" />, 'text-red-400')}
              {renderSection('Due Today', tasks.today, <Clock size={14} className="text-yellow-400" />, 'text-yellow-400')}
              {renderSection('Due This Week', tasks.this_week, <Clock size={14} className="text-blue-400" />, 'text-blue-400')}
              {renderSection('Due Later', tasks.later, <Clock size={14} className="text-gray-400" />, 'text-gray-400')}
              {renderSection('No Due Date', tasks.no_date, <Clock size={14} className="text-gray-500" />, 'text-gray-500')}
              {renderSection('Completed', tasks.completed, <CheckCircle size={14} className="text-green-400" />, 'text-green-400')}
            </>
          )}
        </div>
      </main>
    </>
  );
}
