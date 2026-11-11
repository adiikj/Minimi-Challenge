import { describe, expect, it } from "vitest";
import type { TurnTrace } from "../src/core/types";
import { runChecks } from "./checks";
import { Scenario } from "./scenario";

const trace = (over: Partial<TurnTrace> = {}): TurnTrace => ({
  model: "m",
  rounds: 1,
  totalMs: 1000,
  firstTokenMs: 500,
  usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
  costUsd: 0.001,
  truncated: false,
  search: { queries: 2, credits: 0, cacheHits: 0, sources: 3, ms: 10 },
  citations: { used: ["S1", "S2"], invalid: [] },
  ...over,
});

const scenario = (expect: Record<string, unknown>) =>
  Scenario.parse({ id: "x", title: "x", category: "memory", now: "2026-11-11T08:35:00Z", tz: "Asia/Kolkata", setup: "demo", message: "q", rubric: "r", expect });

const failed = (checks: ReturnType<typeof runChecks>) => checks.filter((c) => !c.pass).map((c) => c.name);

describe("runChecks", () => {
  it("passes a good memory answer", () => {
    const s = scenario({ memory: "found", recalledDate: "2026-11-03", statesDate: ["3 Nov"], mentions: ["Neon"], searched: true, minCitations: 2 });
    const t = trace({ memory: { status: "found", assumptions: [], refs: [{ threadId: "t", title: "x", localDate: "2026-11-03" }], ms: 1 } });
    expect(failed(runChecks(s, { answer: "On Tue 3 Nov you asked about Neon [S1][S2].", trace: t, error: null }))).toEqual([]);
  });

  it("catches the wrong day, missing names, no search and invented citations", () => {
    const s = scenario({ memory: "found", recalledDate: "2026-11-03", mentions: ["Neon", "Railway"], searched: true, minCitations: 1 });
    const t = trace({
      search: { queries: 0, credits: 0, cacheHits: 0, sources: 0, ms: 0 },
      citations: { used: [], invalid: ["S9"] },
      memory: { status: "found", assumptions: [], refs: [{ threadId: "t", title: "x", localDate: "2026-11-10" }], ms: 1 },
    });
    expect(failed(runChecks(s, { answer: "On 10 Nov you asked about Neon.", trace: t, error: null }))).toEqual([
      "recalled the right day",
      'mentions "Railway"',
      "searched the web",
      "≥ 1 citations",
      "no invented citations",
    ]);
  });

  it("recognises honest 'nothing found' answers, and flags invented ones", () => {
    const s = scenario({ memory: "none-found", honestNotFound: true });
    const t = trace({ memory: { status: "none-found", assumptions: [], refs: [], ms: 1 } });
    expect(failed(runChecks(s, { answer: "I don't have any record of a conversation on 5 November.", trace: t, error: null }))).toEqual([]);
    expect(failed(runChecks(s, { answer: "On 5 November you asked about Kubernetes.", trace: t, error: null }))).toEqual(["says plainly nothing was found"]);
  });

  it("treats a missing memory trace as 'not-needed' and reports errors", () => {
    const s = scenario({ memory: "found" });
    expect(failed(runChecks(s, { answer: "x", trace: trace(), error: null }))).toEqual(["memory status"]);
    expect(failed(runChecks(s, { answer: "", trace: null, error: "boom" }))).toEqual(["answered"]);
  });
});
