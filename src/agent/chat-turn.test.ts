import { describe, expect, it } from "vitest";
import { fixedClock } from "@/core/clock";
import type { AgentEvent } from "@/core/types";
import { createFakeLLM, type FakeStep } from "@/llm/fake";
import { openDb } from "@/memory/db";
import { createRepo } from "@/memory/repo";
import { SearchService } from "@/search/service";
import { stripCitations } from "@/lib/citations";
import { runChatTurn, titleFrom, type ChatDeps } from "./chat-turn";

const NOW = new Date("2026-11-11T08:35:00Z");

function setup(steps: FakeStep[]) {
  const repo = createRepo(openDb(":memory:"), () => NOW);
  const scope = { userId: repo.createProfile(repo.createDevice(), "You").id };
  const llm = createFakeLLM(steps);
  const deps: ChatDeps = {
    repo,
    llm,
    clock: fixedClock(NOW),
    search: new SearchService({
      provider: {
        name: "fake",
        search: async () => ({ results: [{ url: "https://neon.com/pricing", title: "Neon pricing", content: "Launch from $5", score: 0.9 }], credits: 1 }),
      },
    }),
    settings: { model: "zai-glm-5-3", maxTokens: 1000, maxRounds: 4, deadlineMs: 60_000, maxQueriesPerTurn: 12 },
  };
  return { repo, scope, llm, deps };
}

