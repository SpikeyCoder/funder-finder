/**
 * process-organization-requests — Supabase Edge Function (scheduled)
 *
 * Trello #153 / FM-2026-10-02-02. Works the queue that request-organization
 * fills: for each pending public.organization_requests row it looks the
 * organization up in IRS data (ProPublica Nonprofit Explorer) and resolves it:
 *
 *   already_listed  EIN already in funders / recipient_organizations
 *   added           501(c)(3) public charity matched by EIN or a near-exact
 *                   name; inserted into recipient_organizations so search
 *                   finds it
 *   needs_review    private foundation (needs the 990-PF funder pipeline),
 *                   another kind of exempt org (501(c)(4), (c)(6), …), or only
 *                   approximate name matches — kept in `candidates`
 *   not_found       nothing in IRS data
 *   failed          lookup errored MAX_ATTEMPTS times
 *
 * Auto-adding is deliberately conservative: a wrong organization in search
 * is worse than a request waiting for review. "Students Feeding Students"
 * must not become "Students Feeding Oahu Foundation".
 *
 * Invoked every 15 minutes by pg_cron via public.invoke_organization_request_
 * processor(). Requires CRON_SECRET (X-Cron-Secret or `Bearer cron:<secret>`),
 * and unlike send-reminders it fails CLOSED when CRON_SECRET is unset: this
 * function writes to recipient_organizations and sends email.
 *
 * Deploy with `--no-verify-jwt`, like send-reminders / process-notifications:
 * pg_net sends no JWT, so the gateway would reject every call otherwise. The
 * CRON_SECRET check above is this function's authentication.
 *
 * Emails go to an address the visitor typed and nobody has confirmed, so they
 * never quote what the visitor typed: only fixed text and names from IRS data
 * or our own tables. They can't be used to deliver someone else's message.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { einVariants, padEin } from "../_shared/ein.ts";
import { cronAuthorized } from "../_shared/cron_auth.ts";
import { createTrelloCard } from "../_shared/trello.ts";

export { cronAuthorized };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

const PROPUBLICA = "https://projects.propublica.org/nonprofits/api/v2";
const BATCH_SIZE = 20;
// Stop taking new rows after this long, so a run (even with its last row
// slow) ends well inside the Edge runtime's wall-clock limit and the
// invoker's 120 s pg_net timeout; the rest wait for the next run.
const RUN_BUDGET_MS = 30_000;
// Outcome emails per address per day, enforced here where they're sent.
const EMAILS_PER_ADDRESS_PER_DAY = 3;
const MAX_ATTEMPTS = 3;
// A claim older than this is from a run that died; the row may be retried.
const CLAIM_TTL_MS = 10 * 60 * 1000;
// Every outbound call is bounded, so one stalled lookup can't hold the
// sequential batch until the runtime kills it.
// (A row makes at most ~11 calls, so a row started just inside RUN_BUDGET_MS
// still ends inside the invoker's 120 s pg_net timeout: 30 + 11 × 7 < 120.)
const FETCH_TIMEOUT_MS = 7_000;
// IRS foundation codes 02/03/04 are private foundations (990-PF filers).
const PRIVATE_FOUNDATION_CODES = new Set([2, 3, 4]);

export interface QueueRow {
  id: string;
  query: string;
  ein: string | null;
  state: string | null;
  requester_email: string | null;
  attempts: number;
}

export interface IrsOrg {
  ein: string; // 9 digits, zero-padded
  name: string;
  city: string | null;
  state: string | null;
  ntee_code: string | null;
}

export type Outcome =
  | { status: "already_listed"; entityType: "funder" | "recipient"; id: string; org: IrsOrg }
  | { status: "added"; id: string; org: IrsOrg }
  | { status: "needs_review"; reason: string; candidates: IrsOrg[] }
  | { status: "not_found" };

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

const LEGAL_SUFFIXES = new Set(["inc", "incorporated", "corp", "corporation", "co", "llc", "ltd", "the"]);

/** Lowercase, '&'→'and', drop punctuation and legal suffixes / leading "the". */
export function normalizeName(name: string): string {
  const words = name
    .toLowerCase()
    // "Children's" → "childrens", as IRS names write it.
    .replace(/['’]/g, "")
    // Fold accents ("Café" → "cafe") rather than dropping the letter, so
    // "Café Hope" can't normalize to the same thing as "CAF HOPE".
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ");
}

/**
 * Pick the single IRS organization a name request unambiguously refers to:
 * normalized names must be equal, and if several share the name the
 * requested state must narrow it to one. Otherwise return null.
 */
export function pickExactMatch(query: string, state: string | null, results: IrsOrg[]): IrsOrg | null {
  const target = normalizeName(query);
  let exact = results.filter((r) => normalizeName(r.name) === target);
  if (exact.length > 1 && state) exact = exact.filter((r) => r.state === state);
  return exact.length === 1 ? exact[0] : null;
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

async function propublica(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${PROPUBLICA}${path}`, {
    headers: { "User-Agent": "FunderMatch (support@fundermatch.org)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ProPublica ${res.status}`);
  return await res.json();
}

function toIrsOrg(o: Record<string, unknown>): IrsOrg {
  return {
    ein: padEin(o.ein as string | number),
    name: String(o.name ?? "").trim(),
    city: (o.city as string) || null,
    state: (o.state as string) || null,
    ntee_code: (o.ntee_code as string) || null,
  };
}

interface IrsDetail {
  org: IrsOrg;
  foundationCode: number | null;
  subsectionCode: number | null; // 3 = 501(c)(3)
}

async function irsDetail(ein: string): Promise<IrsDetail | null> {
  const d = await propublica(`/organizations/${ein}.json`);
  const o = d?.organization as Record<string, unknown> | undefined;
  if (!o) return null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return { org: toIrsOrg(o), foundationCode: num(o.foundation_code), subsectionCode: num(o.subsection_code) };
}

/**
 * Why an IRS organization can't be added automatically as a recipient, or
 * null if it can: only a 501(c)(3) public charity (known foundation code, not
 * a private foundation) is added without a person looking at it.
 */
export function reviewReason(d: Pick<IrsDetail, "foundationCode" | "subsectionCode">): string | null {
  if (d.foundationCode !== null && PRIVATE_FOUNDATION_CODES.has(d.foundationCode)) return "private foundation";
  if (d.subsectionCode !== 3 || d.foundationCode === null) return "not a 501(c)(3) public charity";
  return null;
}

type Existing = { entityType: "funder" | "recipient"; id: string; name: string };

async function existingEntity(ein: string): Promise<Existing | null> {
  // funders.id / recipient_organizations.ein aren't consistently zero-padded.
  const variants = einVariants(ein).map((v) => `"${v}"`).join(",");
  const [recips, funders] = await Promise.all([
    restJson<{ id: string; name: string }[]>(`recipient_organizations?ein=in.(${variants})&select=id,name&limit=1`),
    restJson<{ id: string; name: string; ntee_code: string | null }[]>(
      `funders?id=in.(${variants})&select=id,name,ntee_code&limit=1`,
    ),
  ]);
  if (recips.length) return { entityType: "recipient", ...recips[0] };
  // Only a funder search can show counts as listed (search_organizations
  // keeps NTEE T-code grantmakers and 990-PF filers).
  if (funders.length) {
    const f = funders[0];
    const searchable = f.ntee_code?.startsWith("T") ||
      (await restJson<unknown[]>(`foundation_filings?foundation_id=eq.${encodeURIComponent(f.id)}&select=foundation_id&limit=1`))
        .length > 0;
    if (searchable) return { entityType: "funder", id: f.id, name: f.name };
  }
  return null;
}

function listed(existing: Existing, org: IrsOrg): Outcome {
  return { status: "already_listed", entityType: existing.entityType, id: existing.id, org };
}

async function resolve(row: QueueRow): Promise<Outcome> {
  if (row.ein) {
    // An EIN we already list needs no IRS lookup (and ProPublica may not
    // have it: a revoked or very new filer).
    const ein = padEin(row.ein);
    const existing = await existingEntity(ein);
    if (existing) return listed(existing, { ein, name: existing.name, city: null, state: null, ntee_code: null });
    const detail = await irsDetail(ein);
    if (!detail) return { status: "not_found" };
    return await addOrList(detail, false);
  }

  const params = new URLSearchParams({ q: row.query });
  if (row.state) params.set("state[id]", row.state);
  const search = await propublica(`/search.json?${params}`);
  const results = ((search?.organizations as Record<string, unknown>[]) || []).map(toIrsOrg);
  if (!results.length) return { status: "not_found" };
  // Only the first page is fetched: with more pages, another organization of
  // the same name could be on one of them, so "unique" can't be known.
  const onePage = Number(search?.num_pages ?? 1) <= 1;
  const match = onePage ? pickExactMatch(row.query, row.state, results) : null;
  if (!match) {
    return { status: "needs_review", reason: "no exact name match", candidates: results.slice(0, 5) };
  }
  const detail = await irsDetail(match.ein);
  // Found by search but its detail record is missing (search can run ahead of
  // it): a person can look, rather than telling the requester "not found".
  if (!detail) return { status: "needs_review", reason: "no exact name match", candidates: [match] };
  return await addOrList(detail, true);
}

async function addOrList(detail: IrsDetail, checkExisting: boolean): Promise<Outcome> {
  if (checkExisting) {
    const existing = await existingEntity(detail.org.ein);
    if (existing) return listed(existing, detail.org);
  }

  const reason = reviewReason(detail);
  if (reason) return { status: "needs_review", reason, candidates: [detail.org] };

  // Inserted by an RPC that locks the EIN and inserts only if neither stored
  // form exists, so two runs handling requests for the same organization
  // can't both add it.
  const [row0] = await restJson<{ id: string; created: boolean }[]>("rpc/add_requested_recipient", {
    method: "POST",
    body: JSON.stringify({
      p_ein: detail.org.ein,
      p_name: detail.org.name,
      p_name_normalized: normalizeName(detail.org.name),
      p_city: detail.org.city,
      p_state: detail.org.state,
      p_ntee_code: detail.org.ntee_code,
    }),
  });
  if (!row0.created) {
    return { status: "already_listed", entityType: "recipient", id: row0.id, org: detail.org };
  }
  return { status: "added", id: row0.id, org: detail.org };
}

// ── Email ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Never quotes the visitor's own text (see the header): the recipient address
// is unconfirmed. Organization names come from IRS data or our own tables.
export function notificationFor(row: QueueRow, outcome: Outcome): { subject: string; text: string } | null {
  switch (outcome.status) {
    case "added":
    case "already_listed": {
      const path = outcome.status === "already_listed" && outcome.entityType === "funder"
        ? `/funder/${outcome.id}`
        : `/recipient/${outcome.id}`;
      return {
        subject: `${outcome.org.name} is on FunderMatch`,
        text: `The organization you asked us to add is now available on FunderMatch:\n\n` +
          `${outcome.org.name}\nhttps://fundermatch.org${path}`,
      };
    }
    case "not_found":
      return row.ein
        ? {
          // The EIN is validated digits, safe to quote.
          subject: "We couldn't find the organization you requested",
          text: `We couldn't find EIN ${row.ein} in IRS nonprofit records. Please check the number; a ` +
            "newly registered organization may not be listed yet.",
        }
        : {
          subject: "We couldn't find the organization you requested",
          text: "We searched IRS nonprofit records for the organization you asked us to add and couldn't " +
            "find a match. If it has an EIN, you can request it again with the EIN at https://fundermatch.org/search.",
        };
    case "needs_review": {
      // The form promised an email; say where the request stands. (A person
      // takes it from here via the review card.) The reason is our own
      // fixed text, never the visitor's.
      const why = outcome.reason === "no exact name match"
        ? "We couldn't automatically match the organization you asked us to add to a single IRS nonprofit record"
        : outcome.reason === "private foundation"
        ? "We found the organization you asked us to add in IRS records. It's a private foundation, which we add by hand"
        : "We found the organization you asked us to add in IRS records, but it isn't a type of organization we add automatically";
      return {
        subject: "We're reviewing your organization request",
        text: `${why}, so someone on our team will review it. If we can add it, it will appear in ` +
          "FunderMatch search at https://fundermatch.org/search.",
      };
    }
  }
}

// For a request we gave up on (lookups kept failing), so the requester isn't
// left waiting on the email the form promised.
export const FAILURE_NOTICE = {
  subject: "We couldn't process your organization request",
  text: "We weren't able to look up the organization you asked us to add, because of a problem on our " +
    "side. Please request it again at https://fundermatch.org/search.",
};

async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "FunderMatch <noreply@fundermatch.org>",
      to: [to],
      subject,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    }),
  });
  if (!res.ok) console.error("Resend error:", res.status, await res.text());
  return res.ok;
}

