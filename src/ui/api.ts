import type { Freshness } from "@/context/freshness";
import type { SourceRef, TurnTrace } from "@/core/types";
import type { StoredMessage, ThreadSummary } from "@/memory/repo";
import type { UIMessage } from "./useChat";

export type ProfileSummary = { id: string; name: string; isDemo: boolean };
export type Session = {
  profile: ProfileSummary & { tz: string };
  profiles: ProfileSummary[];
  threads: Array<ThreadSummary & { needsRecheck?: boolean }>;
};

export type ThreadPayload = {
  thread: ThreadSummary;
  messages: Array<Omit<StoredMessage, "sources"> & { sources: SourceRef[]; freshness: Freshness | null }>;
  today: string;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  return body;
}

export const api = {
  session: () => call<Session>("/api/session"),
  thread: (id: string) => call<ThreadPayload>(`/api/threads/${id}`),
  deleteThread: (id: string) => call<{ ok: true }>(`/api/threads/${id}`, { method: "DELETE" }),
  createProfile: (name: string) => call<Session>("/api/profiles", { method: "POST", body: JSON.stringify({ name }) }),
  switchProfile: (profileId: string) => call<Session>("/api/profiles/active", { method: "POST", body: JSON.stringify({ profileId }) }),
  renameProfile: (id: string, name: string) => call<Session>(`/api/profiles/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteProfile: (id: string) => call<Session>(`/api/profiles/${id}`, { method: "DELETE" }),
  loadDemo: () => call<Session>("/api/demo", { method: "POST" }),
};

export function toUIMessages(messages: ThreadPayload["messages"]): UIMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: Date.parse(m.createdAt),
    state: m.status,
    ...(m.sources.length ? { sources: m.sources } : {}),
    ...(m.freshness ? { freshness: m.freshness } : {}),
    ...(m.trace ? { trace: m.trace as TurnTrace } : {}),
    ...(m.trace?.memory
      ? { assumptions: m.trace.memory.assumptions, memory: { status: m.trace.memory.status, refs: m.trace.memory.refs } }
      : {}),
    ...(m.status === "error" ? { error: { message: "This answer didn't finish.", retryable: true } } : {}),
  }));
}
