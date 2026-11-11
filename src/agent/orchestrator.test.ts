import { describe, expect, it } from "vitest";
import { fixedClock } from "@/core/clock";
import { ProviderError } from "@/core/errors";
import type { AgentEvent } from "@/core/types";
import { createFakeLLM, type FakeStep } from "@/llm/fake";
import { SearchService } from "@/search/service";
import { runTurn, type TurnDeps, type TurnInput } from "./orchestrator";
import { SYSTEM_PROMPT } from "./prompts";

const NOW = new Date("2026-11-11T08:35:00Z");

function setup(steps: FakeStep[], search?: SearchService) {
  const llm = createFakeLLM(steps);
  const deps: TurnDeps = {
    llm,
    clock: fixedClock(NOW),
    ...(search ? { search } : {}),
    settings: { model: "zai-glm-5-3", maxTokens: 1000, maxRounds: 4, deadlineMs: 60_000, maxQueriesPerTurn: 12 },
  };
  return { llm, deps };
}

const fakeSearch = () =>
  new SearchService({
    provider: {
      name: "fake",
      search: async (q) => ({
        results: [{ url: "https://neon.com/pricing", title: "Pricing — Neon", content: `Launch plan details for ${q.q}`, score: 0.9 }],
        credits: 1,
      }),
    },
  });

const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  scope: { userId: "u1" },
  message: "What day is it?",
  history: [],
  clientTz: "Asia/Kolkata",
  ...over,
});

