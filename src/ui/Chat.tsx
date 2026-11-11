"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { Freshness } from "@/context/freshness";
import { stripCitations } from "@/lib/citations";
import { api } from "./api";
import { Composer } from "./Composer";
import { chapterLabel, dayKey, dollars, seconds, timeOfDay } from "./format";
import { FreshnessNote } from "./FreshnessNote";
import { IconCheck, IconClock, IconCopy, IconGlobe, IconMenu, IconTimeline } from "./icons";
import { Markdown } from "./Markdown";
import { MemoryNote } from "./MemoryNote";
import { SourceList } from "./SourceList";
import { TracePanel } from "./TracePanel";
import { useChat, type ThreadEvent, type UIMessage } from "./useChat";

const LEDGER_REFRESH_MS = [5_000, 12_000];

type Example = { q: string; uses: "web" | "memory" };
const EXAMPLES: Example[] = [
  { q: "What's new in Postgres 18, and is it worth upgrading?", uses: "web" },
  { q: "Compare Neon and Supabase pricing for a small side project.", uses: "web" },
  { q: "What did I ask you on 3 November? Is your answer still correct today?", uses: "memory" },
  { q: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", uses: "memory" },
];

const COLUMN = "mx-auto w-full max-w-3xl xl:max-w-[52rem] 2xl:max-w-[56rem]";

type Props = {
  threadId: string | null;
  title: string | null;
  initialMessages: UIMessage[];
  now: number;
  today: string;
  onThread: (thread: ThreadEvent) => void;
  onAnswered?: () => void;
  onOpenMenu: () => void;
  onOpenThread: (threadId: string) => void;
  onLoadDemo?: () => void;
};

export function Chat({ threadId, title, initialMessages, now, today, onThread, onAnswered, onOpenMenu, onOpenThread, onLoadDemo }: Props) {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const applyRef = useRef<(byId: Map<string, Freshness | null>) => void>(() => {});
  const [day, setDay] = useState(today);

  const handleAnswered = useCallback(
    (id: string) => {
      onAnswered?.();
      for (const ms of LEDGER_REFRESH_MS) {
        timers.current.push(
          setTimeout(() => {
            api.thread(id).then(
              ({ messages: stored, today: serverToday }) => {
                setDay(serverToday);
                applyRef.current(new Map(stored.filter((m) => m.role === "assistant").map((m) => [m.id, m.freshness])));
              },
              () => {},
            );
          }, ms),
        );
      }
    },
    [onAnswered],
  );
  const { messages, busy, send, stop, retry, applyFreshness } = useChat({ threadId, initialMessages, onThread, onAnswered: handleAnswered });
  applyRef.current = applyFreshness;
  const endRef = useRef<HTMLDivElement>(null);
  const empty = messages.length === 0;

  const last = messages.at(-1);
  const lastLength = last?.content.length ?? 0;
  const lastState = last?.state;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastLength, lastState]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenMenu}
            className="-ml-1.5 rounded-lg p-1.5 text-graphite hover:bg-surface hover:text-ink md:hidden"
            aria-label="Show conversations"
          >
            <IconMenu />
          </button>
          {!empty && <h1 className="truncate text-sm text-graphite first-letter:uppercase">{title ?? "New conversation"}</h1>}
        </div>
        <NowStamp now={now} />
      </header>

      {empty ? (
        <main className="flex flex-1 flex-col overflow-y-auto px-4 sm:px-6">
          <div className={`${COLUMN} my-auto py-10`}>
            <Welcome />
            <div className="mt-8">
              <Composer hero busy={busy} onSend={(t) => void send(t)} onStop={stop} />
            </div>
            <Examples onPick={(q) => void send(q)} />
            {onLoadDemo && (
              <p className="mt-6 text-center text-sm text-graphite">
                No history on this profile yet, so the memory questions will find nothing.{" "}
                <button type="button" onClick={onLoadDemo} className="font-medium text-ink underline decoration-faint underline-offset-4 hover:decoration-ink">
                  Load the demo history
                </button>
              </p>
            )}
          </div>
        </main>
      ) : (
        <>
          <main className="flex-1 overflow-y-auto px-4 sm:px-6" aria-live="polite">
            <div className={`${COLUMN} pb-10 pt-4`}>
              <ol>
                {messages.map((m, i) => {
                  const newDay = i === 0 || dayKey(m.createdAt) !== dayKey(messages[i - 1]!.createdAt);
                  return (
                    <Fragment key={m.id}>
                      {newDay && <DaySeparator ms={m.createdAt} now={now} />}
                      {m.role === "user" ? (
                        <UserMessage message={m} />
                      ) : (
                        <AssistantMessage
                          message={m}
                          today={day}
                          canAct={!busy}
                          onRetry={() => retry(m.id)}
                          onRecheck={() => void send(`Re-check your answer from ${answerDate(m.createdAt)}: is it still correct today?`, undefined, { recheckOf: m.id })}
                          memoryNote={
                            <MemoryNote
                              {...(m.memory ? { memory: m.memory } : {})}
                              {...(m.assumptions ? { assumptions: m.assumptions } : {})}
                              canAct={!busy}
                              onPickDate={(label) => void send(`I meant ${label}.`)}
                              onOpenThread={onOpenThread}
                            />
                          }
                        />
                      )}
                    </Fragment>
                  );
                })}
              </ol>
              <div ref={endRef} />
            </div>
          </main>

          <footer className="relative shrink-0 px-4 pb-4 sm:px-6">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-paper to-transparent" />
            <div className={COLUMN}>
              <Composer busy={busy} onSend={(t) => void send(t)} onStop={stop} />
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

function UserMessage({ message: m }: { message: UIMessage }) {
  return (
    <li className="mt-12 flex justify-end first:mt-0">
      <p
        className="max-w-[85%] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-raised px-4 py-2.5 text-[0.97rem] leading-relaxed text-ink"
        title={`Asked at ${timeOfDay(m.createdAt)}`}
      >
        {m.content}
      </p>
    </li>
  );
}

type AssistantProps = {
  message: UIMessage;
  today: string;
  canAct: boolean;
  onRetry: () => void;
  onRecheck: () => void;
  memoryNote: React.ReactNode;
};

function AssistantMessage({ message: m, today, canAct, onRetry, onRecheck, memoryNote }: AssistantProps) {
  const [traceOpen, setTraceOpen] = useState(false);
  return (
    <li className="mt-5 min-w-0">
      {memoryNote}
      {m.content && <Markdown text={m.content} sources={m.sources} />}
      {m.status && <StatusLine label={m.status} />}
      {m.state !== "streaming" && m.sources && <SourceList sources={m.sources} answer={m.content} />}
      {m.state === "stopped" && <p className="mt-3 text-sm text-graphite">Stopped. What's above was saved.</p>}
      {m.state === "error" && m.error && (
        <div className="mt-3 flex flex-wrap items-baseline gap-3 rounded-2xl border border-rule bg-surface px-4 py-2.5 text-sm">
          <span className="text-alert">{m.error.message}</span>
          {m.error.retryable && (
            <button type="button" onClick={onRetry} className="font-medium text-ink underline decoration-faint underline-offset-4 hover:decoration-ink">
              Try again
            </button>
          )}
        </div>
      )}
      {m.state === "done" && m.freshness && <FreshnessNote freshness={m.freshness} today={today} canAct={canAct} onRecheck={onRecheck} />}
      {(m.state === "done" || m.state === "stopped") && m.content && (
        <Actions message={m} traceOpen={traceOpen} onToggleTrace={m.trace ? () => setTraceOpen((o) => !o) : undefined} />
      )}
      {traceOpen && m.trace && <TracePanel trace={m.trace} />}
    </li>
  );
}

function Actions({ message: m, traceOpen, onToggleTrace }: { message: UIMessage; traceOpen: boolean; onToggleTrace: (() => void) | undefined }) {
  const [copied, setCopied] = useState(false);
  const parts = [timeOfDay(m.createdAt)];
  if (m.trace) {
    parts.push(seconds(m.trace.totalMs));
    if (m.trace.search.queries > 0) {
      parts.push(`${m.trace.search.queries} search${m.trace.search.queries === 1 ? "" : "es"}${m.trace.search.cacheHits ? ` (${m.trace.search.cacheHits} cached)` : ""}`);
    }
    parts.push(dollars(m.trace.costUsd));
    if (m.trace.truncated) parts.push("answer cut short");
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stripCitations(m.content));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs text-faint">
      <button
        type="button"
        onClick={() => void copy()}
        className="-ml-1.5 rounded-md p-1.5 hover:bg-surface hover:text-ink"
        aria-label={copied ? "Copied" : "Copy answer"}
        title={copied ? "Copied" : "Copy answer"}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      {onToggleTrace && (
        <button
          type="button"
          onClick={onToggleTrace}
          aria-expanded={traceOpen}
          className={`rounded-md p-1.5 hover:bg-surface hover:text-ink ${traceOpen ? "bg-surface text-ink" : ""}`}
          aria-label={traceOpen ? "Hide how this answer was made" : "Show how this answer was made"}
          title="How this answer was made"
        >
          <IconTimeline />
        </button>
      )}
      <span className="tabular">{parts.join(", ")}</span>
    </div>
  );
}

const answerDate = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(ms);

function StatusLine({ label }: { label: string }) {
  return (
    <p className="mt-1 text-sm" role="status">
      <span className="shimmer">{label}</span>
    </p>
  );
}

function DaySeparator({ ms, now }: { ms: number; now: number }) {
  const { date, relative } = chapterLabel(ms, now);
  return (
    <li className="mt-12 flex items-center gap-3 first:mt-0 [&+li]:mt-6" aria-label={date}>
      <span aria-hidden className="h-px flex-1 bg-rule" />
      <span className="text-xs text-faint">
        {relative ? <span className="text-graphite">{relative}, </span> : null}
        {date}
      </span>
      <span aria-hidden className="h-px flex-1 bg-rule" />
    </li>
  );
}

function Welcome() {
  return (
    <div className="text-center">
      <h2 className="text-[1.75rem] font-semibold tracking-tight text-ink sm:text-[2rem]">What do you want to find out?</h2>
      <p className="mx-auto mt-3 max-w-[54ch] text-[0.95rem] leading-relaxed text-graphite">
        I search the web for anything current and cite every source. I also remember our conversations, so you can ask later
        what changed.
      </p>
    </div>
  );
}

function Examples({ onPick }: { onPick: (q: string) => void }) {
  return (
    <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
      {EXAMPLES.map(({ q, uses }) => (
        <li key={q}>
          <button
            type="button"
            onClick={() => onPick(q)}
            className="flex h-full w-full flex-col gap-2 rounded-2xl border border-rule p-3.5 text-left hover:border-[#3d3d3d] hover:bg-surface"
          >
            <span className="flex items-center gap-1.5 text-xs text-faint">
              {uses === "web" ? <IconGlobe /> : <IconClock />}
              {uses === "web" ? "Searches the web" : "Uses memory"}
            </span>
            <span className="text-sm leading-snug text-prose">{q}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NowStamp({ now }: { now: number }) {
  if (now === 0) return <span aria-hidden className="text-xs">&nbsp;</span>;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const label = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(now);
  return (
    <p className="flex shrink-0 items-center gap-1.5 rounded-full border border-rule px-2.5 py-1 text-xs text-graphite" title={`Your time zone: ${tz}`}>
      <IconClock />
      <span className="tabular">{label}</span>
    </p>
  );
}

export function useNow(): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
