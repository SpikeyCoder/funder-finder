/**
 * monitor-sweep — Supabase Edge Function (scheduled)
 *
 * FM-2026-10-03-02. Every 15 minutes, at :06/:21/:36/:51 (pg_cron →
 * invoke_monitor_sweep(), see
 * migration 20261003140000) it:
 *
 *   1. once an hour (the :06 run), times a funder match through
 *      match-funders, as a visitor's request makes it (anon key, the app's
 *      request body), and records the check; a failed or slow check in 2 of
 *      the last 3 hours opens a card (at most once per 24 h);
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
import { rest, restConfigured, restCount, restJson } from "../_shared/rest.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const MAX_CRASH_CARDS = 5;
export const MAX_CRASH_CARDS_PER_DAY = 10;
// A crash or alert claimed for a card that didn't get one is retried after
// this long.
const RETRY_AFTER_MS = 60 * 60 * 1000;
// After this many failed attempts a crash is retried daily instead, and
// after MAX_CARD_TRIES (about a week of daily tries) weekly, behind every
// other crash: Trello may reject that card, and it mustn't take a daily
// slot every day; but a long outage delays a card, it never loses one.
const MAX_CARD_ATTEMPTS = 3;
const MAX_CARD_TRIES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// No new card is started after this long into a run: a card takes up to
// ~37 s (its claim, Trello's timeout, then recording its URL with retries;
// database calls time out at _shared/rest.ts's 7 s default),
// and pg_net gives up on the run at 120 s (the Edge Function itself at
// 150 s), which could leave a card opened but unrecorded (then opened again
// an hour later).
const RUN_CARD_DEADLINE_MS = 70_000;

// Matching SLA: the check fails if match-funders doesn't return 200 with at
// least one funder within MATCH_SLA_MS. It times funder matching rather than
// org search because matching is what visitors actually run (14 matches and
// no org searches by visitors on 2026-10-05/06); real matches took 12 s at the
// median and 18 s at p90 then, so 20 s flags a match slower than nearly all.
// The check is a whole request, as a visitor makes it: this project's Edge
// Functions boot per request, so boot time is part of the wait.
export const MATCH_SLA_MS = 20_000;
// Real matches peaked at 28 s; past 30 s the check is a failure either way,
// and the run's 70 s card deadline still leaves room to open the card.
const MATCH_CHECK_TIMEOUT_MS = 30_000;
// A match without peers runs peer suggestion and the peer-grant lookup over
// foundation_grants, uncached: about 12 s of database work. Hourly keeps the
// check to ~2x the visitors' matching load on this small database, not ~7x.
export function matchCheckDue(now: Date): boolean {
  return now.getUTCMinutes() < 15; // the :06 run of the :06/:21/:36/:51 schedule
}
// The app's request for a mission search (src/utils/matching.ts findMatches).
// A plain mission with a location; it matches 340 funders.
const MATCH_CHECK_NAME = "match: after-school STEM, Chicago";
const MATCH_CHECK_BODY = {
  mission: "Provide after-school STEM programs for middle school students",
  locationServed: "Chicago, IL",
  keywords: [],
  budgetBand: "prefer_not_to_say",
  forceRefresh: false,
  peerNonprofits: [],
};
// How many of the window's hourly checks must have failed, and the window:
// 2 of the last 3 hours.
export const SLA_FAILING_RUNS = 2;
const SLA_WINDOW_MS = 3 * 60 * 60 * 1000;
const SLA_COOLDOWN_MS = DAY_MS;
const VITALS_COOLDOWN_MS = WEEK_MS;
// A page-speed card that failed is retried a day later, not hourly: it isn't
// urgent, and a Trello that keeps rejecting gets a few calls a day.
const VITALS_RETRY_MS = DAY_MS;
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
  card_attempted_at: string | null;
  card_counted_at?: string | null;
  previous_card_url?: string | null;
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
  // The title is plain text but still reporter-supplied: no URLs, and
  // anything that could be a hostname defanged ("evil[.]ai", whatever the
  // TLD), so a forged report can't put a convincing link on the board,
  // while "e[.]info is not a function" stays readable.
  const title = `${c.name}: ${c.message}`
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "<url>")
    .replace(/([\w-])\.(?=[a-z][a-z0-9-]*\b)/gi, "$1[.]")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return {
    name: `[CRASH] ${title}`,
    desc: [
      `Reported automatically by the browser (${c.kind === "boundary" ? "error screen shown" : c.kind === "rejection" ? "unhandled promise rejection" : "uncaught error"}).`,
      "",
      `**Occurrences:** ${c.occurrences} (first ${c.first_seen}, last ${c.last_seen})`,
      c.previous_card_url ? `**Came back** after 7+ quiet days; earlier card: ${c.previous_card_url}` : "",
      c.card_attempts > 0
        ? `**Earlier tries:** ${c.card_attempts} (one may have opened a card if Trello was slow; search the board for this fingerprint)`
        : "",
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

// Failures in at least two runs, not just one: one slow match is a blip,
// while an outage is caught by the second. A run's checks are inserted
// together, so they share checked_at.
export function slaBreached(checks: Pick<SlaCheck, "ok" | "checked_at">[]): boolean {
  const failed = checks.filter((c) => !c.ok);
  // (Checks without a time count as one run: never more runs than proven.)
  const runs = new Set(failed.map((c) => c.checked_at ?? "?"));
  return runs.size >= SLA_FAILING_RUNS;
}

export function slaCard(checks: SlaCheck[]): { name: string; desc: string } {
  const failed = checks.filter((c) => !c.ok);
  const rows = checks.map((c) =>
    `| ${c.checked_at ?? ""} | ${code(c.check_name)} | ${c.status ?? "—"} | ${c.ms} | ${c.ok ? "ok" : "**FAIL**"} ${c.detail ? code(c.detail.replace(/\|/g, "/")) : ""} |`
  );
  return {
    name: `[SLA] Funder matching: ${failed.length} of ${checks.length} checks failed in the last 3 hours`,
    desc: [
      `Funder matching missed its SLA (a 200 with funders within ${MATCH_SLA_MS / 1000} s) on ${failed.length} of the last 3 hours' ${checks.length} hourly synthetic checks. Visitors wait this long on the Results page, or see an error.`,
      "",
      "| Checked at (UTC) | Check | Status | ms | Result |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      "First places to look: the match-funders Edge Function logs (execution time per request), Postgres logs for \"canceling statement due to statement timeout\", and pg_stat_statements for the foundation_grants and funders queries (disk reads mean the database is short of memory).",
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
      `monitor-sweep tries at most ${MAX_CRASH_CARDS_PER_DAY} crash cards a day (a failed or timed-out try counts, since a timed-out card may still have opened), and that many were tried in the last 24 hours. ${waiting} more new kinds of crash are waiting; they're carded as the limit allows, most frequent first.`,
      "",
      "A sudden burst usually means one bad deploy (look at the build on recent [CRASH] cards) or someone sending fake reports to monitor-report (look for many kinds with one occurrence each).",
      "",
      "To see them: `select fingerprint, name, message, occurrences, path from monitor_crashes where trello_card_url is null order by occurrences desc;`",
    ].join("\n"),
  };
}

// ── IO ──────────────────────────────────────────────────────────────────────

async function runMatchCheck(): Promise<SlaCheck> {
  const t0 = Date.now();
  const check_name = MATCH_CHECK_NAME;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/match-funders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify(MATCH_CHECK_BODY),
      signal: AbortSignal.timeout(MATCH_CHECK_TIMEOUT_MS),
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
      check_name,
      ok: found && ms <= MATCH_SLA_MS,
      status: res.status,
      ms,
      detail: !valid ? text.slice(0, 200) : !found ? "no results" : ms > MATCH_SLA_MS ? `slow (> ${MATCH_SLA_MS} ms)` : null,
    };
  } catch (err) {
    return { check_name, ok: false, status: null, ms: Date.now() - t0, detail: String(err).slice(0, 200) };
  }
}

type AlertRow = { alert_key: string; last_carded_at: string; trello_card_url: string | null };

/** Whether an alert may open a card now: never alerted, quiet period over,
 * or claimed without getting a card more than RETRY_AFTER_MS ago. */
