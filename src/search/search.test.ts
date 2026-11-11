import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QuotaError } from "@/core/errors";
import { cacheKey, SearchCache } from "./cache";
import { domainOf, extractRelevant, matchesDomain, normalizeUrl, sanitizeQuery, toIsoDate, truncate } from "./normalize";
import { rank, select, SearchService, SourceRegistry } from "./service";
import { parseTavily, toTavilyBody } from "./tavily";
import type { PageReader, ProviderResponse, RawResult, SearchProvider, SearchQuery } from "./types";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));

describe("normalize", () => {
  it("strips values the model expects to find from queries", () => {
    expect(sanitizeQuery("Neon pricing page 2026 Launch plan $19 month 100 compute hours")).toBe(
      "Neon pricing page 2026 Launch plan month 100 compute hours",
    );
    expect(sanitizeQuery("Supabase Pro plan $25/month official")).toBe("Supabase Pro plan official");
    expect(sanitizeQuery("Pipedrive €14 per user pricing")).toBe("Pipedrive pricing");
  });

  it("normalises domains and URLs for matching and de-duplication", () => {
    expect(domainOf("https://www.Neon.com/pricing/")).toBe("neon.com");
    expect(domainOf("neon.tech")).toBe("neon.tech");
    expect(matchesDomain("docs.neon.com", "neon.com")).toBe(true);
    expect(matchesDomain("notneon.com", "neon.com")).toBe(false);
    expect(normalizeUrl("https://www.neon.com/pricing/?utm_source=x#plans")).toBe("https://neon.com/pricing");
    expect(normalizeUrl("https://neon.com/blog?page=2&ref=hn")).toBe("https://neon.com/blog?page=2");
  });

  it("parses provider dates to YYYY-MM-DD", () => {
    expect(toIsoDate("Thu, 25 Jun 2026 08:25:10 GMT")).toBe("2026-06-25");
    expect(toIsoDate(null)).toBeUndefined();
    expect(toIsoDate("not a date")).toBeUndefined();
  });

  it("truncates at a sentence boundary when that keeps most of the text", () => {
    expect(truncate("First sentence here. Second one is longer.", 25)).toBe("First sentence here. …");
    expect(truncate("Hi. This sentence keeps going and going.", 30)).toBe("Hi. This sentence keeps going …");
    expect(truncate("short", 30)).toBe("short");
  });

  it("keeps the pricing lines of a long page", () => {
    const page = ["# Pricing", "Some marketing intro.", "", "## Pro", "$25 per month", "Includes 8 GB", "", "Footer links", "Careers"].join("\n");
    const out = extractRelevant(page, 500);
    expect(out).toContain("$25 per month");
    expect(out).toContain("## Pro");
    expect(out).not.toContain("Careers");
  });
});

describe("tavily adapter", () => {
  it("maps our query to Tavily's parameters", () => {
    expect(toTavilyBody({ q: "Neon pricing", domains: ["https://www.neon.com/pricing"] }, "fast")).toMatchObject({
      query: "Neon pricing",
      search_depth: "basic",
      topic: "general",
      include_domains: ["neon.com"],
      include_domains_mode: "prefer",
    });
    expect(toTavilyBody({ q: "Supabase pricing change", kind: "news", since: "2026-10-01" }, "thorough")).toMatchObject({
      search_depth: "advanced",
      topic: "news",
      start_date: "2026-10-01",
    });
  });

  it("parses a recorded response, including undated official pages", () => {
    const res = parseTavily(fixture("tavily-neon-pricing.json"));
    expect(res.credits).toBe(1);
    expect(res.results.length).toBe(5);
    const official = res.results.find((r) => r.url === "https://neon.com/pricing");
    expect(official?.publishedAt).toBeUndefined();
    expect(res.results[0]?.publishedAt).toBe("2026-06-25");
  });
});

const result = (url: string, score: number, extra: Partial<RawResult> = {}): RawResult => ({
  url,
  title: `Title of ${url}`,
  content: `Content of ${url}`,
  score,
  ...extra,
});

