// Run: deno test supabase/functions/match-funders/discovery_test.ts
// Grant page discovery against a fake fetch: the batch budget covers slow
// headers and slow bodies, and only scanned funders are reported as checked.
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

type Site = "apply" | "none" | "stall-body" | "stall-headers" | "404" | "503" | "pdf" | "redirect" | "redirect-in";

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
      case "redirect-in": {
        // fund.org served from https://www.fund.org/en/ after a redirect
        const res = html(page('<a href="apply">Apply</a>'));
        Object.defineProperty(res, "url", { value: "https://www.fund.org/en/" });
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

Deno.test("fetchHomepageHtml: definite misses vs failures that may pass", async () => {
  const { fn } = fakeFetch({ "a.org": "404", "b.org": "pdf", "c.org": "503", "ok.org": "apply" });
  const signal = AbortSignal.timeout(1_000);
  assertEquals(await fetchHomepageHtml("https://a.org", signal, fn), { kind: "miss" });
  assertEquals(await fetchHomepageHtml("https://b.org", signal, fn), { kind: "miss" });
  assertEquals(await fetchHomepageHtml("https://c.org", signal, fn), { kind: "error" });
  assertEquals(await fetchHomepageHtml("https://gone.org", signal, fn), { kind: "error" });
  assertEquals(await fetchHomepageHtml("https://ok.org/", signal, fn), { kind: "page", html: APPLY, url: "https://ok.org/" });
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
  const { fn } = fakeFetch({ "fund.org": "redirect-in", "old.org": "redirect" });
  const { found, missed } = await discoverGrantUrlsInBatch([
    { id: "in", website: "fund.org" },
    { id: "off", website: "old.org" },
  ], { fetchFn: fn, budgetMs: 1_000 });
  assertEquals(found.get("in"), "https://www.fund.org/en/apply");
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
  // Hung sites in flight were cut off (retried after a day); the rest weren't reached
  assertEquals(missed, []);
  assertEquals(failed.length, 4);
  // Only `concurrency` hung sites are ever in flight; the rest aren't started
  assert(requested.length <= 5, `requested ${requested.length}`);
});

Deno.test("discoverGrantUrlsInBatch with nothing to scan, or no time left", async () => {
  const empty = { found: new Map(), missed: [], failed: [] };
  assertEquals(await discoverGrantUrlsInBatch([]), empty);
  // A spent budget (even negative) returns nothing rather than throwing
  const { fn, requested } = fakeFetch({ "a.org": "apply" });
  assertEquals(await discoverGrantUrlsInBatch([{ id: "a", website: "a.org" }], { fetchFn: fn, budgetMs: -5 }), empty);
  assertEquals(requested, []);
});
