/**
 * Company calendar feeds as the server last fetched them, by address: the
 * body, its validators and when it was fetched. In memory, once per process
 * (not per bundle copy), and at most MAX_ENTRIES feeds; a replica that
 * starts fetches again.
 */

export interface CachedFeed {
  body: ArrayBuffer;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
}

const MAX_ENTRIES = 200;
const KEY = Symbol.for('bulwark.companyFeedCache');

function store(): Map<string, CachedFeed> {
  const g = globalThis as typeof globalThis & { [KEY]?: Map<string, CachedFeed> };
  g[KEY] ??= new Map();
  return g[KEY];
}

export const companyFeedCache = {
  get(url: string): CachedFeed | undefined {
    return store().get(url);
  },
  set(url: string, entry: CachedFeed): void {
    const map = store();
    map.delete(url);
    map.set(url, entry);
    // The oldest entry goes first.
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  },
  clear(): void {
    store().clear();
  },
};
