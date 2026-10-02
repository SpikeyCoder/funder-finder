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
// when the engine raised them (always a SyntaxError for link failures).
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
  return (name === 'SyntaxError' || name === 'TypeError') && LINK_FAILURE.test(message);
}

// Keys we've already auto-reloaded for in this tab. The key is the failing
// chunk's file when the browser names it (fetch failures do), else the page
// path (Safari's binding error names no file). Each key gets one reload for
// the life of the tab, so nothing can loop however long a failure takes to
// surface; a later deploy still auto-recovers because it changes the chunk's
// hashed filename, and with it the key.
const CHUNK_RELOAD_KEY = 'ff_chunk_reloads';
const MAX_REMEMBERED = 50;

export function reloadKey(error: unknown, pathname: string): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  const chunk = message.match(/[\w.-]+\.(?:js|css)\b/);
  return chunk ? `chunk:${chunk[0]}` : `path:${pathname}`;
}

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns true if a reload was started; false if we already reloaded
// for this chunk/path, or sessionStorage is unavailable — the caller should
// then show a manual "Reload" screen. Without storage there's no way to
// remember that we already reloaded, so we don't auto-reload at all rather
// than risk a loop.
export function reloadOnceForChunkError(error: unknown): boolean {
  const key = reloadKey(error, window.location.pathname);
  try {
    let seen: string[] = [];
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CHUNK_RELOAD_KEY) || '[]');
      seen = Array.isArray(parsed) ? parsed : [];
    } catch {
      seen = []; // corrupt value: start over
    }
    if (seen.includes(key)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify([...seen, key].slice(-MAX_REMEMBERED)));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
