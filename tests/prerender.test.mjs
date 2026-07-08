/**
 * Prerender coverage tests.
 *
 * These assert that the BUILT output (dist/<dir>/index.html) for every public
 * route in the prerender manifest contains real, crawler-visible content —
 * matching the quality bar of the existing hand-authored landing pages
 * (public/foundation-grants, etc.): a non-empty <h1>, per-route <title> and
 * meta description, a canonical link, Open Graph tags, JSON-LD structured data,
 * and a meaningful amount of body copy.
 *
 * Run AFTER `npm run build` (the build injects the committed body fragments via
 * the prerender Vite plugin). With no fragments/plugin in place, dist/<dir>/
 * index.html does not exist and every assertion fails — which is the intended
 * red state for TDD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ROUTES, ORIGIN_URL } from '../prerender/manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Absolute canonical URL for a route (root normalises to a single trailing slash). */
function canonicalFor(route) {
  return route === '/' ? `${ORIGIN_URL}/` : `${ORIGIN_URL}${route}`;
}

function loadRoute(dir) {
  const file = join(DIST, dir, 'index.html');
  assert.ok(existsSync(file), `expected built page at dist/${join(dir, 'index.html')} — run \`npm run build\` first`);
  const html = readFileSync(file, 'utf8');
  return { html, doc: new JSDOM(html).window.document };
}

function metaContent(doc, selector) {
  const el = doc.querySelector(selector);
  return el ? el.getAttribute('content') : null;
}

for (const r of ROUTES) {
  test(`prerendered ${r.route} has crawler-visible content`, () => {
    const { html, doc } = loadRoute(r.dir);

    // --- Real heading -------------------------------------------------------
    const h1 = doc.querySelector('h1');
    assert.ok(h1, `${r.route}: missing <h1>`);
    assert.ok(h1.textContent.trim().length > 0, `${r.route}: empty <h1>`);

    // --- Title --------------------------------------------------------------
    const title = doc.querySelector('title');
    assert.ok(title && title.textContent.trim().length > 0, `${r.route}: missing <title>`);
    if (r.headManaged !== false) {
      assert.equal(title.textContent.trim(), r.title, `${r.route}: <title> should match manifest`);
    }

    // --- Meta description ---------------------------------------------------
    const desc = metaContent(doc, 'meta[name="description"]');
    assert.ok(desc && desc.trim().length >= 50, `${r.route}: missing/short meta description`);
    if (r.headManaged !== false) {
      assert.equal(desc, r.description, `${r.route}: meta description should match manifest`);
    }

    // --- Canonical ----------------------------------------------------------
    // Dedicated subpage files carry a static canonical (safe: they are real
    // per-route files, not the SPA fallback). The homepage is served by the
    // shell that ALSO backs the SPA fallback, so per its deliberate design
    // (src/components/CanonicalTag.tsx) the static canonical is omitted and set
    // at runtime — a static one would mark every fallback route a duplicate.
    if (r.headManaged !== false) {
      const canonical = doc.querySelector('link[rel="canonical"]');
      assert.ok(canonical, `${r.route}: missing canonical link`);
      assert.equal(canonical.getAttribute('href'), canonicalFor(r.route), `${r.route}: wrong canonical`);
      assert.equal(metaContent(doc, 'meta[property="og:url"]'), canonicalFor(r.route), `${r.route}: wrong og:url`);
    }

    // --- Open Graph ---------------------------------------------------------
    assert.ok(metaContent(doc, 'meta[property="og:title"]'), `${r.route}: missing og:title`);
    assert.ok(metaContent(doc, 'meta[property="og:description"]'), `${r.route}: missing og:description`);
    assert.ok(metaContent(doc, 'meta[property="og:url"]'), `${r.route}: missing og:url`);
    assert.ok(metaContent(doc, 'meta[property="og:image"]'), `${r.route}: missing og:image`);

    // --- JSON-LD structured data -------------------------------------------
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')];
    assert.ok(ld.length > 0, `${r.route}: missing JSON-LD`);
    for (const block of ld) {
      assert.doesNotThrow(() => JSON.parse(block.textContent), `${r.route}: JSON-LD does not parse`);
    }
    if (r.headManaged !== false && r.jsonld) {
      const types = ld.map((b) => JSON.parse(b.textContent)['@type']);
      assert.ok(types.includes(r.jsonld['@type']), `${r.route}: expected JSON-LD @type ${r.jsonld['@type']}`);
    }

    // --- Meaningful body copy ----------------------------------------------
    const root = doc.getElementById('root');
    assert.ok(root, `${r.route}: missing #root`);
    const bodyText = root.textContent.replace(/\s+/g, ' ').trim();
    assert.ok(bodyText.length >= 300, `${r.route}: thin body copy (${bodyText.length} chars) — crawlers would see near-empty page`);

    // --- App still boots (SPA hydrates over the prerendered markup) ---------
    assert.match(html, /<script[^>]+type="module"[^>]+src="\/assets\/[^"]+\.js"/, `${r.route}: missing app entry script — SPA would not hydrate`);
  });
}
