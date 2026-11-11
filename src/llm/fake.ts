import type { ChatMessage, FinishReason, LLMChunk, LLMProvider, LLMRequest, ToolCall, Usage } from "@/core/types";

export type FakeStep =
  | { text?: string[]; toolCalls?: ToolCall[]; finish?: FinishReason; usage?: Partial<Usage> }
  | { error: Error };

export type FakeLLM = LLMProvider & { requests: LLMRequest[] };

export function createFakeLLM(steps: FakeStep[]): FakeLLM {
  const requests: LLMRequest[] = [];
  let i = 0;
  return {
    requests,
    async *stream(req, signal): AsyncGenerator<LLMChunk> {
      requests.push({ ...req, messages: [...req.messages] });
      const step = steps[i++];
      if (!step) throw new Error(`FakeLLM: no scripted step #${i}`);
      if ("error" in step) throw step.error;
      let text = "";
      for (const delta of step.text ?? []) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        text += delta;
        yield { type: "text", delta };
      }
      const message: Extract<ChatMessage, { role: "assistant" }> = {
        role: "assistant",
        content: text,
        ...(step.toolCalls?.length ? { toolCalls: step.toolCalls } : {}),
      };
      yield {
        type: "finish",
        reason: step.finish ?? (step.toolCalls?.length ? "tool_calls" : "stop"),
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0, ...step.usage },
        message,
      };
    },
  };
}
