import type { AssumptionRef, UserScope } from "@/core/types";
import { findCitations } from "@/lib/citations";
import { rangeLabel, type LocalDateRange, type Ymd } from "@/lib/dates";
import { localDate } from "@/lib/time";
import type { Repo, StoredClaim, StoredMessage, StoredSource } from "@/memory/repo";
import { detectIntent, type Intent } from "./intent";
import { resolveTemporal, type TemporalRef } from "./temporal";

export type RecalledExchange = {
  threadId: string;
  threadTitle: string;
  localDate: Ymd;
  question: string;
  answer: string | null;
  answerStatus: StoredMessage["status"] | null;
  sources: StoredSource[];
  answerId: string | null;
  facts: StoredClaim[];
  entities: Array<{ name: string; domain: string | null }>;
};

export type Assumption = AssumptionRef;

export type MemoryResult = {
  status: "not-needed" | "found" | "none-found";
  intent: Intent;
  refs: TemporalRef[];
  resolved: Array<{ phrase: string; range: LocalDateRange; label: string; role: TemporalRef["role"] }>;
  assumptions: Assumption[];
  exchanges: RecalledExchange[];
  index: ReturnType<Repo["threadIndex"]>;
  nearest?: { searched: string; before?: { localDate: Ymd; title: string }; after?: { localDate: Ymd; title: string } };
  sinceDate?: Ymd;
};

const MAX_EXCHANGES = 6;
const MAX_THREADS_LOADED = 8;
const STOPWORDS = new Set(
  "a an and any are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our since so than that the their them then there these they this to was we were what when which who why will with would you your yes no about ask asked tell told said say still correct today now any anything something changed change shipped big".split(" "),
);