export function alertDue(
  row: Pick<AlertRow, "last_carded_at" | "trello_card_url"> | null | undefined,
  cooldownMs: number,
  now = Date.now(),
  retryAfterMs = RETRY_AFTER_MS,
): boolean {
  if (!row) return true;
  const age = now - Date.parse(row.last_carded_at);
  return age >= cooldownMs || (row.trello_card_url === null && age >= retryAfterMs);
}

/**
 * Open an alert's card, claiming the alert first with a compare-and-set
 * (an insert for a new alert, or an update conditional on the row being
 * unchanged), so overlapping runs can't both open it. Pass the alert's row
 * if already fetched (null if it has none). Returns the card URL, or null
 * if nothing was opened (not due, claimed by another run, or Trello failed:
 * then the claim stays and it's retried after `retryAfterMs`).
 */
async function openAlertCard(
  key: string,
  cooldownMs: number,
  card: { name: string; desc: string },
  known?: AlertRow | null,
  retryAfterMs = RETRY_AFTER_MS,
): Promise<string | null> {
  const row = known !== undefined ? known : (await restJson<AlertRow[]>(
    `monitor_alerts?alert_key=eq.${encodeURIComponent(key)}&select=alert_key,last_carded_at,trello_card_url`,
  ))[0] ?? null;
  if (!alertDue(row, cooldownMs, Date.now(), retryAfterMs)) return null;
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
  await recordCard(`monitor_alerts?alert_key=eq.${encodeURIComponent(key)}`, { trello_card_url: url }, `card ${url} for alert ${key}`);
  return url;
}

