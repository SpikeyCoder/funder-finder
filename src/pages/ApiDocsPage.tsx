import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Key, ExternalLink } from 'lucide-react';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

const OPENAPI_SPEC_URL =
  'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/public-api/openapi.json';

/**
 * Builds a self-contained HTML page that loads Swagger UI from the unpkg CDN
 * and points it at the FunderMatch OpenAPI spec.
 *
 * Rendered inside a sandboxed iframe so the Swagger UI CSS/JS never touches
 * the host page and we avoid pulling the 1.5 MB swagger-ui-react package
 * into the Vite bundle.
 */
function buildSwaggerHtml(): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8"/>',
    '<title>FunderMatch API</title>',
    '<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>',
    '<style>',
    'html,body{margin:0;padding:0;background:#fff}',
    '.swagger-ui .topbar{display:none}',
    '.swagger-ui .info hgroup.main a{display:none}',
    '</style>',
    '</head>',
    '<body>',
    '<div id="swagger-ui"></div>',
    '<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"><\/script>',
    '<script>',
    'SwaggerUIBundle({',
    `  url:"${OPENAPI_SPEC_URL}",`,
    '  dom_id:"#swagger-ui",',
    '  deepLinking:true,',
    '  docExpansion:"list",',
    '  defaultModelsExpandDepth:-1,',
    '  tryItOutEnabled:true,',
    '  persistAuthorization:true,',
    '  filter:true',
    '});',
    '<\/script>',
    '</body>',
    '</html>',
  ].join('\n');
}

export default function ApiDocsPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    document.title = 'API Documentation | FunderMatch';
  }, []);

  // Use a blob URL so the iframe has a proper origin and can fetch external
  // resources.  A data: URI would be treated as an opaque origin by the
  // browser, blocking the Swagger UI network requests.
  useEffect(() => {
    const blob = new Blob([buildSwaggerHtml()], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    if (iframeRef.current) {
      iframeRef.current.src = url;
    }
    return () => URL.revokeObjectURL(url);
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

        {/* Swagger UI iframe */}
        <div className="flex-1 px-4 pb-8 max-w-[1400px] mx-auto w-full">
          <div className="rounded-xl overflow-hidden border border-[#30363d] bg-white">
            <iframe
              ref={iframeRef}
              title="FunderMatch API Reference"
              className="w-full border-0"
              style={{ minHeight: 'calc(100vh - 120px)' }}
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
