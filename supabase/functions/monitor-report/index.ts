/**
 * monitor-report — Supabase Edge Function (public)
 *
 * FM-2026-10-03-02. Receives the browser's automatic crash and Core Web
 * Vitals reports (src/lib/monitoring.ts) and records them; monitor-sweep
 * turns them into Trello cards (see migration 20261003140000).
 *
 * Public like report-bug: crashes happen to signed-out visitors too. Deploy
 * with `--no-verify-jwt`: the browser sends no key or JWT (the body is JSON
 * sent as text/plain, so it goes as a CORS simple request with keepalive
 * while the page unloads), so with JWT verification on, the gateway answers
 * every report 401 and nothing is recorded, silently.
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// The client caps fields by characters (about 6,600 in all); in bytes that
// can be several times more (3-byte CJK, 6-byte \uXXXX JSON escapes).
const MAX_BODY_BYTES = 48 * 1024;
// A page load sends at most 5 crash reports, and a vitals report each time
// it's hidden with a changed value. Generous enough for an office, school or
// mobile carrier's visitors behind one IP; the board is protected by the
// sweep's card caps.
const RATE_LIMITS = { crash: 120, vitals: 600 } as const;
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
const WORDS = new Set([
  "a", "am", "an", "as", "at", "be", "by", "do", "go", "he", "id", "if", "in", "is", "it", "me", "my", "no", "of", "ok", "on",
  "or", "so", "to", "up", "us", "we",
  // Units.
  "gb", "kb", "mb", "ms", "px",
]);
const minified = (name: string) => /^[A-Za-z_$][\w$]?$/.test(name) && !WORDS.has(name.toLowerCase());
// A short word followed by member access or a call, or the subject of an
// "is" ("a is not a function", Firefox's "…, a is undefined"), is a name,
// not a word.
const usedAsName = (next: string | undefined, rest: string) =>
  /^[.([]/.test(next ?? "") || /^ is\b/.test(rest);

// A quoted part of a message: kept if it's a short identifier or dotted
// path ("reading 'name'" and "reading 'map'" are different bugs), with
// minified segments of a dotted path replaced (Safari quotes whole
// expressions: 'n.current.focus'); anything else is a value.
function quoted(q: string, inner: string): string {
  if (inner === "<id>") return q + inner + q; // already replaced
  if (!/^[A-Za-z_$][\w$.-]{0,39}$/.test(inner)) return "<str>";
  // A long token with digits in it is an id ('abcdef1234', 'a1b2c3d4…').
  if (inner.length >= 8 && /\d/.test(inner) && !inner.includes(".")) return "<str>";
  if (!inner.includes(".")) return q + inner + q;
  // A dotted path starts with a variable, which minifying renames (even to
  // a word like 'a'); the property names after it keep their names.
  const [first, ...props] = inner.split(".");
  return q + [/^[A-Za-z_$][\w$]?$/.test(first) ? "<id>" : first, ...props].join(".") + q;
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
    // Ids: UUIDs and other hex runs with both digits and letters.
    .replace(/\b(?=[\da-f-]*\d)(?=[\da-f-]*[a-f])[\da-f]+(?:-[\da-f]+)*\b/gi, (m) => (m.replace(/-/g, "").length >= 8 ? "<hex>" : m))
    // What a JSON parse choked on is the response, not the bug: "Unexpected
    // token 'N', "Not Found" is not valid JSON" and "… '<', "<!DOCTYPE"…"
    // are the same missing res.ok check.
    // Only a token itself: quoted, a run of symbols ("<"), or one character
    // ("Unexpected token o in JSON"); not a word ("unexpected character at
    // line 1").
    .replace(/\b(Unexpected (?:token|identifier|character))\s+(?:(["'`]).*?\2|[^\s\w,]+|\w(?=[\s,]|$))/gi, "$1 <tok>")
    // A variable named in a TDZ error is a minified name, quoted or not:
    // "Cannot access 'Xt' before initialization" (Chrome), "can't access
    // lexical declaration 'Xt' before initialization" (Firefox).
    .replace(/(access (?:lexical declaration )?)(["'`])[A-Za-z_$][\w$]?\2/gi, "$1$2<id>$2")
    // A quote right after a letter is an apostrophe ("can't"), not a quote.
    .replace(/(?<![A-Za-z])(["'`])(.*?)\1/g, (_m, q, inner) => quoted(q, inner))
    // Chrome marks a cut-off quoted excerpt: "Internal S"...
    .replace(/<str>\.\.\./g, "<str>")
    // Unquoted too: Firefox says "t.current is null". A short word is a name
    // where it's used as one ("a is not a function", "in.x is null"); one
    // after a dot is a property, which keeps its name.
    .replace(/(^|[^\w$'"`<.])([A-Za-z_$][\w$]?)(?=([^\w$'"`>]|$))/g, (m, pre, tok, next, offset, all) =>
      minified(tok) || (/^[A-Za-z_$][\w$]?$/.test(tok) && usedAsName(next, all.slice(offset + m.length)))
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
export function fingerprintSource(name: string, message: string, stack: string, msg = normalizeMessage(message)): string {
  // Frames only: V8's stack starts with "Name: message", and a URL in the
  // message isn't where it was thrown.
  let file = "";
  for (const line of stack.split("\n")) {
    if (!FRAME.test(line)) continue;
    const m = line.match(/(?:https?:\/\/[^/\s)]+)?(\/[^\s():?#]+\.(?:js|mjs|cjs|ts|tsx))(?::\d+)?/);
    if (m) {
      // Vite's hashes are exactly 8 base64url characters, so they can contain
      // - and _: OrgSearch-BrsvDQt6.js, LoginPage-DK1D-7OR.js → OrgSearch.js,
      // LoginPage.js. Exactly 8, anchored to the end, so a hyphenated name
      // keeps its own parts (ab-cd-AbC12345.js → ab-cd.js).
      // A hash has an uppercase letter, digit, - or _ in it (all but 0.07%
      // of them do), which keeps names like use-debounce.js whole.
      file = m[1].replace(/-(?=[\w-]{0,7}[A-Z\d_-])[\w-]{8}(\.(?:js|mjs|cjs))$/, "$1");
      break;
    }
  }
  return `${name}|${msg}|${file}`;
}

// A stack frame line: V8 "    at fn (url:1:2)"; Firefox/Safari "fn@url:1:2"
// (no spaces before the @, unlike a message that mentions "@scope/pkg",
// except Safari's "global code@…" and the like).
const FRAME = /^\s*at\s|^(?:[^\s@]*|(?:global|module|eval) code)@\S/;

export async function fingerprint(name: string, message: string, stack: string, msg?: string): Promise<string> {
  const data = new TextEncoder().encode(fingerprintSource(name, message, stack, msg));
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
  const normalized = normalizeMessage(message);
  return {
    fingerprint: await fingerprint(name, message, stack, normalized),
    kind,
    name,
    // Stored without its values (quoted strings, numbers, ids, URLs), which
    // can echo what a visitor typed or a response held; the stack keeps
    // only its frames, since V8's starts with the message.
    message: normalized,
    stack: stack.split("\n").filter((l) => FRAME.test(l)).join("\n"),
    component_stack: scrub(str(b.componentStack, 4000)).slice(0, 2000),
    path: normalizePath(str(b.path, 500) || "/"),
    release: release(b.release),
    user_agent: userAgent.slice(0, 300),
  };
}

/**
 * A vitals report as rows (possibly none), or an error message. A bad
 * metric is skipped, not the batch: one out-of-range value (a very slow
 * load) mustn't lose the good ones with it. All bad is an error.
 */