export function recall(
  repo: Repo,
  input: { scope: UserScope; message: string; now: Date; tz: string; currentThreadId?: string },
  opts: { dates?: boolean } = {},
): MemoryResult {
  const { scope, message, now, tz } = input;
  const exclude = input.currentThreadId ?? "";
  const intent = detectIntent(message);
  const refs = opts.dates === false ? [] : resolveTemporal(message, now, tz);
  const year = Number(localDate(now, tz).slice(0, 4));
  const index = repo.threadIndex(scope, 8, exclude);

  const base = { intent, refs, index, assumptions: [] as Assumption[], resolved: [] as MemoryResult["resolved"], exchanges: [] as RecalledExchange[] };
  if (!intent.memoryCue && refs.length === 0) return { ...base, status: "not-needed" };

  for (const ref of refs) {
    const active = ref.candidates.map((c) => repo.threadsInRange(scope, c.start, c.end, exclude).length > 0);
    let chosen = ref.chosen;
    if (!active[chosen] && active.some(Boolean)) chosen = active.findIndex(Boolean);
    const use = active.filter(Boolean).length > 1 ? ref.candidates.map((_, i) => i).filter((i) => active[i]) : [chosen];
    for (const i of use) base.resolved.push({ phrase: ref.phrase, range: ref.candidates[i]!, label: rangeLabel(ref.candidates[i]!, year), role: ref.role });
    if (ref.candidates.length > 1) {
      base.assumptions.push({
        phrase: ref.phrase,
        chosen: use.map((i) => ref.labels[i]!).join(" and "),
        alternatives: ref.candidates.map((_, i) => i).filter((i) => !use.includes(i)).map((i) => ({ label: ref.labels[i]!, hasConversations: !!active[i] })),
      });
    }
  }

  const keywords = topicWords(message, refs);
  const anchors = base.resolved.filter((r) => r.role === "anchor");
  const windows = anchors.length ? anchors : base.resolved;
  let hits: Array<{ threadId: string; localDate: Ymd; messageId?: string }> = [];

  if (windows.length) {
    for (const w of windows) {
      const threads = repo.threadsInRange(scope, w.range.start, w.range.end, exclude);
      const byTopic = keywords ? repo.searchMessages(scope, keywords, { start: w.range.start, end: w.range.end, excludeThreadId: exclude }) : [];
      const ordered = [...new Set([...byTopic.map((h) => h.threadId), ...threads])];
      hits.push(...ordered.map((threadId) => ({ threadId, localDate: w.range.start })));
    }
  } else if (keywords) {
    hits = repo.searchMessages(scope, keywords, { excludeThreadId: exclude, limit: 10 }).map((h) => ({ threadId: h.threadId, localDate: h.localDate, messageId: h.id }));
  }

  const threadIds = [...new Set(hits.map((h) => h.threadId))].slice(0, MAX_THREADS_LOADED);
  const titles = new Map(index.map((t) => [t.threadId, t.title]));
  const inWindow = (d: Ymd) => !windows.length || windows.some((w) => d >= w.range.start && d <= w.range.end);
  const hitIds = new Set(hits.map((h) => h.messageId).filter(Boolean));

  for (const threadId of threadIds) {
    const thread = repo.getThread(scope, threadId);
    const messages = repo.listMessages(scope, threadId);
    for (let i = 0; i < messages.length; i++) {
      const q = messages[i]!;
      if (q.role !== "user" || !inWindow(q.localDate)) continue;
      const a = messages[i + 1]?.role === "assistant" ? messages[i + 1]! : undefined;
      if (hitIds.size && !windows.length && !hitIds.has(q.id) && !(a && hitIds.has(a.id))) continue;
      const cited = new Set(a ? findCitations(a.content) : []);
      base.exchanges.push({
        threadId,
        threadTitle: thread?.title ?? titles.get(threadId) ?? "",
        localDate: q.localDate,
        question: q.content,
        answer: a ? a.content : null,
        answerStatus: a ? a.status : null,
        answerId: a ? a.id : null,
        facts: [],
        entities: [],
        sources: a ? a.sources.filter((s) => cited.has(s.id)) : [],
      });
    }
  }
  base.exchanges = base.exchanges.slice(0, MAX_EXCHANGES);

  const answerIds = base.exchanges.map((e) => e.answerId).filter((id): id is string => !!id);
  const facts = repo.claimsForMessages(scope, answerIds);
  const entities = repo.entitiesForMessages(scope, answerIds);
  for (const e of base.exchanges) {
    e.facts = facts.filter((f) => f.messageId === e.answerId);
    e.entities = entities.filter((x) => x.messageId === e.answerId).map(({ name, domain }) => ({ name, domain }));
  }

  const sinceRef = base.resolved.find((r) => r.role === "since");
  const sinceDate = sinceRef?.range.start ?? (intent.changeCheck || intent.sinceThen ? base.exchanges.map((e) => e.localDate).sort()[0] : undefined);

  if (base.exchanges.length === 0) {
    const first = base.resolved[0] ?? (refs[0] ? { range: refs[0].candidates[refs[0].chosen]!, label: refs[0].labels[refs[0].chosen]! } : undefined);
    return {
      ...base,
      status: "none-found",
      ...(first ? { nearest: { searched: first.label, ...repo.nearestActiveDays(scope, first.range.start, exclude) } } : {}),
    };
  }
  return { ...base, status: "found", ...(sinceDate ? { sinceDate } : {}) };
}

export function topicWords(message: string, refs: TemporalRef[]): string {
  let text = message;
  for (const r of refs) text = text.replace(r.phrase, " ");
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
  return [...new Set(words)].join(" ");
}

export function recallAnswer(repo: Repo, input: { scope: UserScope; threadId: string; answerId: string }): MemoryResult | null {
  const { scope, threadId, answerId } = input;
  const messages = repo.listMessages(scope, threadId);
  const i = messages.findIndex((m) => m.id === answerId && m.role === "assistant");
  if (i < 0) return null;
  const a = messages[i]!;
  const q = messages[i - 1]?.role === "user" ? messages[i - 1] : undefined;
  const cited = new Set(findCitations(a.content));
  const exchange: RecalledExchange = {
    threadId,
    threadTitle: repo.getThread(scope, threadId)?.title ?? "",
    localDate: q?.localDate ?? a.localDate,
    question: q?.content ?? "",
    answer: a.content,
    answerStatus: a.status,
    answerId: a.id,
    sources: a.sources.filter((s) => cited.has(s.id)),
    facts: repo.claimsForMessages(scope, [a.id]),
    entities: repo.entitiesForMessages(scope, [a.id]).map(({ name, domain }) => ({ name, domain })),
  };
  return {
    status: "found",
    intent: { memoryCue: true, changeCheck: true, sinceThen: true },
    refs: [],
    resolved: [],
    assumptions: [],
    exchanges: [exchange],
    index: [],
    sinceDate: a.localDate,
  };
}
