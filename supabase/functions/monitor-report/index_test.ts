import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fingerprint, fingerprintSource, normalizeMessage, parseCrash, parseVitals, readLimited } from "./index.ts";
import { normalizePath, scrub } from "../_shared/monitor_scrub.ts";

Deno.test("scrub masks emails and drops query strings", () => {
  assertEquals(
    scrub("No user jane.doe+x@example.org at https://fundermatch.org/search?q=jane#top done"),
    "No user [email] at https://fundermatch.org/search done",
  );
});

Deno.test("normalizePath hides share tokens and route ids", () => {
  assertEquals(normalizePath("/shared/9f3a1c0e5b7d4a2f8e6c1b0a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e"), "/shared/:id");
  assertEquals(normalizePath("/shared/abc"), "/shared/:id");
  assertEquals(normalizePath("/projects/42/tracker"), "/projects/:id/tracker");
  assertEquals(normalizePath("/projects/new/chat"), "/projects/new/chat");
  assertEquals(normalizePath("/unknown/a1b2c3d4e5f6g7h8i9"), "(other)");
  assertEquals(normalizePath("/made-up-path-1"), "(other)");
  assertEquals(normalizePath("/onboarding/first-project"), "/onboarding/first-project");
  assertEquals(normalizePath("/Search/"), "/search");
  assertEquals(normalizePath("/Projects/42/Tracker"), "/projects/:id/tracker");
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
  assert(fingerprintSource("TypeError", msg(1), STACK_A).endsWith("|/assets/OrgSearch.js"));
});

Deno.test("fingerprint survives renamed minified functions and hashes containing - or _", async () => {
  const a = "Error: x\n    at Xt (https://fundermatch.org/assets/LoginPage-DK1D-7OR.js:3:9)";
  const b = "Error: x\n    at Qa (https://fundermatch.org/assets/LoginPage-a_b9Zk2Q.js:7:1)";
  assertEquals(await fingerprint("Error", "x", a), await fingerprint("Error", "x", b));
  assert(fingerprintSource("Error", "x", a).endsWith("|/assets/LoginPage.js"));
  // A dashed module name keeps its name, loses only the hash.
  assert(fingerprintSource("Error", "x", "at f (https://x/assets/chunk-reload-AbC12345.js:1:1)").endsWith("|/assets/chunk-reload.js"));
  assert(fingerprintSource("Error", "x", "at f (https://x/assets/ab-cd-AbC12345.js:1:1)").endsWith("|/assets/ab-cd.js"));
});

Deno.test("message normalisation keeps the meaning, drops values and minified names", () => {
  assertEquals(
    normalizeMessage("Cannot read properties of undefined (reading 'name')"),
    "Cannot read properties of undefined (reading 'name')",
  );
  assertEquals(normalizeMessage("Xt is not a function"), normalizeMessage("Qa is not a function"));
  assertEquals(normalizeMessage("e is undefined"), "<id> is undefined");
  assertEquals(normalizeMessage('No funder "Ford Foundation 2024" found'), "No funder <str> found");
  assertEquals(normalizeMessage("Request 42 failed at https://x/y"), "Request <n> failed at <url>");
  // HTTP statuses are different failures; other numbers aren't.
  assertEquals(normalizeMessage("Request failed with status code 401"), "Request failed with status code 401");
  assertEquals(normalizeMessage("HTTP 500 from server"), "HTTP 500 from server");
  assertEquals(normalizeMessage("Expected 200 rows"), "Expected <n> rows");
  assertEquals(normalizeMessage("status code 12345"), "status code <n>");
  // Safari quotes expressions; Firefox doesn't: minified parts go either way.
  assertEquals(
    normalizeMessage("undefined is not an object (evaluating 'n.current.focus')"),
    normalizeMessage("undefined is not an object (evaluating 't.current.focus')"),
  );
  assertEquals(normalizeMessage("t.current is null"), "<id>.current is null");
  // Minified names that are also short words.
  assertEquals(normalizeMessage("a is not a function"), normalizeMessage("e is not a function"));
  assertEquals(normalizeMessage("in.x is null"), normalizeMessage("t.x is null"));
  assertEquals(normalizeMessage("No organizations found"), "No organizations found");
  // TDZ errors name a minified variable, quoted.
  assertEquals(normalizeMessage("Cannot access 'Xt' before initialization"), normalizeMessage("Cannot access 'Qa' before initialization"));
  assertEquals(normalizeMessage("can't access lexical declaration 'Xt' before initialization"), "can't access lexical declaration '<id>' before initialization");
  // React's numbered production errors are different bugs.
  const react = (n: number) => `Minified React error #${n}; visit https://react.dev/errors/${n} for the full message`;
  assertNotEquals(normalizeMessage(react(418)), normalizeMessage(react(310)));
  assertEquals(normalizeMessage(react(418)), "Minified React error #418; visit <url> for the full message");
});

Deno.test("fingerprint separates different errors and frames", async () => {
  const read = (p: string) => `Cannot read properties of undefined (reading '${p}')`;
  assertNotEquals(await fingerprint("TypeError", read("name"), STACK_A), await fingerprint("TypeError", read("map"), STACK_A));
  const a = await fingerprint("TypeError", "x is undefined", STACK_A);
  assertNotEquals(a, await fingerprint("RangeError", "x is undefined", STACK_A));
  assertNotEquals(a, await fingerprint("TypeError", "x is null", STACK_A));
  assertNotEquals(a, await fingerprint("TypeError", "x is undefined", STACK_A.replace("OrgSearch-", "FunderPage-")));
});

