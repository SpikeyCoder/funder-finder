import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, BookmarkCheck, ChevronRight, Copy, Download } from 'lucide-react';
import { findMatches, getMatchingTags } from '../utils/matching';
import { Funder } from '../types';
import { getSavedIds, saveFunder, unsaveFunder } from '../utils/storage';

export default function Results() {
  const location = useLocation();
  const navigate = useNavigate();
  const { mission = '', keywords = [] } = location.state || {};
  const [matches, setMatches] = useState<Funder[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setMatches(findMatches(mission, keywords));
    setSavedIds(getSavedIds());
  }, [mission, keywords]);

  const toggleSave = (id: string) => {
    if (savedIds.includes(id)) {
      unsaveFunder(id);
      setSavedIds(prev => prev.filter(i => i !== id));
    } else {
      saveFunder(id);
      setSavedIds(prev => [...prev, id]);
    }
  };

  const copyEmail = (email: string, id: string) => {
    navigator.clipboard.writeText(email);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const exportCSV = () => {
    const rows = [
      ['Rank', 'Name', 'Type', 'Contact', 'Email', 'Phone', 'Location', 'Website', 'Next Step'],
      ...matches.map((f, i) => [
        i + 1, f.name, f.type, `${f.contact} (${f.title})`, f.email, f.phone, f.location, f.website, f.nextStep,
      ]),
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'funder-matches.csv';
    a.click();
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold">Your Funder Matches</h1>
            <p className="text-gray-400 mt-1">Found {matches.length} funders aligned with your mission</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => navigate('/saved')}
              className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
            >
              <Bookmark size={16} />
              Saved ({savedIds.length})
            </button>
            <button
              onClick={exportCSV}
              className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
            >
              <Download size={16} />
              Export
            </button>
          </div>
        </div>

        <button
          onClick={() => navigate('/mission')}
          className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-8 transition-colors"
        >
          <ArrowLeft size={16} />
          Update Search
        </button>

        {/* Funder Cards */}
        <div className="space-y-6">
          {matches.map((funder, index) => {
            const matchTags = getMatchingTags(funder, keywords, mission);
            const isSaved = savedIds.includes(funder.id);
            return (
              <div key={funder.id} className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">
                <div className="flex items-start gap-3 mb-3">
                  <span className="text-blue-400 font-bold text-lg">#{index + 1}</span>
                  <div>
                    <h2 className="text-xl font-bold">{funder.name}</h2>
                    <span className="inline-block mt-1 bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full">
                      {funder.type}
                    </span>
                  </div>
                </div>

                <p className="text-gray-300 text-sm mb-4">{funder.description}</p>

                {matchTags.length > 0 && (
                  <div className="mb-4">
                    <p className="text-sm font-semibold mb-2">Mission alignment:</p>
                    <div className="flex flex-wrap gap-2">
                      {matchTags.map(tag => (
                        <span key={tag} className="bg-[#21262d] text-gray-300 text-xs px-3 py-1 rounded-full">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm text-gray-400 mb-4">
                  <span><strong className="text-white">Contact:</strong> {funder.contact}, {funder.title}</span>
                  <span><strong className="text-white">Location:</strong> {funder.location}</span>
                </div>

                <div className="bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mb-4 text-sm">
                  <span className="text-gray-400">Best next step: </span>
                  <span className="text-blue-400">{funder.nextStep}</span>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => copyEmail(funder.email, funder.id)}
                    className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#21262d] transition-colors"
                  >
                    <Copy size={14} />
                    {copied === funder.id ? 'Copied!' : 'Copy Email'}
                  </button>
                  <button
                    onClick={() => toggleSave(funder.id)}
                    className={`flex items-center gap-2 border rounded-xl px-4 py-2 text-sm transition-colors ${isSaved ? 'border-blue-600 text-blue-400 bg-blue-900/20' : 'border-[#30363d] hover:bg-[#21262d]'}`}
                  >
                    {isSaved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
                    {isSaved ? 'Saved' : 'Save'}
                  </button>
                  <button
                    onClick={() => navigate(`/funder/${funder.id}`, { state: { mission, keywords } })}
                    className="flex items-center gap-2 bg-white text-gray-900 font-semibold rounded-xl px-4 py-2 text-sm hover:bg-gray-100 transition-colors ml-auto"
                  >
                    View Details
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
