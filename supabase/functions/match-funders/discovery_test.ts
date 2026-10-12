// Run: deno test supabase/functions/match-funders/discovery_test.ts
// Grant page discovery against a fake fetch: the batch budget covers slow
// headers and slow bodies; misses, failures and unreached funders are told apart.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { discoverGrantPageUrl, discoverGrantUrlsInBatch, fetchHomepageHtml } from "./discovery.ts";

const page = (body: string) => `<html><body>${body}</body></html>`;
const APPLY = page('<a href="/how-to-apply">How to apply</a>');
const NO_LINK = page('<a href="/about">About us</a>');

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// A response whose body sends its first chunk, then never finishes.
function stalledBody(signal?: AbortSignal | null) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<html><a href=\"/apply\">Apply</a>"));
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
  return new Response(stream, { headers: { "content-type": "text/html" } });
}

// Headers that never arrive (and ignore the abort signal).
const never = () => new Promise<Response>(() => {});

type Site =
  | "apply" | "none" | "stall-body" | "stall-headers" | "404" | "503" | "pdf" | "no-type"
  | "redirect" | "redirect-in" | "redirect-sub";

function fakeFetch(sites: Record<string, Site>) {
  const requested: string[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    switch (sites[new URL(url).hostname]) {
      case "apply": return Promise.resolve(html(APPLY));
      case "none": return Promise.resolve(html(NO_LINK));
      case "stall-body": return Promise.resolve(stalledBody(init?.signal));
      case "stall-headers": return never();
      case "404": return Promise.resolve(new Response("nope", { status: 404 }));
      case "503": return Promise.resolve(new Response("busy", { status: 503 }));
      case "no-type": {
        const res = new Response(APPLY);
        res.headers.delete("content-type");
        return Promise.resolve(res);
      }
      case "redirect-in": {
        // fund.org served from https://www.fund.org/en/ after a redirect
        const res = html(page('<a href="apply">Apply</a>'));
        Object.defineProperty(res, "url", { value: "https://www.fund.org/en/" });
        return Promise.resolve(res);
      }
      case "redirect-sub": {
        // sub.org served from https://home.sub.org/, linking to the main site
        const res = html(page('<a href="https://www.sub.org/how-to-apply">How to apply</a>'));
        Object.defineProperty(res, "url", { value: "https://home.sub.org/" });
        return Promise.resolve(res);
      }
      case "redirect": {
        // Served from https://www.fundfoundation.org/en/ after a redirect
        const res = html(page('<a href="apply">Apply</a> <a href="https://fund.org/grants">Old site</a>'));
        Object.defineProperty(res, "url", { value: "https://www.fundfoundation.org/en/" });
        return Promise.resolve(res);
      }
      case "pdf": return Promise.resolve(new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
      default: return Promise.reject(new TypeError("dns error"));
    }
  }) as typeof fetch;
  return { fn, requested };
}

Deno.test("discoverGrantPageUrl picks a same-domain grant link", () => {
  assertEquals(discoverGrantPageUrl(APPLY, "https://www.fund.org"), "https://www.fund.org/how-to-apply");
  assertEquals(discoverGrantPageUrl(NO_LINK, "https://fund.org"), null);
  assertEquals(discoverGrantPageUrl(page('<a href="https://other.org/apply">Apply</a>'), "https://fund.org"), null);
  assertEquals(discoverGrantPageUrl(page('<a href="https://apply.fund.org/start">Apply</a>'), "https://fund.org"), "https://apply.fund.org/start");
  // A foundation on a company subdomain doesn't pick up the company's links
  assertEquals(discoverGrantPageUrl(page('<a href="https://bigcorp.com/careers/apply">Apply now</a>'), "https://foundation.bigcorp.com"), null);
});

Deno.test("discoverGrantPageUrl after a redirect up to a parent domain stays under the landing path", () => {
  const html = page(
    '<a href="https://www.bigcorp.com/careers/apply">Apply now</a>' +
    '<a href="/foundation/grants/apply">Apply for a grant</a>',
  );
  assertEquals(
    discoverGrantPageUrl(html, "https://www.bigcorp.com/foundation/", "https://foundation.bigcorp.com"),
    "https://www.bigcorp.com/foundation/grants/apply",
  );
  // Landing on the parent's homepage: nothing there is the foundation's own
  assertEquals(discoverGrantPageUrl(html, "https://www.bigcorp.com/", "https://foundation.bigcorp.com"), null);
});

Deno.test("discoverGrantPageUrl rejects lookalike domains", () => {
  for (const href of ["https://notfund.org/apply", "https://fund.org.example.com/grants"]) {
    assertEquals(discoverGrantPageUrl(page(`<a href="${href}">Apply</a>`), "https://fund.org"), null);
  }
});

Deno.test("fetchHomepageHtml: the signal bounds a stalled body, not just the headers", async () => {
  const { fn } = fakeFetch({ "slow.org": "stall-body" });
  const started = Date.now();
  assertEquals(await fetchHomepageHtml("https://slow.org", AbortSignal.timeout(100), fn), { kind: "error" });
  assert(Date.now() - started < 1_000, "returned at the deadline");
});

Deno.test("fetchHomepageHtml with an already-aborted signal leaves no unhandled rejection", async () => {
  // A fetch that rejects on an aborted signal, like the real one
  const fn = ((_: string, init?: RequestInit) => Promise.reject(init?.signal?.reason)) as typeof fetch;
  assertEquals(await fetchHomepageHtml("https://a.org", AbortSignal.abort(), fn), { kind: "error" });
  await new Promise((resolve) => setTimeout(resolve, 0)); // an unhandled rejection would fail the test here
});