async function collect(gen: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const searchThenAnswer = (answer: string): FakeStep[] => [
  { toolCalls: [{ id: "c1", name: "web_search", arguments: JSON.stringify({ queries: [{ q: "neon pricing" }] }) }] },
  { text: [answer] },
];

describe("runChatTurn", () => {
  it("creates a thread, saves question + answer + evidence + trace, and reports the ids", async () => {
    const { repo, scope, deps } = setup(searchThenAnswer("Neon starts at $5 [S1]."));
    const events = await collect(runChatTurn({ scope, message: "How much is Neon?", clientTz: "Asia/Kolkata" }, deps, new AbortController().signal));

    const threadEv = events[0];
    expect(threadEv).toMatchObject({ type: "thread", thread: { title: "How much is Neon?", isNew: true } });
    const done = events.at(-1);
    expect(done?.type).toBe("done");

    const threadId = threadEv?.type === "thread" ? threadEv.thread.id : "";
    const [q, a] = repo.listMessages(scope, threadId);
    expect(q).toMatchObject({ role: "user", content: "How much is Neon?", localDate: "2026-11-11", tz: "Asia/Kolkata" });
    expect(a).toMatchObject({ role: "assistant", content: "Neon starts at $5 [S1].", status: "done" });
    expect(done).toMatchObject({ messageId: a?.id });
    expect(a?.sources).toEqual([expect.objectContaining({ id: "S1", url: "https://neon.com/pricing", excerpt: "Launch from $5", retrievedAt: "2026-11-11" })]);
    expect(a?.trace?.citations.used).toEqual(["S1"]);
  });

  it("continues a thread with its history (old citation markers stripped)", async () => {
    const { repo, scope, deps, llm } = setup([...searchThenAnswer("Neon starts at $5 [S1]."), { text: ["Yes, still usage-based."] }]);
    const first = await collect(runChatTurn({ scope, message: "How much is Neon?", clientTz: "UTC" }, deps, new AbortController().signal));
    const threadId = first[0]?.type === "thread" ? first[0].thread.id : "";

    const second = await collect(runChatTurn({ scope, threadId, message: "Is it usage-based?", clientTz: "UTC" }, deps, new AbortController().signal));
    expect(second[0]).toMatchObject({ type: "thread", thread: { id: threadId, isNew: false } });

    const sent = llm.requests.at(-1)!.messages;
    expect(sent.slice(1, 3)).toEqual([
      { role: "user", content: "How much is Neon?" },
      { role: "assistant", content: "Neon starts at $5." },
    ]);
    expect(repo.listMessages(scope, threadId)).toHaveLength(4);
  });

  it("saves a partial answer as 'stopped' when the user stops mid-stream", async () => {
    const { repo, scope, deps } = setup([{ text: ["Part one, ", "part two, ", "part three."] }]);
    const controller = new AbortController();
    let threadId = "";
    for await (const e of runChatTurn({ scope, message: "Tell me a long story", clientTz: "UTC" }, deps, controller.signal)) {
      if (e.type === "thread") threadId = e.thread.id;
      if (e.type === "text") controller.abort();
    }
    const [, a] = repo.listMessages(scope, threadId);
    expect(a).toMatchObject({ status: "stopped", content: "Part one, " });
  });

  it("saves a failed answer as 'error' so it is excluded from future history", async () => {
    const { repo, scope, deps } = setup([{ error: new Error("boom") }]);
    const events = await collect(runChatTurn({ scope, message: "Hi", clientTz: "UTC" }, deps, new AbortController().signal));
    expect(events.at(-1)?.type).toBe("error");
    const threadId = events[0]?.type === "thread" ? events[0].thread.id : "";
    expect(repo.listMessages(scope, threadId).map((m) => m.status)).toEqual(["done", "error"]);
    expect(repo.recentHistory(scope, threadId)).toEqual([]);
  });

  it("re-checks exactly the chosen answer: its facts in memory, its items prefetched", async () => {
    const { repo, scope, deps, llm } = setup([{ text: ["✅ Neon Launch still $19/month [S1]."] }]);
    const t = repo.createThread(scope, "Postgres hosting");
    repo.addMessage(scope, { threadId: t.id, role: "user", content: "Cheapest Postgres host?", tz: "UTC", createdAt: "2026-11-03T09:00:00Z" });
    const a = repo.addMessage(scope, { threadId: t.id, role: "assistant", content: "Neon Launch is $19/month.", tz: "UTC", createdAt: "2026-11-03T09:00:05Z" });
    repo.saveClaims(scope, { messageId: a.id, threadId: t.id }, [{ entity: "Neon", plan: "Launch", attribute: "monthly price", value: "$19/month", observedAt: "2026-11-03", confidence: "high" }]);
    repo.saveEntities(scope, a.id, [{ name: "Neon", domain: "neon.com" }]);

    const events = await collect(
      runChatTurn({ scope, threadId: t.id, recheckOf: a.id, message: "Re-check your answer from Tue 3 Nov.", clientTz: "UTC" }, deps, new AbortController().signal),
    );
    expect(events.find((e) => e.type === "memory")).toMatchObject({ status: "found", refs: [{ threadId: t.id, localDate: "2026-11-03" }] });
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", trace: { prefetch: { queries: 2 } } });
    expect(llm.requests).toHaveLength(1);
    const prompt = llm.requests[0]!.messages.at(-1)!.content as string;
    expect(prompt).toContain("Neon (Launch) · monthly price = $19/month [seen Tue 3 Nov]");
    expect(prompt).toContain("<prefetched_evidence");
    expect(prompt).toContain("since = 2026-11-03");
  });

  it("refuses to re-check an answer that isn't in this thread", async () => {
    const { repo, scope, deps } = setup([{ text: ["never"] }]);
    const t = repo.createThread(scope, "x");
    const events = await collect(
      runChatTurn({ scope, threadId: t.id, recheckOf: "00000000-0000-4000-8000-000000000000", message: "Re-check", clientTz: "UTC" }, deps, new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
  });

  it("refuses a thread id that belongs to someone else", async () => {
    const { repo, deps } = setup([{ text: ["never"] }]);
    const owner = { userId: repo.createProfile(repo.createDevice(), "Owner").id };
    const intruder = { userId: repo.createProfile(repo.createDevice(), "Intruder").id };
    const t = repo.createThread(owner, "private");
    const events = await collect(runChatTurn({ scope: intruder, threadId: t.id, message: "hi", clientTz: "UTC" }, deps, new AbortController().signal));
    expect(events).toEqual([expect.objectContaining({ type: "error", retryable: false })]);
    expect(repo.listMessages(owner, t.id)).toEqual([]);
  });
});

describe("helpers", () => {
  it("titles threads from the first line, cut at a word", () => {
    expect(titleFrom("  Compare Neon and Supabase\nmore details")).toBe("Compare Neon and Supabase");
    expect(titleFrom("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any changed?")).toBe(
      "On Monday we shortlisted 5 CRM tools for a 20-person sales…",
    );
  });

  it("strips citation markers without leaving gaps before punctuation", () => {
    expect(stripCitations("Neon is cheap [S1]. Supabase too [S2, S3]!")).toBe("Neon is cheap. Supabase too!");
  });
});
