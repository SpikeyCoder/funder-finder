// Guards against an infinite reload loop if a chunk is genuinely gone.
const CHUNK_RELOAD_KEY = 'ff_chunk_reload_at';
const CHUNK_RELOAD_COOLDOWN_MS = 10_000;

// A lazy/dynamic import that fails to download or link throws one of these. It
// usually means a new deploy rotated the hashed chunk filenames out from under
// a client that still has the old index.html, or a flaky mobile connection
// dropped one of the route's sibling chunks. WebKit sometimes reports the
// latter as a link-time SyntaxError ("Importing binding name 'x' is not
// found") rather than a fetch failure.
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name = '', message = '' } = error as { name?: string; message?: string };
  return (
    name === 'ChunkLoadError' ||
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message) ||
    /dynamically imported module/i.test(message) ||
    /importing binding name/i.test(message) ||
    /unable to preload css/i.test(message)
  );
}

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns true if a reload was started, false if we already reloaded
// within the cooldown (the caller should then surface the error instead).
export function reloadOnceForChunkError(): boolean {
  let lastReload = 0;
  try {
    lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0;
  } catch {
    /* sessionStorage unavailable (private mode); fall through to manual UI */
    return false;
  }
  if (Date.now() - lastReload <= CHUNK_RELOAD_COOLDOWN_MS) return false;
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// Wraps a route's dynamic import so any rejection — whatever wording the
// browser uses — reaches the ErrorBoundary tagged as a chunk-load error.
export function asChunkLoadError(error: unknown): Error {
  if (isChunkLoadError(error)) return error as Error;
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Failed to load route module: ${message}`);
  wrapped.name = 'ChunkLoadError';
  return Object.assign(wrapped, { cause: error });
}
