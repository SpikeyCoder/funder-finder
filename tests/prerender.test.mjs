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
 *
 * Parsing is deliberately dependency-free (small, tolerant regex helpers rather
 * than a DOM library): the built HTML is machine-generated and stable, and this
 * keeps the CI content-check hermetic — no headless browser, and no reliance on
 * jsdom's transitive dependencies (which are pinned by the repo's `overrides`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, ORIGIN_URL } from '../prerender/manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Absolute canonical URL for a route (root normalises to a single trailing slash). */
function canonicalFor(route) {
  return route === '/' ? `${ORIGIN_URL}/` : `${ORIGIN_URL}${route}`;
}

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Text of the first <h1>…</h1>, or null. */
function h1Text(html) {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : null;
}

/** Text of <title>…</title>, or null. */
function titleText(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

/** `content` of a <meta> tag identified by `attr="val"` (attribute order tolerant). */
function metaContent(html, attr, val) {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}=["']${val.replace(/[/]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/\bcontent=["']([^"']*)["']/i);
  return c ? c[1] : null;
}

/** `href` of <link rel="canonical">, or null. */
function canonicalHref(html) {
  const tag = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i);
  if (!tag) return null;
  const h = tag[0].match(/\bhref=["']([^"']*)["']/i);
  return h ? h[1] : null;
}

/** All JSON-LD blocks, parsed. */
function jsonLdBlocks(html) {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  return [...html.matchAll(re)].map((m) => JSON.parse(m[1]));
}

/** Visible text inside <div id="root">…</div> (the app entry follows in <head>,
 *  so everything after this marker is body content). */
function rootText(html) {
  const i = html.indexOf('<div id="root">');
  return i === -1 ? null : stripTags(html.slice(i));
}

function loadRoute(dir) {
  const file = join(DIST, dir, 'index.html');
  assert.ok(existsSync(file), `expected built page at dist/${join(dir, 'index.html')} — run \`npm run build\` first`);
  return readFileSync(file, 'utf8');
}

for (const r of ROUTES) {
  test(`prerendered ${r.route} has crawler-visible content`, () => {
    const html = loadRoute(r.dir);

    // --- Real heading -------------------------------------------------------
    const h1 = h1Text(html);
    assert.ok(h1 && h1.length > 0, `${r.route}: missing/empty <h1>`);

    // --- Title --------------------------------------------------------------
    const title = titleText(html);
    assert.ok(title && title.length > 0, `${r.route}: missing <title>`);
    if (r.headManaged !== false) {
      assert.equal(title, r.title, `${r.route}: <title> should match manifest`);
    }

    // --- Meta description ---------------------------------------------------
    const desc = metaContent(html, 'name', 'description');
    assert.ok(desc && desc.trim().length >= 50, `${r.route}: missing/short meta description`);
    if (r.headManaged !== false) {
      assert.equal(desc, r.description, `${r.route}: meta description should match manifest`);
    }

    // --- Canonical + og:url -------------------------------------------------
    // Every prerendered route — the homepage included — carries a static,
    // self-referential canonical in its raw HTML. index.html ships
    // <link rel="canonical" href="https://fundermatch.org/"> for "/", and the
    // prerender plugin overwrites it per subpage. The runtime CanonicalTag
    // (src/components/CanonicalTag.tsx) updates this same tag in place on client
    // navigation, so JS clients never end up with a duplicate.
    assert.equal(canonicalHref(html), canonicalFor(r.route), `${r.route}: wrong/missing canonical`);
    if (r.headManaged !== false) {
      assert.equal(metaContent(html, 'property', 'og:url'), canonicalFor(r.route), `${r.route}: wrong og:url`);
    }

    // --- Open Graph ---------------------------------------------------------
    assert.ok(metaContent(html, 'property', 'og:title'), `${r.route}: missing og:title`);
    assert.ok(metaContent(html, 'property', 'og:description'), `${r.route}: missing og:description`);
    assert.ok(metaContent(html, 'property', 'og:url'), `${r.route}: missing og:url`);
    assert.ok(metaContent(html, 'property', 'og:image'), `${r.route}: missing og:image`);

    // --- JSON-LD structured data -------------------------------------------
    const ld = jsonLdBlocks(html); // JSON.parse throws here if malformed
    assert.ok(ld.length > 0, `${r.route}: missing JSON-LD`);
    if (r.headManaged !== false && r.jsonld) {
      const types = ld.map((b) => b['@type']);
      assert.ok(types.includes(r.jsonld['@type']), `${r.route}: expected JSON-LD @type ${r.jsonld['@type']}`);
    }

    // --- Meaningful body copy ----------------------------------------------
    const bodyText = rootText(html);
    assert.ok(bodyText !== null, `${r.route}: missing #root`);
    assert.ok(bodyText.length >= 300, `${r.route}: thin body copy (${bodyText.length} chars) — crawlers would see near-empty page`);

    // --- App still boots (SPA hydrates over the prerendered markup) ---------
    assert.match(html, /<script[^>]+type="module"[^>]+src="\/assets\/[^"]+\.js"/, `${r.route}: missing app entry script — SPA would not hydrate`);
  });
}
