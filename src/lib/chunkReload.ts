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

// Reloads are tracked per top-level section ("/funder" for /funder/123), so a
// chunk that keeps failing doesn't earn a fresh reload for every id.
export function reloadKey(pathname: string): string {
  return '/' + (pathname.split('/')[1] ?? '');
}

// section -> time of our last automatic reload for it. One reload per section
// per window: a chunk that can never load gets exactly one reload rather than
// a loop (Back/Forward included), while a later deploy can still auto-recover.
const CHUNK_RELOAD_KEY = 'ff_chunk_reloads';
// Far longer than a reload takes (so no loop), short enough that a second
// deploy shortly after still auto-recovers.
export const CHUNK_RELOAD_WINDOW_MS = 2 * 60 * 1000;

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns true if a reload was started; false if we already reloaded
// for this section within the window, or sessionStorage is unavailable — the
// caller should then show a manual "Reload" screen. Without storage there's no
// way to remember that we already reloaded, so we don't auto-reload at all
// rather than risk a loop.
export function reloadOnceForChunkError(now = Date.now()): boolean {
  const path = reloadKey(window.location.pathname);
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