Deno.test("fingerprint reads Safari/Firefox frames", () => {
  assert(fingerprintSource("Error", "boom", "Xt@https://fundermatch.org/assets/index-AbC123xy.js:3:20").endsWith("|/assets/index.js"));
});

Deno.test("parseCrash validates and scrubs", async () => {
  assertEquals(await parseCrash({ kind: "nope", message: "x" }, ""), "Invalid kind");
  assertEquals(await parseCrash({ kind: "error" }, ""), "Empty report");
  assertEquals(await parseCrash({ kind: "error", message: "", stack: 1 }, ""), "Empty report");
  const named = await parseCrash({ kind: "error", name: "jane@example.org", message: "x" }, "");
  if (typeof named === "string") throw new Error(named);
  assertEquals(named.name, "[email]");
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
  const id = (n: number) => `v5-1696300000000-${n}234567890123`;
  const m = (name: string, value: number, rating = "good", i = 1) => ({ id: id(i), name, value, rating });
  const ok = parseVitals({
    path: "/search/",
    release: "index-a.js",
    metrics: [m("LCP", 2500), m("CLS", 0.3, "poor", 2)],
  });
  if (typeof ok === "string") throw new Error(ok);
  assertEquals(ok.map((r) => [r.metric_id, r.metric, r.path]), [[id(1), "LCP", "/search"], [id(2), "CLS", "/search"]]);
  assertEquals(parseVitals({ metrics: [m("FID", 1)] }), "Invalid metric");
  assertEquals(parseVitals({ metrics: [m("LCP", -1)] }), "Invalid value");
  assertEquals(parseVitals({ metrics: [m("LCP", Infinity)] }), "Invalid value");
  assertEquals(parseVitals({ metrics: [m("LCP", 1, "bad")] }), "Invalid rating");
  // Two page views' metrics in one batch are fine; the same id twice isn't.
  const twoViews = parseVitals({ metrics: [m("CLS", 0.1), m("CLS", 0.2, "good", 2)] });
  if (typeof twoViews === "string") throw new Error(twoViews);
  assertEquals(twoViews.length, 2);
  assertEquals(parseVitals({ metrics: [m("LCP", 1), m("LCP", 2)] }), "Invalid id");
  assertEquals(parseVitals({ metrics: Array.from({ length: 7 }, (_, i) => m("CLS", 0.1, "good", i + 1)) }), "Invalid metrics");
  assertEquals(parseVitals({ metrics: [{ name: "LCP", value: 1, rating: "good" }] }), "Invalid id");
  assertEquals(parseVitals({ metrics: [{ ...m("LCP", 1), id: "x'; drop" }] }), "Invalid id");
  assertEquals(parseVitals({ metrics: [m("toString", 1)] }), "Invalid metric");
  // Per-metric path wins over the report's (INP/CLS can belong to a later page).
  const perMetric = parseVitals({ path: "/", metrics: [{ ...m("INP", 900, "poor"), path: "/search?q=x" }, m("LCP", 1000, "good", 2)] });
  if (typeof perMetric === "string") throw new Error(perMetric);
  assertEquals(perMetric.map((r) => [r.metric, r.path]), [["INP", "/search"], ["LCP", "/"]]);
  assertEquals(parseVitals({ metrics: "x" }), "Invalid metrics");
});

Deno.test("readLimited stops at the byte limit, not the character count", async () => {
  const body = (s: string) => new Request("http://x", { method: "POST", body: s });
  assertEquals(await readLimited(body("hello"), 16), "hello");
  assertEquals(await readLimited(body("é".repeat(10)), 16), null); // 20 bytes
  assertEquals(await readLimited(new Request("http://x", { method: "POST", body: "x", headers: { "content-length": "99999" } }), 16), null);
});

Deno.test("scrub strips relative query strings and masks percent-encoded addresses", () => {
  assertEquals(scrub("Request /search?q=acme+grants failed"), "Request /search failed");
  assertEquals(scrub("user jane%40example.org not found"), "user [email] not found");
  assertEquals(scrub("Did you mean x? Try again"), "Did you mean x? Try again");
});

Deno.test("scrub strips a query string that holds an address, and masks a bare one", () => {
  assertEquals(
    scrub("GET https://x.supabase.co/rest/v1/t?email=eq.a@b.org&x=1 failed for c@d.org"),
    "GET https://x.supabase.co/rest/v1/t failed for [email]",
  );
});

Deno.test("an address cut by the length limit is still masked (scrub before cut)", async () => {
  const row = await parseCrash({ kind: "error", message: "x".repeat(490) + " jane.doe@example.org and more" }, "");
  if (typeof row === "string") throw new Error(row);
  assert(!row.message.includes("jane"));
  assertEquals(row.message.length, 500);
});

Deno.test("fingerprint takes the file from the top frame, not a URL in Chrome's message line", () => {
  const msg = "Failed to load https://fundermatch.org/assets/Foo-AbC12345.js";
  const chrome = `TypeError: ${msg}\n    at load (https://fundermatch.org/assets/Search-Xy_9-abc.js:1:2)`;
  const firefox = "load@https://fundermatch.org/assets/Search-Xy_9-abc.js:1:2";
  assertEquals(fingerprintSource("TypeError", msg, chrome), fingerprintSource("TypeError", msg, firefox));
  assertEquals(fingerprintSource("TypeError", msg, chrome).split("|")[2], "/assets/Search.js");
});