/**
 * An alert card's URL to record, or null if none was opened (it's retried).
 * A timeout means the card may exist, so a placeholder is recorded rather
 * than risk a duplicate: the breach stays in the tables. (Crash cards mark a
 * timeout with card_uncertain_at; see sweepCrashes.)
 */
export function cardUrl(result: string | null | "unconfigured" | "timeout"): string | null {
  if (result === "timeout") return "(Trello timed out; the card may exist, check the board)";
  return result && result !== "unconfigured" ? result : null;
}

/**
 * Record what became of a card (its URL, or that its call timed out),
 * retrying twice: until it's recorded, the claim alone holds a retry off for
 * RETRY_AFTER_MS, after which a second card could be opened. Logged if it
 * still fails.
 */
async function recordCard(target: string, fields: Record<string, string>, what: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await rest(target, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(fields),
      });
      if (res.ok) return;
      console.error(`monitor-sweep: recording ${what} failed (attempt ${attempt}):`, res.status, await res.text());
    } catch (err) {
      console.error(`monitor-sweep: recording ${what} failed (attempt ${attempt}):`, err);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}

export type Summary = Record<string, number | string>;

async function sweepSla(summary: Summary, trello: boolean): Promise<void> {
  if (!matchCheckDue(new Date())) {
    summary.sla = "not this run (hourly)";
    return;
  }
  const checks: SlaCheck[] = [await runMatchCheck()];
  const res = await rest("monitor_sla_checks", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(checks),
  });
  if (!res.ok) throw new Error(`REST monitor_sla_checks ${res.status}: ${await res.text()}`);
  summary.sla_failed_now = checks.filter((c) => !c.ok).length;

  // Only matching checks: the org-search checks this replaced are still in
  // the table for a while and must not count.
  const since = new Date(Date.now() - SLA_WINDOW_MS).toISOString();
  const recent = await restJson<SlaCheck[]>(
    `monitor_sla_checks?checked_at=gte.${encodeURIComponent(since)}&check_name=like.${encodeURIComponent("match:*")}` +
      `&order=checked_at.asc&select=check_name,ok,status,ms,detail,checked_at`,
  );
  if (!slaBreached(recent)) return;
  summary.sla_breached = "yes";
  // Without Trello, don't claim the alert for a card that can't be opened.
  if (!trello) return;
  const url = await openAlertCard("sla:match", SLA_COOLDOWN_MS, slaCard(recent));
  if (url) summary.sla_card = url;
}

