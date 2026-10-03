// Automatic crash and page-speed reporting (FM-2026-10-03-02).
//
// Crashes (the ErrorBoundary's screen, uncaught errors, unhandled promise
// rejections) and each page view's Core Web Vitals are sent to the
// `monitor-report` Edge Function. A scheduled sweep (`monitor-sweep`) groups
// crashes by fingerprint and opens one Trello card per new kind, and opens a
// card when a page's 75th-percentile vitals are "poor" (see migration
// 20261003140000).
//
// Everything here is best-effort: reporting never throws, never blocks the
// page, and is off in development.
//
// Privacy: no user id, IP or query string is sent; paths are reduced to the
// app's route (ids and share tokens become :id). Email addresses in error
// text are masked here and again on the server.
import type { Metric } from 'web-vitals';
import { currentBuild, isChunkLoadError } from './chunkReload';
// Shared with the monitor-report Edge Function, so both scrub the same way.
import { normalizePath, scrub } from '../../supabase/functions/_shared/monitor_scrub.ts';
import { SUPABASE_URL } from './supabaseProject';

const ENDPOINT = `${SUPABASE_URL}/functions/v1/monitor-report`;

// One page load can't send more than this many crash reports (a render loop
// would otherwise send one per frame), and the same crash is sent once.
const MAX_CRASHES_PER_PAGE = 5;

export type CrashKind = 'boundary' | 'error' | 'rejection';

export interface CrashReport {
  type: 'crash';
  kind: CrashKind;
  name: string;
  message: string;
  stack: string;
  componentStack: string;
  path: string;
  release: string;
}

export interface VitalsReport {
  type: 'vitals';
  release: string;
  // `id` is web-vitals' per-page-view id: the server keeps one row per id.
  // `path` is per metric (see installMonitoring).
  metrics: { id: string; name: string; value: number; rating: string; path: string }[];
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * Errors that aren't ours to fix: browser extensions, the opaque
 * cross-origin "Script error.", ResizeObserver's benign loop warning, and
 * chunk-load failures (ErrorBoundary reloads for those; see chunkReload.ts)
 * unless the reload already happened and didn't help (`chunkGaveUp`).
 */
export function isNoise(error: unknown, message: string, stack: string, chunkGaveUp = false, screenShown = false): boolean {
  if (isChunkLoadError(error)) return !chunkGaveUp;
  // `Promise.reject()` with no reason: nothing to say where, or what.
  if (error === undefined || error === null) return !screenShown;
  if (/^Script error\.?$/i.test(message.trim())) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  if (/(?:chrome|moz|safari(?:-web)?)-extension:\/\//i.test(stack)) return true;
  // Lost connections and cancelled requests, in each browser's wording: the
  // network, not our code. Unless the error screen showed: a page that breaks
  // when a request fails is a bug worth a card.
  if (screenShown) return false;
  // Some versions add the host: "Failed to fetch (api.example.org)". Safari
  // also says why ("The network connection was lost."), and supabase-js
  // wraps a failed Edge Function request in its own wording.
  if (/^(?:TypeError: )?(?:(?:Failed to fetch|Load failed)(?: \([^)]*\))?|NetworkError when attempting to fetch resource|Network request failed|Failed to send a request to the Edge Function|The network connection was lost|The Internet connection appears to be offline|A server with the specified hostname could not be found|The request timed out|cancelled)\.?$/i.test(message.trim())) return true;
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** Name, message and stack of anything that can be thrown. */
export function describe(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: String(error.message ?? ''), stack: String(error.stack ?? '') };
  }
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof e.message === 'string') {
      return { name: typeof e.name === 'string' ? e.name : 'Error', message: e.message, stack: typeof e.stack === 'string' ? e.stack : '' };
    }
  }
  // Anything else: a thrown string is a message; for other values only their
  // shape, never their contents (a rejected object can hold a profile or a
  // token, and scrubbing only knows emails).
  if (typeof error === 'string') return { name: 'NonError', message: error, stack: '' };
  let message: string;
  if (error && typeof error === 'object') {
    let keys: string[] = [];
    try {
      keys = Object.keys(error).slice(0, 10);
    } catch {
      // A hostile proxy; the shape stays unknown.
    }
    message = `${Array.isArray(error) ? 'array' : 'object'}${keys.length ? ` with keys ${keys.join(', ')}` : ''}`;
  } else {
    message = error === null ? 'null' : typeof error;
  }
  return { name: 'NonError', message, stack: '' };
}

export function buildCrashReport(
  kind: CrashKind,
  error: unknown,
  pathname: string,
  release: string,
  componentStack = '',
  chunkGaveUp = false,
): CrashReport | null {
  const { name, message, stack } = describe(error);
  if (isNoise(error, message, stack, chunkGaveUp, kind === 'boundary')) return null;
  return {
    type: 'crash',
    kind,
    name: scrub(name).slice(0, 100),
    message: scrub(message).slice(0, 500),
    stack: scrub(stack).slice(0, 4000),
    componentStack: scrub(componentStack).slice(0, 2000),
    path: normalizePath(pathname),
    release: release.slice(0, 100),
  };
}

// ── Sending ─────────────────────────────────────────────────────────────────

