import { describe, expect, it } from "vitest";
import { ProviderError } from "@/core/errors";
import type { LLMChunk } from "@/core/types";
import { createMistralProvider, mapReasoningEffort, readStream, toWireRequest } from "./mistral";

function sseBody(chunks: unknown[], splitEvery = 7): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += splitEvery) controller.enqueue(bytes.slice(i, i + splitEvery));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out: LLMChunk[] = [];
  for await (const c of readStream(body)) out.push(c);
  return out;
}

const usage = { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 120 }, completion_tokens_details: { reasoning_tokens: 20 } };

describe("readStream", () => {
  it("handles thinking chunks, then the switch to plain-string content (Mistral reasoning format)", async () => {
    const out = await collect(
      sseBody([
        { choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "Let me " }] }] } }] },
        { choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "think." }] }, { type: "text", text: "Hello" }] } }] },
        { choices: [{ delta: { content: " world" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage },
      ]),
    );
    expect(out.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("")).toBe("Hello world");
    expect(out.some((c) => c.type === "thinking")).toBe(true);
    const finish = out.at(-1);
    expect(finish).toMatchObject({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 200, cachedInputTokens: 120, outputTokens: 50, reasoningTokens: 20 },
      message: { role: "assistant", content: "Hello world" },
    });
    expect((finish as Extract<LLMChunk, { type: "finish" }>).message.providerContent).toEqual([
      { type: "thinking", thinking: [{ type: "text", text: "Let me think." }] },
      { type: "text", text: "Hello world" },
    ]);
  });

  it("assembles tool calls whose arguments arrive in pieces (GLM 5.3 style)", async () => {
    const out = await collect(
      sseBody([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "web_search", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "", arguments: '{"queries": ' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '[{"q": "neon"}]}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
      ]),
    );
    const finish = out.at(-1) as Extract<LLMChunk, { type: "finish" }>;
    expect(finish.reason).toBe("tool_calls");
    expect(finish.message.toolCalls).toEqual([{ id: "call-1", name: "web_search", arguments: '{"queries": [{"q": "neon"}]}' }]);
  });

  it("keeps parallel tool calls apart by index (Large 4 style, whole arguments)", async () => {
    const out = await collect(
      sseBody([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "web_search", arguments: '{"queries":[{"q":"x"}]}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "web_search", arguments: '{"queries":[{"q":"y"}]}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const finish = out.at(-1) as Extract<LLMChunk, { type: "finish" }>;
    expect(finish.message.toolCalls?.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("maps length finishes and surfaces stream errors", async () => {
    const out = await collect(sseBody([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }]));
    expect(out.at(-1)).toMatchObject({ type: "finish", reason: "length" });

    await expect(collect(sseBody([{ object: "error", message: "boom" }]))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("request mapping", () => {
  it("maps reasoning effort to what each model family accepts", () => {
    expect(mapReasoningEffort("mistral-large-4", "none")).toBe("low");
    expect(mapReasoningEffort("mistral-large-4", "medium")).toBe("medium");
    expect(mapReasoningEffort("zai-glm-5-3", "none")).toBe("low");
    expect(mapReasoningEffort("zai-glm-5-3", "high")).toBe("high");
    expect(mapReasoningEffort("mistral-small-2603", "low")).toBe("none");
    expect(mapReasoningEffort("mistral-small-2603", "high")).toBe("high");
    expect(mapReasoningEffort("mistral-large-2512", "low")).toBeUndefined();
  });

  it("requests structured output with a strict JSON schema", () => {
    const wire = toWireRequest({ model: "mistral-small-2603", messages: [], responseFormat: { name: "x", schema: { type: "object" } } });
    expect(wire.response_format).toEqual({ type: "json_schema", json_schema: { name: "x", schema: { type: "object" }, strict: true } });
  });

  it("serialises tools, tool calls and tool results in Mistral's wire format", () => {
    const wire = toWireRequest({
      model: "zai-glm-5-3",
      reasoningEffort: "low",
      toolChoice: "none",
      tools: [{ name: "web_search", description: "d", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_search", arguments: "{}" }] },
        { role: "tool", toolCallId: "c1", name: "web_search", content: "[]" },
      ],
    });
    expect(wire).toMatchObject({
      reasoning_effort: "low",
      tool_choice: "none",
      parallel_tool_calls: true,
      tools: [{ type: "function", function: { name: "web_search" } }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", name: "web_search", content: "[]" },
      ],
    });
  });
});

describe("retries", () => {
  const okBody = () => sseBody([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);

  it("retries 429/5xx before streaming starts, then succeeds", async () => {
    const statuses = [429, 503];
    let calls = 0;
    const llm = createMistralProvider({
      apiKey: "k",
      sleep: async () => {},
      fetchImpl: async () => {
        const s = statuses[calls++];
        return s ? new Response("busy", { status: s }) : new Response(okBody(), { status: 200 });
      },
    });
    const out: LLMChunk[] = [];
    for await (const c of llm.stream({ model: "m", messages: [] }, new AbortController().signal)) out.push(c);
    expect(calls).toBe(3);
    expect(out.at(-1)).toMatchObject({ type: "finish", message: { content: "ok" } });
  });

  it("does not retry a 401 and reports it as non-retryable", async () => {
    let calls = 0;
    const llm = createMistralProvider({
      apiKey: "bad",
      sleep: async () => {},
      fetchImpl: async () => {
        calls++;
        return new Response("unauthorized", { status: 401 });
      },
    });
    const run = async () => {
      for await (const _ of llm.stream({ model: "m", messages: [] }, new AbortController().signal)) void _;
    };
    await expect(run()).rejects.toMatchObject({ name: "ProviderError", status: 401, retryable: false });
    expect(calls).toBe(1);
  });
});
