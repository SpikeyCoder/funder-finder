// Set when we auto-reload for a failed route chunk; cleared once a route
// module loads successfully. While it's set we don't reload again, so a chunk
// that can never load (or a module that throws on import) gets exactly one
// reload, never a loop — however slow the connection.
const CHUNK_RELOAD_KEY = 'ff_chunk_reloaded';

// A lazy/dynamic import that fails to download or link throws one of these. It
// usually means a new deploy rotated the hashed chunk filenames out from under
// a client that still has the old index.html, or a flaky mobile connection
// dropped one of the route's sibling chunks. WebKit sometimes reports the
// latter as a link-time SyntaxError ("Importing binding name 'x' is not
// found") rather than a fetch failure.
const CHUNK_ERROR_MESSAGE =
  /dynamically imported module|importing a module script failed|importing binding name|unable to preload css/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name = '', message = '' } = error as { name?: string; message?: string };
  return name === 'ChunkLoadError' || CHUNK_ERROR_MESSAGE.test(message);
}

// Reloading pulls a fresh index.html plus valid chunks and almost always
// recovers. Returns true if a reload was started; false if we already reloaded
// for a chunk error that hasn't since cleared, or sessionStorage is unavailable
// (private mode) — the caller should then show the error instead.
export function reloadOnceForChunkError(): boolean {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export function clearChunkReloadFlag(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    /* ignore */
  }
}

// Wraps a route's dynamic import so any rejection — whatever wording the
// browser uses — reaches the ErrorBoundary tagged as a chunk-load error. The
// original error stays on `cause` so it can still be shown and reported.
export function asChunkLoadError(error: unknown): Error {
  if (isChunkLoadError(error)) return error as Error;
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Failed to load route module: ${message}`);
  wrapped.name = 'ChunkLoadError';
  return Object.assign(wrapped, { cause: error });
}

// The error worth showing a person: the original one if we wrapped it.
export function underlyingError(error: Error): Error {
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? cause : error;
}
