/**
 * monitor-sweep — Supabase Edge Function (scheduled)
 *
 * FM-2026-10-03-02. Every 15 minutes (pg_cron → invoke_monitor_sweep(), see
 * migration 20261003140000) it:
 *
 *   1. times live searches through search-organizations, as a visitor would
 *      (anon key, so anon's 3 s statement_timeout applies), and records each
 *      check; 2 or more failed or slow checks in the last hour open a card
 *      (at most once per 24 h);
 *   2. opens a card for each new crash fingerprint monitor-report recorded,
 *      most frequent first, at most MAX_CRASH_CARDS per run;
 *   3. opens a card for each page whose 75th-percentile LCP/INP/CLS over the
 *      last 24 h is "poor" (at most once per page and metric per 7 days).
 *
 * Cards go to report-bug's Trello list. Requires CRON_SECRET and fails
 * closed; deploy with --no-verify-jwt (pg_net sends no JWT), like
 * process-organization-requests.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cronAuthorized } from "../_shared/cron_auth.ts";
import { createTrelloCard } from "../_shared/trello.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const MAX_CRASH_CARDS = 5;
const FETCH_TIMEOUT_MS = 7000;

// Search SLA: a check fails if it doesn't return 200 with a results array
// within SLA_MS. The 3 s anon timeout makes anything near it a near-miss.
export const SLA_MS = 2000;
const SLA_CHECK_TIMEOUT_MS = 5000;
export const SLA_BREACHES_PER_HOUR = 2;
// A common word, a multi-word name, and a dashed EIN (different code paths).
const SLA_QUERIES = ["foundation", "community foundation", "01-0224898"];
const SLA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const VITALS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const VITALS_MIN_SAMPLES = 20;

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
  occurrences: number;
  first_seen: string;
  last_seen: string;
}

export interface SlaCheck {
  check_name: string;
  ok: boolean;
  status: number | null;
  ms: number;
  detail: string | null;
  checked_at?: string;
}

export interface VitalsBreach {
  metric: string;
  path: string;
  samples: number;
  p75: number;
  poor_share: number;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

const fence = (s: string) => "```\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";

export function crashCard(c: CrashRow): { name: string; desc: string } {
  const title = `${c.name}: ${c.message}`.replace(/\s+/g, " ").slice(0, 120);
  return {
    name: `[CRASH] ${title}`,
    desc: [
      `Reported automatically by the browser (${c.kind === "boundary" ? "error screen shown" : c.kind === "rejection" ? "unhandled promise rejection" : "uncaught error"}).`,
      "",
      `**Occurrences:** ${c.occurrences} (first ${c.first_seen}, last ${c.last_seen})`,
      `**Page:** ${c.path}`,
      `**Build:** ${c.release || "unknown"}`,
      `**Browser (latest):** ${c.user_agent || "unknown"}`,
      "",
      "**Error**",
      fence(`${c.name}: ${c.message}`),
      c.stack ? "**Stack (minified)**\n" + fence(c.stack) : "",
      c.component_stack ? "**React component stack**\n" + fence(c.component_stack) : "",
      `monitor_crashes.fingerprint = ${c.fingerprint}`,
    ].filter((l) => l !== "").join("\n"),
  };
}

export function slaBreached(checks: Pick<SlaCheck, "ok">[]): boolean {
  return checks.filter((c) => !c.ok).length >= SLA_BREACHES_PER_HOUR;
}

export function slaCard(checks: SlaCheck[]): { name: string; desc: string } {
  const failed = checks.filter((c) => !c.ok);
  const rows = checks.map((c) =>
    `| ${c.checked_at ?? ""} | ${c.check_name} | ${c.status ?? "—"} | ${c.ms} | ${c.ok ? "ok" : "**FAIL**"} ${c.detail ?? ""} |`
  );
  return {
    name: `[SLA] Search: ${failed.length} of ${checks.length} checks failed in the last hour`,
    desc: [
      `Search missed its SLA (a 200 with results within ${SLA_MS} ms) on ${failed.length} of the last hour's ${checks.length} synthetic checks. Visitors see "Search failed" when the database query passes anon's 3 s statement_timeout.`,
      "",
      "| Checked at (UTC) | Query | Status | ms | Result |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      "First places to look: the search-organizations Edge Function logs, Postgres logs for \"canceling statement due to statement timeout\", and cron.job_run_details for prewarm-search-indexes.",
      "Opened by monitor-sweep (at most once per 24 h).",
    ].join("\n"),
  };
}

const VITAL_UNITS: Record<string, (v: number) => string> = {
  LCP: (v) => `${(v / 1000).toFixed(1)} s`,
  INP: (v) => `${Math.round(v)} ms`,
  CLS: (v) => v.toFixed(2),
};
const VITAL_POOR: Record<string, string> = { LCP: "4.0 s", INP: "500 ms", CLS: "0.25" };
const VITAL_NAMES: Record<string, string> = {
  LCP: "Largest Contentful Paint (loading)",
  INP: "Interaction to Next Paint (responsiveness)",
  CLS: "Cumulative Layout Shift (visual stability)",
};

export function vitalsCard(b: VitalsBreach): { name: string; desc: string } {
  const fmt = VITAL_UNITS[b.metric] ?? ((v: number) => String(v));
  return {
    name: `[PERF] ${b.metric} is poor on ${b.path} (p75 ${fmt(b.p75)})`,
    desc: [
      `Over the last 24 hours, the 75th-percentile ${VITAL_NAMES[b.metric] ?? b.metric} on \`${b.path}\` was **${fmt(b.p75)}**, worse than the "poor" threshold of ${VITAL_POOR[b.metric] ?? "?"}.`,
      "",
      `**Page views measured:** ${b.samples}`,
      `**Share rated poor:** ${Math.round(b.poor_share * 100)}%`,
      "",
      "Measured in visitors' browsers with web-vitals. Opened by monitor-sweep (at most once per page and metric per 7 days).",
    ].join("\n"),
  };
}

// ── IO ──────────────────────────────────────────────────────────────────────

function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function restJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rest(path, init);
  if (!res.ok) throw new Error(`REST ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

async function runSlaCheck(query: string): Promise<SlaCheck> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/search-organizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify({ query, limit: 15 }),
      signal: AbortSignal.timeout(SLA_CHECK_TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    let results: unknown = null;
    try {
      results = (JSON.parse(text) as { results?: unknown }).results;
    } catch { /* not JSON */ }
    const valid = res.status === 200 && Array.isArray(results);
    return {
      check_name: query,
      ok: valid && ms <= SLA_MS,
      status: res.status,
      ms,
      detail: valid ? (ms > SLA_MS ? `slow (> ${SLA_MS} ms)` : null) : text.slice(0, 200),
    };
  } catch (err) {
    return { check_name: query, ok: false, status: null, ms: Date.now() - t0, detail: String(err).slice(0, 200) };
  }
}

