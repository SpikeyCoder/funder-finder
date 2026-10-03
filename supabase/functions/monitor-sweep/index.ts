/**
 * monitor-sweep — Supabase Edge Function (scheduled)
 *
 * FM-2026-10-03-02. Every 15 minutes, at :06/:21/:36/:51 (pg_cron →
 * invoke_monitor_sweep(), see
 * migration 20261003140000) it:
 *
 *   1. times live searches through search-organizations, as a visitor would
 *      (anon key, so anon's 3 s statement_timeout applies), and records each
 *      check; 2 or more failed or slow checks in the last hour open a card
 *      (at most once per 24 h);
 *   2. opens a card for each new crash fingerprint monitor-report recorded,
 *      most frequent first: at most MAX_CRASH_CARDS per run and
 *      MAX_CRASH_CARDS_PER_DAY per 24 h, then one summary card a day saying
 *      how many wait (so a flood of fake reports can't flood the board);
 *   3. opens a card for each page whose 75th-percentile LCP/INP/CLS over the
 *      last 24 h is "poor" (at most once per page and metric per 7 days, 2
 *      per run and 5 per 24 h; reported paths are mapped onto the app's
 *      routes, so made-up paths can't multiply them).
 *
 * Cards go to report-bug's Trello list. Requires CRON_SECRET and fails
 * closed; deploy with --no-verify-jwt (pg_net sends no JWT), like
 * process-organization-requests.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cronAuthorized } from "../_shared/cron_auth.ts";
import { createTrelloCard, trelloConfigured } from "../_shared/trello.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const MAX_CRASH_CARDS = 5;
export const MAX_CRASH_CARDS_PER_DAY = 10;
// A crash or alert claimed for a card that didn't get one is retried after
// this long.
const RETRY_AFTER_MS = 60 * 60 * 1000;
// After this many failed attempts a crash is retried daily instead.
const MAX_CARD_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;

// Search SLA: a check fails if it doesn't return 200 with at least one
// result within SLA_MS (every query below has matches). The 3 s anon
// timeout makes anything near it a near-miss. Each check is a whole
// request, as a visitor makes it: this project's Edge Functions boot per
// request, so boot time is part of what visitors wait for (~0.2 s).
export const SLA_MS = 2000;
const SLA_CHECK_TIMEOUT_MS = 5000;
export const SLA_BREACHES_PER_HOUR = 2;
// A common word, a multi-word name, and a dashed EIN (different code paths).
const SLA_QUERIES = ["foundation", "community foundation", "01-0224898"];
const SLA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const VITALS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const VITALS_MIN_SAMPLES = 20;
const MAX_VITALS_CARDS = 2;
export const MAX_VITALS_CARDS_PER_DAY = 5;

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
  card_attempts: number;
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

// Reported text is untrusted: shown only as code, so it can't add links or
// formatting to a triage card.
const fence = (s: string) => "```\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";
export const code = (s: string) => "`" + s.replace(/[`\n\r]/g, " ") + "`";

export function crashCard(c: CrashRow): { name: string; desc: string } {
  // The title is plain text but still reporter-supplied: no URLs or domains
  // in it, so a forged report can't put a convincing link on the board.
  const title = `${c.name}: ${c.message}`
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "<url>")
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|app|co|us|uk|info|biz|example)\b\S*/gi, "<url>")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return {
    name: `[CRASH] ${title}`,
    desc: [
      `Reported automatically by the browser (${c.kind === "boundary" ? "error screen shown" : c.kind === "rejection" ? "unhandled promise rejection" : "uncaught error"}).`,
      "",
      `**Occurrences:** ${c.occurrences} (first ${c.first_seen}, last ${c.last_seen})`,
      `**Page:** ${code(c.path)}`,
      `**Build:** ${c.release ? code(c.release) : "unknown"}`,
      `**Browser (latest):** ${c.user_agent ? code(c.user_agent) : "unknown"}`,
      "",
      "**Error**",
      fence(`${c.name}: ${c.message}`),
      c.stack ? "**Stack (minified)**\n" + fence(c.stack) : "",
      c.component_stack ? "**React component stack**\n" + fence(c.component_stack) : "",
      `monitor_crashes.fingerprint = ${code(c.fingerprint)}`,
    ].filter((l) => l !== "").join("\n"),
  };
}

