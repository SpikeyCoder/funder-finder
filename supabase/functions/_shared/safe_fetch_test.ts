// Run: deno test supabase/functions/_shared/safe_fetch_test.ts
// IP-literal targets safeFetch must refuse without fetching, in every IPv6
// spelling of a private IPv4 address (URL parsing turns ::ffff:a.b.c.d into
// hex, ::ffff:a9fe:a9fe).
import { assert, assertRejects } from "jsr:@std/assert@1";
import { safeFetch, SSRFBlockedError } from "./safe_fetch.ts";

Deno.test("safeFetch refuses private IPv4 addresses written as IPv6", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (() => {
    fetched++;
    return Promise.resolve(new Response("metadata"));
  }) as typeof fetch;
  try {
    for (const url of [
      "http://[::ffff:169.254.169.254]/", // mapped, dotted (parsed to hex)
      "http://[::ffff:a9fe:a9fe]/", // mapped, hex
      "http://[::ffff:7f00:1]/", // mapped loopback
      "http://[0:0:0:0:0:ffff:a00:1]/", // mapped 10.0.0.1, long form
      "http://[::a9fe:a9fe]/", // IPv4-compatible
      "http://[64:ff9b::a9fe:a9fe]/", // NAT64
      "http://[::ffff:0:a9fe:a9fe]/", // IPv4-translated
      "http://[64:ff9b:1::a9fe:a9fe]/", // local-use NAT64
      "http://[2002:a9fe:a9fe::1]/", // 6to4
      "http://[fec0::1]/", // site-local
      "http://[::1]/",
      "http://[fd00:ec2::254]/",
    ]) {
      await assertRejects(() => safeFetch(url), SSRFBlockedError, undefined, url);
    }
    assert(fetched === 0, `fetched ${fetched} private targets`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("safeFetch still fetches a public IPv6 literal", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("ok"))) as typeof fetch;
  try {
    const res = await safeFetch("http://[2606:4700:4700::1111]/");
    assert(res.ok);
    await res.body?.cancel();
  } finally {
    globalThis.fetch = realFetch;
  }
});
