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
// Privacy: no user id, IP or query string is sent. Email addresses in error
// text are masked here and again on the server.
import { onCLS, onINP, onLCP, type Metric } from 'web-vitals';
import { currentBuild, isChunkLoadError } from './chunkReload';

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
  metrics: { name: string; value: number; rating: string }[];
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// Local part can't span URL syntax, so "…?email=eq.a@b.org" masks just the address.
const EMAIL = /[^\s@<>"'()/:?=&#]+@[^\s@<>"'()/?=&#]+\.[a-z]{2,}/gi;

/** Mask email addresses and drop query strings and fragments from URLs. */
export function scrub(text: string): string {
  // Query strings first: they're where addresses most often hide in URLs.
  return text
    .replace(/(https?:\/\/[^\s?#)"']*)[?#][^\s)"']*/gi, '$1')
    .replace(EMAIL, '[email]');
}

/**
 * Collapse ids in a path so one route is one key: /recipient/<uuid> and
 * /funder/123456789 become /recipient/:id and /funder/:id.
 */
export function normalizePath(pathname: string): string {
  const path = pathname
    .split('/')
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d[\d-]{3,}$/.test(seg)
        ? ':id'
        : seg,
    )
    .join('/');
  return (path.length > 1 ? path.replace(/\/+$/, '') : path).slice(0, 200) || '/';
}

/**
 * Errors that aren't ours to fix: browser extensions, the opaque
 * cross-origin "Script error.", ResizeObserver's benign loop warning, and
 * chunk-load failures (ErrorBoundary reloads for those; see chunkReload.ts)
 * unless the reload already happened and didn't help (`chunkGaveUp`).
 */
export function isNoise(error: unknown, message: string, stack: string, chunkGaveUp = false): boolean {
  if (isChunkLoadError(error)) return !chunkGaveUp;
  if (/^Script error\.?$/i.test(message.trim())) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  return /(?:chrome|moz|safari(?:-web)?)-extension:\/\//i.test(stack);
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
  if (isNoise(error, message, stack, chunkGaveUp)) return null;
  return {
    type: 'crash',
    kind,
    name: name.slice(0, 100),
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

  // Core Web Vitals, one report per page view, sent when the page is hidden
  // (web-vitals finalises LCP, CLS and INP then; its listeners are registered
  // first, so they run before the flush below).
  const metrics = new Map<string, Metric>();
  const record = (m: Metric) => metrics.set(m.name, m);
  onLCP(record);
  onINP(record);
  onCLS(record);
  // SPA navigations keep the first page's path: vitals describe the page load.
  const path = normalizePath(window.location.pathname);
  let flushed = false;
  const flush = () => {
    if (flushed || metrics.size === 0) return;
    flushed = true;
    send({
      type: 'vitals',
      path,
      release: currentBuild().slice(0, 100),
      metrics: [...metrics.values()].map((m) => ({ name: m.name, value: m.value, rating: m.rating })),
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
