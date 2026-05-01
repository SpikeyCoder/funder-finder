import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';

export default function NotFound() {
  useEffect(() => {
    document.title = 'Page Not Found | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'The page you’re looking for doesn’t exist on FunderMatch.';
  }, []);

  const navigate = useNavigate();
  return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-6xl font-bold text-gray-400 mb-4">404</h1>
          <p className="text-xl text-gray-400 mb-8">Page not found</p>
          <button
            onClick={() => navigate('/')}
            className="bg-white text-gray-900 font-semibold px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors"
          >
            Go Home
          </button>
        </div>
      </div>
    </>
  );
}
