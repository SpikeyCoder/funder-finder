import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Database } from 'lucide-react';
import OrgSearch from '../components/OrgSearch';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
];

// The state picked last time, a convenience only (storage can be unavailable).
const STATE_KEY = 'orgSearch.state';
function savedState(): string {
  try {
    const s = localStorage.getItem(STATE_KEY) ?? '';
    return US_STATES.includes(s) ? s : '';
  } catch {
    return '';
  }
}

export default function OrgSearchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';
  // Many organizations share a name (YMCA, Habitat for Humanity chapters);
  // those in this state are listed first.
  const [state, setState] = useState(savedState);
  const pickState = (s: string) => {
    setState(s);
    try {
      if (s) localStorage.setItem(STATE_KEY, s);
      else localStorage.removeItem(STATE_KEY);
    } catch {
      // Not remembered; it still applies now.
    }
  };

  useEffect(() => {
    document.title = 'Search Organizations | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Search 300K+ funders and 640K+ nonprofits by name or EIN. Explore 990 giving data.';
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
            Explore 300,000+ funders and 640,000+ nonprofits. Search by name or EIN to view
            990 giving data, funding trends, and connections.
          </p>
        </div>

        <div className="mb-3 flex items-center justify-end gap-2 text-sm text-gray-400">
          <label htmlFor="org-search-state">List first from</label>
          <select
            id="org-search-state"
            value={state}
            onChange={(e) => pickState(e.target.value)}
            className="bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1 text-white focus:outline-hidden focus:border-blue-500"
          >
            <option value="">Any state</option>
            {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <OrgSearch autoFocus placeholder="Search by organization name or EIN..." initialQuery={initialQuery} state={state} />

        <div className="mt-12 grid grid-cols-2 gap-4">
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <p className="text-2xl font-bold text-blue-400">300K+</p>
            <p className="text-xs text-gray-400 mt-1">Funders indexed</p>
          </div>
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <p className="text-2xl font-bold text-green-400">640K+</p>
            <p className="text-xs text-gray-400 mt-1">Nonprofits</p>
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
      <Footer />
    </>
  );
}
