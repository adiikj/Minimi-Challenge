import type { SearchQuery } from "@/search/types";
import type { MemoryResult } from "./recall";

export const MAX_PREFETCH_QUERIES = 10;
const MAX_ENTITIES = 5;

export type PrefetchPlan = { queries: SearchQuery[]; entities: string[] };

export function planPrefetch(m: MemoryResult): PrefetchPlan | null {
  if (m.status !== "found") return null;
  if (!m.intent.changeCheck && !m.intent.sinceThen) return null;

  const byName = new Map<string, string | null>();
  for (const e of m.exchanges) {
    for (const x of e.entities) if (!byName.has(x.name)) byName.set(x.name, x.domain);
    for (const f of e.facts) if (!byName.has(f.entity)) byName.set(f.entity, null);
  }
  const entities = [...byName.entries()].slice(0, MAX_ENTITIES);
  if (entities.length === 0) return null;

  const attributes = m.exchanges.flatMap((e) => e.facts.map((f) => f.attribute.toLowerCase())).join(" ");
  const topic = /price|pricing|cost|seat|month|plan|tier|free/.test(attributes) ? "pricing" : "latest";

  const current: SearchQuery[] = entities.map(([name, domain]) => ({ q: `${name} ${topic}`, ...(domain ? { domains: [domain] } : {}) }));
  const since: SearchQuery[] = m.sinceDate
    ? entities.map(([name]) => ({ q: `${name} announcement`, kind: "news" as const, since: m.sinceDate! }))
    : [];

  const queries: SearchQuery[] = [];
  for (let i = 0; i < entities.length; i++) {
    if (current[i]) queries.push(current[i]!);
    if (since[i]) queries.push(since[i]!);
  }
  return { queries: queries.slice(0, MAX_PREFETCH_QUERIES), entities: entities.map(([name]) => name) };
}
