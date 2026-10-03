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
 * Abuse: reports are validated, capped in size and rate-limited per IP; this
 * function never calls Trello, and the sweep opens at most 5 crash cards per
 * run, so flooding it can't flood the board.
 *
 * Privacy: no user id or IP is stored. Paths lose ids and query strings, and
 * email addresses in error text are masked (again; the browser does it too).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const MAX_BODY_BYTES = 16 * 1024;
// A page load sends one vitals report and at most 5 crash reports.
const RATE_LIMIT = 30;
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
  metric: string;
  value: number;
  rating: string;
  path: string;
  release: string;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// Local part can't span URL syntax, so "…?email=eq.a@b.org" masks just the address.
const EMAIL = /[^\s@<>"'()/:?=&#]+@[^\s@<>"'()/?=&#]+\.[a-z]{2,}/gi;

export function scrub(text: string): string {
  // Query strings first: they're where addresses most often hide in URLs.
  return text
    .replace(/(https?:\/\/[^\s?#)"']*)[?#][^\s)"']*/gi, "$1")
    .replace(EMAIL, "[email]");
}

/** Same as the browser's normalizePath: ids become :id, no query string. */
export function normalizePath(path: string): string {
  const bare = path.split(/[?#]/)[0];
  const norm = bare
    .split("/")
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d[\d-]{3,}$/.test(seg)
        ? ":id"
        : seg
    )
    .join("/");
  return (norm.length > 1 ? norm.replace(/\/+$/, "") : norm).slice(0, 200) || "/";
}

/**
 * The parts of a crash that identify its kind across occurrences and
 * deploys: the error name, the message with values taken out, and the top
 * stack frame without line numbers or the build hash in chunk names.
 */
export function fingerprintSource(name: string, message: string, stack: string): string {
  const msg = message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(["'`]).*?\1/g, "<str>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<n>")
    .replace(/\d+/g, "<n>")
    .trim();
  const frame = stack
    .split("\n")
    .map((l) => l.trim())
    // V8 "at fn (url:1:2)", Firefox/Safari "fn@url:1:2"; skip the message line.
    .find((l) => /^at\s/.test(l) || /@\S+:\d+/.test(l)) ?? "";
  const top = frame
    .replace(/https?:\/\/[^/\s)]+/g, "")            // origin
    .replace(/-[A-Za-z0-9_]{6,12}(\.(?:js|mjs|css))/g, "$1") // index-BrsvDQt6.js → index.js
    .replace(/:\d+(?::\d+)?/g, "");                 // :line:col
  return `${name}|${msg}|${top}`;
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
    if (!(metric in VITAL_LIMITS) || seen.has(metric)) return "Invalid metric";
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > VITAL_LIMITS[metric]) {
      return "Invalid value";
    }
    if (!RATINGS.has(rating)) return "Invalid rating";
    seen.add(metric);
    rows.push({ metric, value, rating, path, release: release(b.release) });
  }
  return rows;
}

// ── Handler ─────────────────────────────────────────────────────────────────

function rest(path: string, body: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
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

    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return reply(413, "Report too large");
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
      write = () => rest("monitor_vitals", rows);
    } else {
      return reply(400, "Invalid type");
    }

    // Only valid reports count against the limit.
    const limited = await ipRateLimit(req, {
      namespace: "monitor-report",
      limit: RATE_LIMIT,
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
