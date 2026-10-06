import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Key, ExternalLink } from 'lucide-react';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

const OPENAPI_SPEC_URL =
  'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/public-api/openapi.json';

export default function ApiDocsPage() {
  const swaggerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    document.title = 'API Documentation | FunderMatch';
  }, []);

  // Swagger UI is self-hosted (swagger-ui-dist) and code-split, so its ~1.5 MB
  // only loads on this page and runs under the site's script-src 'self' CSP —
  // no third-party CDN script and no iframe (frame-src stays 'none').
  useEffect(() => {
    let cancelled = false;
    Promise.all([import('swagger-ui-dist/swagger-ui-bundle.js'), import('swagger-ui-dist/swagger-ui.css')])
      .then(([{ default: SwaggerUIBundle }]) => {
        if (cancelled || !swaggerRef.current) return;
        SwaggerUIBundle({
          url: OPENAPI_SPEC_URL,
          domNode: swaggerRef.current,
          deepLinking: true,
          docExpansion: 'list',
          defaultModelsExpandDepth: -1,
          tryItOutEnabled: true,
          persistAuthorization: true,
          filter: true,
        });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      <NavBar />

      <main id="main-content" className="flex-1 flex flex-col">
        {/* Intro header */}
        <div className="px-6 pt-16 pb-8 max-w-5xl mx-auto w-full">
          <div className="flex items-center gap-3 mb-4">
            <BookOpen className="w-8 h-8 text-blue-400" />
            <h1 className="text-3xl font-bold tracking-tight">API Documentation</h1>
          </div>
          <p className="text-gray-400 max-w-2xl mb-6">
            Integrate FunderMatch data into your own tools. The REST API lets you
            search funders, retrieve funder profiles, and access matching scores
            programmatically.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link
              to="/settings"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
            >
              <Key size={16} />
              Get an API Key
            </Link>
            <a
              href={OPENAPI_SPEC_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[#30363d] text-gray-300 hover:text-white hover:border-gray-500 text-sm font-medium transition-colors"
            >
              <ExternalLink size={16} />
              Raw OpenAPI Spec
            </a>
          </div>
        </div>

        {/* Swagger UI */}
        <div className="flex-1 px-4 pb-8 max-w-[1400px] mx-auto w-full">
          <div className="rounded-xl overflow-hidden border border-[#30363d] bg-white text-gray-900 min-h-[60vh]">
            {loadError ? (
              <p className="p-6 text-sm">
                The interactive reference failed to load. You can still use the{' '}
                <a href={OPENAPI_SPEC_URL} className="underline" target="_blank" rel="noopener noreferrer">
                  raw OpenAPI spec
                </a>
                .
              </p>
            ) : (
              <div ref={swaggerRef} aria-label="FunderMatch API Reference" />
            )}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

