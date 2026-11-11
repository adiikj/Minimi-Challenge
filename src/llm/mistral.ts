import { isAbortError, ProviderError } from "@/core/errors";
import type {
  ChatMessage,
  FinishReason,
  LLMChunk,
  LLMProvider,
  LLMRequest,
  ReasoningEffort,
  ToolCall,
  Usage,
} from "@/core/types";
import { parseSSE } from "@/lib/sse";

const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

type Options = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function createMistralProvider(opts: Options): LLMProvider {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  return {
    async *stream(req, signal) {
      const body = JSON.stringify(toWireRequest(req));
      const res = await fetchWithRetry(() =>
        doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        }),
      );
      if (!res.body) throw new ProviderError("Empty response body", "mistral", res.status, true);
      yield* readStream(res.body);
    },
  };

  async function fetchWithRetry(send: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await send();
      } catch (err) {
        if (isAbortError(err) || attempt >= MAX_RETRIES) throw toProviderError(err);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new ProviderError(`Mistral HTTP ${res.status}: ${detail}`, "mistral", res.status, retryable);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
    }
  }
}

const backoffMs = (attempt: number) => 500 * 2 ** attempt;

function toProviderError(err: unknown): unknown {
  if (isAbortError(err) || err instanceof ProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new ProviderError(`Mistral request failed: ${msg}`, "mistral", null, true);
}

export function mapReasoningEffort(model: string, effort: ReasoningEffort | undefined): string | undefined {
  if (!effort) return undefined;
  if (model.startsWith("mistral-small")) return effort === "none" || effort === "low" ? "none" : "high";
  if (model.startsWith("zai-glm")) return effort === "none" || effort === "low" || effort === "medium" ? "low" : "high";
  if (model.startsWith("mistral-large-4")) return effort === "none" ? "low" : effort;
  return undefined;
}

export function toWireRequest(req: LLMRequest): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toWireMessage),
    stream: true,
  };
  if (req.maxTokens) wire.max_tokens = req.maxTokens;
  const effort = mapReasoningEffort(req.model, req.reasoningEffort);
  if (effort) wire.reasoning_effort = effort;
  if (req.responseFormat) {
    wire.response_format = { type: "json_schema", json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema, strict: true } };
  }
  if (req.tools?.length) {
    wire.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    wire.tool_choice = req.toolChoice ?? "auto";
    wire.parallel_tool_calls = true;
  }
  return wire;
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.providerContent ?? m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
  }
}

type WireChunk = {
  object?: string;
  message?: unknown;
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type: string; text?: string; thinking?: Array<{ text?: string }> }> | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

export async function* readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LLMChunk> {
  let text = "";
  let thinking = "";
  let rawFinish: string | undefined;
  let usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const calls = new Map<number, ToolCall>();

  for await (const data of parseSSE(body)) {
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(data) as WireChunk;
    } catch {
      continue;
    }
    if (chunk.object === "error") {
      throw new ProviderError(`Mistral stream error: ${JSON.stringify(chunk.message ?? chunk)}`, "mistral", null, true);
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (typeof delta?.content === "string") {
      if (delta.content) {
        text += delta.content;
        yield { type: "text", delta: delta.content };
      }
    } else if (Array.isArray(delta?.content)) {
      for (const part of delta.content) {
        if (part.type === "text" && part.text) {
          text += part.text;
          yield { type: "text", delta: part.text };
        } else if (part.type === "thinking") {
          const t = (part.thinking ?? []).map((x) => x.text ?? "").join("");
          if (t) {
            thinking += t;
            yield { type: "thinking", delta: t };
          }
        }
      }
    }

    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? calls.size;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      current.id ||= tc.id ?? "";
      current.name ||= tc.function?.name ?? "";
      current.arguments += tc.function?.arguments ?? "";
      calls.set(index, current);
    }

    if (choice?.finish_reason) rawFinish = choice.finish_reason;
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    }
  }

  if (rawFinish === "error") throw new ProviderError("Mistral finished with an error", "mistral", null, true);

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  const reason: FinishReason =
    toolCalls.length > 0 ? "tool_calls" : rawFinish === "length" || rawFinish === "model_length" ? "length" : "stop";

  yield {
    type: "finish",
    reason,
    usage,
    message: {
      role: "assistant",
      content: text,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(thinking
        ? {
            providerContent: [
              { type: "thinking", thinking: [{ type: "text", text: thinking }] },
              ...(text ? [{ type: "text", text }] : []),
            ],
          }
        : {}),
    },
  };
}
