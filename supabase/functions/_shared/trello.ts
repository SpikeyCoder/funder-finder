// Opens a card on the bug-triage list report-bug uses (TRELLO_API_KEY,
// TRELLO_TOKEN, TRELLO_LIST_ID). Returns the card's URL, null if Trello
// failed (worth retrying), or "unconfigured" if the secrets aren't set.

export async function createTrelloCard(
  card: { name: string; desc: string },
  timeoutMs = 7000,
): Promise<string | null | "unconfigured"> {
  const key = Deno.env.get("TRELLO_API_KEY");
  const token = Deno.env.get("TRELLO_TOKEN");
  const idList = Deno.env.get("TRELLO_LIST_ID");
  if (!key || !token || !idList) return "unconfigured";
  const params = new URLSearchParams({
    key,
    token,
    idList,
    name: card.name.slice(0, 200),
    // Trello's limit is 16,384 characters.
    desc: card.desc.slice(0, 16000),
    pos: "top",
  });
  try {
    const res = await fetch(`https://api.trello.com/1/cards?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.error("Trello card failed:", res.status, await res.text());
      return null;
    }
    const body = await res.json() as { shortUrl?: string; url?: string };
    return body.shortUrl || body.url || "";
  } catch (err) {
    console.error("Trello card failed:", err);
    return null;
  }
}
