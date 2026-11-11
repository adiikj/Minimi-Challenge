"use client";

import { useCallback, useRef, useState } from "react";
import type { Freshness } from "@/context/freshness";
import type { AgentEvent, AssumptionRef, MemoryRef, SourceRef, TurnTrace } from "@/core/types";
import { parseSSE } from "@/lib/sse";

export type UIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  state: "streaming" | "done" | "stopped" | "error";
  status?: string | null;
  error?: { message: string; retryable: boolean };
  trace?: TurnTrace;
  sources?: SourceRef[];
  assumptions?: AssumptionRef[];
  memory?: { status: "found" | "none-found"; refs: MemoryRef[] };
  freshness?: Freshness;
};

export type ThreadEvent = Extract<AgentEvent, { type: "thread" }>["thread"];

type Options = {
  threadId: string | null;
  initialMessages: UIMessage[];
  onThread?: (thread: ThreadEvent) => void;
  onAnswered?: (threadId: string) => void;
};

const newId = () => crypto.randomUUID();

export function useChat({ threadId, initialMessages, onThread, onAnswered }: Options) {
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const threadRef = useRef(threadId);
  const callbacks = useRef({ onThread, onAnswered });
  callbacks.current = { onThread, onAnswered };

  const patch = (id: string, change: Partial<UIMessage> | ((m: UIMessage) => Partial<UIMessage>)) =>
    setMessages((all) => all.map((m) => (m.id === id ? { ...m, ...(typeof change === "function" ? change(m) : change) } : m)));

  const send = useCallback(async (text: string, base?: UIMessage[], opts: { recheckOf?: string } = {}) => {
    const prior = base ?? messagesRef.current;
    const user: UIMessage = { id: newId(), role: "user", content: text, createdAt: Date.now(), state: "done" };
    const reply: UIMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now(), state: "streaming", status: "Working on it…" };
    setMessages([...prior, user, reply]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(threadRef.current ? { threadId: threadRef.current } : {}),
          message: text,
          clientTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(opts.recheckOf ? { recheckOf: opts.recheckOf } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The server answered with HTTP ${res.status}.`);
      }
      for await (const data of parseSSE(res.body)) {
        const ev = JSON.parse(data) as AgentEvent;
        switch (ev.type) {
          case "thread":
            threadRef.current = ev.thread.id;
            callbacks.current.onThread?.(ev.thread);
            break;
          case "status":
            patch(reply.id, { status: ev.state === "start" ? ev.label : null });
            break;
          case "assumption":
            patch(reply.id, (m) => ({ assumptions: [...(m.assumptions ?? []), ev.assumption] }));
            break;
          case "memory":
            patch(reply.id, { memory: { status: ev.status, refs: ev.refs } });
            break;
          case "sources":
            patch(reply.id, { sources: ev.sources });
            break;
          case "text":
            patch(reply.id, (m) => ({ content: m.content + ev.delta, status: null }));
            break;
          case "done":
            patch(reply.id, { state: "done", status: null, trace: ev.trace });
            if (threadRef.current) callbacks.current.onAnswered?.(threadRef.current);
            break;
          case "error":
            patch(reply.id, { state: "error", status: null, error: { message: ev.message, retryable: ev.retryable } });
            break;
        }
      }
      patch(reply.id, (m) => (m.state === "streaming" ? { state: "error", status: null, error: { message: "The connection closed before the answer finished.", retryable: true } } : {}));
    } catch (err) {
      if (controller.signal.aborted) {
        patch(reply.id, { state: "stopped", status: null });
      } else {
        patch(reply.id, { state: "error", status: null, error: { message: err instanceof Error ? err.message : String(err), retryable: true } });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const retry = useCallback(
    (assistantId: string) => {
      const all = messagesRef.current;
      const i = all.findIndex((m) => m.id === assistantId);
      const question = all[i - 1];
      if (i < 1 || question?.role !== "user") return;
      void send(question.content, all.slice(0, i - 1));
    },
    [send],
  );

  const applyFreshness = useCallback((byId: Map<string, Freshness | null>) => {
    setMessages((all) =>
      all.map((m) => {
        if (!byId.has(m.id)) return m;
        const f = byId.get(m.id);
        const { freshness: _old, ...rest } = m;
        return f ? { ...rest, freshness: f } : rest;
      }),
    );
  }, []);

  return { messages, busy, send, stop, retry, applyFreshness };
}
