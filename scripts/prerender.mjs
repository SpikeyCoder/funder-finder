#!/usr/bin/env node
/**
 * prerender.mjs — offline content generator for static prerendering.
 *
 * WHY THIS EXISTS
 * ---------------
 * fundermatch.org is a client-rendered SPA: the shell HTML ships an empty
 * <div id="root">, so crawlers and AI/LLM agents that don't execute JS see no
 * content. The existing hand-authored landing pages (public/foundation-grants,
 * …) fix this for a handful of marketing URLs. This script extends the same
 * "static prerender" idea to the app's remaining PUBLIC routes without an SSR
 * rewrite: it renders each route in a real headless browser and captures the
 * rendered <div id="root"> markup.
 *
 * The captured markup is written to prerender/bodies/<slug>.html and COMMITTED.
 * At `vite build` time, scripts/vite-plugin-prerender.mjs stitches each fragment
 * into a full page using the freshly built shell (so asset hashes are always
 * current). That means the deploy build needs NO browser — this script is only
 * re-run by a developer when the rendered content of a page changes:
 *
 *     npm run prerender
 *
 * Determinism: all cross-origin requests (Supabase, Google Fonts, analytics) are
 * blocked, so pages render their signed-out static shell with no network, no
 * secrets, and no run-to-run variation.
 */
import http from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ROUTES } from '../prerender/manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BODIES_DIR = join(ROOT, 'prerender', 'bodies');
const PORT = 5188;

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

/** Serve dist/ with SPA fallback so any route boots the app and client-routes. */
function startServer() {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let fp = join(DIST, path);
    if (existsSync(fp) && statSync(fp).isDirectory()) fp = join(fp, 'index.html');
    if (!existsSync(fp)) fp = join(DIST, 'index.html'); // SPA fallback
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(readFileSync(fp));
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function renderRoute(browser, route) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Only same-origin (the local dist server) is allowed; everything else
    // (Supabase, fonts, analytics) is blocked for a deterministic render.
    if (new URL(req.url()).host === `localhost:${PORT}`) req.continue();
    else req.abort();
  });

  const url = `http://localhost:${PORT}${route}`;
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
  // Wait for the route's real content to mount (an <h1> anywhere in the app).
  await page.waitForSelector('h1', { timeout: 10000 });

  const { finalPath, body } = await page.evaluate(() => ({
    finalPath: window.location.pathname,
    body: document.getElementById('root')?.innerHTML ?? '',
  }));

  await page.close();

  // Guard against silently capturing a redirect target (e.g. a route that
  // bounces to /saved or /login). The rendered path must match the request.
  if (finalPath !== route) {
    throw new Error(`route ${route} redirected to ${finalPath}; remove it from the manifest or fix the route`);
  }
  return body;
}

async function main() {
  console.log('› Building app (so captured content + asset graph are current)…');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

  if (!existsSync(BODIES_DIR)) mkdirSync(BODIES_DIR, { recursive: true });

  const server = await startServer();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  let ok = 0;
  try {
    for (const r of ROUTES) {
      const body = await renderRoute(browser, r.route);
      const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 300) {
        throw new Error(`route ${r.route} rendered thin content (${text.length} chars); aborting so we never commit an empty fragment`);
      }
      // Cross-origin is blocked for determinism, so a route that fetches data on
      // mount renders a failure state. Reject it rather than baking an error
      // message into a committed page — such a route belongs in EXCLUDED_ROUTES.
      if (/Failed to fetch|Something went wrong|Please try again/i.test(text)) {
        throw new Error(`route ${r.route} rendered a data-fetch error state; it needs live data and should not be prerendered (move it to EXCLUDED_ROUTES)`);
      }
      const out = join(BODIES_DIR, `${r.slug}.html`);
      writeFileSync(out, body.trim() + '\n', 'utf8');
      console.log(`  ✓ ${r.route.padEnd(12)} → prerender/bodies/${r.slug}.html (${text.length} chars of copy)`);
      ok++;
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n✓ Prerendered ${ok}/${ROUTES.length} routes. Re-run \`npm run build\` to stitch them into dist/.`);
}

main().catch((err) => {
  console.error('✗ prerender failed:', err.message);
  process.exit(1);
});
