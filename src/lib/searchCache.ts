// Recent organization-search results, so a query the user already ran in this
// tab (backspacing over a typo, going back to the search page) shows its
// results at once instead of waiting on another round trip.
//
// Only results with matches are kept: a search that found nothing is always
// sent again. After the user requests a missing organization the cache is
// off for a while (pause()): adding it takes up to ~15 minutes (the request
// queue runs every 15), and any cached search (its name, a prefix of it,
// another spelling) could hide it meanwhile.
//
// Keyed by the query as sent, with whitespace runs collapsed (the server does
// the same), but case kept: ranking reads camelCase ("SitStayRead" is split
// into words, "sitstayread" isn't). Entries expire, so a long-open tab still
// sees newly added organizations, and the oldest go first past the cap.

const MAX_ENTRIES = 50;
const TTL_MS = 5 * 60_000;
// Requests are processed every 15 minutes; leave room for a slow run.
const PAUSE_MS = 30 * 60_000;

interface Entry<T> {
  value: T;
  at: number;
}

export function searchKey(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

export class SearchCache<T extends readonly unknown[]> {
  private entries = new Map<string, Entry<T>>();
  private pausedUntil = 0;

  constructor(
    private readonly maxEntries = MAX_ENTRIES,
    private readonly ttlMs = TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(query: string): T | undefined {
    if (this.paused()) return undefined;
    const key = searchKey(query);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Most recently used goes to the back, so it's evicted last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  // Drops everything and caches nothing for the next `ms`.
  pause(ms = PAUSE_MS): void {
    this.pausedUntil = this.now() + ms;
    this.entries.clear();
  }

  private paused(): boolean {
    return this.now() < this.pausedUntil;
  }

  set(query: string, value: T): void {
    if (value.length === 0 || this.paused()) return;
    const key = searchKey(query);
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }
}
