import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/core/types";
import { createFakeLLM } from "@/llm/fake";
import { runLoop, type LoopEvent, type LoopOptions, type ToolSet } from "./loop";

const opts: LoopOptions = { model: "m", maxRounds: 4, deadlineMs: 60_000 };
const history: ChatMessage[] = [{ role: "user", content: "hi" }];
const signal = () => new AbortController().signal;

async function collect(gen: AsyncIterable<LoopEvent>) {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  const done = events.at(-1);
  if (done?.type !== "complete") throw new Error("loop did not complete");
  return { events, result: done.result };
}

const echoTools = (log: string[] = []): ToolSet => ({
  definitions: [{ name: "web_search", description: "search", parameters: { type: "object" } }],
  async execute(calls) {
    log.push(calls.map((c) => c.id).join(","));
    return calls.map((c) => ({ toolCallId: c.id, name: c.name, content: `result for ${c.id}` }));
  },
});

describe("runLoop", () => {
  it("streams text and finishes in one round when no tool is needed", async () => {
    const llm = createFakeLLM([{ text: ["Hel", "lo"] }]);
    const { events, result } = await collect(runLoop(llm, history, echoTools(), opts, signal()));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual(["Hel", "lo"]);
    expect(result).toMatchObject({ finalText: "Hello", rounds: 1, truncated: false });
    expect(llm.requests).toHaveLength(1);
  });

  it("runs all tool calls of a round together and returns every result before the next call", async () => {
    const log: string[] = [];
    const llm = createFakeLLM([
      {
        toolCalls: [
          { id: "a", name: "web_search", arguments: "{}" },
          { id: "b", name: "web_search", arguments: "{}" },
        ],
      },
      { text: ["Answer"] },
    ]);
    const { result } = await collect(runLoop(llm, history, echoTools(log), opts, signal()));
    expect(log).toEqual(["a,b"]);
    const second = llm.requests[1]!.messages;
    expect(second.slice(-2)).toEqual([
      { role: "tool", toolCallId: "a", name: "web_search", content: "result for a" },
      { role: "tool", toolCallId: "b", name: "web_search", content: "result for b" },
    ]);
    expect(result).toMatchObject({ finalText: "Answer", rounds: 2 });
  });

  it("separates text written before a tool call from text written after it", async () => {
    const llm = createFakeLLM([
      { text: ["Let me re-check that."], toolCalls: [{ id: "a", name: "web_search", arguments: "{}" }] },
      { text: ["Mostly yes."] },
    ]);
    const { result } = await collect(runLoop(llm, history, echoTools(), opts, signal()));
    expect(result.finalText).toBe("Let me re-check that.\n\nMostly yes.");
  });

  it("forces a final answer (toolChoice none) on the last round", async () => {
    const llm = createFakeLLM([
      { toolCalls: [{ id: "a", name: "web_search", arguments: "{}" }] },
      { text: ["Best I can do"] },
    ]);
    await collect(runLoop(llm, history, echoTools(), { ...opts, maxRounds: 2 }, signal()));
    expect(llm.requests[0]!.toolChoice).toBe("auto");
    expect(llm.requests[1]!.toolChoice).toBe("none");
  });

  it("drops tool calls the model makes despite toolChoice none, so history stays valid", async () => {
    const llm = createFakeLLM([{ text: ["Partial"], toolCalls: [{ id: "x", name: "web_search", arguments: "{}" }] }]);
    const { result } = await collect(runLoop(llm, history, echoTools(), { ...opts, maxRounds: 1 }, signal()));
    expect(result.truncated).toBe(true);
    expect(result.newMessages).toEqual([{ role: "assistant", content: "Partial" }]);
  });

  it("continues once when the answer hits the token limit", async () => {
    const llm = createFakeLLM([{ text: ["First half "], finish: "length" }, { text: ["second half"] }]);
    const { result } = await collect(runLoop(llm, history, echoTools(), opts, signal()));
    expect(result).toMatchObject({ finalText: "First half second half", rounds: 2, truncated: false });
    expect(llm.requests[1]!.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("reports truncation if the continuation is also cut off", async () => {
    const llm = createFakeLLM([
      { text: ["a"], finish: "length" },
      { text: ["b"], finish: "length" },
    ]);
    const { result } = await collect(runLoop(llm, history, echoTools(), opts, signal()));
    expect(result).toMatchObject({ truncated: true, rounds: 2 });
  });

  it("adds up usage across rounds", async () => {
    const llm = createFakeLLM([
      { toolCalls: [{ id: "a", name: "web_search", arguments: "{}" }], usage: { inputTokens: 100, outputTokens: 5 } },
      { text: ["x"], usage: { inputTokens: 300, cachedInputTokens: 90, outputTokens: 20 } },
    ]);
    const { result } = await collect(runLoop(llm, history, echoTools(), opts, signal()));
    expect(result.usage).toEqual({ inputTokens: 400, cachedInputTokens: 90, outputTokens: 25, reasoningTokens: 0 });
  });
});
