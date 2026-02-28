import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, BookmarkX, Download, ChevronRight, Loader2, LogOut, User as UserIcon } from 'lucide-react';
import { Funder } from '../types';
import { getSavedFunders, unsaveFunder } from '../utils/storage';
import { formatTotalGiving } from '../utils/matching';
import { useAuth } from '../contexts/AuthContext';
import LoginModal from '../components/LoginModal';

export default function SavedFunders() {
  const navigate = useNavigate();
  const { user, signOut, fetchSavedFunders, unsaveFunderFromDB } = useAuth();

  const [saved, setSaved] = useState<Funder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLoginModal, setShowLoginModal] = useState(false);

  useEffect(() => {
    loadSaved();
  }, [user]);

  const loadSaved = async () => {
    setLoading(true);
    if (user) {
      try {
        const funders = await fetchSavedFunders();
        setSaved(funders);
      } catch (e) {
        console.error('Failed to load saved funders from DB:', e);
        // Fall back to localStorage
        setSaved(getSavedFunders());
      }
    } else {
      setSaved(getSavedFunders());
    }
    setLoading(false);
  };

  const remove = async (id: string) => {
    if (user) {
      try {
        await unsaveFunderFromDB(id);
      } catch (e) {
        console.error('Failed to remove from DB:', e);
      }
    } else {
      unsaveFunder(id);
    }
    setSaved(prev => prev.filter(f => f.id !== id));
  };

  const handleSignOut = async () => {
    await signOut();
    setSaved(getSavedFunders()); // switch to local view
  };

  const exportCSV = () => {
    const rows = [
      ['Name', 'Type', 'State', 'Total Giving', 'Contact', 'Email', 'Website', 'Next Step'],
      ...saved.map(f => [
        f.name,
        f.type,
        f.state || '',
        formatTotalGiving(f.total_giving),
        `${f.contact_name || ''} ${f.contact_title ? `(${f.contact_title})` : ''}`.trim(),
        f.contact_email || '',
        f.website || '',
        f.next_step || '',
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'saved-funders.csv';
    a.click();
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Saved Funders</h1>
            {!loading && (
              <p className="text-gray-400 mt-1">{saved.length} funder{saved.length !== 1 ? 's' : ''} saved</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {saved.length > 0 && (
              <button
                onClick={exportCSV}
                className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
              >
                <Download size={16} />
                Export CSV
              </button>
            )}
            {user ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-sm text-gray-400 border border-[#30363d] rounded-xl px-3 py-2">
                  <UserIcon size={14} />
                  <span className="max-w-[140px] truncate">{user.email}</span>
                </div>
                <button
                  onClick={handleSignOut}
                  className="flex items-center gap-2 border border-[#30363d] rounded-xl px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-[#161b22] transition-colors"
                  title="Sign out"
                >
                  <LogOut size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowLoginModal(true)}
                className="flex items-center gap-2 border border-blue-700 text-blue-400 rounded-xl px-4 py-2 text-sm hover:bg-blue-900/20 transition-colors"
              >
                Log in to sync
              </button>
            )}
          </div>
        </div>

        {/* Auth callout for anonymous users who have saved funders */}
        {!user && saved.length > 0 && (
          <div className="mb-6 bg-blue-900/10 border border-blue-800/40 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
            <p className="text-sm text-blue-300">
              Log in to sync your saved funders across all your devices.
            </p>
            <button
              onClick={() => setShowLoginModal(true)}
              className="shrink-0 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl px-4 py-2 transition-colors"
            >
              Log in
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-24">
            <Loader2 size={32} className="animate-spin text-blue-400" />
          </div>
        ) : saved.length === 0 ? (
          <div className="text-center py-24 text-gray-500">
            <p className="text-2xl mb-3">No saved funders yet</p>
            <p className="mb-6">Save funders from your search results to keep track of them here.</p>
            <button
              onClick={() => navigate('/mission')}
              className="bg-white text-gray-900 font-semibold px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors"
            >
              Find Funders
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {saved.map(funder => (
              <div key={funder.id} className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h2 className="text-xl font-bold">{funder.name}</h2>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full capitalize">
                        {funder.type}
                      </span>
                      {funder.state && (
                        <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full">
                          {funder.city ? `${funder.city}, ${funder.state}` : funder.state}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-400 mt-3">
                      {funder.contact_name && (
                        <span>{funder.contact_name}{funder.contact_title ? `, ${funder.contact_title}` : ''}</span>
                      )}
                      {funder.total_giving && (
                        <span className="text-green-400">{formatTotalGiving(funder.total_giving)} in grants</span>
                      )}
                      {funder.contact_email && (
                        <span className="text-blue-400">{funder.contact_email}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <button
                    onClick={() => remove(funder.id)}
                    className="flex items-center gap-2 border border-red-900 text-red-400 rounded-xl px-4 py-2 text-sm hover:bg-red-900/20 transition-colors"
                  >
                    <BookmarkX size={14} />
                    Remove
                  </button>
                  <button
                    onClick={() => navigate(`/funder/${funder.id}`, { state: { funder } })}
                    className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#21262d] transition-colors ml-auto"
                  >
                    View Details
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Login modal */}
      {showLoginModal && (
        <LoginModal onClose={() => setShowLoginModal(false)} />
      )}
    </div>
  );
}