async function collect(gen: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("runTurn", () => {
  it("streams the answer and ends with a trace", async () => {
    const { deps } = setup([{ text: ["It's ", "Wednesday."], usage: { inputTokens: 1000, outputTokens: 10 } }]);
    const events = await collect(runTurn(input(), deps, new AbortController().signal));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("It's Wednesday.");
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", trace: { model: "zai-glm-5-3", rounds: 1, truncated: false } });
    if (done?.type === "done") {
      expect(done.trace.firstTokenMs).not.toBeNull();
      expect(done.trace.costUsd).toBeCloseTo((1000 * 1.4 + 10 * 4.4) / 1e6, 10);
    }
  });

  it("keeps the system prompt first and byte-identical, with date context in the user turn (cache-friendly)", async () => {
    const { llm, deps } = setup([{ text: ["ok"] }]);
    await collect(
      runTurn(input({ history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }] }), deps, new AbortController().signal),
    );
    const msgs = llm.requests[0]!.messages;
    expect(msgs[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(msgs[1]).toEqual({ role: "user", content: "earlier" });
    const last = msgs.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("Wednesday, 11 November 2026, 14:05 (Asia/Kolkata");
    expect(last.content).toContain("today: 2026-11-11");
    expect(last.content.endsWith("What day is it?")).toBe(true);
  });

  it("falls back to UTC for an invalid client time zone", async () => {
    const { llm, deps } = setup([{ text: ["ok"] }]);
    await collect(runTurn(input({ clientTz: "Not/AZone" }), deps, new AbortController().signal));
    expect(llm.requests[0]!.messages.at(-1)!.content).toContain("(UTC");
  });

  it("turns provider failures into a friendly, retryable error event", async () => {
    const { deps } = setup([{ error: new ProviderError("HTTP 429", "mistral", 429, true) }]);
    const events = await collect(runTurn(input(), deps, new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("rate-limiting"), retryable: true }]);
  });

  it("runs a search round: status → sources → cited answer, with search stats and citation check in the trace", async () => {
    const { llm, deps } = setup(
      [
        { toolCalls: [{ id: "c1", name: "web_search", arguments: JSON.stringify({ queries: [{ q: "neon pricing", domains: ["neon.com"] }] }) }] },
        { text: ["Launch is usage-based [S1]. Also [S7]."] },
      ],
      fakeSearch(),
    );
    const events = await collect(runTurn(input({ message: "What does Neon cost?" }), deps, new AbortController().signal));

    const kinds = events.map((e) => (e.type === "status" ? `status:${e.id}:${e.state}` : e.type));
    expect(kinds).toEqual([
      "status:search:start",
      "status:search:end",
      "sources",
      "status:reading:start",
      "status:reading:end",
      "text",
      "done",
    ]);
    expect(events.find((e) => e.type === "status")).toMatchObject({ label: "Searching: “neon pricing”" });
    expect(events.find((e) => e.type === "sources")).toMatchObject({
      sources: [{ id: "S1", url: "https://neon.com/pricing", domain: "neon.com", retrievedAt: "2026-11-11" }],
    });
    expect(llm.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    expect(llm.requests[0]!.tools?.[0]?.name).toBe("web_search");

    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      trace: { search: { queries: 1, credits: 1, sources: 1 }, citations: { used: ["S1"], invalid: ["S7"] } },
    });
  });

  it("records the turn as a timeline: memory → model → search → model, in order, with queries and tokens", async () => {
    const { deps } = setup(
      [
        { toolCalls: [{ id: "c1", name: "web_search", arguments: JSON.stringify({ queries: [{ q: "neon pricing" }, { q: "supabase pricing" }] }) }], usage: { inputTokens: 900, outputTokens: 20 } },
        { text: ["Neon starts at $5 [S1]."], usage: { inputTokens: 1500, outputTokens: 12 } },
      ],
      fakeSearch(),
    );
    const memory = { status: "found" as const, text: "<memory>…</memory>", assumptions: [], refs: [{ threadId: "t1", title: "Postgres", localDate: "2026-11-03" }], ms: 4 };
    const events = await collect(runTurn(input({ message: "Has Neon changed?", memory }), deps, new AbortController().signal));
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done event");
    const spans = done.trace.spans ?? [];
    expect(spans.map((s) => s.kind)).toEqual(["memory", "model", "search", "model"]);
    expect(spans[0]).toMatchObject({ label: "Memory: 1 past conversation", startMs: 0, ms: 4 });
    expect(spans[1]).toMatchObject({ label: "Model, round 1 → search", usage: { inputTokens: 900 } });
    expect(spans[2]).toMatchObject({ label: "Search: 2 queries", queries: ["neon pricing", "supabase pricing"], cacheHits: 0 });
    expect(spans[3]?.firstTextMs).toBeGreaterThanOrEqual(spans[3]!.startMs);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.startMs).toBeGreaterThanOrEqual(spans[i - 1]!.startMs);
  });

  it("shows memory before the model starts, puts it in the per-turn context, and records it in the trace", async () => {
    const { llm, deps } = setup([{ text: ["Last Tuesday (3 Nov) you asked about Postgres."] }]);
    const memory = {
      status: "found" as const,
      text: "<memory>\nResolved: \"last Tuesday\" → Tue 3 Nov.\n</memory>",
      assumptions: [{ phrase: "last Tuesday", chosen: "Tue 3 Nov", alternatives: [{ label: "Tue 10 Nov", hasConversations: false }] }],
      refs: [{ threadId: "t1", title: "Postgres hosting", localDate: "2026-11-03" }],
      ms: 3,
    };
    const events = await collect(runTurn(input({ message: "What did I ask last Tuesday?", memory }), deps, new AbortController().signal));

    expect(events.slice(0, 2)).toEqual([
      { type: "assumption", assumption: memory.assumptions[0] },
      { type: "memory", status: "found", refs: memory.refs },
    ]);
    const userTurn = llm.requests[0]!.messages.at(-1)!.content;
    expect(userTurn).toContain("calendar: Thu 29 Oct,");
    expect(userTurn).toContain("Wed 11 Nov (today)");
    expect(userTurn).toMatch(/<memory>[\s\S]*<\/memory>\n<\/context>\n\nWhat did I ask last Tuesday\?$/);
    expect(llm.requests[0]!.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(events.at(-1)).toMatchObject({ type: "done", trace: { memory: { status: "found", refs: memory.refs, ms: 3 } } });
  });

  it("emits no memory events when memory wasn't needed (an index may still ride along)", async () => {
    const { deps } = setup([{ text: ["Lisbon is mild in spring."] }]);
    const memory = { status: "not-needed" as const, text: "<memory>\nRecent conversations…\n</memory>", assumptions: [], refs: [], ms: 1 };
    const events = await collect(runTurn(input({ memory }), deps, new AbortController().signal));
    expect(events.some((e) => e.type === "memory" || e.type === "assumption")).toBe(false);
    expect(events.at(-1)).not.toHaveProperty("trace.memory");
  });

  it("ends quietly when the user stops the turn", async () => {
    const { deps } = setup([{ text: ["a", "b", "c"] }]);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const e of runTurn(input(), deps, controller.signal)) {
      events.push(e);
      controller.abort();
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
