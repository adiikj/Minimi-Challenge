import { formatMemory } from "@/context/memory-pack";
import { planPrefetch, type PrefetchPlan } from "@/context/prefetch";
import { recall, recallAnswer, type MemoryResult } from "@/context/recall";
import type { AgentEvent, UserScope } from "@/core/types";
import { stripCitations } from "@/lib/citations";
import { localDate, safeTimeZone } from "@/lib/time";
import type { MessageStatus, Repo } from "@/memory/repo";
import { SourceRegistry } from "@/search/service";
import type { MemoryWriter } from "./memory-writer";
import { runTurn, type TurnDeps, type TurnMemory } from "./orchestrator";

export type ChatTurnInput = {
  scope: UserScope;
  threadId?: string;
  message: string;
  clientTz: string;
  recheckOf?: string;
};
export type ChatDeps = TurnDeps & {
  repo: Repo;
  writer?: MemoryWriter;
  spendLimitUsd?: number;
  memory?: MemoryOptions;
};

export type MemoryOptions = {
  enabled?: boolean;
  dates?: boolean;
  facts?: boolean;
};

const HISTORY_MESSAGES = 20;

export async function* runChatTurn(input: ChatTurnInput, deps: ChatDeps, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const startedAt = performance.now();
  const { repo } = deps;
  const { scope } = input;
  const tz = safeTimeZone(input.clientTz);
  repo.setTimeZone(scope, tz);

  if (deps.spendLimitUsd && repo.totalSpend() >= deps.spendLimitUsd) {
    yield {
      type: "error",
      message: `This install has reached its model budget (${deps.spendLimitUsd.toFixed(2)}, SPEND_LIMIT_USD in .env). Raise the limit to keep chatting.`,
      retryable: false,
    };
    return;
  }

  let thread = input.threadId ? repo.getThread(scope, input.threadId) : undefined;
  if (input.threadId && !thread) {
    yield { type: "error", message: "That conversation doesn't exist anymore. Start a new chat.", retryable: false };
    return;
  }
  const isNew = !thread;
  thread ??= repo.createThread(scope, titleFrom(input.message));

  const recallInput = { scope, message: input.message, now: deps.clock.now(), tz, currentThreadId: thread.id };
  let memory: ReturnType<typeof buildMemory>;
  if (input.recheckOf) {
    const t0 = performance.now();
    const result = recallAnswer(repo, { scope, threadId: thread.id, answerId: input.recheckOf });
    if (!result) {
      yield { type: "error", message: "That answer can't be found anymore, so it can't be re-checked.", retryable: false };
      return;
    }
    memory = packMemory(result, recallInput, t0);
  } else {
    memory = buildMemory(repo, recallInput, deps.memory);
  }
  const history = isNew ? [] : repo.recentHistory(scope, thread.id, HISTORY_MESSAGES).map((m) => ({ ...m, content: stripCitations(m.content) }));
  const question = repo.addMessage(scope, { threadId: thread.id, role: "user", content: input.message, tz, createdAt: deps.clock.now().toISOString() });
  yield { type: "thread", thread: { id: thread.id, title: thread.title, isNew }, userMessageId: question.id };

  const registry = new SourceRegistry();
  let text = "";
  let saved = false;

  const save = (status: MessageStatus, trace?: Extract<AgentEvent, { type: "done" }>["trace"]) => {
    if (saved) return undefined;
    saved = true;
    const answer = repo.addMessage(scope, { threadId: thread.id, role: "assistant", content: text, status, tz, createdAt: deps.clock.now().toISOString() });
    const evidence = registry.all();
    if (evidence.length) repo.saveSources(scope, answer.id, evidence);
    if (trace) repo.saveTrace(scope, answer.id, trace);
    return answer.id;
  };

  try {
    for await (const ev of runTurn({ scope, message: input.message, history, clientTz: tz, registry, memory, prefetch: memory.prefetch, startedAt }, deps, signal)) {
      if (ev.type === "text") text += ev.delta;
      if (ev.type === "done") {
        const messageId = save("done", ev.trace);
        yield { ...ev, messageId };
        if (messageId && deps.writer) {
          const related = repo
            .claimsForMessages(scope, [...memory.answerIds, ...repo.messageIds(scope, thread.id, "assistant")])
            .filter((c) => !c.supersededBy && c.messageId !== messageId);
          deps.writer.enqueue({
            scope,
            threadId: thread.id,
            messageId,
            question: input.message,
            answer: text,
            observedAt: localDate(deps.clock.now(), tz),
            sources: registry.all(),
            existing: related,
            wantTitle: isNew,
          });
        }
        continue;
      }
      if (ev.type === "error") save("error");
      yield ev;
    }
  } finally {
    save("stopped");
  }
}

export function buildMemory(
  repo: Repo,
  input: Parameters<typeof recall>[1],
  opts: MemoryOptions = {},
): TurnMemory & { answerIds: string[]; prefetch: PrefetchPlan | null } {
  if (opts.enabled === false) return { status: "not-needed", text: null, assumptions: [], refs: [], ms: 0, answerIds: [], prefetch: null };
  const t0 = performance.now();
  const result = recall(repo, input, { dates: opts.dates !== false });
  if (opts.facts === false) {
    for (const e of result.exchanges) {
      e.facts = [];
      e.entities = [];
    }
  }
  return packMemory(result, input, t0);
}

function packMemory(
  result: MemoryResult,
  input: { now: Date; tz: string },
  t0: number,
): TurnMemory & { answerIds: string[]; prefetch: PrefetchPlan | null } {
  const year = Number(localDate(input.now, input.tz).slice(0, 4));
  const seen = new Set<string>();
  const refs = result.exchanges
    .filter((e) => !seen.has(`${e.threadId}|${e.localDate}`) && seen.add(`${e.threadId}|${e.localDate}`))
    .map((e) => ({ threadId: e.threadId, title: e.threadTitle, localDate: e.localDate }));
  return {
    status: result.status,
    answerIds: result.exchanges.map((e) => e.answerId).filter((id): id is string => !!id),
    prefetch: planPrefetch(result),
    text: formatMemory(result, year),
    assumptions: result.assumptions,
    refs,
    ms: Math.round(performance.now() - t0),
  };
}

export function titleFrom(message: string): string {
  const line = message.trim().split("\n")[0]!.replace(/\s+/g, " ");
  if (line.length <= 60) return line || "New chat";
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}
