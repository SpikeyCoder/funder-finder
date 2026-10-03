/**
 * monitor-report — Supabase Edge Function (public)
 *
 * FM-2026-10-03-02. Receives the browser's automatic crash and Core Web
 * Vitals reports (src/lib/monitoring.ts) and records them; monitor-sweep
 * turns them into Trello cards (see migration 20261003140000).
 *
 * Public (verify_jwt=false) like report-bug: crashes happen to signed-out
 * visitors too. The body is JSON sent as text/plain, so the browser can send
 * it as a CORS simple request with keepalive while the page unloads.
 *
 * Abuse: reports are validated, capped in size and rate-limited per IP
 * (crashes and vitals separately, so page views can't use up the budget for
 * crashes). This function never calls Trello, and the sweep opens at most 10
 * crash cards a day plus one summary, so flooding it can't flood the board.
 *
 * Privacy: no user id or IP is stored. Paths lose ids and query strings, and
 * email addresses in error text are masked (again; the browser does it too).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";
import { corsHeaders } from "../_shared/cors.ts";
// The browser scrubs with the same module; redone here because reports are untrusted.
import { normalizePath, scrub } from "../_shared/monitor_scrub.ts";

export { normalizePath, scrub };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const MAX_BODY_BYTES = 16 * 1024;
// A page load sends at most 5 crash reports, and a vitals report each time
// it's hidden with a changed value.
const RATE_LIMITS = { crash: 10, vitals: 120 } as const;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const VITAL_LIMITS: Record<string, number> = { LCP: 600_000, INP: 600_000, CLS: 100 };
const RATINGS = new Set(["good", "needs-improvement", "poor"]);
const KINDS = new Set(["boundary", "error", "rejection"]);

export interface CrashRow {
  fingerprint: string;
  kind: string;
  name: string;
  message: string;
  stack: string;
  component_stack: string;
  path: string;
  release: string;
  user_agent: string;
}

export interface VitalRow {
  metric_id: string;
  metric: string;
  value: number;
  rating: string;
  path: string;
  release: string;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// Local part can't span URL syntax, so "…?email=eq.a@b.org" masks just the address.
// Short words a message really contains, as opposed to minified names.
const WORDS = new Set(["a", "an", "as", "at", "be", "by", "do", "id", "if", "in", "is", "it", "no", "of", "on", "or", "to", "up"]);
const minified = (name: string) => /^[A-Za-z_$][\w$]?$/.test(name) && !WORDS.has(name.toLowerCase());

// A quoted part of a message: kept if it's a short identifier or dotted
// path ("reading 'name'" and "reading 'map'" are different bugs), with
// minified segments of a dotted path replaced (Safari quotes whole
// expressions: 'n.current.focus'); anything else is a value.
function quoted(q: string, inner: string): string {
  if (!/^[A-Za-z_$][\w$.-]{0,39}$/.test(inner)) return "<str>";
  if (!inner.includes(".")) return q + inner + q;
  return q + inner.split(".").map((seg) => (minified(seg) ? "<id>" : seg)).join(".") + q;
}

/**
 * A message with its values taken out but its meaning kept: URLs and
 * value-like quoted strings go, identifier-like ones stay (see quoted());
 * one- and two-letter names, which are what minifying produces ("Xt is not
 * a function"), become <id>; numbers become <n>.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(["'`])(.*?)\1/g, (_m, q, inner) => quoted(q, inner))
    // Unquoted too: Firefox says "t.current is null".
    .replace(/(^|[^\w$'"`<])([A-Za-z_$][\w$]?)(?=[^\w$'"`>]|$)/g, (m, pre, tok) => (minified(tok) ? `${pre}<id>` : m))
    .replace(/\b0x[0-9a-f]+\b/gi, "<n>")
    .replace(/\d+/g, "<n>")
    .trim();
}

/**
 * The parts of a crash that identify its kind across occurrences and
 * deploys: the error name, the normalized message, and the file of the top
 * stack frame that has one, without its build hash. Not the function name
 * or line: minifying renames and moves those on every build.
 */
