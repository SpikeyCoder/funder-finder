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
    "script-src 'self' 'sha256-9Jn/cnXgKbJ7J7q33fTfvOmHEa+5yzYGzkbavQwjgws=' https://gc.zgo.at",
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);

    // If the asset exists (JS, CSS, images, etc.), return it with headers.
    if (response.status !== 404) return withSecurityHeaders(response);

    // For 404s, serve index.html with 200 status (SPA routing).
    const indexResponse = await env.ASSETS.fetch(
      new Request(new URL('/', url.origin), request),
    );
    return withSecurityHeaders(
      new Response(indexResponse.body, {
        status: 200,
        headers: indexResponse.headers,
      }),
    );
  },
};
