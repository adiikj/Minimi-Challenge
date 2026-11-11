import { describe, expect, it } from "vitest";
import { fixedClock } from "@/core/clock";
import type { AgentEvent } from "@/core/types";
import { formatFact } from "@/context/memory-pack";
import { dayLabel } from "@/lib/dates";
import { createFakeLLM } from "@/llm/fake";
import { openDb } from "@/memory/db";
import { createRepo, type StoredClaim } from "@/memory/repo";
import { seedDemo } from "@/memory/seed";
import { SearchService } from "@/search/service";
import { runChatTurn, type ChatDeps } from "./chat-turn";
import { applyExtraction, isHedged, MemoryWriter, sameValue, type Extraction, type WriterJob } from "./memory-writer";

const NOW = new Date("2026-11-11T08:35:00Z");
const TZ = "Asia/Kolkata";

function setup() {
  const repo = createRepo(openDb(":memory:"), () => NOW);
  const scope = { userId: repo.createProfile(repo.createDevice(), "U").id };
  const thread = repo.createThread(scope, "How much is Neon?");
  repo.addMessage(scope, { threadId: thread.id, role: "user", content: "q", tz: TZ });
  const answer = repo.addMessage(scope, { threadId: thread.id, role: "assistant", content: "a", tz: TZ });
  return { repo, scope, thread, answerId: answer.id };
}

function withOldFacts(ctx: ReturnType<typeof setup>, facts: Array<{ attribute: string; value: string; plan?: string }>): StoredClaim[] {
  const { repo, scope } = ctx;
  const t = repo.createThread(scope, "older");
  repo.addMessage(scope, { threadId: t.id, role: "user", content: "q0", tz: TZ, createdAt: "2026-11-03T05:00:00Z" });
  const a = repo.addMessage(scope, { threadId: t.id, role: "assistant", content: "a0", tz: TZ, createdAt: "2026-11-03T05:00:10Z" });
  repo.saveClaims(
    scope,
    { messageId: a.id, threadId: t.id },
    facts.map((f) => ({ entity: "Neon", plan: f.plan ?? "Free", attribute: f.attribute, value: f.value, observedAt: "2026-11-03", confidence: "high" as const })),
  );
  return repo.claimsForMessages(scope, [a.id]);
}
const ids = (claims: StoredClaim[]) => new Map(claims.map((c, i) => [`F${i + 1}`, c]));

const empty: Extraction = { title: null, entities: [], checks: [], facts: [] };
const newFact = (over: Partial<Extraction["facts"][number]> = {}): Extraction["facts"][number] => ({
  entity: "Neon",
  plan: "Free",
  attribute: "storage per project",
  value: "1 GB",
  previous_value: null,
  effective_from: null,
  source_id: "S1",
  ...over,
});
type Check = Extraction["checks"][number];
const check = (id: string, status: Check["status"], new_value: string | null = null, over: Partial<Check> = {}): Check => ({
  id,
  status,
  new_value,
  effective_from: null,
  source_id: "S1",
  ...over,
});

function job(ctx: ReturnType<typeof setup>, over: Partial<WriterJob> = {}): WriterJob {
  return {
    scope: ctx.scope,
    threadId: ctx.thread.id,
    messageId: ctx.answerId,
    question: "Is Neon's free tier still 0.5 GB?",
    answer: "No: it's now 1 GB per project [S1].",
    observedAt: "2026-11-11",
    sources: [{ id: "S1", url: "https://neon.com/pricing", domain: "neon.com", title: "Pricing — Neon", retrievedAt: "2026-11-11", excerpt: "Free: 1 GB" }],
    existing: [],
    wantTitle: false,
    ...over,
  };
}
const claimsOf = (ctx: ReturnType<typeof setup>, messageId: string) => ctx.repo.claimsForMessages(ctx.scope, [messageId]);

