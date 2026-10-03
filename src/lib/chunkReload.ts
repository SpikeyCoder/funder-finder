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

export function reloadKey(error: unknown, pathname: string, build: string): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  const chunk = FETCH_FAILURE.test(message) ? message.match(/[\w.-]+\.(?:js|css)\b/) : null;
  return chunk ? `chunk:${chunk[0]}@${build}` : `path:${pathname}@${build}`;
}

// The hashed entry chunk this page is running (index-AbC123.js), which
// changes with every deploy.
function currentBuild(): string {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? '';
  return src.split('/').pop() || 'dev';
}

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns true if a reload was started; false if we already reloaded
// for this chunk/path, or sessionStorage is unavailable — the caller should
// then show a manual "Reload" screen. Without storage there's no way to
// remember that we already reloaded, so we don't auto-reload at all rather
// than risk a loop.
export function reloadOnceForChunkError(error: unknown): boolean {
  const key = reloadKey(error, window.location.pathname, currentBuild());
  try {
    // A read error propagates to the outer catch (no reload); only a corrupt
    // value resets the history.
    const raw = sessionStorage.getItem(CHUNK_RELOAD_KEY) || '[]';
    let seen: string[] = [];
    try {
      const parsed = JSON.parse(raw);
      seen = Array.isArray(parsed) ? parsed : [];
    } catch {
      seen = [];
    }
    if (seen.includes(key)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify([...seen, key].slice(-MAX_REMEMBERED)));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