Deno.test("fetchHomepageHtml: definite misses vs failures that may pass", async () => {
  const { fn } = fakeFetch({ "a.org": "404", "b.org": "pdf", "c.org": "503", "ok.org": "apply", "bare.org": "no-type" });
  const signal = AbortSignal.timeout(1_000);
  assertEquals(await fetchHomepageHtml("https://a.org", signal, fn), { kind: "miss" });
  assertEquals(await fetchHomepageHtml("https://b.org", signal, fn), { kind: "miss" });
  assertEquals(await fetchHomepageHtml("https://c.org", signal, fn), { kind: "error" });
  assertEquals(await fetchHomepageHtml("https://gone.org", signal, fn), { kind: "error" });
  assertEquals(await fetchHomepageHtml("https://ok.org/", signal, fn), { kind: "page", html: APPLY, url: "https://ok.org/" });
  // No Content-Type at all: read as a page
  assertEquals((await fetchHomepageHtml("https://bare.org/", signal, fn)).kind, "page");
});

Deno.test("discoverGrantUrlsInBatch finds links, and tells misses from failures", async () => {
  const { fn, requested } = fakeFetch({ "a.org": "apply", "b.org": "none", "c.org": "404", "e.org": "503" });
  const { found, missed, failed } = await discoverGrantUrlsInBatch([
    { id: "a", website: "a.org" },
    { id: "b", website: "https://b.org" },
    { id: "c", website: "c.org" },
    { id: "d", website: "d.org" },
    { id: "e", website: "e.org" },
  ], { fetchFn: fn, budgetMs: 1_000 });
  assertEquals([...found], [["a", "https://a.org/how-to-apply"]]);
  assertEquals(missed.sort(), ["b", "c"]);
  // d (DNS error) and e (503) may recover
  assertEquals(failed.sort(), ["d", "e"]);
  assertEquals(requested.length, 5);
});

Deno.test("discoverGrantUrlsInBatch resolves links against the page's URL after redirects", async () => {
  const { fn } = fakeFetch({ "fund.org": "redirect-in", "sub.org": "redirect-sub", "old.org": "redirect" });
  const { found, missed } = await discoverGrantUrlsInBatch([
    { id: "in", website: "fund.org" },
    { id: "sub", website: "sub.org" },
    { id: "off", website: "old.org" },
  ], { fetchFn: fn, budgetMs: 1_000 });
  assertEquals(found.get("in"), "https://www.fund.org/en/apply");
  assertEquals(found.get("sub"), "https://www.sub.org/how-to-apply");
  // Redirected off the funder's site: nothing there is the funder's grant page
  assertEquals(missed, ["off"]);
});

Deno.test("discoverGrantUrlsInBatch returns at its budget when sites hang", async () => {
  const sites: Record<string, Site> = { "fast.org": "apply" };
  const funders = [{ id: "fast", website: "fast.org" }];
  for (let i = 0; i < 30; i++) {
    sites[`s${i}.org`] = i % 2 ? "stall-body" : "stall-headers";
    funders.push({ id: `s${i}`, website: `s${i}.org` });
  }
  const { fn, requested } = fakeFetch(sites);
  const started = Date.now();
  const { found, missed, failed } = await discoverGrantUrlsInBatch(funders, { fetchFn: fn, budgetMs: 200, concurrency: 4 });
  const elapsed = Date.now() - started;
  assert(elapsed < 1_000, `returned at the budget (${elapsed} ms)`);
  assertEquals([...found.keys()], ["fast"]);
  // Hung sites were cut off before DISCOVERY_HUNG_MS, or not reached: neither
  // missed nor failed, tried again next time
  assertEquals(missed, []);
  assertEquals(failed, []);
  // Only `concurrency` hung sites are ever in flight; the rest aren't started
  assert(requested.length <= 5, `requested ${requested.length}`);
});

Deno.test("discoverGrantUrlsInBatch counts sites still loading after hungMs as failed", async () => {
  const { fn } = fakeFetch({ "a.org": "stall-headers", "b.org": "stall-body", "c.org": "apply" });
  const { found, failed } = await discoverGrantUrlsInBatch([
    { id: "a", website: "a.org" },
    { id: "b", website: "b.org" },
    { id: "c", website: "c.org" },
  ], { fetchFn: fn, budgetMs: 200, hungMs: 100 });
  assertEquals([...found.keys()], ["c"]);
  assertEquals(failed.sort(), ["a", "b"]);
});

Deno.test("discoverGrantUrlsInBatch fetches a website shared by several funders once", async () => {
  const { fn, requested } = fakeFetch({ "a.org": "apply" });
  const { found } = await discoverGrantUrlsInBatch([
    { id: "a1", website: "a.org" },
    { id: "a2", website: "a.org" },
  ], { fetchFn: fn, budgetMs: 1_000 });
  assertEquals(requested, ["https://a.org"]);
  assertEquals([...found.keys()], ["a1", "a2"]);
});

Deno.test("discoverGrantUrlsInBatch with nothing to scan, or no time left", async () => {
  const empty = { found: new Map(), missed: [], failed: [] };
  assertEquals(await discoverGrantUrlsInBatch([]), empty);
  // A spent budget (even negative) returns nothing rather than throwing
  const { fn, requested } = fakeFetch({ "a.org": "apply" });
  assertEquals(await discoverGrantUrlsInBatch([{ id: "a", website: "a.org" }], { fetchFn: fn, budgetMs: -5 }), empty);
  assertEquals(requested, []);
});