export function slaBreached(checks: Pick<SlaCheck, "ok">[]): boolean {
  return checks.filter((c) => !c.ok).length >= SLA_BREACHES_PER_HOUR;
}

export function slaCard(checks: SlaCheck[]): { name: string; desc: string } {
  const failed = checks.filter((c) => !c.ok);
  const rows = checks.map((c) =>
    `| ${c.checked_at ?? ""} | ${code(c.check_name)} | ${c.status ?? "—"} | ${c.ms} | ${c.ok ? "ok" : "**FAIL**"} ${c.detail ? code(c.detail.replace(/\|/g, "/")) : ""} |`
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
      `Over the last 24 hours, the 75th-percentile ${VITAL_NAMES[b.metric] ?? b.metric} on ${code(b.path)} was **${fmt(b.p75)}**, worse than the "poor" threshold of ${VITAL_POOR[b.metric] ?? "?"}.`,
      "",
      `**Page views measured:** ${b.samples}`,
      `**Share rated poor:** ${Math.round(b.poor_share * 100)}%`,
      "",
      "Measured in visitors' browsers with web-vitals. Opened by monitor-sweep (at most once per page and metric per 7 days).",
    ].join("\n"),
  };
}

export function crashOverflowCard(waiting: number): { name: string; desc: string } {
  return {
    name: `[CRASH] ${waiting} more new kinds of crash waiting (daily card limit reached)`,
    desc: [
      `monitor-sweep opens at most ${MAX_CRASH_CARDS_PER_DAY} crash cards a day, and that many were opened in the last 24 hours. ${waiting} more new kinds of crash are waiting; they're carded as the limit allows, most frequent first.`,
      "",
      "A sudden burst usually means one bad deploy (look at the build on recent [CRASH] cards) or someone sending fake reports to monitor-report (look for many kinds with one occurrence each).",
      "",
      "To see them: `select fingerprint, name, message, occurrences, path from monitor_crashes where trello_card_url is null order by occurrences desc;`",
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
    const found = valid && (results as unknown[]).length > 0;
    return {
      check_name: query,
      ok: found && ms <= SLA_MS,
      status: res.status,
      ms,
      detail: !valid ? text.slice(0, 200) : !found ? "no results" : ms > SLA_MS ? `slow (> ${SLA_MS} ms)` : null,
    };
  } catch (err) {
    return { check_name: query, ok: false, status: null, ms: Date.now() - t0, detail: String(err).slice(0, 200) };
  }
}

type AlertRow = { alert_key: string; last_carded_at: string; trello_card_url: string | null };

/** Whether an alert may open a card now: never alerted, quiet period over,
 * or claimed without getting a card more than RETRY_AFTER_MS ago. */
export function alertDue(
  row: Pick<AlertRow, "last_carded_at" | "trello_card_url"> | null | undefined,
  cooldownMs: number,
  now = Date.now(),
): boolean {
  if (!row) return true;
  const age = now - Date.parse(row.last_carded_at);
  return age >= cooldownMs || (row.trello_card_url === null && age >= RETRY_AFTER_MS);
}

/**
 * Open an alert's card, claiming the alert first with a compare-and-set
 * (an insert for a new alert, or an update conditional on the row being
 * unchanged), so overlapping runs can't both open it. Pass the alert's row
 * if already fetched (null if it has none). Returns the card URL, or null
 * if nothing was opened (not due, claimed by another run, or Trello failed:
 * then the claim stays and it's retried after RETRY_AFTER_MS).
 */
async function openAlertCard(
  key: string,
  cooldownMs: number,
  card: { name: string; desc: string },
  known?: AlertRow | null,
): Promise<string | null> {
  const row = known !== undefined ? known : (await restJson<AlertRow[]>(
    `monitor_alerts?alert_key=eq.${encodeURIComponent(key)}&select=alert_key,last_carded_at,trello_card_url`,
  ))[0] ?? null;
  if (!alertDue(row, cooldownMs)) return null;
  const claimed = { last_carded_at: new Date().toISOString(), trello_card_url: null };
  const claim = row
    ? await rest(
      `monitor_alerts?alert_key=eq.${encodeURIComponent(key)}&last_carded_at=eq.${encodeURIComponent(row.last_carded_at)}&select=alert_key`,
      { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(claimed) },
    )
    : await rest("monitor_alerts?select=alert_key", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ alert_key: key, ...claimed }),
    });
  if (claim.status === 409) return null; // another run inserted it first
  if (!claim.ok) throw new Error(`REST monitor_alerts claim ${claim.status}: ${await claim.text()}`);
  if (((await claim.json()) as unknown[]).length !== 1) return null; // another run updated it first
  const url = cardUrl(await createTrelloCard(card));
  if (!url) return null;
  await recordCard(`monitor_alerts?alert_key=eq.${encodeURIComponent(key)}`, url, key);
  return url;
}