describe("applyExtraction: verdicts on existing facts", () => {
  it("changed → new value recorded today, old fact superseded but keeps its own dates (bitemporal)", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [{ attribute: "storage per project", value: "0.5 GB" }]);
    const r = applyExtraction(ctx.repo, job(ctx, { existing: old }), ids(old), { ...empty, checks: [check("F1", "changed", "1 GB", { effective_from: "2026-11-01" })] });
    expect(r).toMatchObject({ saved: 1, superseded: 1, confirmed: 0 });
    expect(claimsOf(ctx, old[0]!.messageId)[0]).toMatchObject({
      value: "0.5 GB",
      observedAt: "2026-11-03",
      supersededBy: { value: "1 GB", observedAt: "2026-11-11", effectiveFrom: "2026-11-01" },
    });
    expect(claimsOf(ctx, ctx.answerId)[0]).toMatchObject({ value: "1 GB", previousValue: "0.5 GB", confidence: "high" });
  });

  it("unchanged → old fact confirmed (still true today) and re-recorded on this answer", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [{ attribute: "storage per project", value: "1 GB" }]);
    const r = applyExtraction(ctx.repo, job(ctx, { existing: old }), ids(old), { ...empty, checks: [check("F1", "unchanged")] });
    expect(r).toMatchObject({ superseded: 0, confirmed: 1, saved: 1 });
    expect(claimsOf(ctx, old[0]!.messageId)[0]).toMatchObject({ confirmedAt: "2026-11-11", supersededBy: null });
  });

  it("'changed' to a shorter phrasing of the same value counts as unchanged (live finding)", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [{ attribute: "monthly price", value: "$5/month including $5 of usage", plan: "Hobby" }]);
    const r = applyExtraction(ctx.repo, job(ctx, { existing: old }), ids(old), { ...empty, checks: [check("F1", "changed", "$5/month")] });
    expect(r).toMatchObject({ superseded: 0, confirmed: 1 });
  });

  it("unconfirmed or not mentioned → the old fact is left alone (live finding: an unsure answer never overwrites)", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [
      { attribute: "compute price", value: "$0.106 per CU-hour", plan: "Launch" },
      { attribute: "storage price", value: "$0.35 per GB-month", plan: "Launch" },
    ]);
    const r = applyExtraction(ctx.repo, job(ctx, { existing: old }), ids(old), {
      ...empty,
      checks: [check("F1", "unconfirmed", "$0.14 per CU-hour"), check("F2", "not_mentioned")],
    });
    expect(r).toMatchObject({ saved: 0, superseded: 0, confirmed: 0 });
    expect(claimsOf(ctx, old[0]!.messageId).every((c) => c.supersededBy === null && c.confirmedAt === null)).toBe(true);
  });

  it("ignores verdicts on fact ids it never offered (so never another user's facts)", () => {
    const ctx = setup();
    const r = applyExtraction(ctx.repo, job(ctx), new Map(), { ...empty, checks: [check("F7", "changed", "1 GB")] });
    expect(r.saved).toBe(0);
  });

  it("drops an effective date that is just the answer date (live finding)", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [{ attribute: "storage per project", value: "0.5 GB" }]);
    applyExtraction(ctx.repo, job(ctx, { existing: old }), ids(old), { ...empty, checks: [check("F1", "changed", "1 GB", { effective_from: "2026-11-11" })] });
    expect(claimsOf(ctx, ctx.answerId)[0]?.effectiveFrom).toBeNull();
  });
});

