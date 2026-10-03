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
import { onCLS, onINP, onLCP, type Metric } from 'web-vitals';
import { currentBuild, isChunkLoadError } from './chunkReload';
// Shared with the monitor-report Edge Function, so both scrub the same way.
import { FRAME, errorTypeName, normalizePath, scrub } from '../../supabase/functions/_shared/monitor_scrub.ts';
import { SUPABASE_URL } from './supabaseProject';

const ENDPOINT = `${SUPABASE_URL}/functions/v1/monitor-report`;

// One page (route) can't send more than this many crash reports (a render
// loop would otherwise send one per frame); the same crash is sent once a
// tab.
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
  // `seq` orders a metric's reports within the page view, so the server
  // ignores one that arrives after a newer one.
  metrics: { id: string; name: string; value: number; rating: string; path: string; seq: number }[];
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
  // Thrown from an extension: its top frame (the first with a URL) is the
  // extension's. Not just any frame: an extension that wraps fetch or
  // addEventListener appears below our own frames in real app crashes.
  const topFrame = stack.split('\n').find((line) => FRAME.test(line) && /\w+:\/\//.test(line)) ?? '';
  if (/(?:chrome|moz|safari(?:-web)?)-extension:\/\//i.test(topFrame)) return true;
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
      return { name: errorTypeName(e.name), message: e.message, stack: typeof e.stack === 'string' ? e.stack : '' };
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
  described = describe(error),
): CrashReport | null {
  const { name, message, stack } = described;
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
// Resolves to 'failed' (no response, or a server error: worth sending
// again), 'rate-limited' (back off), or 'done' (delivered, or a 400 or 413
// that would fail again); never rejects.
type SendResult = 'done' | 'rate-limited' | 'failed';

function send(payload: CrashReport | VitalsReport): Promise<SendResult> {
  try {
    return fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    }).then(
      (res): SendResult => (res.status === 429 ? 'rate-limited' : res.status >= 500 ? 'failed' : 'done'),
      (): SendResult => 'failed',
    );
  } catch {
    // Reporting must never break the page.
    return Promise.resolve('failed');
  }
}

// The running build, which can't change during the page's life.
let runningBuild: string | null = null;
const build = () => (runningBuild ??= currentBuild());

const sentCrashes = new Set<string>();
// Crashes already sent again once after a failed send: not again.
const resentCrashes = new Set<string>();
// Raw errors already seen, so a crash thrown every frame skips the
// scrubbing below after the first time.
const seenRaw = new Set<string>();
// Reports sent from the current route (ids aside: /funder/1 and /funder/2
// are one route); navigating to another route starts over.
let pageReports = { path: '', count: 0 };

export function reportCrash(kind: CrashKind, error: unknown, componentStack = '', chunkGaveUp = false): void {
  if (!enabled()) return;
  try {
    const path = window.location.pathname;
    const route = normalizePath(path);
    if (pageReports.path !== route) pageReports = { path: route, count: 0 };
    if (pageReports.count >= MAX_CRASHES_PER_PAGE) return;
    const raw = describe(error);
    const rawKey = `${route}|${kind}|${raw.name}|${raw.message.slice(0, 200)}|${raw.stack.split('\n', 3).join('|').slice(0, 400)}`;
    if (seenRaw.has(rawKey)) return;
    if (seenRaw.size >= 200) seenRaw.clear(); // bounded; starts over when full
    seenRaw.add(rawKey);
    const report = buildCrashReport(kind, error, path, build(), componentStack, chunkGaveUp, raw);
    if (!report) return;
    // Once a tab per crash, plus once more if it later brings up the error
    // screen, so the server learns it did (the card says so).
    const key = `${kind === 'boundary' ? 'boundary|' : ''}${report.name}|${report.message}|${report.stack.split('\n', 3).join('|')}`;
    if (sentCrashes.has(key)) return;
    sentCrashes.add(key);
    const counter = pageReports;
    counter.count++;
    void send(report).then((result) => {
      // Lost (offline, server error): the next time it happens it's sent
      // once more, without using up the route's cap. Not when rate-limited:
      // that means back off.
      if (result !== 'failed' || resentCrashes.has(key)) return;
      resentCrashes.add(key);
      sentCrashes.delete(key);
      seenRaw.delete(rawKey);
      if (pageReports === counter) counter.count--;
    });
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
    // ("Uncaught …" in Chrome and Safari, "uncaught exception: …" in Firefox.)
    const m = /^(?:uncaught (?:exception: )?)?(?:(\w*(?:Error|Exception)): )?(.*)$/is.exec(event.message || '');
    // `throw undefined`, `throw null`, `throw false`, `throw 0`: nothing to
    // go on, as for an empty rejection.
    if (!m || (!m[1] && /^(?:undefined|null|true|false|NaN|-?Infinity|[-+\d.e]*)$/i.test(m[2].trim()))) return;
    reportCrash('error', { name: m[1] || 'Error', message: m[2], stack: `    at ${event.filename}:${event.lineno}:${event.colno}` });
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
  // what made it slow.) CLS is the worst session window of shifts (at most
  // 5 s long), and its value changes when the current window becomes the
  // worst, so the route then is that window's.
  let loadedPath = normalizePath(window.location.pathname);
  // The current route, recomputed only when the pathname changes (CLS and
  // INP call back often).
  let lastPathname = '';
  let lastRoute = '';
  const currentRoute = () => {
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      lastRoute = normalizePath(lastPathname);
    }
    return lastRoute;
  };
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) loadedPath = normalizePath(window.location.pathname);
  });
  // Snapshots, not the Metric objects: web-vitals updates one object in
  // place, so a report that failed must be compared by the value it sent.
  type Sample = VitalsReport['metrics'][number];
  const pending = new Map<string, Sample>();
  const sentValues = new Map<string, number>();
  let seq = 0;
  const record = (m: Metric) => {
    if (sentValues.get(m.id) === m.value) {
      // Back to what was sent (INP can go down): nothing newer to send.
      pending.delete(m.id);
      return;
    }
    const path = m.name === 'LCP' ? loadedPath : currentRoute();
    pending.set(m.id, { id: m.id, name: m.name, value: m.value, rating: m.rating, path, seq: ++seq });
  };
  // Part of the entry bundle (about 2 KB), not loaded later: a visitor who
  // gives up on a slow load before a separate chunk arrived would send no
  // LCP, and those are the poor loads the p75 is meant to catch.
  onLCP(record, { reportAllChanges: true });
  onINP(record, { reportAllChanges: true });
  onCLS(record, { reportAllChanges: true });
  const flush = () => {
    if (pending.size === 0) return;
    const metrics = [...pending.values()];
    pending.clear();
    for (const s of metrics) sentValues.set(s.id, s.value);
    // At most 6 metrics a report (the server's limit): re-queued ones and a
    // back/forward-cache restore's new ids can add up to more.
    for (let i = 0; i < metrics.length; i += 6) {
      const batch = metrics.slice(i, i + 6);
      void send({
        type: 'vitals',
        release: build().slice(0, 100),
        metrics: batch,
      }).then((result) => {
        // Lost (offline, over the keepalive budget, server error): send
        // these again on the next hide, unless newer values came in. Not if
        // rate-limited: that means back off, and samples can be spared.
        if (result !== 'failed') return;
        for (const s of batch) {
          if (sentValues.get(s.id) !== s.value) continue; // a newer value went since
          sentValues.delete(s.id);
          if (!pending.has(s.id)) pending.set(s.id, s);
        }
      });
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
