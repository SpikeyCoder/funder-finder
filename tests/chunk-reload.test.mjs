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
const { isChunkLoadError, onReloadPageFor, reloadKey, reloadOnceForChunkError } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

// Safari's link error names no file, so it's keyed by path.
const LINK = new SyntaxError("Importing binding name 'Dt' is not found.");
const fetchFail = (file) => new TypeError(`Failed to fetch dynamically imported module: https://x/assets/${file}`);

// Minimal browser globals.
function setBuild(file) {
  globalThis.document = { querySelector: () => ({ src: `https://fundermatch.org/assets/${file}` }) };
}
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
  setBuild('index-Build1.js');
}
beforeEach(() => installGlobals());

test('recognises each engine’s chunk-load wording', () => {
  for (const [ErrorType, message] of [
    [TypeError, 'Failed to fetch dynamically imported module: https://x/assets/Results-1.js'], // Chrome
    [TypeError, 'error loading dynamically imported module: https://x/a.js'],                  // Firefox
    [TypeError, 'Importing a module script failed.'],                                           // Safari
    [SyntaxError, "Importing binding name 'Dt' is not found."],                                 // Safari link — #214
    [SyntaxError, "The requested module './index-1.js' does not provide an export named 'Dt'"], // Chrome link
    [SyntaxError, 'import not found: Dt'],                                                      // Firefox link
    [SyntaxError, 'ambiguous indirect export: Dt'],                                             // Firefox link
    [Error, 'Unable to preload CSS for /assets/index.css'],                                     // Vite
  ]) {
    assert.equal(isChunkLoadError(new ErrorType(message)), true, message);
  }
  assert.equal(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' })), true);
  // Fetch-failure phrases are trusted even when rethrown as a plain Error.
  assert.equal(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://x/a.js')), true);
});

test('does not treat ordinary errors as chunk-load errors', () => {
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')")), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError('Importing binding name'), false); // not an error object
  // App errors that merely mention the short link phrases aren't load failures.
  assert.equal(isChunkLoadError(new Error('Import not found')), false);
  assert.equal(isChunkLoadError(new Error('importing binding name failed in CSV mapper')), false);
  assert.equal(isChunkLoadError(new TypeError('Import not found: column EIN')), false);
});

test('reload key: the failing chunk when named, else the page path', () => {
  assert.equal(reloadKey(fetchFail('FunderDetail-Ab1.js'), '/funder/1', 'index-B1.js'), 'chunk:FunderDetail-Ab1.js@index-B1.js');
  assert.equal(reloadKey(LINK, '/results', 'index-B1.js'), 'path:/results@index-B1.js');
  // Chrome's link error names the shared dependency, not the failing route.
  const chromeLink = new SyntaxError("The requested module './index-B1.js' does not provide an export named 'Dt'");
  assert.equal(reloadKey(chromeLink, '/funder/1', 'index-B1.js'), 'path:/funder/1@index-B1.js');
});

test('one reload per key for the life of the tab — no loop however slow', () => {
  assert.equal(reloadOnceForChunkError(LINK), 'reloading');
  assert.equal(reloadOnceForChunkError(LINK), 'already-reloaded');
  assert.equal(reloadOnceForChunkError(LINK), 'already-reloaded');
  assert.equal(reloads, 1);
});

test('a chunk that keeps failing gets one reload, not one per page using it', () => {
  window.location.pathname = '/funder/1';
  assert.equal(reloadOnceForChunkError(fetchFail('FunderDetail-Ab1.js')), 'reloading');
  window.location.pathname = '/funder/2';
  assert.equal(reloadOnceForChunkError(fetchFail('FunderDetail-Ab1.js')), 'already-reloaded');
  assert.equal(reloads, 1);
});

test('a later deploy auto-recovers, even for a chunk whose hash is unchanged', () => {
  assert.equal(reloadOnceForChunkError(fetchFail('Vendor-Same.js')), 'reloading');
  assert.equal(reloadOnceForChunkError(fetchFail('Vendor-Same.js')), 'already-reloaded'); // same build: no loop
  setBuild('index-Build2.js');
  assert.equal(reloadOnceForChunkError(fetchFail('Vendor-Same.js')), 'reloading');
  assert.equal(reloads, 2);
});

test('different pages keyed by path each get their own reload; Back does not re-arm', () => {
  assert.equal(reloadOnceForChunkError(LINK), 'reloading');
  window.location.pathname = '/reports';
  assert.equal(reloadOnceForChunkError(LINK), 'reloading');
  window.location.pathname = '/results';
  assert.equal(reloadOnceForChunkError(LINK), 'already-reloaded');
  assert.equal(reloads, 2);
});

test('Safari (path-keyed) failures auto-recover again after a new deploy', () => {
  assert.equal(reloadOnceForChunkError(LINK), 'reloading');
  assert.equal(reloadOnceForChunkError(LINK), 'already-reloaded'); // same build: no loop
  setBuild('index-Build2.js'); // a deploy later
  assert.equal(reloadOnceForChunkError(LINK), 'reloading');
  assert.equal(reloads, 2);
});

test('a storage read error means no reload and keeps the history', () => {
  reloadOnceForChunkError(fetchFail('A-1.js'));
  const before = store.get('ff_chunk_reloads');
  const getItem = sessionStorage.getItem;
  sessionStorage.getItem = () => { throw new DOMException('flaky', 'SecurityError'); };
  assert.equal(reloadOnceForChunkError(fetchFail('B-2.js')), 'unavailable');
  sessionStorage.getItem = getItem;
  assert.equal(store.get('ff_chunk_reloads'), before);
});

test('remembers a bounded number of keys', () => {
  for (let i = 0; i < 60; i++) reloadOnceForChunkError(fetchFail(`C-${i}.js`));
  assert.equal(JSON.parse(store.get('ff_chunk_reloads')).length, 50);
});

test('never auto-reloads when sessionStorage is blocked', () => {
  installGlobals({ blocked: true });
  assert.equal(reloadOnceForChunkError(LINK), 'unavailable');
  assert.equal(reloads, 0);
});

test('a corrupt stored value is treated as empty, not as a crash', () => {
  store.set('ff_chunk_reloads', '{not json');
  assert.equal(reloadOnceForChunkError(LINK), 'reloading');
  store.set('ff_chunk_reloads', '{"a":1}'); // old object format
  window.location.pathname = '/other';
  assert.equal(reloadOnceForChunkError(LINK), 'reloading');
});

test('onReloadPageFor: only the page our reload loaded, for the same failure', () => {
  const realPerformance = globalThis.performance;
  const pageStartedAt = (ms) => Object.defineProperty(globalThis, 'performance', { value: { timeOrigin: ms }, configurable: true });
  try {
    const before = Date.now();
    assert.equal(reloadOnceForChunkError(LINK), 'reloading');
    // The reloaded page started loading a moment later: same failure there.
    pageStartedAt(before + 300);
    assert.equal(onReloadPageFor(LINK), true);
    // A different failure on that page isn't the one we reloaded for.
    assert.equal(onReloadPageFor(fetchFail('Other-1.js')), false);
    // A page loaded a minute later (a later navigation in the tab) isn't the reload's.
    pageStartedAt(before + 60_000);
    assert.equal(onReloadPageFor(LINK), false);
    // Nor the page that started the reload.
    pageStartedAt(before - 5_000);
    assert.equal(onReloadPageFor(LINK), false);
  } finally {
    Object.defineProperty(globalThis, 'performance', { value: realPerformance, configurable: true });
  }
});

test('onReloadPageFor is false without a recorded reload or storage', () => {
  assert.equal(onReloadPageFor(LINK), false);
  installGlobals({ blocked: true });
  assert.equal(onReloadPageFor(LINK), false);
});