describe("applyExtraction: new facts, entities, title", () => {
  it("stores new facts; one without a valid source id is low-confidence", () => {
    const ctx = setup();
    const r = applyExtraction(ctx.repo, job(ctx), new Map(), {
      ...empty,
      facts: [newFact(), newFact({ attribute: "compute per project", value: "100 CU-hours", source_id: "S9" })],
    });
    expect(r.saved).toBe(2);
    expect(claimsOf(ctx, ctx.answerId).map((c) => c.confidence)).toEqual(["high", "low"]);
  });

  it("links a restated existing fact by exact key when the model gave no verdict, and canonicalises names", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [{ attribute: "storage per project", value: "0.5 GB" }]);
    const r = applyExtraction(ctx.repo, job(ctx, { existing: old }), ids(old), {
      ...empty,
      entities: [{ name: "NEON", domain: "https://www.neon.com/pricing" }],
      facts: [newFact({ entity: "neon" })],
    });
    expect(r.superseded).toBe(1);
    expect(claimsOf(ctx, ctx.answerId)[0]?.entity).toBe("Neon");
    expect(ctx.repo.entitiesForMessages(ctx.scope, [ctx.answerId])).toEqual([{ messageId: ctx.answerId, name: "Neon", domain: "neon.com" }]);
  });

  it("skips new facts already covered by a verdict", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [{ attribute: "storage per project", value: "0.5 GB" }]);
    const r = applyExtraction(ctx.repo, job(ctx, { existing: old }), ids(old), { ...empty, checks: [check("F1", "changed", "1 GB")], facts: [newFact()] });
    expect(r.saved).toBe(1);
  });

  it("renames a new thread only when asked to", () => {
    const ctx = setup();
    const x = { ...empty, title: "Neon free tier storage." };
    expect(applyExtraction(ctx.repo, job(ctx, { wantTitle: false }), new Map(), x).titled).toBe(false);
    expect(applyExtraction(ctx.repo, job(ctx, { wantTitle: true }), new Map(), x).titled).toBe(true);
    expect(ctx.repo.getThread(ctx.scope, ctx.thread.id)?.title).toBe("Neon free tier storage");
    applyExtraction(ctx.repo, job(ctx, { wantTitle: true }), new Map(), { ...empty, title: "Postgres hosting pricing updates since last Tuesday" });
    expect(ctx.repo.getThread(ctx.scope, ctx.thread.id)?.title).toBe("Postgres hosting pricing updates");
  });
});

describe("sameValue", () => {
  it.each([
    ["$5/month", "$5/month including $5 of usage", true],
    ["$25/month", "$25 / month", true],
    ["0.5 GB", "1 GB", false],
    ["$0.106 per CU-hour", "$0.14 per CU-hour", false],
    ["no free plan, one-time trial credit only", "$0/month", false],
    ["$5/month", "$50/month", false],
    ["100 CU-hours/month", "100 CU-hours per project monthly, up to 100 projects", true],
    ["0.5 GB", "1 GB storage per project", false],
    ["1 GB", "1 GB storage per project", true],
    ["$25/month", "$25/year", false],
    ["$25/month", "$25 per month", true],
  ])("%s vs %s → %s", (a, b, same) => {
    expect(sameValue(a, b)).toBe(same);
  });
});

describe("isHedged", () => {
  const answer =
    "The free tier now includes 1 GB storage per project [S6]. For Launch, Neon's explainer lists compute at $0.14 per CU-hour [S5], but I can't confirm whether it's $0.106 or $0.14 right now.";
  it("spots a value the answer itself says it couldn't confirm (live finding)", () => {
    expect(isHedged(answer, "$0.14 per CU-hour")).toBe(true);
    expect(isHedged(answer, "1 GB")).toBe(false);
  });

  it("turns a hedged 'changed' verdict into 'leave the old fact alone'", () => {
    const ctx = setup();
    const old = withOldFacts(ctx, [{ attribute: "compute price", value: "$0.106 per CU-hour", plan: "Launch" }]);
    const r = applyExtraction(ctx.repo, job(ctx, { existing: old, answer }), ids(old), { ...empty, checks: [check("F1", "changed", "$0.14 per CU-hour")] });
    expect(r).toMatchObject({ superseded: 0, saved: 0 });
  });
});

describe("MemoryWriter.run", () => {
  it("calls the model with a strict JSON schema, applies the result, and logs its spend", async () => {
    const ctx = setup();
    const llm = createFakeLLM([{ text: [JSON.stringify({ ...empty, facts: [newFact()] })], usage: { inputTokens: 2000, outputTokens: 200 } }]);
    const writer = new MemoryWriter({ llm, repo: ctx.repo, model: "mistral-small-2603" });
    expect(await writer.run(job(ctx))).toMatchObject({ saved: 1 });
    expect(llm.requests[0]).toMatchObject({ model: "mistral-small-2603", reasoningEffort: "none", responseFormat: { name: "memory_extraction" } });
    expect(ctx.repo.totalSpend()).toBeCloseTo((2000 * 0.15 + 200 * 0.6) / 1e6, 10);
  });

  it("retries once, then gives up quietly (raw messages stay searchable)", async () => {
    const ctx = setup();
    const logs: string[] = [];
    const llm = createFakeLLM([{ text: ["not json"] }, { error: new Error("boom") }]);
    const writer = new MemoryWriter({ llm, repo: ctx.repo, model: "m", log: (m) => logs.push(m) });
    await expect(writer.run(job(ctx))).resolves.toBeNull();
    expect(llm.requests).toHaveLength(2);
    expect(logs).toHaveLength(1);
  });
});

