// Run: deno test --allow-env supabase/functions/_shared/rate_limit_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ipRateLimit } from "./rate_limit.ts";

Deno.env.set("SUPABASE_URL", "http://db.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-test");

const req = () => new Request("http://fn.test", { headers: { "cf-connecting-ip": "203.0.113.7" } });

// A check_rate_limit that answers `body` after `delayMs`, or rejects with the
// abort reason if the caller's signal fires first (as real fetch does).
function stubFetch(body: unknown, delayMs = 0, status = 200) {
  const real = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = ((_input: string | URL | Request, init: RequestInit = {}) => {
    calls.push(init);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(body), { status })), delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

Deno.test("a limiter slower than timeoutMs fails open, in about timeoutMs", async () => {
  const f = stubFetch(false, 5_000);
  try {
    const t0 = performance.now();
    const decision = await ipRateLimit(req(), { timeoutMs: 50 });
    const took = performance.now() - t0;
    assertEquals(decision.allow, true);
    assert(took < 1_000, `took ${took} ms`);
  } finally {
    f.restore();
  }
});

Deno.test("within timeoutMs the limiter's answer stands: over the limit is a 429", async () => {
  const f = stubFetch(false, 10);
  try {
    const decision = await ipRateLimit(req(), { timeoutMs: 1_000, extraHeaders: { "x-cors": "1" } });
    assertEquals(decision.allow, false);
    assertEquals(decision.response?.status, 429);
    assertEquals(decision.response?.headers.get("x-cors"), "1");
  } finally {
    f.restore();
  }
});

Deno.test("without timeoutMs no signal is passed, so the limiter is waited for as before", async () => {
  const f = stubFetch(true, 80);
  try {
    const decision = await ipRateLimit(req());
    assertEquals(decision.allow, true);
    assertEquals(f.calls[0].signal, undefined);
  } finally {
    f.restore();
  }
});

Deno.test("a limiter error still fails open", async () => {
  const f = stubFetch({ message: "boom" }, 0, 500);
  try {
    assertEquals((await ipRateLimit(req(), { timeoutMs: 1_000 })).allow, true);
  } finally {
    f.restore();
  }
});
