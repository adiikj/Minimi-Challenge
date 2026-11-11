import { describe, expect, it } from "vitest";
import { fixedClock } from "@/core/clock";
import type { AgentEvent } from "@/core/types";
import { runTurn, type TurnDeps } from "@/agent/orchestrator";
import { createFakeLLM } from "@/llm/fake";
import { openDb } from "@/memory/db";
import { createRepo } from "@/memory/repo";
import { seedDemo } from "@/memory/seed";
import { SearchService } from "@/search/service";
import type { SearchProvider, SearchQuery } from "@/search/types";
import { MAX_PREFETCH_QUERIES, planPrefetch } from "./prefetch";
import { recall } from "./recall";

const NOW = new Date("2026-11-11T08:35:00Z");
const TZ = "Asia/Kolkata";

function demo() {
  const repo = createRepo(openDb(":memory:"), () => NOW);
  const { profileId } = seedDemo(repo, { now: NOW, tz: TZ });
  const scope = { userId: profileId };
  return { repo, scope, ask: (message: string) => recall(repo, { scope, message, now: NOW, tz: TZ }) };
}

const CRM_QUESTION = "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";

describe("planPrefetch", () => {
  it("plans current-state + news-since queries for every recalled entity (the CRM question)", () => {
    const plan = planPrefetch(demo().ask(CRM_QUESTION))!;
    expect(plan.entities).toEqual(["HubSpot Sales Hub", "Pipedrive", "Salesforce Sales Cloud", "Zoho CRM", "Freshsales"]);
    expect(plan.queries).toHaveLength(10);
    expect(plan.queries[0]).toEqual({ q: "HubSpot Sales Hub pricing", domains: ["hubspot.com"] });
    expect(plan.queries[1]).toEqual({ q: "HubSpot Sales Hub announcement", kind: "news", since: "2026-11-09" });
    expect(plan.queries.filter((q) => q.kind === "news").every((q) => q.since === "2026-11-09")).toBe(true);
  });

  it("does not fire for a memory question that isn't asking what changed", () => {
    expect(planPrefetch(demo().ask("What did we shortlist on Monday?"))).toBeNull();
  });

  it("does not fire without recalled memory, even when the question is about change", () => {
    expect(planPrefetch(demo().ask("Has the price of Notion changed recently?"))).toBeNull();
  });

  it("caps the number of queries", () => {
    const plan = planPrefetch(demo().ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"))!;
    expect(plan.entities).toEqual(["Neon", "Supabase", "Railway"]);
    expect(plan.queries.length).toBeLessThanOrEqual(MAX_PREFETCH_QUERIES);
    expect(plan.queries.map((q) => q.q)).toEqual([
      "Neon pricing",
      "Neon announcement",
      "Supabase pricing",
      "Supabase announcement",
      "Railway pricing",
      "Railway announcement",
    ]);
  });
});

describe("runTurn with prefetch", () => {
  const plan = { entities: ["Neon", "Supabase"], queries: [{ q: "Neon pricing", domains: ["neon.com"] }, { q: "Supabase pricing", domains: ["supabase.com"] }] as SearchQuery[] };

  function setup(provider: SearchProvider, prefetch = true) {
    const llm = createFakeLLM([{ text: ["Neon now gives 1 GB [S1]; Supabase is unchanged [S2]."] }]);
    const deps: TurnDeps = {
      llm,
      clock: fixedClock(NOW),
      search: new SearchService({ provider }),
      settings: { model: "zai-glm-5-3", maxTokens: 1000, maxRounds: 4, deadlineMs: 60_000, maxQueriesPerTurn: 12, prefetch },
    };
    return { llm, deps };
  }
  const provider = (calls: string[] = []): SearchProvider => ({
    name: "fake",
    search: async (q) => {
      calls.push(q.q);
      return { results: [{ url: `https://${q.domains?.[0] ?? "x.com"}/pricing`, title: `${q.q} page`, content: `Facts about ${q.q}`, score: 0.9 }], credits: 1 };
    },
  });
  const input = (over = {}) => ({ scope: { userId: "u" }, message: "Has their pricing changed since 3 Nov?", history: [], clientTz: TZ, prefetch: plan, ...over });
  async function collect(gen: AsyncIterable<AgentEvent>) {
    const out: AgentEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("searches before the first model call and answers in ONE model round", async () => {
    const calls: string[] = [];
    const { llm, deps } = setup(provider(calls));
    const events = await collect(runTurn(input(), deps, new AbortController().signal));

    expect(calls).toEqual(["Neon pricing", "Supabase pricing"]);
    expect(llm.requests).toHaveLength(1);
    const firstPrompt = llm.requests[0]!.messages.at(-1)!.content;
    expect(firstPrompt).toContain("<prefetched_evidence");
    expect(firstPrompt).toMatch(/<source id="S1"[^>]*domain="neon.com"/);

    const kinds = events.map((e) => (e.type === "status" ? `status:${e.id}:${e.state}` : e.type));
    expect(kinds.slice(0, 4)).toEqual(["status:prefetch:start", "status:prefetch:end", "sources", "status:reading:start"]);
    expect(events.find((e) => e.type === "status")).toMatchObject({ label: "Checking 2 items: Neon, Supabase" });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      trace: { rounds: 1, prefetch: { queries: 2, sources: 2 }, search: { queries: 2, credits: 2 }, citations: { used: ["S1", "S2"], invalid: [] } },
    });
  });

  it("is skipped when switched off (ablation), leaving the normal loop", async () => {
    const calls: string[] = [];
    const { llm, deps } = setup(provider(calls), false);
    const events = await collect(runTurn(input(), deps, new AbortController().signal));
    expect(calls).toEqual([]);
    expect(llm.requests[0]!.messages.at(-1)!.content).not.toContain("<prefetched_evidence");
    expect(events.at(-1)).not.toHaveProperty("trace.prefetch");
  });

  it("carries on without evidence if every prefetch query fails", async () => {
    const failing: SearchProvider = { name: "fake", search: async () => { throw new Error("down"); } };
    const { llm, deps } = setup(failing);
    const events = await collect(runTurn(input(), deps, new AbortController().signal));
    expect(llm.requests).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
});