describe("chat turn → background memory writer (end to end, fake models)", () => {
  async function drain(gen: AsyncIterable<AgentEvent>) {
    const out: AgentEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("re-checking the demo's 3 Nov answer updates the ledger: old fact superseded, new one observed today", async () => {
    const repo = createRepo(openDb(":memory:"), () => NOW);
    const { profileId } = seedDemo(repo, { now: NOW, tz: TZ });
    const scope = { userId: profileId };
    const llm = createFakeLLM([
      { toolCalls: [{ id: "c1", name: "web_search", arguments: JSON.stringify({ queries: [{ q: "neon pricing", domains: ["neon.com"] }] }) }] },
      { text: ["On 3 Nov I said 0.5 GB; Neon's free tier now has 1 GB per project [S1]."] },
      {
        text: [
          JSON.stringify({ ...empty, title: "Re-checking Postgres pricing", entities: [{ name: "Neon", domain: "neon.com" }], checks: [check("F2", "changed", "1 GB")] }),
        ],
      },
    ]);
    const writer = new MemoryWriter({ llm, repo, model: "mistral-small-2603" });
    const deps: ChatDeps = {
      repo,
      llm,
      writer,
      clock: fixedClock(NOW),
      search: new SearchService({
        provider: { name: "fake", search: async () => ({ results: [{ url: "https://neon.com/pricing", title: "Pricing — Neon", content: "Free: 1 GB", score: 0.9 }], credits: 1 }) },
      }),
      settings: { model: "zai-glm-5-3", maxTokens: 1000, maxRounds: 4, deadlineMs: 60_000, maxQueriesPerTurn: 12 },
    };

    const events = await drain(runChatTurn({ scope, message: "What did I ask you on 3 November? Is your answer still correct today?", clientTz: TZ }, deps, new AbortController().signal));
    await writer.idle();

    expect(llm.requests[2]!.messages[1]!.content).toContain("F2 Neon (Free) · storage per project = 0.5 GB (observed 2026-11-03)");
    const postgres = repo.listThreads(scope).find((t) => t.title.startsWith("Cheapest"))!;
    const oldAnswer = repo.listMessages(scope, postgres.id).find((m) => m.role === "assistant")!;
    const storage = repo.claimsForMessages(scope, [oldAnswer.id]).find((c) => c.attribute === "storage per project")!;
    expect(storage.supersededBy).toMatchObject({ value: "1 GB", observedAt: "2026-11-11" });
    expect(formatFact(storage, (d) => dayLabel(d, 2026))).toBe(
      "Neon (Free) · storage per project = 0.5 GB [seen Tue 3 Nov] → later found 1 GB (seen Wed 11 Nov)",
    );
    const threadId = events[0]?.type === "thread" ? events[0].thread.id : "";
    expect(repo.getThread(scope, threadId)?.title).toBe("Re-checking Postgres pricing");
  });

  it("the spend guard stops a turn before any model call once the budget is used", async () => {
    const repo = createRepo(openDb(":memory:"), () => NOW);
    const scope = { userId: repo.createProfile(repo.createDevice(), "U").id };
    repo.logSpend("test", "m", 4.01);
    const llm = createFakeLLM([]);
    const deps: ChatDeps = {
      repo,
      llm,
      clock: fixedClock(NOW),
      spendLimitUsd: 4,
      settings: { model: "m", maxTokens: 100, maxRounds: 2, deadlineMs: 1000, maxQueriesPerTurn: 1 },
    };
    const events = await drain(runChatTurn({ scope, message: "hi", clientTz: TZ }, deps, new AbortController().signal));
    expect(events).toEqual([expect.objectContaining({ type: "error", retryable: false, message: expect.stringContaining("SPEND_LIMIT_USD") })]);
    expect(llm.requests).toHaveLength(0);
    expect(repo.listThreads(scope)).toHaveLength(0);
  });
});
