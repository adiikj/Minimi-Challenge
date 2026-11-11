import { isAbortError, ProviderError } from "@/core/errors";
import type {
  AgentEvent,
  AssumptionRef,
  ChatMessage,
  Clock,
  LLMProvider,
  MemoryRef,
  ReasoningEffort,
  SourceRef,
  TraceSpan,
  TurnTrace,
  UserScope,
} from "@/core/types";
import { checkCitations } from "@/lib/citations";
import { localDate, safeTimeZone } from "@/lib/time";
import { costUsd } from "@/llm/pricing";
import { SourceRegistry, type SearchService } from "@/search/service";
import { noTools, runLoop } from "./loop";
import { buildTurnContext, SYSTEM_PROMPT, withContext } from "./prompts";
import { createWebSearchTool, formatRun, type SearchTurnState, type WebSearchToolSet } from "./tools/web-search";
import type { PrefetchPlan } from "@/context/prefetch";


export type HistoryMessage = { role: "user" | "assistant"; content: string };

const PREFETCH_TIMEOUT_MS = 3_500;

export type TurnInput = {
  scope: UserScope;
  message: string;
  history: HistoryMessage[];
  clientTz: string;
  registry?: SourceRegistry;
  memory?: TurnMemory;
  prefetch?: PrefetchPlan | null;
  startedAt?: number;
};

export type TurnMemory = {
  status: "not-needed" | "found" | "none-found";
  text: string | null;
  assumptions: AssumptionRef[];
  refs: MemoryRef[];
  ms: number;
};

export type TurnDeps = {
  llm: LLMProvider;
  clock: Clock;
  search?: SearchService;
  settings: {
    model: string;
    reasoningEffort?: ReasoningEffort;
    maxTokens: number;
    maxRounds: number;
    deadlineMs: number;
    maxQueriesPerTurn: number;
    prefetch?: boolean;
  };
};

