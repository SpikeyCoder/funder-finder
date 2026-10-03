// Run: deno test --allow-env supabase/functions/monitor-sweep/
// sweepCrashes against a fake PostgREST and Trello: the daily budget, retries,
// the overflow card and timeouts.
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://db.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
Deno.env.set("TRELLO_API_KEY", "k");
Deno.env.set("TRELLO_TOKEN", "t");
Deno.env.set("TRELLO_LIST_ID", "l");
const { sweepCrashes, MAX_CRASH_CARDS_PER_DAY } = await import("./index.ts");

const crash = (fingerprint: string, card_attempts = 0, card_attempted_at: string | null = null) => ({
  fingerprint, kind: "error", name: "TypeError", message: "boom", stack: "", component_stack: "", path: "/",
  release: "", user_agent: "", occurrences: 1, first_seen: "2026-10-03T00:00:00Z", last_seen: "2026-10-03T00:00:00Z",
  card_attempts, card_attempted_at, previous_card_url: null,
});

interface World {
  triedToday: number;
  waiting: number;
  retries: ReturnType<typeof crash>[];
  fresh: ReturnType<typeof crash>[];
  trello: (name: string) => "ok" | "timeout" | "reject";
}

// Serves the queries sweepCrashes makes, and records the writes and cards.
function fake(world: World) {
  const cards: string[] = [];
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.startsWith("https://api.trello.com/")) {
      const name = new URLSearchParams(String(init.body)).get("name") ?? "";
      const outcome = world.trello(name);
      if (outcome === "timeout") throw new DOMException("slow", "TimeoutError");
      if (outcome === "reject") return new Response("invalid", { status: 400 });
      cards.push(name);
      return json({ shortUrl: `https://trello.com/c/${cards.length}` });
    }
    const path = decodeURIComponent(url.replace("http://db.test/rest/v1/", ""));
    if (method === "HEAD") {
      const n = path.includes("card_uncertain_at=is.null") ? world.waiting : world.triedToday;
      return new Response(null, { status: 200, headers: { "content-range": `*/${n}` } });
    }
    if (method === "GET" && path.startsWith("monitor_crashes")) {
      return json(path.includes("card_attempted_at=gte.") ? world.retries : world.fresh);
    }
    if (method === "GET" && path.startsWith("monitor_alerts")) return json([]);
    if (method === "POST" && path.startsWith("monitor_alerts")) return json([{ alert_key: "crash:overflow" }], 201);
    if (method === "PATCH") {
      patches.push({ url: path, body: JSON.parse(String(init.body)) });
      return path.includes("card_attempts=eq.") ? json([{}]) : new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof fetch;
  return { cards, patches, restore: () => (globalThis.fetch = realFetch) };
}

const later = () => Date.now() + 60_000;

Deno.test("retries go first and use no daily budget; the cap's last slot triggers the overflow card", async () => {
  const f = fake({
    triedToday: MAX_CRASH_CARDS_PER_DAY - 1,
    waiting: 2,
    retries: [crash("r1", 1, new Date(Date.now() - 2 * 3600_000).toISOString())],
    fresh: [crash("f1"), crash("f2"), crash("f3")],
    trello: () => "ok",
  });
  try {
    const summary: Record<string, number | string> = {};
    await sweepCrashes(summary, later());
    // r1 (a retry) and f1 (the one slot left); not f2, f3.
    assertEquals(f.patches.filter((p) => p.url.includes("card_attempts=eq.")).map((p) => p.url.match(/fingerprint=eq\.(\w+)/)![1]), ["r1", "f1"]);
    assertEquals(summary.crash_cards, 2);
    assert(f.cards.some((n) => n.includes("2 more new kinds of crash waiting")), f.cards.join(" / "));
  } finally {
    f.restore();
  }
});

Deno.test("no overflow card while the day's budget lasts", async () => {
  const f = fake({ triedToday: 0, waiting: 5, retries: [], fresh: [crash("f1")], trello: () => "ok" });
  try {
    await sweepCrashes({}, later());
    assertEquals(f.cards.length, 1);
  } finally {
    f.restore();
  }
});

Deno.test("a timed-out card marks the crash uncertain, not carded; a rejected one stays due", async () => {
  let calls = 0;
  const f = fake({
    triedToday: 0, waiting: 0, retries: [], fresh: [crash("slow"), crash("bad")],
    trello: () => (calls++ === 0 ? "timeout" : "reject"),
  });
  try {
    const summary: Record<string, number | string> = {};
    await sweepCrashes(summary, later());
    const writes = f.patches.filter((p) => !p.url.includes("card_attempts=eq."));
    assertEquals(writes.length, 1);
    assert(writes[0].url.includes("fingerprint=eq.slow"));
    assert(typeof writes[0].body.card_uncertain_at === "string");
    assertEquals(summary.crash_cards, 0);
  } finally {
    f.restore();
  }
});

Deno.test("no new card is started past the run's deadline", async () => {
  const f = fake({ triedToday: 0, waiting: 0, retries: [], fresh: [crash("f1")], trello: () => "ok" });
  try {
    await sweepCrashes({}, Date.now() - 1);
    assertEquals(f.cards.length, 0);
  } finally {
    f.restore();
  }
});
