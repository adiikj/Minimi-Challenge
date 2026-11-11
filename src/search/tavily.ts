import { z } from "zod";
import { ProviderError, QuotaError } from "@/core/errors";
import { domainOf, toIsoDate } from "./normalize";
import type { ProviderResponse, SearchDepth, SearchProvider, SearchQuery } from "./types";

const TavilyResponse = z.object({
  results: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().nullish(),
        content: z.string().nullish(),
        score: z.number().nullish(),
        published_date: z.string().nullish(),
      }),
    )
    .default([]),
  usage: z.object({ credits: z.number() }).partial().nullish(),
});

export function toTavilyBody(q: SearchQuery, depth: SearchDepth): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: q.q,
    search_depth: depth === "thorough" ? "advanced" : "basic",
    max_results: 5,
    chunks_per_source: 3,
    include_published_date: true,
    include_usage: true,
    topic: q.kind === "news" ? "news" : "general",
  };
  if (q.since) body.start_date = q.since;
  if (q.domains?.length) {
    body.include_domains = q.domains.map(domainOf);
    body.include_domains_mode = "prefer";
  }
  return body;
}

export function parseTavily(json: unknown): ProviderResponse {
  const data = TavilyResponse.parse(json);
  return {
    credits: data.usage?.credits ?? 1,
    results: data.results.map((r) => ({
      url: r.url,
      title: r.title?.trim() || domainOf(r.url),
      content: r.content ?? "",
      score: r.score ?? 0,
      publishedAt: toIsoDate(r.published_date),
    })),
  };
}

export function createTavilyProvider(opts: { apiKey: string; fetchImpl?: typeof fetch }): SearchProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: "tavily",
    async search(q, depth, signal) {
      const res = await doFetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(toTavilyBody(q, depth)),
        signal,
      });
      if (res.ok) return parseTavily(await res.json());
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 432 || res.status === 433) throw new QuotaError(`Tavily quota reached (${res.status}): ${detail}`);
      throw new ProviderError(`Tavily HTTP ${res.status}: ${detail}`, "tavily", res.status, res.status === 429 || res.status >= 500);
    },
  };
}
