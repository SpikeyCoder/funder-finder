import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';

export default function NotFound() {
  useEffect(() => {
    document.title = 'Page Not Found | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'The page you’re looking for doesn’t exist on FunderMatch.';

    // SEO: tell crawlers not to index unknown SPA routes. Because fundermatch.org
    // is hosted on GitHub Pages, every unknown path resolves to index.html with
    // HTTP 200 and renders this <NotFound /> component client-side. Without an
    // explicit "noindex, nofollow" hint, search engines may pick up arbitrary
    // garbage paths as valid pages. We toggle the meta tag on mount and reset
    // it on unmount so that real routes the user navigates to next aren't
    // accidentally suppressed.
    // (Audit fix: FM-A11Y/SEO 2026-05-18.)
    const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    let injected: HTMLMetaElement | null = null;
    const previousContent = existing ? existing.content : null;
    if (existing) {
      existing.content = 'noindex, nofollow';
    } else {
      injected = document.createElement('meta');
      injected.name = 'robots';
      injected.content = 'noindex, nofollow';
      document.head.appendChild(injected);
    }

    return () => {
      if (injected && injected.parentNode) {
        injected.parentNode.removeChild(injected);
      } else if (existing) {
        if (previousContent === null) {
          existing.parentNode?.removeChild(existing);
        } else {
          existing.content = previousContent;
        }
      }
    };
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
