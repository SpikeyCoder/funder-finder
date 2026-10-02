// Unit tests for src/lib/chunkReload.ts — the one-reload guard behind the
// ErrorBoundary's chunk-load recovery (Trello #214). A regression here is an
// infinite reload loop in production, so the invariants are pinned down.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/chunkReload.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const { isChunkLoadError, reloadKey, reloadOnceForChunkError, CHUNK_RELOAD_WINDOW_MS } = mod;

// Safari's link error names no file, so it's keyed by path.
const LINK = new SyntaxError("Importing binding name 'Dt' is not found.");
const fetchFail = (file) => new TypeError(`Failed to fetch dynamically imported module: https://x/assets/${file}`);

// Minimal browser globals.
let store;
let reloads;
function installGlobals({ blocked = false } = {}) {
  store = new Map();
  reloads = 0;
  const throwIfBlocked = () => { if (blocked) throw new DOMException('blocked', 'SecurityError'); };
  globalThis.sessionStorage = {
    getItem: (k) => { throwIfBlocked(); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { throwIfBlocked(); store.set(k, String(v)); },
  };
  globalThis.window = { location: { pathname: '/results', reload: () => { reloads++; } } };
}
beforeEach(() => installGlobals());

test('recognises each engine’s chunk-load wording', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://x/assets/Results-1.js', // Chrome
    'error loading dynamically imported module: https://x/a.js',                  // Firefox
    'Importing a module script failed.',                                           // Safari (fetch)
    "Importing binding name 'Dt' is not found.",                                   // Safari (link) — #214
    "The requested module './index-1.js' does not provide an export named 'Dt'",  // Chrome (link)
    'import not found: Dt',                                                        // Firefox (link)
    'ambiguous indirect export: Dt',                                               // Firefox (link)
  ]) {
    const ErrorType = /binding|export named|import not found|indirect export/.test(message) ? SyntaxError : TypeError;
    assert.equal(isChunkLoadError(new ErrorType(message)), true, message);
  }
  assert.equal(isChunkLoadError(new Error('Unable to preload CSS for /assets/index.css')), true); // Vite
  assert.equal(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' })), true);
});

test('does not treat ordinary errors as chunk-load errors', () => {
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')")), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError('Importing binding name'), false); // not an error object
  // App errors that merely mention the words aren't load failures.
  assert.equal(isChunkLoadError(new Error('Import not found')), false);
  assert.equal(isChunkLoadError(new RangeError('dynamically imported module limit')), false);
});

test('reload key: the failing chunk when named, else the page path', () => {
  assert.equal(reloadKey(fetchFail('FunderDetail-Ab1.js'), '/funder/1'), 'chunk:FunderDetail-Ab1.js');
  assert.equal(reloadKey(LINK, '/results'), 'path:/results');
});

test('a chunk that keeps failing gets one reload, not one per page using it', () => {
  window.location.pathname = '/funder/1';
  assert.equal(reloadOnceForChunkError(fetchFail('FunderDetail-Ab1.js'), 1_000_000), true);
  window.location.pathname = '/funder/2';
  assert.equal(reloadOnceForChunkError(fetchFail('FunderDetail-Ab1.js'), 1_001_000), false);
  assert.equal(reloadOnceForChunkError(fetchFail('Results-Zz9.js'), 1_002_000), true); // different chunk
  assert.equal(reloads, 2);
});

test('reloads once per path, then refuses within the window (no loop)', () => {
  const t0 = 1_000_000;
  assert.equal(reloadOnceForChunkError(LINK, t0), true);
  assert.equal(reloads, 1);
  assert.equal(reloadOnceForChunkError(LINK, t0 + 5_000), false);
  assert.equal(reloadOnceForChunkError(LINK, t0 + CHUNK_RELOAD_WINDOW_MS - 1), false);
  assert.equal(reloads, 1);
});

test('a different path gets its own reload, without re-arming the first', () => {
  const t0 = 1_000_000;
  reloadOnceForChunkError(LINK, t0);
  window.location.pathname = '/reports';
  assert.equal(reloadOnceForChunkError(LINK, t0 + 1_000), true);
  window.location.pathname = '/results'; // Back to the still-broken page
  assert.equal(reloadOnceForChunkError(LINK, t0 + 2_000), false);
  assert.equal(reloads, 2);
});

test('re-arms after the window so a later deploy can auto-recover', () => {
  const t0 = 1_000_000;
  reloadOnceForChunkError(LINK, t0);
  assert.equal(reloadOnceForChunkError(LINK, t0 + CHUNK_RELOAD_WINDOW_MS), true);
  assert.equal(reloads, 2);
});

test('prunes expired paths from storage', () => {
  const t0 = 1_000_000;
  reloadOnceForChunkError(LINK, t0);
  window.location.pathname = '/reports';
  reloadOnceForChunkError(LINK, t0 + CHUNK_RELOAD_WINDOW_MS + 1);
  assert.deepEqual(Object.keys(JSON.parse(store.get('ff_chunk_reloads'))), ['path:/reports']);
});

test('never auto-reloads when sessionStorage is blocked', () => {
  installGlobals({ blocked: true });
  assert.equal(reloadOnceForChunkError(LINK, 1_000_000), false);
  assert.equal(reloads, 0);
});

test('a corrupt stored value is treated as empty, not as a crash', () => {
  store.set('ff_chunk_reloads', '{not json');
  assert.equal(reloadOnceForChunkError(LINK, 1_000_000), true);
});