export async function sweepCrashes(summary: Summary, deadline: number): Promise<void> {
  const now = Date.now();
  const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
  // Due: no card yet, and never claimed, or last claimed over an hour ago
  // (over a day ago after MAX_CARD_ATTEMPTS failures: a long
  // Trello outage delays a card, it never loses one). Retries of crashes
  // tried in the last day are fetched apart and go first: they need no
  // daily budget, so fresh ones waiting for it mustn't crowd them out.
  // Fewest tries first, so a crash whose card Trello keeps rejecting falls
  // behind new ones instead of taking a daily slot every day.
  const select = "&order=card_attempts.asc,occurrences.desc,first_seen.asc" +
    "&select=fingerprint,kind,name,message,stack,component_stack,path,release,user_agent,occurrences,first_seen,last_seen,card_attempts,card_attempted_at,previous_card_url";
  const uncarded = "monitor_crashes?trello_card_url=is.null&card_uncertain_at=is.null";
  // Waiting for the daily budget: not tried in the last day (nor the last
  // hour), and, past MAX_CARD_TRIES, not in the last week. Also what the
  // overflow card counts.
  const freshFilter = `${uncarded}&or=(card_attempts.lt.${MAX_CARD_TRIES},card_counted_at.lt.${iso(now - WEEK_MS)})` +
    `&and=(or(card_counted_at.is.null,card_counted_at.lt.${iso(now - DAY_MS)}),or(card_attempted_at.is.null,card_attempted_at.lt.${iso(now - RETRY_AFTER_MS)}))`;
  const [triedToday, retries, fresh] = await Promise.all([
    // Every crash whose card was tried in the last day counts against the
    // daily cap, opened or not: a Trello timeout may still have opened it.
    restCount(`monitor_crashes?card_counted_at=gte.${iso(now - DAY_MS)}`),
    // Tried in the last day and failed: already counted, so no new budget.
    restJson<CrashRow[]>(
      `${uncarded}&card_attempts=lt.${MAX_CARD_ATTEMPTS}&card_attempted_at=lt.${iso(now - RETRY_AFTER_MS)}&card_counted_at=gte.${iso(now - DAY_MS)}` +
        `${select}&limit=${MAX_CRASH_CARDS}`,
    ),
    // Waiting for the daily budget: each uses a slot.
    restJson<CrashRow[]>(`${freshFilter}${select}&limit=${MAX_CRASH_CARDS}`),
  ]);
  const dayLeft = MAX_CRASH_CARDS_PER_DAY - triedToday;
  const freshPicked = new Set(fresh.slice(0, Math.max(0, dayLeft)));
  const picked = [...retries, ...freshPicked].slice(0, MAX_CRASH_CARDS);
  let carded = 0;
  let freshTried = 0;
  for (const c of picked) {
    if (Date.now() > deadline) break;
    // Claim it (counts as an attempt) only if no other run has meanwhile.
    const claim = await rest(
      `monitor_crashes?fingerprint=eq.${c.fingerprint}&trello_card_url=is.null&card_attempts=eq.${c.card_attempts}&select=fingerprint`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          card_attempted_at: new Date().toISOString(),
          card_attempts: c.card_attempts + 1,
          // A fresh pick takes a daily slot; a retry within the day doesn't.
          ...(freshPicked.has(c) ? { card_counted_at: new Date().toISOString() } : {}),
        }),
      },
    );
    if (!claim.ok) throw new Error(`REST monitor_crashes claim ${claim.status}: ${await claim.text()}`);
    if (((await claim.json()) as unknown[]).length !== 1) continue;
    if (freshPicked.has(c)) freshTried++;
    const result = await createTrelloCard(crashCard(c));
    if (result === "timeout") {
      // The card may exist: not retried (no duplicate) until the crash
      // happens again a day later (record_client_crash clears this).
      await recordCard(
        `monitor_crashes?fingerprint=eq.${c.fingerprint}`,
        { card_uncertain_at: new Date().toISOString() },
        `crash ${c.fingerprint} timed out`,
      );
      continue;
    }
    const url = cardUrl(result);
    // Trello rejected or failed: retried in an hour (the claim counts as an
    // attempt), without holding up the rest.
    if (!url) continue;
    await recordCard(`monitor_crashes?fingerprint=eq.${c.fingerprint}`, { trello_card_url: url }, `card ${url} for crash ${c.fingerprint}`);
    carded++;
  }
  summary.crash_cards = carded;
  // (With headroom: the summary card takes a few more calls than a crash's.)
  if (triedToday + freshTried < MAX_CRASH_CARDS_PER_DAY || Date.now() > deadline - 15_000) return;
  // The daily limit is reached: say (once a day) how many kinds wait for it
  // (not ones tried today and waiting only on a Trello retry).
  const overflow = (await restJson<AlertRow[]>(
    "monitor_alerts?alert_key=eq.crash:overflow&select=alert_key,last_carded_at,trello_card_url",
  ))[0] ?? null;
  if (!alertDue(overflow, DAY_MS)) return;
  const waiting = await restCount(freshFilter);
  summary.crashes_waiting = waiting;
  if (waiting > 0) {
    const url = await openAlertCard("crash:overflow", DAY_MS, crashOverflowCard(waiting), overflow);
    if (url) summary.crash_overflow_card = url;
  }
}

