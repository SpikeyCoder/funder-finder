import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import NavBar from '../components/NavBar';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SHARE_LINK_URL = `${SUPABASE_URL}/functions/v1/share-link`;

interface SharedGrant {
  id: string;
  funder_name: string;
  grant_title: string | null;
  deadline: string | null;
  awarded_amount: number | null;
  pipeline_statuses: { name: string; color: string } | null;
}

export default function SharedViewPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) loadSharedData();
  }, [token]);

  const loadSharedData = async () => {
    try {
      const res = await fetch(`${SHARE_LINK_URL}?token=${token}`);
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || 'Unable to load shared data');
        return;
      }
      setData(await res.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
        <div className="text-gray-400">Loading shared view...</div>
      </div>
    </>
  );

  if (error) return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2">Unable to Access</h1>
          <p className="text-gray-400">{error}</p>
          <a href="https://fundermatch.org" className="text-blue-400 hover:underline mt-4 inline-block">Go to FunderMatch</a>
        </div>
      </div>
    </>
  );

  const grants: SharedGrant[] = data?.grants || [];

  return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] text-white">
      <header className="border-b border-[#30363d] bg-[#161b22]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-blue-400">FunderMatch</h1>
            <p className="text-xs text-gray-500">Shared View (Read Only)</p>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-6xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h2 className="text-xl font-bold">{data?.project?.name || 'Shared Project'}</h2>
          {data?.project?.description && <p className="text-gray-400 text-sm mt-1">{data.project.description}</p>}
          <p className="text-xs text-gray-500 mt-2">{grants.length} grants tracked</p>
        </div>

        <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#0d1117]">
              <tr className="text-gray-400 text-xs">
                <th className="text-left p-3">Funder / Grant</th>
                <th className="text-left p-3">Status</th>
                <th className="text-right p-3">Amount</th>
                <th className="text-left p-3">Deadline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#30363d]">
              {grants.map(grant => (
                <tr key={grant.id}>
                  <td className="p-3">
                    <p className="font-medium text-white">{grant.funder_name}</p>
                    {grant.grant_title && <p className="text-xs text-gray-500">{grant.grant_title}</p>}
                  </td>
                  <td className="p-3">
                    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
                      style={{ backgroundColor: (grant.pipeline_statuses?.color || '#30363d') + '20', color: grant.pipeline_statuses?.color || '#9ca3af' }}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: grant.pipeline_statuses?.color || '#9ca3af' }} />
                      {grant.pipeline_statuses?.name || 'Unknown'}
                    </span>
                  </td>
                  <td className="p-3 text-right text-white">
                    {grant.awarded_amount ? `$${grant.awarded_amount.toLocaleString()}` : '—'}
                  </td>
                  <td className="p-3 text-gray-400">
                    {grant.deadline ? new Date(grant.deadline).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
              {grants.length === 0 && (
                <tr><td colSpan={4} className="p-6 text-center text-gray-500">No grants to display</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-center text-xs text-gray-600 mt-8">
          Powered by <a href="https://fundermatch.org" className="text-blue-400 hover:underline">FunderMatch</a>
        </p>
      </main>
    </div>
    </>
  );
}
