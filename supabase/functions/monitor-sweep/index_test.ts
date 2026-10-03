import { assert, assertEquals } from "jsr:@std/assert@1";
import { alertDue, cardUrl, crashCard, crashOverflowCard, pickCrashes, slaBreached, slaCard, vitalsCard } from "./index.ts";

const crash = {
  fingerprint: "f".repeat(64),
  kind: "boundary",
  name: "TypeError",
  message: "x is undefined",
  stack: "TypeError: x is undefined\n    at Xt (/assets/OrgSearch.js:1:2)\n```injected```",
  component_stack: "at OrgSearch",
  path: "/search",
  release: "index-AbC.js",
  user_agent: "Mozilla/5.0",
  occurrences: 7,
  first_seen: "2026-10-03T07:00:00Z",
  last_seen: "2026-10-03T07:10:00Z",
  card_attempts: 0,
  card_attempted_at: null,
};

Deno.test("crash card names the error and counts occurrences", () => {
  const c = crashCard(crash);
  assertEquals(c.name, "[CRASH] TypeError: x is undefined");
  assert(c.desc.includes("**Occurrences:** 7"));
  assert(c.desc.includes("error screen shown"));
  assert(c.desc.includes(crash.fingerprint));
  // Reported text can't close the code fence it's shown in.
  assertEquals(c.desc.match(/```/g)!.length % 2, 0);
  assert(!c.desc.includes("```injected```"));
});

Deno.test("reported fields can't add links or formatting to a card", () => {
  const c = crashCard({ ...crash, user_agent: "[Fix: see logs](https://evil.example/login)\n**urgent**", path: "/x`)[a](b)" });
  assert(c.desc.includes("**Browser (latest):** `[Fix: see logs](https://evil.example/login) **urgent**`"));
  assert(c.desc.includes("**Page:** `/x )[a](b)`"));
  assert(vitalsCard({ metric: "LCP", path: "/[a](https://evil)", samples: 20, p75: 5000, poor_share: 0.5 }).desc.includes("`/[a](https://evil)`"));
});

Deno.test("alerts: due when new, after the quiet period, or an hour after a claim that got no card", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  assertEquals(alertDue(undefined, day, now), true);
  assertEquals(alertDue({ last_carded_at: "2026-10-03T06:00:00Z", trello_card_url: "u" }, day, now), false);
  assertEquals(alertDue({ last_carded_at: "2026-10-02T11:00:00Z", trello_card_url: "u" }, day, now), true);
  assertEquals(alertDue({ last_carded_at: "2026-10-03T11:30:00Z", trello_card_url: null }, day, now), false);
  assertEquals(alertDue({ last_carded_at: "2026-10-03T10:30:00Z", trello_card_url: null }, day, now), true);
});

Deno.test("an SLA check with no results counts as failed (checked in runSlaCheck's detail)", () => {
  // slaBreached only counts ok=false; runSlaCheck sets ok=false for an empty result.
  assertEquals(slaBreached([{ ok: false, checked_at: "2026-10-03T07:06:01Z" }, { ok: false, checked_at: "2026-10-03T07:21:01Z" }]), true);
});

Deno.test("a Trello timeout is recorded (no duplicate card); failures and no config aren't", () => {
  assertEquals(cardUrl("https://trello.com/c/x"), "https://trello.com/c/x");
  assert(cardUrl("timeout")!.includes("timed out"));
  assertEquals(cardUrl(null), null);
  assertEquals(cardUrl("unconfigured"), null);
});

Deno.test("overflow card says how many crashes wait", () => {
  assertEquals(crashOverflowCard(37).name, "[CRASH] 37 more new kinds of crash waiting (daily card limit reached)");
});

