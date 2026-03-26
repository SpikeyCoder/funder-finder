import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';
import {
  Trash2, UserPlus, Shield, Eye, Edit3, Clock, Mail,
  ChevronDown, ChevronRight, Users, FolderOpen, AlertCircle,
  CheckCircle, Loader, X, Search
} from 'lucide-react';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const TEAM_INVITE_URL = `${SUPABASE_URL}/functions/v1/team-invite`;

// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  grant_count: number;
}

interface TeamMember {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  organization_name: string | null;
  role: 'admin' | 'editor' | 'viewer';
  status: string;
  created_at: string;
  project_summary: {
    total: number;
    projects: ProjectSummary[];
  } | null;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROLE_CONFIG = {
  admin: { label: 'Admin', desc: 'Full access to everything', icon: Shield, color: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20' },
  editor: { label: 'Editor', desc: 'Can modify grants, tasks, and projects', icon: Edit3, color: 'text-blue-400', bg: 'bg-blue-400/10 border-blue-400/20' },
  viewer: { label: 'Viewer', desc: 'Read-only access', icon: Eye, color: 'text-gray-400', bg: 'bg-gray-400/10 border-gray-400/20' },
} as const;

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function TeamSettingsPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Invite form
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('editor');
  const [inviting, setInviting] = useState(false);

  // Member actions
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Search filter
  const [searchQuery, setSearchQuery] = useState('');

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadTeam = useCallback(async () => {
    try {
      setIsLoading(true);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(`${TEAM_INVITE_URL}?include_projects=true`, { headers });
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
        setInvitations(data.invitations || []);
      } else {
        const errData = await res.json().catch(() => null);
        setError(errData?.error || 'Failed to load team data');
      }
    } catch (err) {
      console.error('Error loading team:', err);
      setError('Unable to connect. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && user) loadTeam();
  }, [user, loading, loadTeam]);

  // Auto-dismiss messages
  useEffect(() => {
    if (successMsg) {
      const t = setTimeout(() => setSuccessMsg(null), 4000);
      return () => clearTimeout(t);
    }
  }, [successMsg]);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => setError(null), 8000);
      return () => clearTimeout(t);
    }
  }, [error]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    try {
      setInviting(true);
      setError(null);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(TEAM_INVITE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email: inviteEmail.trim().toLowerCase(), role: inviteRole }),
      });
      if (res.ok) {
        setInviteEmail('');
        setShowInviteForm(false);
        setSuccessMsg(`Invitation sent to ${inviteEmail}`);
        loadTeam();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || 'Failed to send invitation');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to send invitation');
    } finally {
      setInviting(false);
    }
  };

  const handleChangeRole = async (memberId: string, newRole: string) => {
    try {
      setActionLoading(true);
      setError(null);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(TEAM_INVITE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ member_id: memberId, role: newRole }),
      });
      if (res.ok) {
        setEditingRole(null);
        setSuccessMsg('Role updated successfully');
        loadTeam();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || 'Failed to update role');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to update role');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      setActionLoading(true);
      setError(null);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(TEAM_INVITE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ member_id: memberId, action: 'remove' }),
      });
      if (res.ok) {
        setRemovingMember(null);
        setSuccessMsg('Team member removed');
        loadTeam();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || 'Failed to remove member');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to remove member');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevokeInvite = async (id: string) => {
    const headers = await getEdgeFunctionHeaders();
    const res = await fetch(`${TEAM_INVITE_URL}?id=${id}`, { method: 'DELETE', headers });
    if (res.ok) {
      setSuccessMsg('Invitation revoked');
      loadTeam();
    }
  };

  // ── Derived data ────────────────────────────────────────────────────────────

  const isCurrentUser = (member: TeamMember) => member.user_id === user?.id;
  const otherMembers = members.filter(m => !isCurrentUser(m));
  const currentUserMember = members.find(m => isCurrentUser(m));
  const totalProjects = members.reduce((sum, m) => sum + (m.project_summary?.total || 0), 0);
  const filteredMembers = searchQuery
    ? otherMembers.filter(m =>
        (m.email?.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (m.display_name?.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : otherMembers;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return null;

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 pt-20 pb-12">

        {/* ─── Header ─── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">Team</h1>
            <p className="text-gray-400 text-sm mt-1">
              Manage your organization's members and see what everyone is working on
            </p>
          </div>
          <button
            onClick={() => setShowInviteForm(!showInviteForm)}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors self-start sm:self-auto"
          >
            <UserPlus size={16} />
            Invite Member
          </button>
        </div>

        {/* ─── Notifications ─── */}
        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-800 rounded-lg flex items-start gap-3">
            <AlertCircle size={18} className="text-red-400 mt-0.5 flex-shrink-0" />
            <p className="text-red-300 text-sm">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-300">
              <X size={16} />
            </button>
          </div>
        )}
        {successMsg && (
          <div className="mb-6 p-4 bg-green-900/20 border border-green-800 rounded-lg flex items-start gap-3">
            <CheckCircle size={18} className="text-green-400 mt-0.5 flex-shrink-0" />
            <p className="text-green-300 text-sm">{successMsg}</p>
          </div>
        )}

        {/* ─── Invite Form ─── */}
        {showInviteForm && (
          <div className="mb-8 bg-[#161b22] border border-[#30363d] rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Invite a team member</h2>
              <button onClick={() => setShowInviteForm(false)} className="text-gray-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-400 mb-5">
              Enter their email address and choose what they can do. They'll get access immediately if they already have an account.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1.5">Email address</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleInvite(); }}
                  placeholder="colleague@organization.org"
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder-gray-500"
                  autoFocus
                />
              </div>
              <div className="sm:w-44">
                <label className="block text-xs text-gray-400 mb-1.5">Role</label>
                <select
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2.5 text-white text-sm"
                >
                  <option value="admin">Admin - full access</option>
                  <option value="editor">Editor - can modify</option>
                  <option value="viewer">Viewer - read only</option>
                </select>
              </div>
              <div className="sm:self-end">
                <button
                  onClick={handleInvite}
                  disabled={!inviteEmail.trim() || inviting}
                  className="w-full sm:w-auto px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {inviting ? <Loader size={14} className="animate-spin" /> : <Mail size={14} />}
                  {inviting ? 'Sending...' : 'Send Invite'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Stats Overview ─── */}
        {!isLoading && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
              <p className="text-2xl font-bold text-white">{members.length}</p>
              <p className="text-xs text-gray-400 mt-1">Team Members</p>
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
              <p className="text-2xl font-bold text-white">{invitations.length}</p>
              <p className="text-xs text-gray-400 mt-1">Pending Invites</p>
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
              <p className="text-2xl font-bold text-white">{totalProjects}</p>
              <p className="text-xs text-gray-400 mt-1">Total Projects</p>
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
              <p className="text-2xl font-bold text-white">
                {members.filter(m => m.role === 'admin').length}
              </p>
              <p className="text-xs text-gray-400 mt-1">Admins</p>
            </div>
          </div>
        )}

        {/* ─── Loading State ─── */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader size={28} className="text-blue-400 animate-spin mb-4" />
            <p className="text-gray-400 text-sm">Loading your team...</p>
          </div>
        )}

        {!isLoading && (
          <>
            {/* ─── Your Account (Owner Card) ─── */}
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Your Account</h2>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 bg-blue-600 rounded-full flex items-center justify-center text-base font-bold flex-shrink-0">
                    {user?.email?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-white truncate">
                      {currentUserMember?.display_name || user?.email?.split('@')[0] || 'You'}
                    </p>
                    <p className="text-sm text-gray-400 truncate">{user?.email}</p>
                  </div>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${ROLE_CONFIG.admin.bg}`}>
                    <Shield size={12} className={ROLE_CONFIG.admin.color} />
                    <span className={ROLE_CONFIG.admin.color}>Owner</span>
                  </div>
                </div>
                {currentUserMember?.project_summary && currentUserMember.project_summary.total > 0 && (
                  <div className="mt-4 pt-4 border-t border-[#30363d]">
                    <p className="text-xs text-gray-400 mb-2">
                      {currentUserMember.project_summary.total} project{currentUserMember.project_summary.total !== 1 ? 's' : ''}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {currentUserMember.project_summary.projects.map(p => (
                        <button
                          key={p.id}
                          onClick={() => navigate(`/projects/${p.id}`)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border border-[#30363d] rounded-md text-xs text-gray-300 hover:text-white hover:border-blue-500/50 transition-colors"
                        >
                          <FolderOpen size={12} className="text-blue-400" />
                          {p.name}
                          {p.grant_count > 0 && (
                            <span className="text-gray-500 ml-1">({p.grant_count} grants)</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ─── Team Members ─── */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  Team Members ({otherMembers.length})
                </h2>
                {otherMembers.length > 3 && (
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="Filter by name or email"
                      className="pl-8 pr-3 py-1.5 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-52"
                    />
                  </div>
                )}
              </div>

              {filteredMembers.length === 0 && otherMembers.length === 0 ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-10 text-center">
                  <Users size={36} className="mx-auto text-gray-600 mb-3" />
                  <p className="text-gray-400 mb-1">No team members yet</p>
                  <p className="text-gray-500 text-sm mb-4">
                    Invite colleagues to collaborate on grant projects
                  </p>
                  <button
                    onClick={() => setShowInviteForm(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
                  >
                    <UserPlus size={14} />
                    Invite Your First Member
                  </button>
                </div>
              ) : filteredMembers.length === 0 && searchQuery ? (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                  <p className="text-gray-400 text-sm">No members matching "{searchQuery}"</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredMembers.map(member => {
                    const roleConf = ROLE_CONFIG[member.role];
                    const RoleIcon = roleConf.icon;
                    const isExpanded = expandedMember === member.id;
                    const isEditingThisRole = editingRole === member.id;
                    const isRemovingThis = removingMember === member.id;

                    return (
                      <div
                        key={member.id}
                        className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden"
                      >
                        {/* Member Row */}
                        <div className="flex items-center gap-3 sm:gap-4 p-4 sm:p-5">
                          {/* Avatar */}
                          <div className="w-10 h-10 bg-[#30363d] rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                            {(member.display_name?.[0] || member.email?.[0] || '?').toUpperCase()}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-white truncate text-sm sm:text-base">
                              {member.display_name || member.email?.split('@')[0]}
                            </p>
                            <p className="text-xs sm:text-sm text-gray-400 truncate">{member.email}</p>
                          </div>

                          {/* Projects count badge */}
                          {member.project_summary && member.project_summary.total > 0 && (
                            <div className="hidden sm:flex items-center gap-1.5 text-xs text-gray-400">
                              <FolderOpen size={12} />
                              {member.project_summary.total} project{member.project_summary.total !== 1 ? 's' : ''}
                            </div>
                          )}

                          {/* Role badge */}
                          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${roleConf.bg}`}>
                            <RoleIcon size={12} className={roleConf.color} />
                            <span className={`${roleConf.color} hidden sm:inline`}>{roleConf.label}</span>
                          </div>

                          {/* Expand/collapse */}
                          <button
                            onClick={() => setExpandedMember(isExpanded ? null : member.id)}
                            className="p-1.5 text-gray-400 hover:text-white transition-colors rounded-md hover:bg-white/[0.06]"
                            title={isExpanded ? 'Collapse' : 'Expand to see details and actions'}
                          >
                            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        </div>

                        {/* Expanded Panel */}
                        {isExpanded && (
                          <div className="border-t border-[#30363d] bg-[#0d1117]/50">
                            {/* Actions row */}
                            <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-[#30363d]">
                              {/* Role editing */}
                              {isEditingThisRole ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-gray-400">Change role to:</span>
                                  {(['admin', 'editor', 'viewer'] as const).map(r => {
                                    const rc = ROLE_CONFIG[r];
                                    const Icon = rc.icon;
                                    return (
                                      <button
                                        key={r}
                                        onClick={() => handleChangeRole(member.id, r)}
                                        disabled={actionLoading || r === member.role}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                                          r === member.role
                                            ? 'border-[#30363d] text-gray-500 cursor-not-allowed opacity-50'
                                            : `${rc.bg} hover:opacity-80 cursor-pointer`
                                        }`}
                                      >
                                        <Icon size={12} className={r === member.role ? 'text-gray-500' : rc.color} />
                                        {rc.label}
                                      </button>
                                    );
                                  })}
                                  <button
                                    onClick={() => setEditingRole(null)}
                                    className="text-xs text-gray-400 hover:text-white ml-1"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setEditingRole(member.id)}
                                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#161b22] border border-[#30363d] rounded-lg text-xs text-gray-300 hover:text-white hover:border-blue-500/50 transition-colors"
                                >
                                  <Edit3 size={12} />
                                  Change Role
                                </button>
                              )}

                              {/* Remove member */}
                              {isRemovingThis ? (
                                <div className="flex items-center gap-2 ml-auto">
                                  <span className="text-xs text-red-300">Remove this member?</span>
                                  <button
                                    onClick={() => handleRemoveMember(member.id)}
                                    disabled={actionLoading}
                                    className="px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded-lg text-xs text-white font-medium transition-colors disabled:opacity-50"
                                  >
                                    {actionLoading ? 'Removing...' : 'Yes, Remove'}
                                  </button>
                                  <button
                                    onClick={() => setRemovingMember(null)}
                                    className="text-xs text-gray-400 hover:text-white"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setRemovingMember(member.id)}
                                  className="flex items-center gap-1.5 px-3 py-1.5 border border-[#30363d] rounded-lg text-xs text-gray-400 hover:text-red-400 hover:border-red-500/30 transition-colors ml-auto"
                                >
                                  <Trash2 size={12} />
                                  Remove
                                </button>
                              )}
                            </div>

                            {/* Project details */}
                            <div className="px-5 py-4">
                              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                                Projects
                              </h4>
                              {member.project_summary && member.project_summary.projects.length > 0 ? (
                                <div className="space-y-2">
                                  {member.project_summary.projects.map(project => (
                                    <button
                                      key={project.id}
                                      onClick={() => navigate(`/projects/${project.id}`)}
                                      className="w-full flex items-center gap-3 p-3 bg-[#161b22] border border-[#30363d] rounded-lg hover:border-blue-500/40 transition-colors text-left group"
                                    >
                                      <FolderOpen size={16} className="text-blue-400 flex-shrink-0" />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm text-white group-hover:text-blue-300 truncate transition-colors">
                                          {project.name}
                                        </p>
                                        <p className="text-xs text-gray-500 mt-0.5">
                                          {project.grant_count} grant{project.grant_count !== 1 ? 's' : ''} tracked
                                          <span className="mx-1.5">|</span>
                                          Updated {timeAgo(project.updated_at)}
                                        </p>
                                      </div>
                                      <ChevronRight size={14} className="text-gray-600 group-hover:text-blue-400 flex-shrink-0 transition-colors" />
                                    </button>
                                  ))}
                                  {member.project_summary.total > 5 && (
                                    <p className="text-xs text-gray-500 text-center pt-1">
                                      + {member.project_summary.total - 5} more project{member.project_summary.total - 5 !== 1 ? 's' : ''}
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <div className="text-center py-4">
                                  <p className="text-sm text-gray-500">No projects yet</p>
                                  <p className="text-xs text-gray-600 mt-1">This member hasn't created any projects</p>
                                </div>
                              )}
                            </div>

                            {/* Member meta */}
                            <div className="px-5 py-3 border-t border-[#30363d] flex items-center gap-4 text-xs text-gray-500">
                              <span>Joined {formatDate(member.created_at)}</span>
                              {member.organization_name && (
                                <span className="truncate">Org: {member.organization_name}</span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ─── Pending Invitations ─── */}
            {invitations.length > 0 && (
              <div className="mb-8">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  Pending Invitations ({invitations.length})
                </h2>
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg divide-y divide-[#30363d]">
                  {invitations.map(inv => {
                    const rc = ROLE_CONFIG[inv.role as keyof typeof ROLE_CONFIG] || ROLE_CONFIG.viewer;
                    const Icon = rc.icon;
                    const isExpired = new Date(inv.expires_at) < new Date();
                    return (
                      <div key={inv.id} className="flex items-center gap-3 sm:gap-4 p-4 sm:p-5">
                        <div className="w-10 h-10 bg-[#30363d] rounded-full flex items-center justify-center flex-shrink-0">
                          <Mail size={16} className="text-gray-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{inv.email}</p>
                          <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                            <Icon size={10} className={rc.color} />
                            <span>{rc.label}</span>
                            <span className="mx-0.5">|</span>
                            {isExpired ? (
                              <span className="text-red-400">Expired</span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <Clock size={10} />
                                Expires {formatDate(inv.expires_at)}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRevokeInvite(inv.id)}
                          className="p-2 text-gray-500 hover:text-red-400 transition-colors rounded-md hover:bg-white/[0.04]"
                          title="Revoke invitation"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ─── Role Permissions Guide ─── */}
            <div>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Role Permissions
              </h2>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <caption className="sr-only">Role permissions comparison</caption>
                  <thead>
                    <tr className="border-b border-[#30363d]">
                      <th scope="col" className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase">Permission</th>
                      <th scope="col" className="text-center px-3 py-3 text-xs font-semibold text-yellow-400 uppercase">Admin</th>
                      <th scope="col" className="text-center px-3 py-3 text-xs font-semibold text-blue-400 uppercase">Editor</th>
                      <th scope="col" className="text-center px-3 py-3 text-xs font-semibold text-gray-400 uppercase">Viewer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#30363d]">
                    {[
                      { perm: 'View projects and grants', admin: true, editor: true, viewer: true },
                      { perm: 'Add and edit grants', admin: true, editor: true, viewer: false },
                      { perm: 'Create projects', admin: true, editor: true, viewer: false },
                      { perm: 'Manage tasks', admin: true, editor: true, viewer: false },
                      { perm: 'Invite team members', admin: true, editor: false, viewer: false },
                      { perm: 'Change member roles', admin: true, editor: false, viewer: false },
                      { perm: 'Remove members', admin: true, editor: false, viewer: false },
                    ].map(row => (
                      <tr key={row.perm}>
                        <td className="px-5 py-2.5 text-gray-300">{row.perm}</td>
                        <td className="text-center px-3 py-2.5">{row.admin ? <CheckCircle size={14} className="inline text-green-400" /> : <X size={14} className="inline text-gray-600" />}</td>
                        <td className="text-center px-3 py-2.5">{row.editor ? <CheckCircle size={14} className="inline text-green-400" /> : <X size={14} className="inline text-gray-600" />}</td>
                        <td className="text-center px-3 py-2.5">{row.viewer ? <CheckCircle size={14} className="inline text-green-400" /> : <X size={14} className="inline text-gray-600" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