// ── Review queue (Trello) ───────────────────────────────────────────────────

export function reviewCardFor(row: QueueRow, reason: string, candidates: IrsOrg[]): { name: string; desc: string } {
  const lines = candidates.map((c) =>
    `- ${c.name} — EIN ${c.ein}${c.city || c.state ? ` — ${[c.city, c.state].filter(Boolean).join(", ")}` : ""}` +
    ` — https://projects.propublica.org/nonprofits/organizations/${Number(c.ein)}`
  );
  return {
    name: `[ORG REQUEST] ${row.query}`.slice(0, 200),
    desc: [
      `Someone asked for "${row.query}" to be added to FunderMatch and it needs a person to decide (${reason}).`,
      "",
      row.ein ? `Requested EIN: ${row.ein}` : "No EIN given.",
      row.state ? `Requested state: ${row.state}` : "",
      "",
      candidates.length ? "IRS candidates:" : "",
      ...lines,
      "",
      `organization_requests.id = ${row.id}`,
    ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n"),
  };
}

// Reuses report-bug's Trello list so requests land where bug reports are
// triaged. Best-effort: a missing config or Trello error doesn't fail the row.
// "unconfigured" (no TRELLO_* secrets) is a deployment state, not a failure
// to retry; false is a Trello error worth retrying.
async function createReviewCard(card: { name: string; desc: string }): Promise<boolean | "unconfigured"> {
  const url = await createTrelloCard(card, FETCH_TIMEOUT_MS);
  return url === "unconfigured" ? url : url !== null;
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function notifyFailure(row: QueueRow, now: string): Promise<void> {
  if (!row.requester_email || !RESEND_API_KEY) return;
  // Fails closed: if the cap can't be checked, don't send.
  if (await emailsSentRecently(row.requester_email).catch(() => EMAILS_PER_ADDRESS_PER_DAY) >= EMAILS_PER_ADDRESS_PER_DAY) {
    return;
  }
  if (await sendEmail(row.requester_email, FAILURE_NOTICE.subject, FAILURE_NOTICE.text).catch(() => false)) {
    await patchRow(row.id, { notified_at: now }).catch((e) =>
      console.error(`organization request ${row.id}: notified but could not record it:`, e)
    );
  }
}

// Write to the row only while this run still holds it (pending, with our
// claim): the purge may have expired it, or a later run reclaimed it after
// our claim went stale. Returns false if the row was no longer ours.
async function patchClaimed(id: string, claimedAt: string, patch: Record<string, unknown>): Promise<boolean> {
  const res = await rest(
    `organization_requests?id=eq.${id}&status=eq.pending&claimed_at=eq.${encodeURIComponent(claimedAt)}&select=id`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) },
  );
  if (!res.ok) throw new Error(`REST organization_requests PATCH ${res.status}: ${await res.text()}`);
  return ((await res.json()) as unknown[]).length === 1;
}

