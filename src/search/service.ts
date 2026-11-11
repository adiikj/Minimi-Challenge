import { isAbortError, QuotaError } from "@/core/errors";
import { cacheKey, SearchCache } from "./cache";
import { cleanText, domainOf, extractRelevant, matchesDomain, normalizeUrl, sanitizeQuery, truncate } from "./normalize";
import type { PageReader, QueryOutcome, RawResult, SearchDepth, SearchProvider, SearchQuery, SearchRun, Source } from "./types";

const QUERY_TIMEOUT_MS = { fast: 5_000, thorough: 7_000 } as const;
const READ_TIMEOUT_MS = 6_000;
const EXCERPT_CHARS = 1_500;
const FULL_PAGE_CHARS = 3_000;
const MAX_FULL_READS = 2;
const OFFICIAL_BOOST = 0.25;
const UNDATED_SINCE_PENALTY = 0.1;

export class SourceRegistry {
  private byUrl = new Map<string, Source>();

  add(s: Omit<Source, "id">): { source: Source; isNew: boolean } {
    const key = normalizeUrl(s.url);
    const existing = this.byUrl.get(key);
    if (existing) return { source: existing, isNew: false };
    const source = { ...s, id: `S${this.byUrl.size + 1}` };
    this.byUrl.set(key, source);
    return { source, isNew: true };
  }

  all(): Source[] {
    return [...this.byUrl.values()];
  }
}

export type SearchServiceDeps = {
  provider: SearchProvider;
  reader?: PageReader;
  cache?: SearchCache;
  queryTimeoutMs?: { fast: number; thorough: number };
};

export type SearchContext = { registry: SourceRegistry; retrievedAt: string };

export class SearchService {
  private cache: SearchCache;

  constructor(private deps: SearchServiceDeps) {
    this.cache = deps.cache ?? new SearchCache();
  }

  get providerName() {
    return this.deps.provider.name;
  }

  async run(queries: SearchQuery[], depth: SearchDepth, ctx: SearchContext, signal: AbortSignal, opts: { timeoutMs?: number } = {}): Promise<SearchRun> {
    const cleaned = queries.map(cleanQuery);
    const settled = await Promise.all(cleaned.map((q) => this.runOne(q, depth, signal, opts.timeoutMs)));
    const outcomes = settled.map((s) => s.outcome);
    const credits = settled.reduce((sum, s) => sum + s.credits, 0);
    if (settled.every((s) => s.quotaExceeded)) throw new QuotaError("Search quota reached");

    const ranked = rank(cleaned, settled.map((s) => s.results));
    const selected = select(ranked, cleaned.length, depth);

    const fullText = new Map<string, string>();
    if (depth === "thorough" && this.deps.reader) {
      const official = selected.filter((r) => r.official).slice(0, MAX_FULL_READS);
      await Promise.all(
        official.map(async (r) => {
          try {
            const page = await this.deps.reader!.read(r.url, AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]));
            const relevant = extractRelevant(page, FULL_PAGE_CHARS);
            if (relevant.length > r.content.length) fullText.set(r.url, relevant);
          } catch {}
        }),
      );
    }

    const sources = selected.map((r) => {
      const { source, isNew } = ctx.registry.add({
        url: r.url,
        domain: domainOf(r.url),
        title: truncate(cleanText(r.title), 120),
        publishedAt: r.publishedAt,
        retrievedAt: ctx.retrievedAt,
        excerpt: fullText.get(r.url) ?? truncate(cleanText(r.content), EXCERPT_CHARS),
      });
      return { ...source, isNew };
    });
    return { sources, outcomes, credits };
  }

  private async runOne(q: SearchQuery, depth: SearchDepth, signal: AbortSignal, timeoutMs?: number) {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      const { value, hit } = await this.cache.getOrLoad(cacheKey(this.deps.provider.name, q, depth), q.kind, () =>
        this.deps.provider.search(
          q,
          depth,
          AbortSignal.any([signal, AbortSignal.timeout(timeoutMs ?? (this.deps.queryTimeoutMs ?? QUERY_TIMEOUT_MS)[depth])]),
        ),
      );
      const outcome: QueryOutcome = { query: q, status: hit ? "cached" : "ok", results: value.results.length, ms: ms() };
      return { outcome, results: value.results, credits: hit ? 0 : value.credits, quotaExceeded: false };
    } catch (err) {
      if (signal.aborted) throw err;
      const timedOut = isAbortError(err);
      const outcome: QueryOutcome = {
        query: q,
        status: timedOut ? "timeout" : "error",
        results: 0,
        ms: ms(),
        error: timedOut ? "timed out" : err instanceof Error ? err.message : String(err),
      };
      return { outcome, results: [] as RawResult[], credits: 0, quotaExceeded: err instanceof QuotaError };
    }
  }
}

function cleanQuery(q: SearchQuery): SearchQuery {
  const sanitized = sanitizeQuery(q.q);
  return {
    q: sanitized.length >= 2 ? sanitized : q.q.trim(),
    ...(q.since ? { since: q.since } : {}),
    ...(q.domains?.length ? { domains: [...new Set(q.domains.map(domainOf))] } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
  };
}

type Ranked = RawResult & { queryIndex: number; adjusted: number; official: boolean };

export function rank(queries: SearchQuery[], resultsPerQuery: RawResult[][]): Ranked[] {
  const best = new Map<string, Ranked>();
  resultsPerQuery.forEach((results, queryIndex) => {
    const q = queries[queryIndex]!;
    for (const r of results) {
      if (q.since && r.publishedAt && r.publishedAt < q.since) continue;
      const domain = domainOf(r.url);
      const official = (q.domains ?? []).some((d) => matchesDomain(domain, d));
      const adjusted =
        r.score + (official ? OFFICIAL_BOOST : 0) - (q.since && !r.publishedAt ? UNDATED_SINCE_PENALTY : 0);
      const key = normalizeUrl(r.url);
      const prev = best.get(key);
      if (!prev || adjusted > prev.adjusted) best.set(key, { ...r, queryIndex, adjusted, official });
    }
  });
  return [...best.values()].sort((a, b) => b.adjusted - a.adjusted);
}

export function select(ranked: Ranked[], queryCount: number, depth: SearchDepth): Ranked[] {
  const limit = Math.min(Math.max(queryCount * 2, 6), 10) + (depth === "thorough" ? 2 : 0);
  const picked: Ranked[] = [];
  const taken = new Set<Ranked>();
  for (let i = 0; i < queryCount; i++) {
    const top = ranked.find((r) => r.queryIndex === i && !taken.has(r));
    if (top) {
      picked.push(top);
      taken.add(top);
    }
  }
  for (const r of ranked) {
    if (picked.length >= limit) break;
    if (!taken.has(r)) {
      picked.push(r);
      taken.add(r);
    }
  }
  return picked.slice(0, limit).sort((a, b) => b.adjusted - a.adjusted);
}
