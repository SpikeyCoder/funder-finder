import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Database } from 'lucide-react';
import OrgSearch from '../components/OrgSearch';
import NavBar from '../components/NavBar';

export default function OrgSearchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';

  useEffect(() => {
    document.title = 'Search Organizations | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Search 460K+ funders and 450K+ grant recipients by name or EIN. Explore 990 giving data.';
  }, []);

  return (
    <>
      <NavBar />
      <main id="main-content" className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-8 transition-colors"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="bg-blue-900/30 border border-blue-800/50 rounded-2xl p-4">
              <Database size={28} className="text-blue-400" />
            </div>
          </div>
          <h1 className="text-3xl font-bold mb-2">Search Organizations</h1>
          <p className="text-gray-400 text-sm max-w-md mx-auto">
            Explore 460,000+ funders and 450,000+ grant recipients. Search by name or EIN to view
            990 giving data, funding trends, and connections.
          </p>
        </div>

        <OrgSearch autoFocus placeholder="Search by organization name or EIN..." initialQuery={initialQuery} />

        <div className="mt-12 grid grid-cols-2 gap-4">
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <p className="text-2xl font-bold text-blue-400">460K+</p>
            <p className="text-xs text-gray-400 mt-1">Funders indexed</p>
          </div>
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <p className="text-2xl font-bold text-green-400">449K+</p>
            <p className="text-xs text-gray-400 mt-1">Grant recipients</p>
          </div>
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <p className="text-2xl font-bold text-purple-400">7.5M+</p>
            <p className="text-xs text-gray-400 mt-1">Individual grants</p>
          </div>
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <p className="text-2xl font-bold text-yellow-400">1.1M+</p>
            <p className="text-xs text-gray-400 mt-1">990 filings</p>
          </div>
        </div>
      </div>
    </main>
    </>
  );
}
