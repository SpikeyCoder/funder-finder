interface GoatCounterCountVars {
  path?: string;
  title?: string;
  event?: boolean;
}

interface GoatCounterGlobal {
  no_onload?: boolean;
  count?: (vars?: GoatCounterCountVars) => void;
}

declare global {
  interface Window {
    goatcounter?: GoatCounterGlobal;
  }
}

const DEFAULT_GOATCOUNTER_ENDPOINT = 'https://fundermatch.goatcounter.com/count';
const GOATCOUNTER_ENDPOINT =
  (import.meta.env.VITE_GOATCOUNTER_ENDPOINT as string | undefined)?.trim() ||
  DEFAULT_GOATCOUNTER_ENDPOINT;

const GOATCOUNTER_SCRIPT_SRC = 'https://gc.zgo.at/count.js';
const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 100;

let goatCounterInitialized = false;
let pendingReadyCheck: Promise<((vars?: GoatCounterCountVars) => void) | null> | null = null;

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function waitForCounter(): Promise<((vars?: GoatCounterCountVars) => void) | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);

  const count = window.goatcounter?.count;
  if (count) return Promise.resolve(count);

  if (pendingReadyCheck) return pendingReadyCheck;

  pendingReadyCheck = new Promise(resolve => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const readyCount = window.goatcounter?.count;
      if (readyCount) {
        window.clearInterval(timer);
        pendingReadyCheck = null;
        resolve(readyCount);
        return;
      }

      if (Date.now() - startedAt >= READY_TIMEOUT_MS) {
        window.clearInterval(timer);
        pendingReadyCheck = null;
        resolve(null);
      }
    }, READY_POLL_MS);
  });

  return pendingReadyCheck;
}

function sendCount(vars: GoatCounterCountVars): void {
  void waitForCounter().then(count => {
    if (!count) return;
    count(vars);
  });
}

function outboundPath(url: URL): string {
  const trimmedPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `/event/outbound/${url.hostname}${trimmedPath}`;
}

export function initGoatCounter(): void {
  if (typeof window === 'undefined' || goatCounterInitialized) return;

  goatCounterInitialized = true;
  window.goatcounter = window.goatcounter || {};
  window.goatcounter.no_onload = true;

  const existingScript = document.querySelector<HTMLScriptElement>('script[data-goatcounter]');
  if (existingScript) {
    if (!existingScript.dataset.goatcounter) {
      existingScript.dataset.goatcounter = GOATCOUNTER_ENDPOINT;
    }
    return;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = GOATCOUNTER_SCRIPT_SRC;
  script.dataset.goatcounter = GOATCOUNTER_ENDPOINT;
  document.head.appendChild(script);
}

export function trackPageView(path: string, title?: string): void {
  sendCount({
    path: normalizePath(path),
    title,
  });
}

export function trackEvent(path: string, title?: string): void {
  sendCount({
    path: normalizePath(path),
    title,
    event: true,
  });
}

export function trackOutboundClick(targetUrl: string, label?: string): void {
  try {
    const parsed = new URL(targetUrl);
    trackEvent(outboundPath(parsed), label || parsed.hostname);
  } catch {
    // Ignore invalid outbound URLs so tracking never interrupts UX.
  }
}

export function trackSaveListAccess(): void {
  trackEvent('/event/save-list-access', 'Saved List Access');
}
