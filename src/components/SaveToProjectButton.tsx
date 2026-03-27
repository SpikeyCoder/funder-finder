import React, { useState, useEffect } from 'react';
import { Bookmark, BookmarkCheck, ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, getEdgeFunctionHeaders } from '../lib/supabase';
import LoginModal from './LoginModal';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const TRACKED_GRANTS_URL = `${SUPABASE_URL}/functions/v1/tracked-grants`;

interface Project {
  id: string;
  name: string;
}

interface SaveToProjectButtonProps {
  funderEin: string;
  funderName: string;
  className?: string;
}

const SaveToProjectButton: React.FC<SaveToProjectButtonProps> = ({
  funderEin,
  funderName,
  className = '',
}) => {
  const { user, session, loading: authLoading } = useAuth();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [savedToProjects, setSavedToProjects] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);

  // Load user's projects when authenticated
  useEffect(() => {
    if (user && session) {
      loadProjects();
      checkSavedStatus();
    }
  }, [user, session]);

  const loadProjects = async () => {
    if (!user) return;

    setLoadingProjects(true);
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name')
        .eq('user_id', user.id)
        .order('name');

      if (error) {
        console.error('Error loading projects:', error);
        setProjects([]);
      } else {
        setProjects(data || []);
      }
    } catch (err) {
      console.error('Error fetching projects:', err);
      setProjects([]);
    } finally {
      setLoadingProjects(false);
    }
  };

  const checkSavedStatus = async () => {
    if (!user) return;

    try {
      // RLS ensures we only see rows belonging to the current user's projects
      const { data: userProjects } = await supabase
        .from('projects')
        .select('id')
        .eq('user_id', user.id);

      if (!userProjects || userProjects.length === 0) return;

      const projectIds = userProjects.map((p) => p.id);
      const { data, error } = await supabase
        .from('project_saved_funders')
        .select('project_id')
        .eq('funder_ein', funderEin)
        .in('project_id', projectIds);

      if (error) {
        console.error('Error checking saved status:', error);
      } else {
        const projectIds = new Set((data || []).map((d) => d.project_id));
        setSavedToProjects(projectIds);
      }
    } catch (err) {
      console.error('Error checking saved status:', err);
    }
  };

  const handleSaveToProject = async (projectId: string) => {
    if (!user || !session) return;

    setIsSaving(true);
    try {
      const isCurrentlySaved = savedToProjects.has(projectId);

      if (isCurrentlySaved) {
        // Remove the funder from the project
        // RLS handles authorization through project ownership
        const { error } = await supabase
          .from('project_saved_funders')
          .delete()
          .eq('project_id', projectId)
          .eq('funder_ein', funderEin);

        if (error) {
          console.error('Error removing funder:', error);
          return;
        }

        // Also remove from tracked_grants so the Tracker stays in sync
        try {
          await supabase
            .from('tracked_grants')
            .delete()
            .eq('project_id', projectId)
            .eq('funder_ein', funderEin);
        } catch (err) {
          console.warn('Failed to remove from tracked_grants:', err);
        }

        // Update local state
        const newSavedProjects = new Set(savedToProjects);
        newSavedProjects.delete(projectId);
        setSavedToProjects(newSavedProjects);
      } else {
        // Add the funder to the project
        const { error } = await supabase
          .from('project_saved_funders')
          .insert({
            project_id: projectId,
            funder_ein: funderEin,
            funder_name: funderName,
          });

        if (error) {
          console.error('Error saving funder:', error);
          return;
        }

        // Also add to tracked_grants so it appears in the project Tracker
        try {
          const headers = await getEdgeFunctionHeaders();
          await fetch(TRACKED_GRANTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({
              project_id: projectId,
              funder_ein: funderEin,
              funder_name: funderName,
              source: 'browse',
              status_slug: 'researching',
            }),
          });
        } catch (err) {
          console.warn('Failed to add to tracked_grants:', err);
        }

        // Update local state
        const newSavedProjects = new Set(savedToProjects);
        newSavedProjects.add(projectId);
        setSavedToProjects(newSavedProjects);
      }
    } catch (err) {
      console.error('Error managing saved funder:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleMainButtonClick = () => {
    if (!user || !session) {
      setShowLoginModal(true);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
      return;
    }

    setShowDropdown(!showDropdown);
  };

  const isSavedToAny = savedToProjects.size > 0;

  return (
    <>
      <div className="relative">
        <button
          onClick={handleMainButtonClick}
          disabled={authLoading || isSaving}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors min-h-[44px] min-w-[44px] ${
            isSavedToAny
              ? 'bg-[#238636] text-white hover:bg-[#2ea043]'
              : 'bg-[#1f6feb] text-white hover:bg-[#388bfd]'
          } disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
        >
          {isSavedToAny ? (
            <BookmarkCheck size={16} />
          ) : (
            <Bookmark size={16} />
          )}
          <span>Save</span>
          {(user && session) && (
            <ChevronDown size={14} className={`transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
          )}
        </button>

        {/* Dropdown Menu */}
        {showDropdown && (user && session) && (
          <div className="absolute right-0 mt-2 w-48 bg-[#161b22] border border-[#30363d] rounded-lg shadow-lg z-50">
            {loadingProjects ? (
              <div className="px-4 py-3 text-sm text-gray-400">Loading projects...</div>
            ) : projects.length === 0 ? (
              <div className="px-4 py-3 text-sm text-gray-400">No projects yet. Create one to save funders.</div>
            ) : (
              <div className="py-1">
                {projects.map((project) => {
                  const isSaved = savedToProjects.has(project.id);
                  return (
                    <button
                      key={project.id}
                      onClick={() => handleSaveToProject(project.id)}
                      disabled={isSaving}
                      className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#0d1117] hover:text-white transition-colors flex items-center justify-between disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span>{project.name}</span>
                      {isSaved && <BookmarkCheck size={14} className="text-[#238636]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Dropdown Backdrop */}
        {showDropdown && (user && session) && (
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowDropdown(false)}
          />
        )}
      </div>

      {/* Toast notification for unauthenticated users */}
      {showToast && !showLoginModal && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#161b22] border border-[#30363d] rounded-lg px-4 py-3 shadow-lg text-sm text-gray-300 animate-fade-in">
          Sign in to save funders to your projects
        </div>
      )}
      {/* Login Modal */}
      {showLoginModal && (
        <LoginModal
          onClose={() => setShowLoginModal(false)}
        />
      )}
    </>
  );
};

export default SaveToProjectButton;
