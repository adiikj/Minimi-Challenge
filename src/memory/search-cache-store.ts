import type { CacheStore } from "@/search/cache";
import type { ProviderResponse } from "@/search/types";
import type { Db } from "./db";

export class SqliteCacheStore implements CacheStore {
  private writes = 0;

  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {}

  get(key: string) {
    const r = this.db.prepare("SELECT value, expires_at FROM search_cache WHERE key = ?").get(key) as
      | { value: string; expires_at: number }
      | undefined;
    return r ? { value: JSON.parse(r.value) as ProviderResponse, expiresAt: r.expires_at } : undefined;
  }

  set(key: string, value: ProviderResponse, expiresAt: number) {
    this.db.prepare("INSERT OR REPLACE INTO search_cache (key, value, expires_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), expiresAt);
    if (++this.writes % 50 === 0) this.db.prepare("DELETE FROM search_cache WHERE expires_at < ?").run(this.now());
  }

  delete(key: string) {
    this.db.prepare("DELETE FROM search_cache WHERE key = ?").run(key);
  }
}