async function patchRow(id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await rest(`organization_requests?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`REST organization_requests PATCH ${res.status}: ${await res.text()}`);
}

// Take the row for this run, unless another run holds a live claim on it
// (overlapping cron ticks, or a manual invocation alongside one). The claim
// counts as an attempt, so a row whose run is killed mid-lookup (no catch
// runs) still reaches MAX_ATTEMPTS instead of being retried forever.
async function claimRow(row: QueueRow, now: Date): Promise<boolean> {
  const stale = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const res = await rest(
    `organization_requests?id=eq.${row.id}&status=eq.pending&attempts=eq.${row.attempts}` +
      `&or=(claimed_at.is.null,claimed_at.lt.${encodeURIComponent(stale)})&select=id`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ claimed_at: now.toISOString(), attempts: row.attempts + 1 }),
    },
  );
  if (!res.ok) throw new Error(`REST organization_requests claim ${res.status}: ${await res.text()}`);
  return ((await res.json()) as unknown[]).length === 1;
}

// Per-run state: which review cards this run already opened.
interface RunState {
  cardKeys: Set<string>;
}

// Counted per mailbox, not per exact address: "victim@x.org",
// "victim+1@x.org" and "victim+2@x.org" share one allowance.
async function emailsSentRecently(email: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const at = email.lastIndexOf("@");
  const box = email.slice(0, at).split("+")[0];
  const domain = email.slice(at);
  // LIKE wildcards in the address itself are literal.
  const likeEsc = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
  const filters = [
    `requester_email=eq.${encodeURIComponent(box + domain)}`,
    `requester_email=like.${encodeURIComponent(`${likeEsc(box)}+*${likeEsc(domain)}`)}`,
  ];
  const counts = await Promise.all(filters.map((f) =>
    restJson<unknown[]>(
      `organization_requests?${f}&notified_at=gte.${encodeURIComponent(since)}` +
        `&select=id&limit=${EMAILS_PER_ADDRESS_PER_DAY}`,
    ).then((rows) => rows.length)
  ));
  return counts[0] + counts[1];
}

async function processRow(row: QueueRow, run: RunState): Promise<string> {
  const started = new Date();
  const now = started.toISOString();
  try {
    if (!(await claimRow(row, started))) return "skipped";
  } catch (err) {
    // Leave it for the next run; don't let one row end the batch.
    console.error(`organization request ${row.id}: claim failed:`, err);
    return "retry";
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    // Earlier runs claimed it and never finished (e.g. killed mid-lookup).
    const marked = await patchClaimed(row.id, now, {
      status: "failed",
      processed_at: now,
      last_error: "gave up: earlier attempts never finished",
    }).catch((e) => {
      console.error(`organization request ${row.id}: could not mark it failed:`, e);
      return false;
    });
    if (marked) await notifyFailure(row, now);
    return "failed";
  }
  let outcome: Outcome;
  let reviewCandidates: IrsOrg[] | null = null;
  let reviewable = true;
  try {
    outcome = await resolve(row);
    if (outcome.status === "needs_review") {
      reviewCandidates = outcome.candidates;
      // The card *is* the review, so it's opened before the outcome is
      // recorded, and failing to open one counts as a failed attempt: the row
      // is retried, and after MAX_ATTEMPTS the requester is told we couldn't
      // process it. (If the write below then failed, a retry could open a
      // second card; that beats a request nobody is asked to review.) Rows
      // for the same organization share one card per run.
      // An EIN request is keyed by the EIN, however its name was typed.
      const key = row.ein ? `ein:${padEin(row.ein)}` : `name:${normalizeName(row.query)}|${row.state ?? ""}`;
      if (!run.cardKeys.has(key)) {
        const carded = await createReviewCard(reviewCardFor(row, outcome.reason, outcome.candidates));
        if (carded === "unconfigured") {
          // Retrying can't help: record it as needs_review (findable in the
          // table) but don't tell the requester someone is reviewing it.
          console.error(`organization request ${row.id} needs review but TRELLO_* is unset; no card, no email`);
          reviewable = false;
        } else if (!carded) {
          throw new Error("review card could not be created (Trello failing)");
        } else {
          run.cardKeys.add(key);
        }
      }
    }
  } catch (err) {
    const attempts = row.attempts + 1; // as claimed
    const message = err instanceof Error ? err.message : String(err);
    console.error(`organization request ${row.id} failed (attempt ${attempts}):`, message);
    const recorded = await patchClaimed(row.id, now, {
      last_error: message.slice(0, 500),
      claimed_at: null, // retry on the next run
      // Keep what the lookup found (e.g. when only the review card failed),
      // so a failed request can still be picked up by hand.
      ...(reviewCandidates ? { candidates: reviewCandidates } : {}),
      ...(attempts >= MAX_ATTEMPTS ? { status: "failed", processed_at: now } : {}),
    }).catch((e) => {
      console.error(`organization request ${row.id}: could not record the failure:`, e);
      return false;
    });
    if (attempts >= MAX_ATTEMPTS && recorded) await notifyFailure(row, now);
    return attempts >= MAX_ATTEMPTS ? "failed" : "retry";
  }

  const patch: Record<string, unknown> = { status: outcome.status, processed_at: now, last_error: null };
  if (outcome.status === "added") {
    patch.resolved_entity_type = "recipient";
    patch.resolved_id = outcome.id;
    patch.candidates = [outcome.org];
  } else if (outcome.status === "already_listed") {
    patch.resolved_entity_type = outcome.entityType;
    patch.resolved_id = outcome.id;
    patch.candidates = [outcome.org];
  } else if (outcome.status === "needs_review") {
    patch.candidates = outcome.candidates;
    patch.last_error = outcome.reason;
  }
  // Record the outcome before emailing: if this write failed after the
  // email, the row would stay pending and the next run would send it again.
  try {
    if (!(await patchClaimed(row.id, now, patch))) {
      // Expired by the purge or reclaimed by another run meanwhile: leave the
      // row as it is now and send nothing.
      console.error(`organization request ${row.id}: no longer ours; outcome ${outcome.status} not recorded`);
      return "skipped";
    }
  } catch (err) {
    // The outcome itself stands (an added organization stays added); only
    // recording it failed. Release the claim for the next run (an addition
    // then resolves as already listed). The claim's attempt still counts, so
    // a write that keeps failing ends in MAX_ATTEMPTS rather than repeating
    // lookups and review cards forever.
    console.error(`organization request ${row.id}: could not record its outcome:`, err);
    await patchClaimed(row.id, now, { claimed_at: null }).catch((e) =>
      console.error(`organization request ${row.id}: could not release it:`, e)
    );
    return "retry";
  }

  // (Without RESEND_API_KEY nothing can be sent; skip the cap lookup too.)
  const note = row.requester_email && RESEND_API_KEY && reviewable ? notificationFor(row, outcome) : null;
  const underCap = note
    // Fails closed: an unchecked cap is no cap.
    ? await emailsSentRecently(row.requester_email!).then((n) => n < EMAILS_PER_ADDRESS_PER_DAY, () => false)
    : false;
  if (note && underCap && await sendEmail(row.requester_email!, note.subject, note.text).catch(() => false)) {
    await patchRow(row.id, { notified_at: now }).catch((e) =>
      console.error(`organization request ${row.id}: notified but could not record it:`, e)
    );
  }
  return outcome.status;
}

if (import.meta.main) {
  Deno.serve(async (req: Request) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (req.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!cronAuthorized(req, Deno.env.get("CRON_SECRET") || "")) return json(401, { error: "Unauthorized" });
    if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: "Server config missing" });

    try {
      const rows = await restJson<QueueRow[]>(
        `organization_requests?status=eq.pending&order=created_at.asc&limit=${BATCH_SIZE}` +
          `&or=(claimed_at.is.null,claimed_at.lt.${encodeURIComponent(new Date(Date.now() - CLAIM_TTL_MS).toISOString())})` +
          `&select=id,query,ein,state,requester_email,attempts`,
      );
      const summary: Record<string, number> = {};
      const runStart = Date.now();
      const run: RunState = { cardKeys: new Set() };
      // Sequential on purpose: be polite to ProPublica's free API.
      for (const row of rows) {
        if (Date.now() - runStart > RUN_BUDGET_MS) {
          summary.deferred = (summary.deferred || 0) + 1;
          continue;
        }
        const result = await processRow(row, run);
        summary[result] = (summary[result] || 0) + 1;
      }
      return json(200, { processed: rows.length, summary });
    } catch (err) {
      console.error("process-organization-requests error:", err);
      return json(500, { error: "Internal server error" });
    }
  });
}
