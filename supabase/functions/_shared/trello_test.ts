// Run: deno test --allow-env supabase/functions/_shared/trello_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { attachUrlToTrelloCard, createTrelloCard, openTrelloCard } from "./trello.ts";

Deno.env.set("TRELLO_API_KEY", "k-test");
Deno.env.set("TRELLO_TOKEN", "t-test");
Deno.env.set("TRELLO_LIST_ID", "list-test");

const CARD_ID = "0123456789abcdef01234567";

// Records each request and answers with `respond`.
function stubFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; auth: string; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init.headers).get("authorization") ?? "", body: String(init.body ?? "") });
    return await respond(url);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

Deno.test("openTrelloCard sends credentials in a header, never the URL, and returns id and URL", async () => {
  const f = stubFetch(() => Response.json({ id: CARD_ID, shortUrl: "https://trello.com/c/abc" }));
  try {
    const card = await openTrelloCard({ name: "n", desc: "d" });
    assertEquals(card, { id: CARD_ID, url: "https://trello.com/c/abc" });
    assertEquals(f.calls[0].url, "https://api.trello.com/1/cards");
    assert(f.calls[0].auth.includes('oauth_consumer_key="k-test"') && f.calls[0].auth.includes('oauth_token="t-test"'));
    assert(!f.calls[0].url.includes("k-test") && !f.calls[0].url.includes("t-test"));
    assertEquals(new URLSearchParams(f.calls[0].body).get("idList"), "list-test");
    assertEquals(await createTrelloCard({ name: "n", desc: "d" }), "https://trello.com/c/abc");
  } finally {
    f.restore();
  }
});

Deno.test("openTrelloCard: a rejection is null, a timeout is 'timeout'", async () => {
  let f = stubFetch(() => new Response("invalid", { status: 400 }));
  try {
    assertEquals(await openTrelloCard({ name: "n", desc: "d" }), null);
  } finally {
    f.restore();
  }
  f = stubFetch(() => Promise.reject(new DOMException("slow", "TimeoutError")));
  try {
    assertEquals(await openTrelloCard({ name: "n", desc: "d" }), "timeout");
  } finally {
    f.restore();
  }
});

Deno.test("attachUrlToTrelloCard posts the link with header auth, and refuses a malformed card id", async () => {
  const f = stubFetch(() => Response.json({}));
  try {
    assertEquals(await attachUrlToTrelloCard(CARD_ID, "https://x/screenshot.png", "screenshot.png"), true);
    assertEquals(f.calls[0].url, `https://api.trello.com/1/cards/${CARD_ID}/attachments`);
    assert(f.calls[0].auth.startsWith("OAuth "));
    assertEquals(new URLSearchParams(f.calls[0].body).get("url"), "https://x/screenshot.png");
    assertEquals(await attachUrlToTrelloCard("../boards/x", "https://x/s.png", "s.png"), false);
    assertEquals(f.calls.length, 1);
  } finally {
    f.restore();
  }
});
