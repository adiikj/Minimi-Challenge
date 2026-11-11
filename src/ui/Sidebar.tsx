"use client";

import type { Session } from "./api";
import { dayKey, dayLabel } from "./format";
import { IconPlus, LogoMark } from "./icons";
import { ProfileSwitcher } from "./ProfileSwitcher";

type Props = {
  session: Session;
  activeThreadId: string | null;
  now: number;
  onNewChat: () => void;
  onOpenThread: (id: string) => void;
  profileActions: Pick<React.ComponentProps<typeof ProfileSwitcher>, "onSwitch" | "onCreate" | "onRename" | "onDelete" | "onLoadDemo">;
};

export function Sidebar({ session, activeThreadId, now, onNewChat, onOpenThread, profileActions }: Props) {
  const groups = groupByDay(session.threads, now);

  return (
    <nav className="flex h-full flex-col bg-sunken" aria-label="Conversations">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <LogoMark />
        <p className="text-[0.95rem] font-semibold tracking-tight text-ink">Minimi</p>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-ink hover:bg-surface"
        >
          <span className="flex size-5 items-center justify-center rounded-full border border-rule">
            <IconPlus className="size-3" />
          </span>
          New conversation
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.length === 0 && (
          <p className="px-3 pt-3 text-sm leading-relaxed text-faint">
            {session.profile.isDemo ? "This demo profile has no conversations yet." : "Your conversations will appear here, grouped by day."}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.key} className="pt-4">
            <h2 className="px-3 pb-1 text-xs text-faint">{g.label}</h2>
            <ul>
              {g.threads.map((t) => {
                const active = t.id === activeThreadId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onOpenThread(t.id)}
                      aria-current={active ? "page" : undefined}
                      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm ${
                        active ? "bg-raised text-ink" : "text-graphite hover:bg-surface hover:text-ink"
                      }`}
                      title={t.needsRecheck ? `${t.title}\nSome facts here may be out of date. Open it to re-check.` : t.title}
                    >
                      <span className="min-w-0 flex-1 truncate first-letter:uppercase">{t.title}</span>
                      {t.needsRecheck && (
                        <>
                          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-graphite" />
                          <span className="sr-only">(may be out of date)</span>
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <div className="border-t border-rule p-2">
        <ProfileSwitcher active={session.profile} profiles={session.profiles} {...profileActions} />
      </div>
    </nav>
  );
}

function groupByDay(threads: Session["threads"], now: number) {
  const groups: Array<{ key: string; label: string; threads: Session["threads"] }> = [];
  for (const t of threads) {
    const ms = Date.parse(t.updatedAt);
    const key = dayKey(ms);
    const last = groups.at(-1);
    if (last?.key === key) last.threads.push(t);
    else groups.push({ key, label: now ? dayLabel(ms, now) : "", threads: [t] });
  }
  return groups;
}
