

export type UserScope = { readonly userId: string };

export interface Clock {
  now(): Date;
}


export type AgentEvent =
  | { type: "thread"; thread: { id: string; title: string; isNew: boolean }; userMessageId: string }
  | { type: "assumption"; assumption: AssumptionRef }
  | { type: "memory"; status: "found" | "none-found"; refs: MemoryRef[] }
  | { type: "status"; id: string; label: string; state: "start" | "end"; ms?: number }
  | { type: "sources"; sources: SourceRef[] }
  | { type: "text"; delta: string }
  | { type: "done"; trace: TurnTrace; messageId?: string }
  | { type: "error"; message: string; retryable: boolean };

export type AssumptionRef = { phrase: string; chosen: string; alternatives: Array<{ label: string; hasConversations: boolean }> };
export type MemoryRef = { threadId: string; title: string; localDate: string };

export type SourceRef = { id: string; url: string; title: string; domain: string; publishedAt?: string; retrievedAt: string };

export type TurnTrace = {
  model: string;
  rounds: number;
  totalMs: number;
  firstTokenMs: number | null;
  usage: Usage;
  costUsd: number;
  truncated: boolean;
  search: { queries: number; credits: number; cacheHits: number; sources: number; ms: number };
  citations: { used: string[]; invalid: string[] };
  memory?: { status: "found" | "none-found"; assumptions: AssumptionRef[]; refs: MemoryRef[]; ms: number };
  prefetch?: { queries: number; sources: number; ms: number };
  spans?: TraceSpan[];
};

export type TraceSpan = {
  kind: "memory" | "prefetch" | "model" | "search";
  label: string;
  startMs: number;
  ms: number;
  firstTextMs?: number;
  usage?: Usage;
  queries?: string[];
  cacheHits?: number;
};


export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      providerContent?: unknown;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export type LLMRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  responseFormat?: { name: string; schema: Record<string, unknown> };
};

export type FinishReason = "stop" | "tool_calls" | "length";

export type LLMChunk =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | {
      type: "finish";
      reason: FinishReason;
      usage: Usage;
      message: Extract<ChatMessage, { role: "assistant" }>;
    };

export interface LLMProvider {
  stream(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk>;
}
