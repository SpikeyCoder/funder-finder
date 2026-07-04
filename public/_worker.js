// Cloudflare Pages advanced-mode Worker for fundermatch.org.
//
// SECURITY (FM-2026-06-26-01): When a Pages project ships a `_worker.js`
// (advanced mode), Cloudflare Pages STOPS processing the `_headers` and
// `_redirects` files — the Worker is fully responsible for the response.
// The previous version of this Worker only handled SPA fallback routing and
// did not emit any of the headers declared in `public/_headers`, so the
// hardened header set (HSTS preload, X-XSS-Protection: 0, the full
// Permissions-Policy deny-list, frame-ancestors 'none', COEP/COOP/CORP, and
// the header-enforced CSP) was silently dropped on the live site and the
// document fell back to weaker Cloudflare-default headers plus the meta-tag
// CSP. This Worker now applies those headers itself so the repo's stated
// security posture is actually enforced at the HTTP layer.
//
// `public/_routes.json` excludes static assets (js/css/images/etc.) from the
// Worker, so this only runs for HTML document / SPA-navigation requests —
// exactly the responses that need these document-scoped security headers.
// The values below are kept in sync with `public/_headers`.

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': [
    'accelerometer=()', 'ambient-light-sensor=()', 'attribution-reporting=()',
    'autoplay=()', 'battery=()', 'bluetooth=()', 'browsing-topics=()',
    'camera=()', 'clipboard-read=()', 'display-capture=()', 'document-domain=()',
    'encrypted-media=()', 'fullscreen=(self)', 'gamepad=()', 'geolocation=()',
    'gyroscope=()', 'hid=()', 'idle-detection=()', 'interest-cohort=()',
    'keyboard-map=()', 'local-fonts=()', 'magnetometer=()', 'microphone=()',
    'midi=()', 'otp-credentials=()', 'payment=()', 'picture-in-picture=(self)',
    'publickey-credentials-create=()', 'publickey-credentials-get=()',
    'screen-wake-lock=()', 'serial=()', 'speaker-selection=()',
    'storage-access=()', 'usb=()', 'web-share=(self)', 'window-management=()',
    'xr-spatial-tracking=()',
  ].join(', '),
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' https://gc.zgo.at",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://tgtotjvdubhjxzybmdex.supabase.co https://accounts.google.com https://fundermatch.goatcounter.com",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self' https://tgtotjvdubhjxzybmdex.supabase.co",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  // Drop fingerprinting headers from upstream where present.
  headers.delete('X-Powered-By');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// SPA routes registered in src/App.tsx. The fallback below serves the app
// shell with HTTP 200 only for these; anything else gets the shell with a
// real 404 status so crawlers stop seeing soft-404s on garbage URLs.
// Keep in sync with the <Routes> table in src/App.tsx.
const SPA_ROUTES = new Set([
  '/', '/mission', '/results', '/saved', '/grant-writer', '/search',
  '/browse', '/login', '/signup', '/dashboard', '/settings',
  '/settings/team', '/settings/team/activity', '/portfolio', '/tasks',
  '/reports', '/applications', '/import', '/privacy', '/contact', '/terms',
]);
const SPA_ROUTE_PREFIXES = [
  '/funder/', '/recipient/', '/projects/', '/onboarding/', '/shared/',
];

function isSpaRoute(pathname) {
  return (
    SPA_ROUTES.has(pathname) ||
    SPA_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Legacy GitHub Pages URLs: the old 404.html hack encoded deep links as
    // /?/path (with '&' escaped to '~and~'). Restore them with a permanent
    // redirect so any such URLs lingering in search indexes consolidate onto
    // the real route. Replaces the inline decoder script formerly in
    // index.html.
    if (url.pathname === '/' && url.search.startsWith('?/')) {
      const decoded = url.search
        .slice(1)
        .split('&')
        .map((s) => s.replace(/~and~/g, '&'))
        .join('?');
      // '//' would be a protocol-relative external URL — refuse to redirect
      // off-origin.
      if (decoded.startsWith('/') && !decoded.startsWith('//')) {
        return Response.redirect(url.origin + decoded, 301);
      }
    }

    const response = await env.ASSETS.fetch(request);

    // If the asset exists (JS, CSS, images, prerendered pages, etc.),
    // return it with headers.
    if (response.status !== 404) return withSecurityHeaders(response);

    // Normalize trailing slashes on SPA routes (/mission/ → /mission) so
    // each route has a single indexable URL. Prerendered directory pages
    // (e.g. /grants-for-nonprofits/) never reach this branch — ASSETS
    // serves them above.
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      const trimmed = url.pathname.replace(/\/+$/, '') || '/';
      return Response.redirect(url.origin + trimmed + url.search, 301);
    }

    // SPA fallback: serve index.html — 200 for registered app routes,
    // 404 for everything else (React renders the NotFound page, but
    // crawlers get an honest status instead of a soft-404).
    const indexResponse = await env.ASSETS.fetch(
      new Request(new URL('/', url.origin), request),
    );
    return withSecurityHeaders(
      new Response(indexResponse.body, {
        status: isSpaRoute(url.pathname) ? 200 : 404,
        headers: indexResponse.headers,
      }),
    );
  },
};