async function alertDue(key: string, cooldownMs: number): Promise<boolean> {
  const since = new Date(Date.now() - cooldownMs).toISOString();
  const rows = await restJson<unknown[]>(
    `monitor_alerts?alert_key=eq.${encodeURIComponent(key)}&last_carded_at=gte.${encodeURIComponent(since)}&select=alert_key`,
  );
  return rows.length === 0;
}

async function markAlerted(key: string, url: string): Promise<void> {
  const res = await rest("monitor_alerts?on_conflict=alert_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ alert_key: key, last_carded_at: new Date().toISOString(), trello_card_url: url }),
  });
  if (!res.ok) throw new Error(`REST monitor_alerts ${res.status}: ${await res.text()}`);
}

type Summary = Record<string, number | string>;

async function sweepSla(summary: Summary): Promise<boolean> {
  const checks: SlaCheck[] = [];
  for (const q of SLA_QUERIES) checks.push(await runSlaCheck(q)); // one at a time, like visitors
  const res = await rest("monitor_sla_checks", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(checks),
  });
  if (!res.ok) throw new Error(`REST monitor_sla_checks ${res.status}: ${await res.text()}`);
  summary.sla_failed_now = checks.filter((c) => !c.ok).length;

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const hour = await restJson<SlaCheck[]>(
    `monitor_sla_checks?checked_at=gte.${encodeURIComponent(since)}&order=checked_at.asc&select=check_name,ok,status,ms,detail,checked_at`,
  );
  if (!slaBreached(hour) || !(await alertDue("sla:search", SLA_COOLDOWN_MS))) return true;
  const url = await createTrelloCard(slaCard(hour));
  if (url === "unconfigured") return false;
  if (url === null) return true; // Trello failing; the next run tries again
  await markAlerted("sla:search", url);
  summary.sla_card = url;
  return true;
}

