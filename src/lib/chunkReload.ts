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
    'unable to preload css', // Vite CSS preload
  ].join('|'),
  'i',
);

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name = '', message = '' } = error as { name?: string; message?: string };
  return name === 'ChunkLoadError' || CHUNK_ERROR_MESSAGE.test(message);
}

// path -> time of our last automatic reload for it. One reload per path per
// window: a chunk that can never load gets exactly one reload rather than a
// loop (Back/Forward included), while a later deploy can still auto-recover.
const CHUNK_RELOAD_KEY = 'ff_chunk_reloads';
export const CHUNK_RELOAD_WINDOW_MS = 10 * 60 * 1000;

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns true if a reload was started; false if we already reloaded
// for this path within the window, or sessionStorage is unavailable — the
// caller should then show a manual "Reload" screen. Without storage there's no
// way to remember that we already reloaded, so we don't auto-reload at all
// rather than risk a loop.
export function reloadOnceForChunkError(now = Date.now()): boolean {
  const path = window.location.pathname;
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