function fakeProvider(byQuery: Record<string, RawResult[] | Error>, calls: string[] = []): SearchProvider {
  return {
    name: "fake",
    async search(q) {
      calls.push(q.q);
      const r = byQuery[q.q];
      if (r instanceof Error) throw r;
      return { results: r ?? [], credits: 1 } satisfies ProviderResponse;
    },
  };
}

const ctx = () => ({ registry: new SourceRegistry(), retrievedAt: "2026-11-11" });
const signal = () => new AbortController().signal;

describe("ranking and selection", () => {
  it("boosts the official domain above a higher-scored SEO page", () => {
    const q: SearchQuery = { q: "neon pricing", domains: ["neon.com"] };
    const ranked = rank([q], [[result("https://selfhost.dev/neon", 0.88), result("https://neon.com/pricing", 0.86)]]);
    expect(ranked[0]?.url).toBe("https://neon.com/pricing");
    expect(ranked[0]?.official).toBe(true);
  });

  it("drops results older than `since` and demotes undated ones", () => {
    const q: SearchQuery = { q: "x", since: "2026-11-01" };
    const ranked = rank([q], [[
      result("https://a.com/old", 0.9, { publishedAt: "2026-10-01" }),
      result("https://b.com/undated", 0.8),
      result("https://c.com/new", 0.75, { publishedAt: "2026-11-05" }),
    ]]);
    expect(ranked.map((r) => r.url)).toEqual(["https://c.com/new", "https://b.com/undated"]);
  });

  it("de-duplicates the same page found by two queries", () => {
    const ranked = rank([{ q: "a" }, { q: "b" }], [[result("https://x.com/p?utm_source=1", 0.5)], [result("https://www.x.com/p", 0.7)]]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.queryIndex).toBe(1);
  });

  it("guarantees every query at least one source, even when another query dominates the scores", () => {
    const strong = Array.from({ length: 10 }, (_, i) => result(`https://strong.com/${i}`, 0.99 - i * 0.01));
    const weak = [result("https://weak.com/only", 0.2)];
    const picked = select(rank([{ q: "a" }, { q: "b" }], [strong, weak]), 2, "fast");
    expect(picked).toHaveLength(6);
    expect(picked.some((r) => r.url === "https://weak.com/only")).toBe(true);
  });
});