/**
 * The URL to record for a card, or null if none was opened. A timeout is
 * recorded as a placeholder (the card may exist): for alerts a duplicate is
 * worse than a missed card, since the crash or breach stays in the tables.
 */
export function cardUrl(result: string | null | "unconfigured" | "timeout"): string | null {
  if (result === "timeout") return "(Trello timed out; the card may exist, check the board)";
  return result && result !== "unconfigured" ? result : null;
}

/**
 * Record an opened card's URL, retrying twice: until it's recorded, the
 * claim alone holds a retry off for RETRY_AFTER_MS, after which a second
 * card could be opened. Logged if it still fails.
 */
async function recordCard(target: string, url: string, what: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await rest(target, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ trello_card_url: url }),
      });
      if (res.ok) return;
      console.error(`monitor-sweep: recording ${url} for ${what} failed (attempt ${attempt}):`, res.status, await res.text());
    } catch (err) {
      console.error(`monitor-sweep: recording ${url} for ${what} failed (attempt ${attempt}):`, err);
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}

/** Exact row count for a PostgREST query (from Content-Range). */
async function restCount(path: string): Promise<number> {
  const res = await rest(path, { method: "HEAD", headers: { Prefer: "count=exact" } });
  if (!res.ok) throw new Error(`REST ${path.split("?")[0]} count ${res.status}`);
  const total = Number(res.headers.get("content-range")?.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

type Summary = Record<string, number | string>;

async function sweepSla(summary: Summary, trello: boolean): Promise<void> {
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
  if (!slaBreached(hour)) return;
  summary.sla_breached = "yes";
  // Without Trello, don't claim the alert for a card that can't be opened.
  if (!trello) return;
  const url = await openAlertCard("sla:search", SLA_COOLDOWN_MS, slaCard(hour));
  if (url) summary.sla_card = url;
}

async function sweepCrashes(summary: Summary): Promise<void> {
  const now = Date.now();
  const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
  const cardedToday = await restCount(
    `monitor_crashes?trello_card_url=not.is.null&card_attempted_at=gte.${iso(now - DAY_MS)}`,
  );
  // Due: no card yet, and never claimed, or last claimed over an hour ago
  // (over a day ago after MAX_CARD_ATTEMPTS failures: a long Trello outage
  // delays a card, it never loses one).
  const budget = Math.min(MAX_CRASH_CARDS, MAX_CRASH_CARDS_PER_DAY - cardedToday);
  const due = budget <= 0 ? [] : await restJson<CrashRow[]>(
    "monitor_crashes?trello_card_url=is.null" +
      `&or=(card_attempted_at.is.null,and(card_attempts.lt.${MAX_CARD_ATTEMPTS},card_attempted_at.lt.${iso(now - RETRY_AFTER_MS)}),card_attempted_at.lt.${iso(now - DAY_MS)})` +
      `&order=occurrences.desc,first_seen.asc&limit=${MAX_CRASH_CARDS}` +
      "&select=fingerprint,kind,name,message,stack,component_stack,path,release,user_agent,occurrences,first_seen,last_seen,card_attempts",
  );
  let carded = 0;
  for (const c of due) {
    // Claim it (counts as an attempt) only if no other run has meanwhile.
    const claim = await rest(
      `monitor_crashes?fingerprint=eq.${c.fingerprint}&trello_card_url=is.null&card_attempts=eq.${c.card_attempts}&select=fingerprint`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ card_attempted_at: new Date().toISOString(), card_attempts: c.card_attempts + 1 }),
      },
    );
    if (!claim.ok) throw new Error(`REST monitor_crashes claim ${claim.status}: ${await claim.text()}`);
    if (((await claim.json()) as unknown[]).length !== 1) continue;
    const url = cardUrl(await createTrelloCard(crashCard(c)));
    // Trello rejected or failed this one: it's retried later and doesn't
    // hold up the rest.
    if (!url) continue;
    await recordCard(`monitor_crashes?fingerprint=eq.${c.fingerprint}`, url, `crash ${c.fingerprint}`);
    carded++;
  }
  summary.crash_cards = carded;
  if (cardedToday + carded < MAX_CRASH_CARDS_PER_DAY) return;
  // The daily limit is reached: say (once a day) how many kinds wait.
  const waiting = await restCount("monitor_crashes?trello_card_url=is.null");
  summary.crashes_waiting = waiting;
  if (waiting > 0) {
    const url = await openAlertCard("crash:overflow", DAY_MS, crashOverflowCard(waiting));
    if (url) summary.crash_overflow_card = url;
  }
}