export function fingerprintSource(name: string, message: string, stack: string): string {
  const msg = normalizeMessage(message);
  // V8 "at fn (url:1:2)", Firefox/Safari "fn@url:1:2".
  let file = "";
  for (const line of stack.split("\n")) {
    const m = line.match(/(?:https?:\/\/[^/\s)]+)?(\/[^\s():?#]+\.(?:js|mjs|cjs|ts|tsx))(?::\d+)?/);
    if (m) {
      // Vite's hashes are base64url, so they can contain - and _:
      // OrgSearch-BrsvDQt6.js, LoginPage-DK1D-7OR.js → OrgSearch.js, LoginPage.js.
      file = m[1].replace(/-[\w-]{6,12}(\.(?:js|mjs|cjs))$/, "$1");
      break;
    }
  }
  return `${name}|${msg}|${file}`;
}

export async function fingerprint(name: string, message: string, stack: string): Promise<string> {
  const data = new TextEncoder().encode(fingerprintSource(name, message, stack));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const release = (v: unknown): string => {
  const r = str(v, 100);
  return /^[\w.-]*$/.test(r) ? r : "";
};

/** A crash report as a row, or an error message. */
export async function parseCrash(b: Record<string, unknown>, userAgent: string): Promise<CrashRow | string> {
  const kind = str(b.kind, 20);
  if (!KINDS.has(kind)) return "Invalid kind";
  const message = scrub(str(b.message, 500));
  const name = str(b.name, 100) || "Error";
  if (!message && !b.stack) return "Empty report";
  const stack = scrub(str(b.stack, 4000));
  return {
    fingerprint: await fingerprint(name, message, stack),
    kind,
    name,
    message,
    stack,
    component_stack: scrub(str(b.componentStack, 2000)),
    path: normalizePath(str(b.path, 500) || "/"),
    release: release(b.release),
    user_agent: userAgent.slice(0, 300),
  };
}

/** A vitals report as rows (possibly none), or an error message. */
export function parseVitals(b: Record<string, unknown>): VitalRow[] | string {
  if (!Array.isArray(b.metrics) || b.metrics.length > 3) return "Invalid metrics";
  const path = normalizePath(str(b.path, 500) || "/");
  const rows: VitalRow[] = [];
  const seen = new Set<string>();
  for (const m of b.metrics as Record<string, unknown>[]) {
    const metric = str(m?.name, 10);
    const value = m?.value;
    const rating = str(m?.rating, 20);
    // web-vitals ids look like "v5-1696300000000-1234567890123".
    const id = str(m?.id, 80);
    if (!/^v\d+-[\w.-]{6,}$/.test(id)) return "Invalid id";
    if (!Object.hasOwn(VITAL_LIMITS, metric) || seen.has(metric)) return "Invalid metric";
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > VITAL_LIMITS[metric]) {
      return "Invalid value";
    }
    if (!RATINGS.has(rating)) return "Invalid rating";
    seen.add(metric);
    // Per metric (INP/CLS can belong to a later page than LCP); the report's
    // path for older clients.
    const mPath = typeof m?.path === "string" ? normalizePath(str(m.path, 500)) : path;
    rows.push({ metric_id: id, metric, value, rating, path: mPath, release: release(b.release) });
  }
  return rows;
}

/** The body as text, or null if it's over `max` bytes (stops reading there). */
export async function readLimited(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ── Handler ─────────────────────────────────────────────────────────────────

function rest(path: string, body: unknown, prefer = "return=minimal"): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

if (import.meta.main) {
  Deno.serve(async (req: Request) => {
    const headers = corsHeaders(req.headers.get("origin"), { methods: "POST, OPTIONS" });
    const reply = (status: number, error?: string) =>
      new Response(error ? JSON.stringify({ error }) : null, {
        status,
        headers: error ? { ...headers, "Content-Type": "application/json" } : headers,
      });

    if (req.method === "OPTIONS") return new Response("ok", { headers });
    if (req.method !== "POST") return reply(405, "Method not allowed");

    const text = await readLimited(req, MAX_BODY_BYTES);
    if (text === null) return reply(413, "Report too large");
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, "Invalid report");
      body = parsed;
    } catch {
      return reply(400, "Invalid JSON");
    }

    let write: () => Promise<Response>;
    if (body.type === "crash") {
      const row = await parseCrash(body, req.headers.get("user-agent") ?? "");
      if (typeof row === "string") return reply(400, row);
      write = () => rest("rpc/record_client_crash", Object.fromEntries(Object.entries(row).map(([k, v]) => [`p_${k}`, v])));
    } else if (body.type === "vitals") {
      const rows = parseVitals(body);
      if (typeof rows === "string") return reply(400, rows);
      if (rows.length === 0) return reply(204);
      // A changed value for a metric id replaces the earlier one.
      write = () => rest("monitor_vitals?on_conflict=metric_id", rows, "resolution=merge-duplicates,return=minimal");
    } else {
      return reply(400, "Invalid type");
    }

    // Only valid reports count against the limit.
    const kind = body.type as keyof typeof RATE_LIMITS;
    const limited = await ipRateLimit(req, {
      namespace: `monitor-report:${kind}`,
      limit: RATE_LIMITS[kind],
      windowMs: RATE_WINDOW_MS,
      extraHeaders: headers,
    });
    if (!limited.allow && limited.response) return limited.response;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error("monitor-report: SUPABASE_URL / SERVICE_ROLE_KEY unset");
      return reply(500, "Internal server error");
    }
    try {
      const res = await write();
      if (!res.ok) {
        console.error("monitor-report: write failed", res.status, await res.text());
        return reply(502, "Could not record the report");
      }
      return reply(204);
    } catch (err) {
      console.error("monitor-report error:", err);
      return reply(500, "Internal server error");
    }
  });
}
