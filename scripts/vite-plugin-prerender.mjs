/**
 * vite-plugin-prerender — assembles static prerendered pages at build time.
 *
 * Runs in `closeBundle`, AFTER Vite has written dist/index.html (the shell, with
 * current hashed asset tags) and copied public/ into dist/. For each route in
 * the prerender manifest it stitches together:
 *
 *     freshly-built shell  +  per-route <head> SEO (manifest)  +  body fragment
 *
 * and writes dist/<dir>/index.html. Because the shell is read fresh every build,
 * the injected <script>/<link> asset references never go stale — so the built
 * pages both (a) show real content to no-JS crawlers and (b) still boot the SPA
 * for real browsers. No headless browser is needed here; the browser only runs
 * offline in `npm run prerender` to (re)generate the committed body fragments.
 *
 * This is pure string assembly and runs in any build environment (GitHub
 * Actions, Cloudflare Pages, local), which is what makes the output guaranteed
 * to ship regardless of deploy host.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, ORIGIN_URL } from '../prerender/manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BODIES_DIR = join(ROOT, 'prerender', 'bodies');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Replace the first match of `re` with `tag`, or insert `tag` before </head>. */
function upsert(html, re, tag) {
  return re.test(html) ? html.replace(re, tag) : html.replace('</head>', `    ${tag}\n  </head>`);
}

function applyHead(html, r) {
  const canonical = r.route === '/' ? `${ORIGIN_URL}/` : `${ORIGIN_URL}${r.route}`;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(r.title)}</title>`);
  html = upsert(html, /<meta\s+name="description"[^>]*>/, `<meta name="description" content="${esc(r.description)}" />`);
  html = upsert(html, /<link\s+rel="canonical"[^>]*>/, `<link rel="canonical" href="${canonical}" />`);
  html = upsert(html, /<meta\s+property="og:url"[^>]*>/, `<meta property="og:url" content="${canonical}" />`);
  html = upsert(html, /<meta\s+property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(r.title)}" />`);
  html = upsert(html, /<meta\s+property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(r.description)}" />`);
  html = upsert(html, /<meta\s+name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${esc(r.title)}" />`);
  html = upsert(html, /<meta\s+name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${esc(r.description)}" />`);

  // Replace the shell's homepage JSON-LD (WebApplication/FAQPage) with this
  // route's own structured data so subpages don't inherit home-specific schema.
  html = html.replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  if (r.jsonld) {
    const block = `    <script type="application/ld+json">\n${JSON.stringify(r.jsonld, null, 2)}\n    </script>\n`;
    html = html.replace('</head>', `${block}  </head>`);
  }
  return html;
}

function injectBody(html, body) {
  if (!/<div id="root">\s*<\/div>/.test(html)) {
    throw new Error('prerender: could not find empty <div id="root"></div> in shell — Vite output changed');
  }
  return html.replace(/<div id="root">\s*<\/div>/, `<div id="root">${body}</div>`);
}

export default function prerenderPlugin() {
  return {
    name: 'fundermatch-prerender',
    apply: 'build',
    closeBundle() {
      const distDir = join(ROOT, 'dist');
      const shellPath = join(distDir, 'index.html');
      if (!existsSync(shellPath)) return; // nothing built (e.g. lib mode) — no-op
      const shell = readFileSync(shellPath, 'utf8');

      let written = 0;
      const skipped = [];
      for (const r of ROUTES) {
        const fragPath = join(BODIES_DIR, `${r.slug}.html`);
        if (!existsSync(fragPath)) {
          // Missing fragment → leave the route on the SPA fallback (status quo,
          // no regression). Regenerate with `npm run prerender`.
          skipped.push(r.route);
          continue;
        }
        const body = readFileSync(fragPath, 'utf8').trim();

        let html = injectBody(shell, body);
        if (r.headManaged !== false) html = applyHead(html, r);

        const outDir = join(distDir, r.dir);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.html'), html, 'utf8');
        written++;
      }

      const suffix = skipped.length ? ` (skipped, no fragment: ${skipped.join(', ')})` : '';
      this.warn?.(`prerendered ${written}/${ROUTES.length} route(s)${suffix}`);
      // eslint-disable-next-line no-console
      console.log(`\n✓ prerender plugin: wrote ${written}/${ROUTES.length} route page(s)${suffix}`);
    },
  };
}
