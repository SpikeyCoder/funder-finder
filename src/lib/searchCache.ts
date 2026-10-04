// Recent organization-search results, so a query the user already ran in this
// tab (backspacing over a typo, going back to the search page) shows its
// results at once instead of waiting on another round trip.
//
// Only results with matches are kept: a search that found nothing is always
// sent again, so an organization added meanwhile (e.g. just requested) turns
// up. And a name requested in this tab is never cached at all (forget()),
// since adding it takes a while and a search in between would otherwise cache
// results without it.
//
// Keyed by the query as sent, with whitespace runs collapsed (the server does
// the same), but case kept: ranking reads camelCase ("SitStayRead" is split
// into words, "sitstayread" isn't). Entries expire, so a long-open tab still
// sees newly added organizations, and the oldest go first past the cap.

const MAX_ENTRIES = 50;
const TTL_MS = 5 * 60_000;

interface Entry<T> {
  value: T;
  at: number;
}

export function searchKey(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

export class SearchCache<T extends readonly unknown[]> {
  private entries = new Map<string, Entry<T>>();
  // Names requested in this tab, case-insensitive (a request is by name).
  private uncached = new Set<string>();

  constructor(
    private readonly maxEntries = MAX_ENTRIES,
    private readonly ttlMs = TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(query: string): T | undefined {
    const key = searchKey(query);
    if (this.uncached.has(key.toLowerCase())) return undefined;
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

  // Stop caching this name (any case) for the life of the tab, and drop what's
  // cached for it.
  forget(query: string): void {
    const lower = searchKey(query).toLowerCase();
    this.uncached.add(lower);
    for (const key of [...this.entries.keys()]) {
      if (key.toLowerCase() === lower) this.entries.delete(key);
    }
  }

  set(query: string, value: T): void {
    const key = searchKey(query);
    if (value.length === 0 || this.uncached.has(key.toLowerCase())) return;
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }
}