export async function* runTurn(input: TurnInput, deps: TurnDeps, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const t0 = input.startedAt ?? performance.now();
  const tz = safeTimeZone(input.clientTz);
  const now = deps.clock.now();

  const searchState: SearchTurnState = {
    registry: input.registry ?? new SourceRegistry(),
    retrievedAt: localDate(now, tz),
    queriesUsed: 0,
    credits: 0,
    cacheHits: 0,
  };
  const tools: WebSearchToolSet | undefined = deps.search
    ? createWebSearchTool(deps.search, searchState, { maxQueriesPerTurn: deps.settings.maxQueriesPerTurn })
    : undefined;

  let firstTokenMs: number | null = null;
  let searchMs = 0;
  let pendingStatus: string | null = null;
  const m = input.memory;
  const memory = m && (m.status === "found" || m.status === "none-found") ? { ...m, status: m.status } : undefined;

  for (const assumption of memory?.assumptions ?? []) yield { type: "assumption", assumption };
  if (memory) yield { type: "memory", status: memory.status, refs: memory.refs };

  let prefetchTrace: TurnTrace["prefetch"];
  const at = (t: number) => Math.max(0, Math.round(t - t0));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const spans: TraceSpan[] = [];
  if (memory) {
    const label = memory.status === "found" ? `Memory: ${plural(memory.refs.length, "past conversation", "past conversations")}` : "Memory: nothing found";
    spans.push({ kind: "memory", label, startMs: 0, ms: memory.ms });
  }
  let searchStartedAt = 0;
  let searchQueries: string[] = [];
  let cacheHitsBefore = 0;

  try {
    let evidence: string | null = null;
    const plan = input.prefetch;
    if (plan?.queries.length && deps.search && deps.settings.prefetch !== false) {
      const shown = plan.entities.slice(0, 2).join(", ");
      const label = `Checking ${plan.entities.length} item${plan.entities.length === 1 ? "" : "s"}: ${shown}${plan.entities.length > 2 ? ` +${plan.entities.length - 2}` : ""}`;
      yield { type: "status", id: "prefetch", label, state: "start" };
      const tp = performance.now();
      try {
        const run = await deps.search.run(plan.queries, "fast", { registry: searchState.registry, retrievedAt: searchState.retrievedAt }, signal, {
          timeoutMs: PREFETCH_TIMEOUT_MS,
        });
        searchState.queriesUsed += plan.queries.length;
        searchState.credits += run.credits;
        searchState.cacheHits += run.outcomes.filter((o) => o.status === "cached").length;
        evidence = `<prefetched_evidence note="Searches already run for the items in memory. Use them first; call web_search only for real gaps.">\n${formatRun(run, searchState.retrievedAt)}\n</prefetched_evidence>`;
        const ms = Math.round(performance.now() - tp);
        searchMs += ms;
        prefetchTrace = { queries: plan.queries.length, sources: run.sources.length, ms };
        spans.push({
          kind: "prefetch",
          label: `Prefetch: ${plural(plan.entities.length, "item", "items")}`,
          startMs: at(tp),
          ms,
          queries: plan.queries.map((q) => q.q),
          cacheHits: run.outcomes.filter((o) => o.status === "cached").length,
        });
        yield { type: "status", id: "prefetch", label: "", state: "end", ms };
        const sources = searchState.registry.all();
        yield { type: "sources", sources: sources.map(toRef) };
        pendingStatus = "reading";
        yield { type: "status", id: "reading", label: `Reading ${sources.length} source${sources.length === 1 ? "" : "s"}…`, state: "start" };
      } catch (err) {
        if (signal.aborted) throw err;
        yield { type: "status", id: "prefetch", label: "", state: "end" };
      }
    }

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...input.history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
      { role: "user", content: withContext(buildTurnContext(now, tz, input.memory?.text, evidence), input.message) },
    ];

    for await (const ev of runLoop(deps.llm, messages, tools ?? noTools, deps.settings, signal)) {
      switch (ev.type) {
        case "thinking":
          if (!pendingStatus && firstTokenMs === null) {
            pendingStatus = "thinking";
            yield { type: "status", id: "thinking", label: "Thinking…", state: "start" };
          }
          break;

        case "text":
          if (pendingStatus) {
            yield { type: "status", id: pendingStatus, label: "", state: "end" };
            pendingStatus = null;
          }
          firstTokenMs ??= Math.round(performance.now() - t0);
          yield { type: "text", delta: ev.delta };
          break;

        case "round":
          spans.push({
            kind: "model",
            label: `Model, round ${ev.round}${ev.toolCalls ? " → search" : ""}`,
            startMs: at(ev.startedAt),
            ms: Math.round(ev.endedAt - ev.startedAt),
            ...(ev.firstTextAt !== null ? { firstTextMs: at(ev.firstTextAt) } : {}),
            usage: ev.usage,
          });
          break;

        case "tools_start":
          searchStartedAt = performance.now();
          searchQueries = tools?.queries(ev.calls) ?? [];
          cacheHitsBefore = searchState.cacheHits;
          pendingStatus = "search";
          yield { type: "status", id: "search", label: tools?.describe(ev.calls) ?? "Working…", state: "start" };
          break;

        case "tools_end": {
          searchMs += ev.ms;
          spans.push({
            kind: "search",
            label: `Search: ${plural(searchQueries.length, "query", "queries")}`,
            startMs: at(searchStartedAt),
            ms: ev.ms,
            queries: searchQueries,
            cacheHits: searchState.cacheHits - cacheHitsBefore,
          });
          const sources = searchState.registry.all();
          yield { type: "status", id: "search", label: "", state: "end", ms: ev.ms };
          yield { type: "sources", sources: sources.map(toRef) };
          pendingStatus = "reading";
          yield {
            type: "status",
            id: "reading",
            label: sources.length ? `Reading ${sources.length} source${sources.length === 1 ? "" : "s"}…` : "Writing the answer…",
            state: "start",
          };
          break;
        }

        case "complete": {
          const validIds = new Set(searchState.registry.all().map((s) => s.id));
          yield {
            type: "done",
            trace: {
              model: deps.settings.model,
              rounds: ev.result.rounds,
              totalMs: Math.round(performance.now() - t0),
              firstTokenMs,
              usage: ev.result.usage,
              costUsd: costUsd(deps.settings.model, ev.result.usage),
              truncated: ev.result.truncated,
              search: {
                queries: searchState.queriesUsed,
                credits: searchState.credits,
                cacheHits: searchState.cacheHits,
                sources: validIds.size,
                ms: searchMs,
              },
              citations: checkCitations(ev.result.finalText, validIds),
              ...(memory ? { memory: { status: memory.status, assumptions: memory.assumptions, refs: memory.refs, ms: memory.ms } } : {}),
              ...(prefetchTrace ? { prefetch: prefetchTrace } : {}),
              spans,
            },
          };
          break;
        }
      }
    }
  } catch (err) {
    if (isAbortError(err) && signal.aborted) return;
    yield toErrorEvent(err);
  }
}

const toRef = (s: SourceRef): SourceRef => ({
  id: s.id,
  url: s.url,
  title: s.title,
  domain: s.domain,
  retrievedAt: s.retrievedAt,
  ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
});

function toErrorEvent(err: unknown): AgentEvent {
  if (err instanceof ProviderError) {
    const message =
      err.status === 401
        ? "The model provider rejected the API key. Check MISTRAL_API_KEY in .env."
        : err.status === 429
          ? "The model provider is rate-limiting us. Please try again in a moment."
          : "The model provider had a problem answering. Please try again.";
    return { type: "error", message, retryable: err.retryable };
  }
  if (isAbortError(err)) return { type: "error", message: "The model took too long to respond.", retryable: true };
  console.error("[runTurn] unexpected error", err);
  return { type: "error", message: "Something went wrong on our side.", retryable: true };
}
