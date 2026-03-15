import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Calendar } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import NavBar from '../components/NavBar';

interface ProjectWithCounts {
  id: string;
  name: string;
  description?: string;
  updated_at: string;
  tracked_grants: Array<{ count?: number }>;
  project_matches: Array<{ count?: number }>;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) {
      loadProjects();
    }
  }, [user, loading]);

  const loadProjects = async () => {
    try {
      setProjectsLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from('projects')
        .select('*, tracked_grants(count), project_matches(count)')
        .eq('user_id', user!.id)
        .order('updated_at', { ascending: false });

      if (fetchError) throw fetchError;

      setProjects(data || []);
    } catch (err) {
      console.error('Error loading projects:', err);
      setError('Failed to load projects. Please try again.');
    } finally {
      setProjectsLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMins = Math.floor(diffMs / (1000 * 60));
        return `${diffMins}m ago`;
      }
      return `${diffHours}h ago`;
    }
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const truncateText = (text: string | undefined, lines: number) => {
    if (!text) return '';
    const textLines = text.split('\n');
    return textLines.slice(0, lines).join('\n');
  };

  const getSavedFundersCount = (project: ProjectWithCounts) => {
    if (!project.tracked_grants || project.tracked_grants.length === 0) {
      return 0;
    }
    return project.tracked_grants[0]?.count || 0;
  };

  const getMatchesCount = (project: ProjectWithCounts) => {
    if (!project.project_matches || project.project_matches.length === 0) {
      return 0;
    }
    return project.project_matches[0]?.count || 0;
  };

  if (loading || projectsLoading) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8">
          <div className="flex justify-center items-center py-12">
            <div className="text-gray-400">Loading your projects...</div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <NavBar />
      <main className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-white">Your Projects</h1>
              <p className="text-gray-400 mt-2">Manage and track your funding initiatives</p>
            </div>
            <button
              onClick={() => navigate('/projects/new')}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors w-full sm:w-auto justify-center sm:justify-start"
            >
              <Plus size={20} />
              New Project
            </button>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-8 p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200">
              {error}
            </div>
          )}

          {/* Projects Grid or Empty State */}
          {projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 bg-[#161b22] border border-[#30363d] rounded-lg">
              <div className="text-center max-w-md">
                <h2 className="text-xl font-semibold text-white mb-3">No projects yet</h2>
                <p className="text-gray-400 mb-6">
                  Create your first project to start discovering funders tailored to a specific initiative.
                </p>
                <button
                  onClick={() => navigate('/projects/new')}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium transition-colors"
                >
                  <Plus size={20} />
                  Create Your First Project
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => navigate(`/projects/${project.id}`)}
                  className="bg-[#161b22] border border-[#30363d] rounded-lg p-6 hover:border-[#58a6ff] hover:shadow-lg transition-all duration-200 text-left group"
                >
                  {/* Project Name */}
                  <h3 className="text-lg font-semibold text-white group-hover:text-[#58a6ff] transition-colors mb-2">
                    {project.name}
                  </h3>

                  {/* Description */}
                  {project.description && (
                    <p className="text-sm text-gray-400 mb-4 line-clamp-2">
                      {truncateText(project.description, 2)}
                    </p>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="bg-[#0d1117] rounded p-3">
                      <div className="text-xs text-gray-500 uppercase tracking-wide">Matched</div>
                      <div className="text-2xl font-bold text-white">
                        {getMatchesCount(project)}
                      </div>
                    </div>
                    <div className="bg-[#0d1117] rounded p-3">
                      <div className="text-xs text-gray-500 uppercase tracking-wide">Tracked</div>
                      <div className="text-2xl font-bold text-white">
                        {getSavedFundersCount(project)}
                      </div>
                    </div>
                  </div>

                  {/* Last Updated */}
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Calendar size={14} />
                    <span>Updated {formatDate(project.updated_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
