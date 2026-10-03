import { assert, assertEquals } from "jsr:@std/assert@1";
import { crashCard, slaBreached, slaCard, vitalsCard } from "./index.ts";
import { cronAuthorized } from "../_shared/cron_auth.ts";

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

Deno.test("crash card title is bounded", () => {
  assert(crashCard({ ...crash, message: "m".repeat(1000) }).name.length <= 130);
});

Deno.test("SLA breach needs 2 failed checks in the window", () => {
  assertEquals(slaBreached([{ ok: true }, { ok: false }, { ok: true }]), false);
  assertEquals(slaBreached([{ ok: false }, { ok: true }, { ok: false }]), true);
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

Deno.test("cron auth fails closed and accepts both header forms", () => {
  const req = (h: Record<string, string>) => new Request("http://x", { method: "POST", headers: h });
  assertEquals(cronAuthorized(req({ "x-cron-secret": "s3cret" }), ""), false);
  assertEquals(cronAuthorized(req({ "x-cron-secret": "s3cret" }), "s3cret"), true);
  assertEquals(cronAuthorized(req({ authorization: "Bearer cron:s3cret" }), "s3cret"), true);
  assertEquals(cronAuthorized(req({ "x-cron-secret": "nope" }), "s3cret"), false);
  assertEquals(cronAuthorized(req({}), "s3cret"), false);
});