export function parseVitals(b: Record<string, unknown>): VitalRow[] | string {
  // Up to two of each metric: after a back/forward-cache restore, one batch
  // can hold an older page view's metric and the new view's (different ids).
  if (!Array.isArray(b.metrics) || b.metrics.length > 6) return "Invalid metrics";
  const rows: VitalRow[] = [];
  const seen = new Set<string>();
  let error = "";
  for (const m of b.metrics as Record<string, unknown>[]) {
    const row = parseVital(m, seen, release(b.release));
    if (typeof row === "string") error ||= row;
    else rows.push(row);
  }
  return rows.length === 0 && error ? error : rows;
}

function parseVital(m: Record<string, unknown>, seen: Set<string>, rel: string): VitalRow | string {
  const metric = str(m?.name, 10);
  const value = m?.value;
  const rating = str(m?.rating, 20);
  // web-vitals ids look like "v5-1696300000000-1234567890123".
  const id = str(m?.id, 80);
  if (!/^v\d+-[\w.-]{6,}$/.test(id) || seen.has(id)) return "Invalid id";
  if (!Object.hasOwn(VITAL_LIMITS, metric)) return "Invalid metric";
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > VITAL_LIMITS[metric]) {
    return "Invalid value";
  }
  if (!RATINGS.has(rating)) return "Invalid rating";
  // Per metric: INP and CLS can belong to a later page than LCP.
  if (typeof m?.path !== "string") return "Invalid path";
  seen.add(id);
  return { metric_id: id, metric, value, rating, path: normalizePath(str(m.path, 500)), release: rel };
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