describe("SearchService", () => {
  it("runs queries in parallel, assigns stable ids across rounds, and marks repeats", async () => {
    const service = new SearchService({
      provider: fakeProvider({ a: [result("https://a.com", 0.9)], b: [result("https://a.com", 0.8), result("https://b.com", 0.7)] }),
    });
    const c = ctx();
    const first = await service.run([{ q: "a" }], "fast", c, signal());
    expect(first.sources.map((s) => [s.id, s.isNew])).toEqual([["S1", true]]);
    const second = await service.run([{ q: "b" }], "fast", c, signal());
    expect(second.sources.map((s) => [s.id, s.isNew])).toEqual([["S1", false], ["S2", true]]);
    expect(second.sources[0]?.retrievedAt).toBe("2026-11-11");
  });

  it("serves repeats from the cache (0 credits) and never caches failures", async () => {
    const calls: string[] = [];
    let fail = true;
    const provider: SearchProvider = {
      name: "fake",
      async search(q) {
        calls.push(q.q);
        if (q.q === "flaky" && fail) {
          fail = false;
          throw new Error("boom");
        }
        return { results: [result(`https://${q.q}.com`, 0.5)], credits: 1 };
      },
    };
    const service = new SearchService({ provider });
    const r1 = await service.run([{ q: "same" }], "fast", ctx(), signal());
    const r2 = await service.run([{ q: "Same " }], "fast", ctx(), signal());
    expect(r1.credits).toBe(1);
    expect(r2.credits).toBe(0);
    expect(r2.outcomes[0]?.status).toBe("cached");

    const f1 = await service.run([{ q: "flaky" }], "fast", ctx(), signal());
    expect(f1.outcomes[0]?.status).toBe("error");
    const f2 = await service.run([{ q: "flaky" }], "fast", ctx(), signal());
    expect(f2.outcomes[0]?.status).toBe("ok");
    expect(calls).toEqual(["same", "flaky", "flaky"]);
  });

  it("reports a timed-out query without failing the others", async () => {
    const provider: SearchProvider = {
      name: "fake",
      search: (q, _d, s) =>
        q.q === "slow"
          ? new Promise((_, reject) => s.addEventListener("abort", () => reject(s.reason), { once: true }))
          : Promise.resolve({ results: [result("https://ok.com", 0.5)], credits: 1 }),
    };
    const service = new SearchService({ provider, queryTimeoutMs: { fast: 30, thorough: 30 } });
    const res = await service.run([{ q: "fast" }, { q: "slow" }], "fast", ctx(), signal());
    expect(res.outcomes.map((o) => o.status)).toEqual(["ok", "timeout"]);
    expect(res.sources).toHaveLength(1);
  });

  it("accepts a shorter per-call timeout (used by prefetch)", async () => {
    const provider: SearchProvider = {
      name: "fake",
      search: (q, _d, s) =>
        q.q === "slow"
          ? new Promise((_, reject) => s.addEventListener("abort", () => reject(s.reason), { once: true }))
          : Promise.resolve({ results: [result("https://ok.com", 0.5)], credits: 1 }),
    };
    const service = new SearchService({ provider, queryTimeoutMs: { fast: 60_000, thorough: 60_000 } });
    const t0 = Date.now();
    const res = await service.run([{ q: "fast" }, { q: "slow" }], "fast", ctx(), signal(), { timeoutMs: 30 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.outcomes.map((o) => o.status)).toEqual(["ok", "timeout"]);
  });

  it("throws QuotaError only when every query hit the quota", async () => {
    const service = new SearchService({ provider: fakeProvider({ a: new QuotaError("quota"), b: [result("https://b.com", 0.5)] }) });
    await expect(service.run([{ q: "a" }], "fast", ctx(), signal())).rejects.toBeInstanceOf(QuotaError);
    const mixed = await service.run([{ q: "a" }, { q: "b" }], "fast", ctx(), signal());
    expect(mixed.sources).toHaveLength(1);
  });

  it("thorough depth reads official pages in full and keeps the pricing lines", async () => {
    const reader: PageReader = {
      read: async () =>
        "# Pricing\nIntro text\n## Pro\n$25 per month, includes 8 GB disk and 250 GB egress, daily backups, and email support for every project on the plan.\n\nFooter\nCareers",
    };
    const service = new SearchService({
      provider: fakeProvider({ "supabase pricing": [result("https://supabase.com/pricing", 0.8, { content: "short" })] }),
      reader,
    });
    const run = await service.run([{ q: "supabase pricing", domains: ["supabase.com"] }], "thorough", ctx(), signal());
    expect(run.sources[0]?.excerpt).toContain("$25 per month");
    expect(run.sources[0]?.excerpt).not.toContain("Careers");
  });

  it("sanitises queries before they reach the provider (and the cache key)", async () => {
    const calls: string[] = [];
    const service = new SearchService({ provider: fakeProvider({}, calls) });
    await service.run([{ q: "Neon Launch plan $19/month" }], "fast", ctx(), signal());
    expect(calls).toEqual(["Neon Launch plan"]);
  });
});

describe("SearchCache", () => {
  it("shares one in-flight request between identical callers", async () => {
    const cache = new SearchCache();
    let loads = 0;
    const load = () => {
      loads++;
      return new Promise<ProviderResponse>((r) => setTimeout(() => r({ results: [], credits: 1 }), 10));
    };
    const key = cacheKey("p", { q: "x" }, "fast");
    const [a, b] = await Promise.all([cache.getOrLoad(key, "general", load), cache.getOrLoad(key, "general", load)]);
    expect(loads).toBe(1);
    expect([a.hit, b.hit]).toEqual([false, true]);
  });

  it("expires news faster than general results", async () => {
    let now = 0;
    const cache = new SearchCache(undefined, () => now);
    const load = async () => ({ results: [], credits: 1 });
    await cache.getOrLoad("n", "news", load);
    await cache.getOrLoad("g", "general", load);
    now = 6 * 60_000;
    expect((await cache.getOrLoad("n", "news", load)).hit).toBe(false);
    expect((await cache.getOrLoad("g", "general", load)).hit).toBe(true);
  });
});
