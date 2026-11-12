import { addUsage, emptyUsage } from "@/core/types";
import type {
  ChatMessage,
  LLMChunk,
  LLMProvider,
  ReasoningEffort,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@/core/types";

type FinishChunk = Extract<LLMChunk, { type: "finish" }>;

export type ToolResult = { toolCallId: string; name: string; content: string };

export interface ToolSet {
  definitions: ToolDefinition[];
  execute(calls: ToolCall[], signal: AbortSignal): Promise<ToolResult[]>;
}

export const noTools: ToolSet = { definitions: [], execute: async () => [] };

export type LoopOptions = {
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  maxRounds: number;
  deadlineMs: number;
};

export type LoopEvent =
  | { type: "text"; delta: string }
  | { type: "thinking" }
  | { type: "tools_start"; calls: ToolCall[] }
  | { type: "tools_end"; calls: ToolCall[]; ms: number }
  | { type: "round"; round: number; startedAt: number; endedAt: number; firstTextAt: number | null; usage: Usage; toolCalls: number }
  | { type: "complete"; result: LoopResult };

export type LoopResult = {
  newMessages: ChatMessage[];
  finalText: string;
  usage: Usage;
  rounds: number;
  truncated: boolean;
};

const CONTINUE_PROMPT = "Continue exactly where you stopped. Do not repeat anything you already wrote.";

export async function* runLoop(
  llm: LLMProvider,
  history: ChatMessage[],
  tools: ToolSet,
  opts: LoopOptions,
  signal: AbortSignal,
): AsyncGenerator<LoopEvent> {
  const started = performance.now();
  const messages = [...history];
  const newMessages: ChatMessage[] = [];
  const push = (m: ChatMessage) => {
    messages.push(m);
    newMessages.push(m);
  };

  let usage = emptyUsage();
  let finalText = "";
  let continued = false;
  let continuing = false;
  let truncated = false;
  let rounds = 0;

  while (rounds < opts.maxRounds) {
    rounds++;
    const outOfBudget = rounds === opts.maxRounds || performance.now() - started > opts.deadlineMs;
    const hasTools = tools.definitions.length > 0;

    let finish: FinishChunk | undefined;
    let roundHasText = false;
    const roundStarted = performance.now();
    let firstTextAt: number | null = null;
    const isContinuation = continuing;
    continuing = false;
    for await (const chunk of llm.stream(
      {
        model: opts.model,
        messages,
        ...(hasTools ? { tools: tools.definitions, toolChoice: outOfBudget ? "none" : "auto" } : {}),
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      },
      signal,
    )) {
      if (chunk.type === "text") {
        if (!roundHasText && !isContinuation && finalText && !/\s$/.test(finalText)) {
          finalText += "\n\n";
          yield { type: "text", delta: "\n\n" };
        }
        roundHasText = true;
        firstTextAt ??= performance.now();
        finalText += chunk.delta;
        yield { type: "text", delta: chunk.delta };
      } else if (chunk.type === "thinking") {
        yield { type: "thinking" };
      } else {
        finish = chunk;
      }
    }
    if (!finish) throw new Error("LLM stream ended without a finish chunk");
    usage = addUsage(usage, finish.usage);
    const calls = finish.reason === "tool_calls" ? (finish.message.toolCalls ?? []) : [];
    yield { type: "round", round: rounds, startedAt: roundStarted, endedAt: performance.now(), firstTextAt, usage: finish.usage, toolCalls: calls.length };

    if (calls.length > 0 && outOfBudget) {
      // A tool call without a result would make the next request invalid.
      const { toolCalls: _dropped, ...withoutCalls } = finish.message;
      push(withoutCalls);
      truncated = true;
      break;
    }
    push(finish.message);

    if (calls.length > 0) {
      yield { type: "tools_start", calls };
      const t0 = performance.now();
      const results = await tools.execute(calls, signal);
      yield { type: "tools_end", calls, ms: Math.round(performance.now() - t0) };
      for (const call of calls) {
        const r = results.find((x) => x.toolCallId === call.id);
        push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: r?.content ?? JSON.stringify({ error: "Tool produced no result." }),
        });
      }
      continue;
    }

    if (finish.reason === "length" && !continued && rounds < opts.maxRounds) {
      continued = true;
      continuing = true;
      push({ role: "user", content: CONTINUE_PROMPT });
      continue;
    }

    truncated = finish.reason === "length";
    break;
  }

  yield { type: "complete", result: { newMessages, finalText, usage, rounds, truncated } };
}
