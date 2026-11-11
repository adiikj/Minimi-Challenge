import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey } from "./cache";
import { domainOf } from "./normalize";
import type { ProviderResponse, SearchProvider, SearchQuery } from "./types";

const fileFor = (dir: string, key: string) => join(dir, `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`);

export function recordingProvider(inner: SearchProvider, dir: string): SearchProvider {
  mkdirSync(dir, { recursive: true });
  return {
    name: inner.name,
    async search(q, depth, signal) {
      const res = await inner.search(q, depth, signal);
      const key = cacheKey(inner.name, q, depth);
      writeFileSync(fileFor(dir, key), JSON.stringify({ key, query: q, depth, response: res }, null, 1));
      return res;
    },
  };
}

export function nearestReplayProvider(name: string, dir: string, threshold = 0.3): SearchProvider & { misses: string[] } {
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { key: string; query: SearchQuery; response: ProviderResponse });
  const byKey = new Map(fixtures.map((f) => [f.key, f.response]));
  const misses: string[] = [];
  return {
    name,
    misses,
    async search(q, depth) {
      const exact = byKey.get(cacheKey(name, q, depth));
      if (exact) return exact;
      let best: { score: number; response: ProviderResponse } | undefined;
      for (const f of fixtures) {
        const score = similarity(q, f.query);
        if (!best || score > best.score) best = { score, response: f.response };
      }
      if (best && best.score >= threshold) return best.response;
      misses.push(q.q);
      return { results: [], credits: 0 };
    },
  };
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export function similarity(a: SearchQuery, b: SearchQuery): number {
  const [wa, wb] = [words(a.q), words(b.q)];
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const jaccard = shared / (new Set([...wa, ...wb]).size || 1);
  const sameDomain = (a.domains ?? []).some((d) => (b.domains ?? []).map(domainOf).includes(domainOf(d))) ? 0.15 : 0;
  const sameKind = (a.kind ?? "general") === (b.kind ?? "general") ? 0.05 : 0;
  return jaccard + sameDomain + sameKind;
}

export function replayProvider(name: string, dir: string): SearchProvider {
  return {
    name,
    async search(q, depth) {
      const key = cacheKey(name, q, depth);
      try {
        return JSON.parse(readFileSync(fileFor(dir, key), "utf8")).response;
      } catch {
        throw new Error(`No recorded search for "${q.q}" (replay mode). Re-run in record mode to capture it.`);
      }
    },
  };
}
