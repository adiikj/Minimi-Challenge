"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, toUIMessages, type Session } from "./api";
import { Chat, useNow } from "./Chat";
import { Sidebar } from "./Sidebar";
import type { ThreadEvent, UIMessage } from "./useChat";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [today, setToday] = useState("");
  const [chatKey, setChatKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const now = useNow();

  useEffect(() => {
    api.session().then(setSession, (err: Error) => setLoadError(err.message));
  }, []);

  const startChat = useCallback((threadId: string | null, messages: UIMessage[], day = "") => {
    setActiveThreadId(threadId);
    setToday(day);
    setInitialMessages(messages);
    setChatKey((k) => k + 1);
    setDrawerOpen(false);
  }, []);

  const openThread = useCallback(
    async (id: string) => {
      try {
        const { messages, today: day } = await api.thread(id);
        startChat(id, toUIMessages(messages), day);
      } catch {
        setSession(await api.session());
      }
    },
    [startChat],
  );

  const onThread = useCallback((t: ThreadEvent) => {
    setActiveThreadId(t.id);
    setSession((s) => {
      if (!s) return s;
      const existing = s.threads.find((x) => x.id === t.id);
      const updated = { ...(existing ?? { id: t.id, title: t.title, createdAt: new Date().toISOString() }), updatedAt: new Date().toISOString() };
      return { ...s, threads: [updated, ...s.threads.filter((x) => x.id !== t.id)] };
    });
  }, []);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onAnswered = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      api.session().then(
        (s) => setSession((prev) => (prev && prev.profile.id === s.profile.id ? s : prev)),
        () => {},
      );
    }, 12_000);
  }, []);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const applySession = useCallback(
    (next: Session) => {
      setSession(next);
      startChat(null, []);
    },
    [startChat],
  );

  if (loadError) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-xl font-semibold text-ink">Minimi couldn’t start</h1>
        <p className="mt-3 whitespace-pre-wrap rounded-xl border border-rule bg-surface p-4 text-[0.9rem] text-graphite">{loadError}</p>
      </main>
    );
  }
  if (!session) return <main className="h-dvh bg-paper" aria-busy="true" />;

  const loadDemo = async () => applySession(await api.loadDemo());
  const sidebar = (
    <Sidebar
      session={session}
      activeThreadId={activeThreadId}
      now={now}
      onNewChat={() => startChat(null, [])}
      onOpenThread={(id) => void openThread(id)}
      profileActions={{
        onSwitch: async (id) => applySession(await api.switchProfile(id)),
        onCreate: async (name) => applySession(await api.createProfile(name)),
        onRename: async (id, name) => setSession(await api.renameProfile(id, name)),
        onDelete: async (id) => applySession(await api.deleteProfile(id)),
        onLoadDemo: loadDemo,
      }}
    />
  );
  const title = session.threads.find((t) => t.id === activeThreadId)?.title ?? null;
  const offerDemo = session.threads.length === 0 && !session.profile.isDemo;

  return (
    <div className="flex h-dvh bg-paper text-ink">
      <aside className="hidden w-68 shrink-0 border-r border-rule md:block">{sidebar}</aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Conversations">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <aside className="relative h-full w-[85%] max-w-xs border-r border-rule">{sidebar}</aside>
        </div>
      )}

      <Chat
        key={chatKey}
        threadId={activeThreadId}
        title={title}
        initialMessages={initialMessages}
        now={now}
        today={today}
        onThread={onThread}
        onAnswered={onAnswered}
        onOpenMenu={() => setDrawerOpen(true)}
        onOpenThread={(id) => void openThread(id)}
        {...(offerDemo ? { onLoadDemo: () => void loadDemo() } : {})}
      />
    </div>
  );
}
