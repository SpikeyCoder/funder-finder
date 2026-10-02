// A lazy route import that fails to download or link throws one of these. It
// usually means a new deploy rotated the hashed chunk filenames out from under
// a client that still has the old index.html, or a flaky mobile connection
// dropped one of the route's sibling chunks. WebKit reports the latter as a
// link-time SyntaxError ("Importing binding name 'x' is not found") rather
// than a fetch failure (Trello #214); Chrome and Firefox have their own link
// wordings. The bundler rejects genuinely missing exports at build time, so at
// runtime a link error means a partial or mixed load, not a code bug.
const CHUNK_ERROR_MESSAGE = new RegExp(
  [
    'dynamically imported module', // Chrome / Firefox fetch failure
    'importing a module script failed', // Safari fetch failure
    'importing binding name', // Safari link failure
    'does not provide an export named', // Chrome link failure
    'import not found', // Firefox link failure
    'ambiguous indirect export', // Firefox link failure
  ].join('|'),
  'i',
);

// Every engine raises these as a TypeError (fetch) or SyntaxError (link);
// requiring that keeps an app error that merely mentions, say, "import not
// found" from being mistaken for one. Vite's CSS preload failure is a plain
// Error with its own fixed message.
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name = '', message = '' } = error as { name?: string; message?: string };
  if (name === 'ChunkLoadError' || /^Unable to preload CSS for /.test(message)) return true;
  return (name === 'TypeError' || name === 'SyntaxError') && CHUNK_ERROR_MESSAGE.test(message);
}

// key -> time of our last automatic reload for it. The key is the failing
// chunk's file when the browser names it (fetch failures do), so a chunk that
// can never load gets one reload however many pages (/funder/1, /funder/2…)
// use it; otherwise the page path (e.g. Safari's binding error names no file).
// A loop needs the same failure faster than the window, which a reload never
// takes, while a later deploy still auto-recovers.
const CHUNK_RELOAD_KEY = 'ff_chunk_reloads';
export const CHUNK_RELOAD_WINDOW_MS = 2 * 60 * 1000;

export function reloadKey(error: unknown, pathname: string): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  const chunk = message.match(/[\w.-]+\.(?:js|css)\b/);
  return chunk ? `chunk:${chunk[0]}` : `path:${pathname}`;
}

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns true if a reload was started; false if we already reloaded
// for this chunk/path within the window, or sessionStorage is unavailable — the
// caller should then show a manual "Reload" screen. Without storage there's no
// way to remember that we already reloaded, so we don't auto-reload at all
// rather than risk a loop.
export function reloadOnceForChunkError(error: unknown, now = Date.now()): boolean {
  const path = reloadKey(error, window.location.pathname);
  try {
    let reloads: Record<string, number> = {};
    try {
      reloads = JSON.parse(sessionStorage.getItem(CHUNK_RELOAD_KEY) || '{}') || {};
    } catch {
      reloads = {}; // corrupt value: start over
    }
    if (now - (reloads[path] ?? 0) < CHUNK_RELOAD_WINDOW_MS) return false;
    const fresh: Record<string, number> = { [path]: now };
    for (const [p, t] of Object.entries(reloads)) {
      if (p !== path && now - t < CHUNK_RELOAD_WINDOW_MS) fresh[p] = t;
    }
    sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify(fresh));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