Deno.test("crash card titles carry no links", () => {
  const c = crashCard({ ...crash, name: "Security notice", message: "Rotate the Trello token now at https://evil.example/trello-login or www.evil.example or evil-login.com/x" });
  assertEquals(c.name, "[CRASH] Security notice: Rotate the Trello token now at <url> or <url> or evil-login[.]com/x");
  // Any TLD, not a list.
  assertEquals(crashCard({ ...crash, name: "Notice", message: "rotate at trello-support.ai/verify or a.b.xyz" }).name,
    "[CRASH] Notice: rotate at trello-support[.]ai/verify or a[.]b[.]xyz");
  // Property names that look like domains stay readable.
  assertEquals(crashCard({ ...crash, name: "TypeError", message: "e.info is not a function (reading 'config.app')" }).name,
    "[CRASH] TypeError: e[.]info is not a function (reading 'config[.]app')");
});

Deno.test("crash card title is bounded", () => {
  assert(crashCard({ ...crash, message: "m".repeat(1000) }).name.length <= 130);
});

Deno.test("SLA breach needs 2 failed checks in the window, from 2 runs", () => {
  const at = (hhmmss: string) => `2026-10-03T${hhmmss}Z`;
  assertEquals(slaBreached([{ ok: true, checked_at: at("07:06:01") }, { ok: false, checked_at: at("07:06:03") }]), false);
  assertEquals(slaBreached([{ ok: false, checked_at: at("07:06:01") }, { ok: true, checked_at: at("07:21:01") }, { ok: false, checked_at: at("07:36:02") }]), true);
  // One slow run (a cold boot slows all its checks) isn't a breach.
  assertEquals(slaBreached([{ ok: false, checked_at: at("07:06:01") }, { ok: false, checked_at: at("07:06:01") }, { ok: false, checked_at: at("07:06:01") }]), false);
  assertEquals(slaBreached([]), false);
});

Deno.test("SLA card lists every check", () => {
  const c = slaCard([
    { check_name: "foundation", ok: false, status: 502, ms: 3300, detail: "Search failed", checked_at: "07:09" },
    { check_name: "foundation", ok: false, status: null, ms: 5001, detail: "TimeoutError", checked_at: "07:24" },
    { check_name: "01-0224898", ok: true, status: 200, ms: 120, detail: null, checked_at: "07:24" },
  ]);
  assertEquals(c.name, "[SLA] Search: 2 of 3 checks failed in the last hour");
  assertEquals(c.desc.split("\n").filter((l) => l.startsWith("| 07:")).length, 3);
});

Deno.test("vitals card formats each metric", () => {
  assertEquals(vitalsCard({ metric: "LCP", path: "/search", samples: 40, p75: 5234, poor_share: 0.3 }).name,
    "[PERF] LCP is poor on /search (p75 5.2 s)");
  assertEquals(vitalsCard({ metric: "INP", path: "/", samples: 40, p75: 612.4, poor_share: 0.3 }).name,
    "[PERF] INP is poor on / (p75 612 ms)");
  assert(vitalsCard({ metric: "CLS", path: "/", samples: 25, p75: 0.31, poor_share: 0.28 }).desc.includes("**Share rated poor:** 28%"));
});

Deno.test("a regression's card links the earlier one", () => {
  assert(crashCard({ ...crash, previous_card_url: "https://trello.com/c/old" }).desc.includes("earlier card: https://trello.com/c/old"));
  assert(!crashCard(crash).desc.includes("earlier card"));
});

Deno.test("pickCrashes: retries within the day use no daily budget; 5 calls a run", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const fresh = (n: string) => ({ n, card_attempted_at: null });
  const retry = (n: string) => ({ n, card_attempted_at: "2026-10-03T10:00:00Z" }); // tried 2 h ago
  const old = (n: string) => ({ n, card_attempted_at: "2026-10-01T10:00:00Z" }); // tried 2 days ago: counts anew
  const names = (xs: { n: string }[]) => xs.map((x) => x.n).join(",");
  assertEquals(names(pickCrashes([retry("a"), fresh("b"), fresh("c"), old("d")], 1, now)), "a,b");
  assertEquals(names(pickCrashes([fresh("b"), retry("a")], 0, now)), "a");
  assertEquals(pickCrashes(Array.from({ length: 9 }, (_, i) => fresh(String(i))), 10, now).length, 5);
});
