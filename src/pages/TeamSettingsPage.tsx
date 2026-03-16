import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';
import { Trash2, UserPlus, Shield, Eye, Edit3, Clock, Mail } from 'lucide-react';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const TEAM_INVITE_URL = `${SUPABASE_URL}/functions/v1/team-invite`;

interface TeamMember {
  id: string;
  user_id: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  status: string;
  created_at: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
}

export default function TeamSettingsPage() {
  const { user, loading } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('editor');
  const [isLoading, setIsLoading] = useState(true);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) loadTeam();
  }, [user, loading]);

  const loadTeam = async () => {
    try {
      setIsLoading(true);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(TEAM_INVITE_URL, { headers });
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
        setInvitations(data.invitations || []);
      }
    } catch (err) {
      console.error('Error loading team:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    try {
      setError(null);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(TEAM_INVITE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (res.ok) {
        setInviteEmail('');
        setShowInviteForm(false);
        setSuccessMsg(`Invitation sent to ${inviteEmail}`);
        setTimeout(() => setSuccessMsg(null), 3000);
        loadTeam();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to send invitation');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRevokeInvite = async (id: string) => {
    const headers = await getEdgeFunctionHeaders();
    await fetch(`${TEAM_INVITE_URL}?id=${id}`, { method: 'DELETE', headers });
    loadTeam();
  };

  const roleIcon = (role: string) => {
    switch (role) {
      case 'admin': return <Shield size={14} className="text-yellow-400" />;
      case 'editor': return <Edit3 size={14} className="text-blue-400" />;
      case 'viewer': return <Eye size={14} className="text-gray-400" />;
      default: return null;
    }
  };

  if (loading) return null;

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Team Management</h1>
            <p className="text-gray-400 text-sm mt-1">Invite members and manage roles</p>
          </div>
          <button onClick={() => setShowInviteForm(!showInviteForm)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm transition-colors">
            <UserPlus size={16} /> Invite Member
          </button>
        </div>

        {error && <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">{error}</div>}
        {successMsg && <div className="mb-4 p-3 bg-green-900/30 border border-green-800 rounded-lg text-green-400 text-sm">{successMsg}</div>}

        {showInviteForm && (
          <div className="mb-6 p-4 bg-[#161b22] border border-[#30363d] rounded-lg">
            <h3 className="text-sm font-semibold mb-3">Send Invitation</h3>
            <div className="flex gap-3">
              <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                placeholder="colleague@organization.org"
                className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm">
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              <button onClick={handleInvite} disabled={!inviteEmail.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm transition-colors">
                Send
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer mt-3">
              <input type="checkbox" className="w-4 h-4 rounded bg-[#0d1117] border border-[#30363d] text-blue-600 cursor-pointer" />
              Restrict to assigned projects only
            </label>
            <p className="text-xs text-gray-500 mt-2">Admin: full access. Editor: can modify grants/tasks. Viewer: read-only access.</p>
          </div>
        )}

        {/* Active Members */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Members</h2>
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg divide-y divide-[#30363d]">
            {/* Current user (always admin/owner) */}
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-sm font-bold">
                  {user?.email?.[0]?.toUpperCase() || '?'}
                </div>
                <div>
                  <p className="text-sm text-white">{user?.email}</p>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Shield size={10} className="text-yellow-400" /> Owner
                  </div>
                </div>
              </div>
              <span className="text-xs text-gray-500">You</span>
            </div>
            {members.filter(m => m.user_id !== user?.id).map(member => (
              <div key={member.id} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-[#30363d] rounded-full flex items-center justify-center text-sm">
                    {member.email?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div>
                    <p className="text-sm text-white">{member.email}</p>
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      {roleIcon(member.role)} {member.role}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {isLoading && <div className="p-4 text-center text-gray-500 text-sm">Loading...</div>}
          </div>
        </div>

        {/* Pending Invitations */}
        {invitations.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-3">Pending Invitations</h2>
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg divide-y divide-[#30363d]">
              {invitations.map(inv => (
                <div key={inv.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Mail size={16} className="text-gray-500" />
                    <div>
                      <p className="text-sm text-white">{inv.email}</p>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        {roleIcon(inv.role)} {inv.role}
                        <span className="flex items-center gap-1"><Clock size={10} /> Expires {new Date(inv.expires_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => handleRevokeInvite(inv.id)}
                    className="text-gray-500 hover:text-red-400 transition-colors">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Activity Log placeholder */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-3">Activity Log</h2>
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6 text-center text-gray-500 text-sm">
            Activity tracking will appear here as team members access shared resources.
          </div>
        </div>
      </main>
    </div>
  );
}
