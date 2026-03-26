import { useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <div className="flex items-center justify-center" style={{ minHeight: 'calc(100vh - 64px)' }}>
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
    </div>
  );
}
