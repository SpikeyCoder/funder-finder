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
// it's hidden with a changed value. Generous enough for an office of
// visitors behind one IP; the board is protected by the sweep's card caps.
const RATE_LIMITS = { crash: 30, vitals: 120 } as const;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const VITAL_LIMITS: Record<string, number> = { LCP: 600_000, INP: 600_000, CLS: 100 };
const RATINGS = new Set(["good", "needs-improvement", "poor"]);
const KINDS = new Set(["boundary", "error", "rejection"]);

export interface CrashInsert {
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

// Short words a message really contains, as opposed to minified names.
const WORDS = new Set(["a", "an", "as", "at", "be", "by", "do", "id", "if", "in", "is", "it", "no", "of", "on", "or", "to", "up"]);
const minified = (name: string) => /^[A-Za-z_$][\w$]?$/.test(name) && !WORDS.has(name.toLowerCase());
// A short word followed by member access or a call, or the subject of the
// message ("a is not a function"), is a name, not a word.
const usedAsName = (next: string | undefined, atStart: boolean, rest: string) =>
  /^[.([]/.test(next ?? "") || (atStart && /^ is\b/.test(rest));

// A quoted part of a message: kept if it's a short identifier or dotted
// path ("reading 'name'" and "reading 'map'" are different bugs), with
// minified segments of a dotted path replaced (Safari quotes whole
// expressions: 'n.current.focus'); anything else is a value.
function quoted(q: string, inner: string): string {
  if (inner === "<id>") return q + inner + q; // already replaced
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
    // A variable named in a TDZ error is a minified name, quoted or not:
    // "Cannot access 'Xt' before initialization" (Chrome), "can't access
    // lexical declaration 'Xt' before initialization" (Firefox).
    .replace(/(access (?:lexical declaration )?)(["'`])[A-Za-z_$][\w$]?\2/gi, "$1$2<id>$2")
    // A quote right after a letter is an apostrophe ("can't"), not a quote.
    .replace(/(?<![A-Za-z])(["'`])(.*?)\1/g, (_m, q, inner) => quoted(q, inner))
    // Unquoted too: Firefox says "t.current is null". A short word is a name
    // where it's used as one ("a is not a function", "in.x is null").
    .replace(/(^|[^\w$'"`<])([A-Za-z_$][\w$]?)(?=([^\w$'"`>]|$))/g, (m, pre, tok, next, offset, all) =>
      minified(tok) || (/^[A-Za-z_$][\w$]?$/.test(tok) && usedAsName(next, offset === 0 && pre === "", all.slice(offset + m.length)))
        ? `${pre}<id>`
        : m)
    .replace(/\b0x[0-9a-f]+\b/gi, "<n>")
    // Numbered error codes stay: React's "Minified React error #418" and
    // "#310" are different bugs, and so are "status code 401" and "… 500".
    .replace(/(?<![#\d])\d+/g, (d, offset: number, all: string) =>
      /^[1-5]\d\d$/.test(d) && /(?:status|code|http)\W*$/i.test(all.slice(Math.max(0, offset - 16), offset)) ? d : "<n>")
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
      // Vite's hashes are exactly 8 base64url characters, so they can contain
      // - and _: OrgSearch-BrsvDQt6.js, LoginPage-DK1D-7OR.js → OrgSearch.js,
      // LoginPage.js. Exactly 8, anchored to the end, so a hyphenated name
      // keeps its own parts (ab-cd-AbC12345.js → ab-cd.js).
      file = m[1].replace(/-[\w-]{8}(\.(?:js|mjs|cjs))$/, "$1");
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
export async function parseCrash(b: Record<string, unknown>, userAgent: string): Promise<CrashInsert | string> {
  const kind = str(b.kind, 20);
  if (!KINDS.has(kind)) return "Invalid kind";
  // Scrub before cutting: a cut can leave half an address the pattern misses.
  const message = scrub(str(b.message, 2000)).slice(0, 500);
  const name = scrub(str(b.name, 200)).slice(0, 100) || "Error";
  const stack = scrub(str(b.stack, 8000)).slice(0, 4000);
  // The validated values: a non-string stack is no stack.
  if (!message && !stack) return "Empty report";
  return {
    fingerprint: await fingerprint(name, message, stack),
    kind,
    name,
    message,
    stack,
    component_stack: scrub(str(b.componentStack, 4000)).slice(0, 2000),
    path: normalizePath(str(b.path, 500) || "/"),
    release: release(b.release),
    user_agent: userAgent.slice(0, 300),
  };
}

/** A vitals report as rows (possibly none), or an error message. */
export function parseVitals(b: Record<string, unknown>): VitalRow[] | string {
  // Up to two of each metric: after a back/forward-cache restore, one batch
  // can hold an older page view's metric and the new view's (different ids).
  if (!Array.isArray(b.metrics) || b.metrics.length > 6) return "Invalid metrics";
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
    if (seen.has(id)) return "Invalid id";
    if (!Object.hasOwn(VITAL_LIMITS, metric)) return "Invalid metric";
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > VITAL_LIMITS[metric]) {
      return "Invalid value";
    }
    if (!RATINGS.has(rating)) return "Invalid rating";
    seen.add(id);
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

    if (body.type !== "crash" && body.type !== "vitals") return reply(400, "Invalid type");
    // Rate-limit before the parsing, scrubbing and hashing below, so the
    // limit caps each caller's CPU as well as their writes. (A malformed
    // report counts too: only well-formed JSON of a known type gets here.)
    const kind = body.type;
    const limited = await ipRateLimit(req, {
      namespace: `monitor-report:${kind}`,
      limit: RATE_LIMITS[kind],
      windowMs: RATE_WINDOW_MS,
      extraHeaders: headers,
    });
    if (!limited.allow && limited.response) return limited.response;

    let write: () => Promise<Response>;
    if (kind === "crash") {
      const row = await parseCrash(body, req.headers.get("user-agent") ?? "");
      if (typeof row === "string") return reply(400, row);
      write = () => rest("rpc/record_client_crash", Object.fromEntries(Object.entries(row).map(([k, v]) => [`p_${k}`, v])));
    } else {
      const rows = parseVitals(body);
      if (typeof rows === "string") return reply(400, rows);
      if (rows.length === 0) return reply(204);
      // A changed value for a metric id replaces the earlier one.
      write = () => rest("monitor_vitals?on_conflict=metric_id", rows, "resolution=merge-duplicates,return=minimal");
    }

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
