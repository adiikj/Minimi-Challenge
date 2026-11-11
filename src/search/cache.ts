import { domainOf } from "./normalize";
import type { ProviderResponse, SearchDepth, SearchQuery } from "./types";

export interface CacheStore {
  get(key: string): { value: ProviderResponse; expiresAt: number } | undefined;
  set(key: string, value: ProviderResponse, expiresAt: number): void;
  delete(key: string): void;
}

export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, { value: ProviderResponse; expiresAt: number }>();
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: ProviderResponse, expiresAt: number) {
    this.map.set(key, { value, expiresAt });
    if (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: string) {
    this.map.delete(key);
  }
}

const TTL_GENERAL_MS = 15 * 60_000;
const TTL_NEWS_MS = 5 * 60_000;
const MAX_ENTRIES = 300;

export function cacheKey(provider: string, q: SearchQuery, depth: SearchDepth): string {
  return JSON.stringify([
    provider,
    depth,
    q.q.trim().toLowerCase().replace(/\s+/g, " "),
    q.kind ?? "general",
    q.since ?? "",
    [...(q.domains ?? [])].map(domainOf).sort(),
  ]);
}

export class SearchCache {
  private inFlight = new Map<string, Promise<ProviderResponse>>();

  constructor(
    private store: CacheStore = new MemoryCacheStore(),
    private now: () => number = Date.now,
  ) {}

  async getOrLoad(
    key: string,
    kind: SearchQuery["kind"],
    load: () => Promise<ProviderResponse>,
  ): Promise<{ value: ProviderResponse; hit: boolean }> {
    const stored = this.store.get(key);
    if (stored && stored.expiresAt > this.now()) return { value: stored.value, hit: true };
    if (stored) this.store.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return { value: await pending, hit: true };

    const promise = load();
    this.inFlight.set(key, promise);
    try {
      const value = await promise;
      this.store.set(key, value, this.now() + (kind === "news" ? TTL_NEWS_MS : TTL_GENERAL_MS));
      return { value, hit: false };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