async function sweepCrashes(summary: Summary): Promise<boolean> {
  const crashes = await restJson<CrashRow[]>(
    `monitor_crashes?trello_card_url=is.null&order=occurrences.desc,first_seen.asc&limit=${MAX_CRASH_CARDS}` +
      "&select=fingerprint,kind,name,message,stack,component_stack,path,release,user_agent,occurrences,first_seen,last_seen",
  );
  let carded = 0;
  for (const c of crashes) {
    const url = await createTrelloCard(crashCard(c));
    if (url === "unconfigured") return false;
    if (url === null) break; // Trello failing; the rest wait for the next run
    // Only if nobody carded it meanwhile (overlapping runs).
    await rest(`monitor_crashes?fingerprint=eq.${c.fingerprint}&trello_card_url=is.null`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ trello_card_url: url, carded_at: new Date().toISOString() }),
    });
    carded++;
  }
  summary.crash_cards = carded;
  summary.crashes_waiting = Math.max(0, crashes.length - carded);
  return true;
}

async function sweepVitals(summary: Summary): Promise<boolean> {
  const breaches = await restJson<VitalsBreach[]>("rpc/monitor_vitals_breaches", {
    method: "POST",
    body: JSON.stringify({ p_min_samples: VITALS_MIN_SAMPLES }),
  });
  let carded = 0;
  for (const b of breaches) {
    const key = `vitals:${b.metric}:${b.path}`;
    if (!(await alertDue(key, VITALS_COOLDOWN_MS))) continue;
    const url = await createTrelloCard(vitalsCard(b));
    if (url === "unconfigured") return false;
    if (url === null) break;
    await markAlerted(key, url);
    carded++;
  }
  summary.vitals_cards = carded;
  return true;
}

if (import.meta.main) {
  Deno.serve(async (req: Request) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (req.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!cronAuthorized(req, Deno.env.get("CRON_SECRET") || "")) return json(401, { error: "Unauthorized" });
    if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return json(500, { error: "Server config missing" });

    // Each part runs even if another fails; failures are logged and reported.
    const summary: Summary = {};
    let trelloConfigured = true;
    for (const [name, part] of [["sla", sweepSla], ["crashes", sweepCrashes], ["vitals", sweepVitals]] as const) {
      try {
        if (!(await part(summary))) trelloConfigured = false;
      } catch (err) {
        console.error(`monitor-sweep ${name} failed:`, err);
        summary[`${name}_error`] = String(err).slice(0, 200);
      }
    }
    if (!trelloConfigured) {
      console.error("monitor-sweep: TRELLO_API_KEY / TRELLO_TOKEN / TRELLO_LIST_ID unset; no cards opened");
      summary.trello = "unconfigured";
    }
    const failed = Object.keys(summary).some((k) => k.endsWith("_error"));
    return json(failed ? 500 : 200, summary);
  });
}
