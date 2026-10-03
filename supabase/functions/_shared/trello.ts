// Opens a card on the bug-triage list report-bug uses (TRELLO_API_KEY,
// TRELLO_TOKEN, TRELLO_LIST_ID). Returns the card's URL, null if Trello
// failed (worth retrying), "unconfigured" if the secrets aren't set, or
// "timeout" if Trello didn't answer in time: the card may or may not exist,
// so the caller decides whether a duplicate or a missing card is worse.

export function trelloConfigured(): boolean {
  return !!(Deno.env.get("TRELLO_API_KEY") && Deno.env.get("TRELLO_TOKEN") && Deno.env.get("TRELLO_LIST_ID"));
}

export async function createTrelloCard(
  card: { name: string; desc: string },
  timeoutMs = 7000,
  // Called with what went wrong when the result is null or "timeout".
  onFailure: (detail: string) => void = () => {},
): Promise<string | null | "unconfigured" | "timeout"> {
  const key = Deno.env.get("TRELLO_API_KEY");
  const token = Deno.env.get("TRELLO_TOKEN");
  const idList = Deno.env.get("TRELLO_LIST_ID");
  if (!key || !token || !idList) return "unconfigured";
  // Card fields go in the body, not the URL: a long stack would push the URL
  // past what Trello accepts (414).
  const auth = new URLSearchParams({ key, token });
  const fields = new URLSearchParams({
    idList,
    name: card.name.slice(0, 200),
    // Trello's limit is 16,384 characters.
    desc: card.desc.slice(0, 16000),
    pos: "top",
  });
  try {
    const res = await fetch(`https://api.trello.com/1/cards?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: fields,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Trello answered: no card. Reading its error body can't turn this
      // into a "timeout" (which would mean the card may exist).
      const detail = `Trello ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      console.error("Trello card failed:", detail);
      onFailure(detail);
      return null;
    }
    const body = await res.json().catch(() => ({})) as { shortUrl?: string; url?: string };
    // Never "": the card exists, and callers record that it does.
    return body.shortUrl || body.url || "(card opened; Trello returned no URL)";
  } catch (err) {
    if ((err as { name?: string })?.name === "TimeoutError") {
      console.error(`Trello timed out after ${timeoutMs} ms; the card may exist: ${card.name}`);
      onFailure(`Trello timed out after ${timeoutMs} ms`);
      return "timeout";
    }
    console.error("Trello card failed:", err);
    onFailure(`Trello request failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}
