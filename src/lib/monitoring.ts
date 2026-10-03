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

export { normalizePath, scrub };

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
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
  path: string;
  release: string;
  // `id` is web-vitals' per-page-view id: the server keeps one row per id.
  // `path` is per metric: LCP belongs to the page that loaded, INP and CLS
  // to the page the visitor was on when they were reported.
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
  if (/^Script error\.?$/i.test(message.trim())) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  if (/(?:chrome|moz|safari(?:-web)?)-extension:\/\//i.test(stack)) return true;
  // Lost connections and cancelled requests, in each browser's wording: the
  // network, not our code. Unless the error screen showed: a page that breaks
  // when a request fails is a bug worth a card.
  if (screenShown) return false;
  if (/^(?:TypeError: )?(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(message.trim())) return true;
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
  let message: string;
  try {
    message = typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
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

function enabled(): boolean {
  return !import.meta.env.DEV && typeof window !== 'undefined';
}

// text/plain keeps this a CORS "simple" request (no preflight), so it can be
// sent with keepalive while the page unloads.
function send(payload: CrashReport | VitalsReport): void {
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Reporting must never break the page.
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
    send(report);
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
    // Resource load failures (an <img> 404) reach here with no error object.
    if (!event.error && !event.message) return;
    reportCrash('error', event.error ?? { name: 'Error', message: event.message, stack: `at ${event.filename}:${event.lineno}` });
  });
  window.addEventListener('unhandledrejection', (event) => reportCrash('rejection', event.reason));

  // Core Web Vitals, sent whenever the page is hidden: web-vitals reports a
  // metric's value then, and again on a later hide if it changed (INP and CLS
  // keep growing while the page is open). Only changed values are sent; the
  // server keeps the latest per metric id. web-vitals listens on window in
  // the capture phase, so it reports before the flush below (on document)
  // runs, whenever it was loaded.
  const pending = new Map<string, Metric>();
  const sentValues = new Map<string, number>();
  const record = (m: Metric) => {
    if (sentValues.get(m.id) !== m.value) pending.set(m.id, m);
  };
  // Loaded once the browser is idle (at most a second in), so its chunk
  // doesn't compete with the first page's; its observers read buffered
  // entries, so nothing measured before it loads is lost. A visitor who leaves
  // within that second sends no vitals.
  const load = () =>
    void import('web-vitals')
      .then(({ onLCP, onINP, onCLS }) => {
        onLCP(record);
        onINP(record);
        onCLS(record);
      })
      .catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 1000 });
  else setTimeout(load, 500);
  // LCP describes the page load, so it keeps the landing page's path; INP
  // and CLS accumulate across client-side navigations, so they take the
  // path the visitor is on when they're reported.
  let path = normalizePath(window.location.pathname);
  // A page restored from the back/forward cache gets a new LCP (and new
  // metric ids) for the route it was restored on.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) path = normalizePath(window.location.pathname);
  });
  const flush = () => {
    if (pending.size === 0) return;
    const metrics = [...pending.values()];
    pending.clear();
    for (const m of metrics) sentValues.set(m.id, m.value);
    send({
      type: 'vitals',
      path,
      release: currentBuild().slice(0, 100),
      metrics: metrics.map((m) => ({
        id: m.id,
        name: m.name,
        value: m.value,
        rating: m.rating,
        path: m.name === 'LCP' ? path : normalizePath(window.location.pathname),
      })),
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
