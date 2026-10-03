// Trello cards on the bug-triage list (TRELLO_API_KEY, TRELLO_TOKEN,
// TRELLO_LIST_ID), for report-bug, monitor-sweep and
// process-organization-requests. Opening a card returns the card, null if
// Trello failed (worth retrying), "unconfigured" if the secrets aren't set,
// or "timeout" if Trello didn't answer in time: the card may or may not
// exist, so the caller decides whether a duplicate or a missing card is worse.

function trelloCredentials(): { key: string; token: string; idList: string } | null {
  const key = Deno.env.get("TRELLO_API_KEY");
  const token = Deno.env.get("TRELLO_TOKEN");
  const idList = Deno.env.get("TRELLO_LIST_ID");
  return key && token && idList ? { key, token, idList } : null;
}

export function trelloConfigured(): boolean {
  return trelloCredentials() !== null;
}

// Credentials go in a header, so a URL in a network error (which callers log
// and store) holds no secrets.
function authHeader(key: string, token: string): string {
  return `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`;
}

/**
 * Opens a card and returns its id and URL (see createTrelloCard for the
 * other results). For callers that act on the card afterwards, such as
 * attaching a file.
 */
export async function openTrelloCard(
  card: { name: string; desc: string },
  timeoutMs = 7000,
  // Called with what went wrong when the result is null or "timeout".
  onFailure: (detail: string) => void = () => {},
): Promise<{ id: string; url: string } | null | "unconfigured" | "timeout"> {
  const creds = trelloCredentials();
  if (!creds) return "unconfigured";
  const { key, token, idList } = creds;
  // Card fields go in the body, not the URL: a long stack would push the URL
  // past what Trello accepts (414).
  // Trello's limit is 16,384 characters for each; a cut is marked.
  const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
  const fields = new URLSearchParams({
    idList,
    name: cut(card.name, 1000),
    desc: cut(card.desc, 16000),
    pos: "top",
  });
  try {
    const res = await fetch("https://api.trello.com/1/cards", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: authHeader(key, token) },
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
    const body = await res.json().catch(() => ({})) as { id?: string; shortUrl?: string; url?: string };
    // Never an empty URL: the card exists, and callers record that it does.
    return { id: body.id ?? "", url: body.shortUrl || body.url || "(card opened; Trello returned no URL)" };
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

/** Opens a card and returns its URL (or null, "unconfigured" or "timeout"; see the top). */
export async function createTrelloCard(
  card: { name: string; desc: string },
  timeoutMs = 7000,
  onFailure: (detail: string) => void = () => {},
): Promise<string | null | "unconfigured" | "timeout"> {
  const result = await openTrelloCard(card, timeoutMs, onFailure);
  return result !== null && typeof result === "object" ? result.url : result;
}

/** Attaches a link (a screenshot's URL, say) to a card. Returns whether it worked. */
export async function attachUrlToTrelloCard(cardId: string, url: string, name: string, timeoutMs = 7000): Promise<boolean> {
  const creds = trelloCredentials();
  // A Trello id is 24 hex characters; anything else isn't put in a URL.
  if (!creds || !/^[0-9a-f]{24}$/.test(cardId)) return false;
  try {
    const res = await fetch(`https://api.trello.com/1/cards/${cardId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: authHeader(creds.key, creds.token) },
      body: new URLSearchParams({ url, name }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read the body either way, so the connection is released.
    const text = await res.text().catch(() => "");
    if (!res.ok) console.warn("Trello attachment failed:", res.status, text.slice(0, 200));
    return res.ok;
  } catch (err) {
    console.warn("Trello attachment failed:", err);
    return false;
  }
}
