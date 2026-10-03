import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fingerprint, fingerprintSource, normalizePath, parseCrash, parseVitals, scrub } from "./index.ts";

Deno.test("scrub masks emails and drops query strings", () => {
  assertEquals(
    scrub("No user jane.doe+x@example.org at https://fundermatch.org/search?q=jane#top done"),
    "No user [email] at https://fundermatch.org/search done",
  );
});

Deno.test("normalizePath collapses ids and drops query strings", () => {
  assertEquals(normalizePath("/recipient/2da01037-c1bc-4106-8c21-40008ead6ca7?x=1"), "/recipient/:id");
  assertEquals(normalizePath("/funder/010224898/"), "/funder/:id");
  assertEquals(normalizePath("/search"), "/search");
  assertEquals(normalizePath(""), "/");
});

const STACK_A = "TypeError: Cannot read properties of undefined (reading 'name')\n" +
  "    at Xt (https://fundermatch.org/assets/OrgSearch-BrsvDQt6.js:12:345)\n    at div";
const STACK_B = "TypeError: Cannot read properties of undefined (reading 'name')\n" +
  "    at Xt (https://fundermatch.org/assets/OrgSearch-Zq81LmP2.js:12:999)\n    at div";

Deno.test("fingerprint ignores build hashes, line numbers and values in the message", async () => {
  const msg = (n: number) => `Request ${n} failed for "query ${n}"`;
  assertEquals(
    await fingerprint("TypeError", msg(1), STACK_A),
    await fingerprint("TypeError", msg(2), STACK_B),
  );
  assert(fingerprintSource("TypeError", msg(1), STACK_A).endsWith("at Xt (/assets/OrgSearch.js)"));
});

Deno.test("fingerprint separates different errors and frames", async () => {
  const a = await fingerprint("TypeError", "x is undefined", STACK_A);
  assertNotEquals(a, await fingerprint("RangeError", "x is undefined", STACK_A));
  assertNotEquals(a, await fingerprint("TypeError", "y is undefined", STACK_A));
  assertNotEquals(a, await fingerprint("TypeError", "x is undefined", STACK_A.replace("at Xt", "at Yt")));
});

Deno.test("fingerprint reads Safari/Firefox frames", () => {
  assert(fingerprintSource("Error", "boom", "Xt@https://fundermatch.org/assets/index-AbC123xy.js:3:20").endsWith("Xt@/assets/index.js"));
});

Deno.test("parseCrash validates and scrubs", async () => {
  assertEquals(await parseCrash({ kind: "nope", message: "x" }, ""), "Invalid kind");
  assertEquals(await parseCrash({ kind: "error" }, ""), "Empty report");
  const row = await parseCrash({
    kind: "boundary",
    name: "TypeError",
    message: "bad a@b.org",
    stack: STACK_A,
    componentStack: "at OrgSearch",
    path: "/recipient/2da01037-c1bc-4106-8c21-40008ead6ca7?q=1",
    release: "index-BrsvDQt6.js",
  }, "UA/1.0");
  if (typeof row === "string") throw new Error(row);
  assertEquals(row.message, "bad [email]");
  assertEquals(row.path, "/recipient/:id");
  assertEquals(row.release, "index-BrsvDQt6.js");
  assertEquals(row.fingerprint.length, 64);
  const bad = await parseCrash({ kind: "error", message: "x", release: "<script>" }, "");
  if (typeof bad === "string") throw new Error(bad);
  assertEquals(bad.release, "");
});

Deno.test("parseVitals accepts the three metrics within range only", () => {
  const ok = parseVitals({
    path: "/search/",
    release: "index-a.js",
    metrics: [{ name: "LCP", value: 2500, rating: "good" }, { name: "CLS", value: 0.3, rating: "poor" }],
  });
  if (typeof ok === "string") throw new Error(ok);
  assertEquals(ok.map((r) => [r.metric, r.path]), [["LCP", "/search"], ["CLS", "/search"]]);
  assertEquals(parseVitals({ metrics: [{ name: "FID", value: 1, rating: "good" }] }), "Invalid metric");
  assertEquals(parseVitals({ metrics: [{ name: "LCP", value: -1, rating: "good" }] }), "Invalid value");
  assertEquals(parseVitals({ metrics: [{ name: "LCP", value: Infinity, rating: "good" }] }), "Invalid value");
  assertEquals(parseVitals({ metrics: [{ name: "LCP", value: 1, rating: "bad" }] }), "Invalid rating");
  assertEquals(parseVitals({ metrics: [{ name: "LCP", value: 1, rating: "good" }, { name: "LCP", value: 2, rating: "good" }] }), "Invalid metric");
  assertEquals(parseVitals({ metrics: "x" }), "Invalid metrics");
});

Deno.test("scrub strips a query string that holds an address, and masks a bare one", () => {
  assertEquals(
    scrub("GET https://x.supabase.co/rest/v1/t?email=eq.a@b.org&x=1 failed for c@d.org"),
    "GET https://x.supabase.co/rest/v1/t failed for [email]",
  );
});
