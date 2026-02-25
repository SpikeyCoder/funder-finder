import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, BookmarkX, Download, ChevronRight } from 'lucide-react';
import { funders } from '../data/funders';
import { Funder } from '../types';
import { getSavedIds, unsaveFunder } from '../utils/storage';

export default function SavedFunders() {
  const navigate = useNavigate();
  const [saved, setSaved] = useState<Funder[]>([]);

  useEffect(() => {
    const ids = getSavedIds();
    setSaved(funders.filter(f => ids.includes(f.id)));
  }, []);

  const remove = (id: string) => {
    unsaveFunder(id);
    setSaved(prev => prev.filter(f => f.id !== id));
  };

  const exportCSV = () => {
    const rows = [
      ['Name', 'Type', 'Contact', 'Email', 'Phone', 'Location', 'Website', 'Next Step'],
      ...saved.map(f => [f.name, f.type, `${f.contact} (${f.title})`, f.email, f.phone, f.location, f.website, f.nextStep]),
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
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
            <p className="text-gray-400 mt-1">{saved.length} funder{saved.length !== 1 ? 's' : ''} saved</p>
          </div>
          {saved.length > 0 && (
            <button
              onClick={exportCSV}
              className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
            >
              <Download size={16} />
              Export CSV
            </button>
          )}
        </div>

        {saved.length === 0 ? (
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
                    <span className="inline-block mt-1 bg-[#21262d] border border-[#30363d] text-gray-300 text-xs px-3 py-1 rounded-full">
                      {funder.type}
                    </span>
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-400 mt-3">
                      <span>{funder.contact}, {funder.title}</span>
                      <span>{funder.location}</span>
                      <span className="text-blue-400">{funder.email}</span>
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
                    onClick={() => navigate(`/funder/${funder.id}`)}
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
    </div>
  );
}