async function sweepVitals(summary: Summary, deadline: number): Promise<void> {
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
  // Every card tried in the last day counts, opened or not, as for crashes;
  // and a failed one is retried a day later, not hourly (page speed isn't
  // urgent), so a Trello that keeps rejecting gets at most a few calls a day.
  const dayAgo = Date.now() - DAY_MS;
  const cardedToday = [...alerts.values()].filter((a) => Date.parse(a.last_carded_at) >= dayAgo).length;
  const budget = Math.min(MAX_VITALS_CARDS, MAX_VITALS_CARDS_PER_DAY - cardedToday);
  // Each due breach tried uses up the budget, card or not, so a failing
  // Trello is called at most MAX_VITALS_CARDS times a run, as for crashes.
  const due = breaches
    .map((b) => ({ b, key: `vitals:${b.metric}:${b.path}` }))
    .filter(({ key }) => alertDue(alerts.get(key), VITALS_COOLDOWN_MS, Date.now(), VITALS_RETRY_MS))
    .slice(0, Math.max(0, budget));
  let carded = 0;
  for (const { b, key } of due) {
    if (Date.now() > deadline) break;
    if (await openAlertCard(key, VITALS_COOLDOWN_MS, vitalsCard(b), alerts.get(key) ?? null, VITALS_RETRY_MS)) carded++;
  }
  summary.vitals_cards = carded;
}

if (import.meta.main) {
  Deno.serve(async (req: Request) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (req.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!cronAuthorized(req, Deno.env.get("CRON_SECRET") || "")) return json(401, { error: "Unauthorized" });
    if (!restConfigured() || !ANON_KEY) return json(500, { error: "Server config missing" });

    // The SLA checks run first, alone, so the sweep's own queries don't slow
    // what they time; then crashes and vitals together (they share no rows).
    // Each part runs even if another fails; failures are logged and reported.
    // Without Trello only the SLA checks run (and are recorded): claiming
    // crashes and alerts for cards that can't be opened would use up their
    // retries.
    const summary: Summary = {};
    const trello = trelloConfigured();
    const deadline = Date.now() + RUN_CARD_DEADLINE_MS;
    const parts: [string, (s: Summary) => Promise<void>][] = [["sla", (s) => sweepSla(s, trello)]];
    if (trello) {
      parts.push(["crashes", (s) => sweepCrashes(s, deadline)], ["vitals", (s) => sweepVitals(s, deadline)]);
    } else {
      console.error("monitor-sweep: TRELLO_API_KEY / TRELLO_TOKEN / TRELLO_LIST_ID unset; no cards opened");
      summary.trello = "unconfigured";
    }
    const run = async ([name, part]: (typeof parts)[number]) => {
      try {
        await part(summary);
      } catch (err) {
        console.error(`monitor-sweep ${name} failed:`, err);
        summary[`${name}_error`] = String(err).slice(0, 200);
      }
    };
    await run(parts[0]);
    await Promise.all(parts.slice(1).map(run));
    const failed = Object.keys(summary).some((k) => k.endsWith("_error"));
    return json(failed ? 500 : 200, summary);
  });
}
