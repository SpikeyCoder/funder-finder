// A lazy route import that fails to download or link throws one of these. It
// usually means a new deploy rotated the hashed chunk filenames out from under
// a client that still has the old index.html, or a flaky mobile connection
// dropped one of the route's sibling chunks. WebKit reports the latter as a
// link-time SyntaxError ("Importing binding name 'x' is not found") rather
// than a fetch failure (Trello #214); Chrome and Firefox have their own link
// wordings. The bundler rejects genuinely missing exports at build time, so at
// runtime a link error means a partial or mixed load, not a code bug.

// Distinctive enough to trust whatever error type carries them (a library may
// rethrow them as a plain Error).
const FETCH_FAILURE = new RegExp(
  [
    'failed to fetch dynamically imported module', // Chrome
    'error loading dynamically imported module', // Firefox
    'importing a module script failed', // Safari
    '^unable to preload css for ', // Vite
  ].join('|'),
  'i',
);

// Shorter phrases an app error could plausibly contain, so they only count
// on a SyntaxError, which is what every engine raises for link failures.
const LINK_FAILURE = new RegExp(
  [
    'importing binding name', // Safari
    'does not provide an export named', // Chrome
    'import not found', // Firefox
    'ambiguous indirect export', // Firefox
  ].join('|'),
  'i',
);

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name = '', message = '' } = error as { name?: string; message?: string };
  if (name === 'ChunkLoadError' || FETCH_FAILURE.test(message)) return true;
  return name === 'SyntaxError' && LINK_FAILURE.test(message);
}

// Keys we've already auto-reloaded for in this tab, always scoped to the
// running build (its entry chunk). A fetch failure names the chunk that
// failed, so it's keyed by that file; link failures name a dependency
// (Chrome's is usually the shared entry chunk) or nothing (Safari), so they're
// keyed by page path. Each key gets one reload for the life of the tab, so
// nothing can loop however long a failure takes to surface; after a deploy the
// build part of every key changes, so the next failure auto-recovers again.
const CHUNK_RELOAD_KEY = 'ff_chunk_reloads';
const MAX_REMEMBERED = 50;
// Set just before an automatic reload to the key it's for; the page that
// reload loads takes it at startup (takeReloadMarker), so no later page
// load, a manual Reload included, sees it.
const PENDING_RELOAD_KEY = 'ff_chunk_pending_reload';
// How long after startup a chunk failure still counts as the reload's
// (the route's chunks load as the page first renders).
const RELOAD_MARKER_MS = 60_000;
let reloadedFor: string | null = null;

export function reloadKey(error: unknown, pathname: string, build: string): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  const chunk = FETCH_FAILURE.test(message) ? message.match(/[\w.-]+\.(?:js|css)\b/) : null;
  return chunk ? `chunk:${chunk[0]}@${build}` : `path:${pathname}@${build}`;
}

// The hashed entry chunk this page is running (index-AbC123.js), which
// changes with every deploy.
export function currentBuild(): string {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? '';
  return src.split('/').pop() || 'dev';
}

// The keys this tab already reloaded for. Throws if sessionStorage can't be
// read; a corrupt value counts as no history.
function readReloaded(): string[] {
  const raw = sessionStorage.getItem(CHUNK_RELOAD_KEY) || '[]';
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type ChunkReloadResult = 'reloading' | 'already-reloaded' | 'unavailable';

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns 'reloading' if a reload was started. Otherwise the caller
// should show a manual "Reload" screen: 'already-reloaded' means we reloaded
// for this chunk/path before and it didn't help (worth reporting), and
// 'unavailable' that sessionStorage is: without it there's no way to remember
// that we already reloaded, so we don't auto-reload at all rather than risk
// a loop.
export function reloadOnceForChunkError(error: unknown): ChunkReloadResult {
  const key = reloadKey(error, window.location.pathname, currentBuild());
  try {
    // A read error propagates to the catch below (no reload).
    const seen = readReloaded();
    if (seen.includes(key)) return 'already-reloaded';
    // The marker first: if recording the key then fails, we don't reload,
    // and the key isn't recorded as reloaded-for either.
    sessionStorage.setItem(PENDING_RELOAD_KEY, key);
    try {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify([...seen, key].slice(-MAX_REMEMBERED)));
    } catch (err) {
      sessionStorage.removeItem(PENDING_RELOAD_KEY);
      throw err;
    }
  } catch {
    return 'unavailable';
  }
  window.location.reload();
  return 'reloading';
}

// Call once at startup, before anything renders: notes whether this page
// load is an automatic reload, and for which key.
export function takeReloadMarker(): void {
  try {
    reloadedFor = sessionStorage.getItem(PENDING_RELOAD_KEY);
    sessionStorage.removeItem(PENDING_RELOAD_KEY);
  } catch {
    reloadedFor = null;
  }
  if (reloadedFor !== null) setTimeout(() => (reloadedFor = null), RELOAD_MARKER_MS);
}

// Whether this failure is the one our automatic reload was for, on the page
// that reload loaded, as it first rendered: then the reload didn't help.
// Answers true once; a later, separate failure in the tab (minutes on, or
// after another full page load) isn't the reload's.
export function onReloadPageFor(error: unknown): boolean {
  if (reloadedFor === null || reloadedFor !== reloadKey(error, window.location.pathname, currentBuild())) return false;
  reloadedFor = null;
  return true;
}