async function sweepVitals(summary: Summary): Promise<void> {
  const breaches = await restJson<VitalsBreach[]>("rpc/monitor_vitals_breaches", {
    method: "POST",
    body: JSON.stringify({ p_min_samples: VITALS_MIN_SAMPLES }),
  });
  if (breaches.length === 0) return;
  // Every vitals alert in one query, rather than one per breach.
  const alerts = new Map(
    (await restJson<AlertRow[]>("monitor_alerts?alert_key=like.vitals:*&select=alert_key,last_carded_at,trello_card_url"))
      .map((a) => [a.alert_key, a]),
  );
  // Cards actually opened (a claim whose card failed has no URL), as for crashes.
  const dayAgo = Date.now() - DAY_MS;
  const cardedToday = [...alerts.values()]
    .filter((a) => a.trello_card_url !== null && Date.parse(a.last_carded_at) >= dayAgo).length;
  let budget = Math.min(MAX_VITALS_CARDS, MAX_VITALS_CARDS_PER_DAY - cardedToday);
  let carded = 0;
  for (const b of breaches) {
    if (budget <= 0) break;
    const key = `vitals:${b.metric}:${b.path}`;
    if (await openAlertCard(key, VITALS_COOLDOWN_MS, vitalsCard(b), alerts.get(key) ?? null)) {
      carded++;
      budget--;
    }
  }
  summary.vitals_cards = carded;
}

if (import.meta.main) {
  Deno.serve(async (req: Request) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (req.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!cronAuthorized(req, Deno.env.get("CRON_SECRET") || "")) return json(401, { error: "Unauthorized" });
    if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return json(500, { error: "Server config missing" });

    // Each part runs even if another fails; failures are logged and reported.
    // Without Trello only the SLA checks run: claiming crashes and alerts for
    // cards that can't be opened would use up their retries.
    const summary: Summary = {};
    const trello = trelloConfigured();
    // Crashes and vitals only open cards, so they run only with Trello; the
    // SLA checks are recorded either way.
    const parts: [string, (s: Summary) => Promise<void>][] = [["sla", (s) => sweepSla(s, trello)]];
    if (trello) parts.push(["crashes", sweepCrashes], ["vitals", sweepVitals]);
    if (!trello) {
      console.error("monitor-sweep: TRELLO_API_KEY / TRELLO_TOKEN / TRELLO_LIST_ID unset; no cards opened");
      summary.trello = "unconfigured";
    }
    for (const [name, part] of parts) {
      try {
        await part(summary);
      } catch (err) {
        console.error(`monitor-sweep ${name} failed:`, err);
        summary[`${name}_error`] = String(err).slice(0, 200);
      }
    }
    const failed = Object.keys(summary).some((k) => k.endsWith("_error"));
    return json(failed ? 500 : 200, summary);
  });
}
