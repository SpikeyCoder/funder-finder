// Run: deno test --allow-env supabase/functions/_shared/rest_test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { rest, restCount, restJson } from "./rest.ts";

Deno.env.set("SUPABASE_URL", "http://db.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-test");

function stubFetch(respond: (url: string, init: RequestInit) => Response) {
  const real = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}

Deno.test("rest sends the service key, keeps caller headers, and builds the URL", async () => {
  const f = stubFetch(() => new Response(null, { status: 204 }));
  try {
    await rest("t?x=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" } });
    const h = new Headers(f.seen[0].init.headers);
    assertEquals(f.seen[0].url, "http://db.test/rest/v1/t?x=eq.1");
    assertEquals(h.get("apikey"), "service-test");
    assertEquals(h.get("authorization"), "Bearer service-test");
    assertEquals(h.get("prefer"), "return=minimal");
  } finally {
    f.restore();
  }
});

Deno.test("restJson throws with the status; restCount reads Content-Range and fails closed", async () => {
  let f = stubFetch(() => new Response("nope", { status: 500 }));
  try {
    await assertRejects(() => restJson("t"), Error, "REST t 500");
  } finally {
    f.restore();
  }
  f = stubFetch(() => new Response(null, { status: 200, headers: { "content-range": "*/42" } }));
  try {
    assertEquals(await restCount("t"), 42);
  } finally {
    f.restore();
  }
  f = stubFetch(() => new Response(null, { status: 200 }));
  try {
    await assertRejects(() => restCount("t"), Error, "count unreadable");
  } finally {
    f.restore();
  }
});