// Only the live site reports: a production build served anywhere else (a
// preview deploy, `vite preview`, a QA machine) would put its crashes and
// timings on the real board and in the real p75s.
const PRODUCTION_HOST = /^(?:www\.)?fundermatch\.org$/;

function enabled(): boolean {
  return !import.meta.env.DEV && typeof window !== 'undefined' && PRODUCTION_HOST.test(window.location.hostname);
}

// text/plain keeps this a CORS "simple" request (no preflight), so it can be
// sent with keepalive while the page unloads.
// Resolves to whether the report was delivered; never rejects.
function send(payload: CrashReport | VitalsReport): Promise<boolean> {
  try {
    return fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    }).then(() => true, () => false);
  } catch {
    // Reporting must never break the page.
    return Promise.resolve(false);
  }
}

const sentCrashes = new Set<string>();

export function reportCrash(kind: CrashKind, error: unknown, componentStack = '', chunkGaveUp = false): void {
  if (!enabled() || sentCrashes.size >= MAX_CRASHES_PER_PAGE) return;
  try {
    const report = buildCrashReport(kind, error, window.location.pathname, currentBuild(), componentStack, chunkGaveUp);
    if (!report) return;
    const key = `${report.name}|${report.message}|${report.stack.split('\n', 3).join('|')}`;
    if (sentCrashes.has(key)) return;
    sentCrashes.add(key);
    void send(report);
  } catch {
    // Reporting must never break the page.
  }
}

let installed = false;

/** Report uncaught errors and unhandled rejections, and each page view's vitals. */
export function installMonitoring(): void {
  if (!enabled() || installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    if (event.error) return reportCrash('error', event.error);
    // No error object (thrown from another realm, or a non-Error): parse the
    // event's message, which browsers prefix ("Uncaught TypeError: …"), so it
    // fingerprints the same as when the object is there.
    const m = /^(?:Uncaught )?(?:(\w*Error): )?(.*)$/s.exec(event.message || '');
    if (!m || !m[2]) return;
    reportCrash('error', { name: m[1] || 'Error', message: m[2], stack: `at ${event.filename}:${event.lineno}` });
  });
  window.addEventListener('unhandledrejection', (event) => reportCrash('rejection', event.reason));

  // Core Web Vitals, sent whenever the page is hidden, and again on a later
  // hide if a value changed (INP and CLS keep growing while the page is
  // open); the server keeps the latest per metric id. web-vitals also
  // reports on hide, listening on window in the capture phase, so final
  // values land before the flush below (on document) runs.
  //
  // Which page a value belongs to: LCP to the page that loaded (the URL
  // first requested, before any redirect, or the one restored from the
  // back/forward cache), since it measures that load. INP and CLS to the
  // route at the time: with reportAllChanges, web-vitals calls back as a new
  // worst interaction finishes or a layout shift happens, so that's where
  // the slow thing was, not where the visitor is when the tab is hidden. (A
  // click that navigates counts against the page it opens, whose render is
  // what made it slow.) CLS adds shifts up, so it goes to the route of the
  // change that added the most, not whichever added the last bit.
  let loadedPath = normalizePath(window.location.pathname);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) loadedPath = normalizePath(window.location.pathname);
  });
  const pending = new Map<string, { m: Metric; path: string }>();
  const sentValues = new Map<string, number>();
  const largestShift = new Map<string, { delta: number; path: string }>();
  const record = (m: Metric) => {
    if (sentValues.get(m.id) === m.value) return;
    let path = m.name === 'LCP' ? loadedPath : normalizePath(window.location.pathname);
    if (m.name === 'CLS') {
      const largest = largestShift.get(m.id);
      if (largest && largest.delta >= m.delta) path = largest.path;
      else largestShift.set(m.id, { delta: m.delta, path });
    }
    pending.set(m.id, { m, path });
  };
  // Loaded once the browser is idle (at most a second in), so its chunk
  // doesn't compete with the first page's; its observers read buffered
  // entries, so nothing measured before it loads is lost. A visitor who leaves
  // within that second sends no vitals.
  const load = () =>
    void import('web-vitals')
      .then(({ onLCP, onINP, onCLS }) => {
        onLCP(record, { reportAllChanges: true });
        onINP(record, { reportAllChanges: true });
        onCLS(record, { reportAllChanges: true });
      })
      .catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 1000 });
  else setTimeout(load, 500);
  const flush = () => {
    if (pending.size === 0) return;
    const metrics = [...pending.values()];
    pending.clear();
    for (const { m } of metrics) sentValues.set(m.id, m.value);
    void send({
      type: 'vitals',
      release: currentBuild().slice(0, 100),
      metrics: metrics.map(({ m, path }) => ({ id: m.id, name: m.name, value: m.value, rating: m.rating, path })),
    }).then((delivered) => {
      if (delivered) return;
      // Not delivered (offline, or over the keepalive budget): send these
      // again on the next hide, unless newer values came in meanwhile.
      for (const entry of metrics) {
        if (sentValues.get(entry.m.id) === entry.m.value) sentValues.delete(entry.m.id);
        if (!pending.has(entry.m.id)) pending.set(entry.m.id, entry);
      }
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
