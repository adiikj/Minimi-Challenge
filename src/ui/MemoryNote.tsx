import type { AssumptionRef, MemoryRef } from "@/core/types";
import { IconClock } from "./icons";

type Props = {
  memory?: { status: "found" | "none-found"; refs: MemoryRef[] };
  assumptions?: AssumptionRef[];
  onPickDate: (label: string) => void;
  onOpenThread: (threadId: string) => void;
  canAct: boolean;
};

export function MemoryNote({ memory, assumptions = [], onPickDate, onOpenThread, canAct }: Props) {
  if (!memory && assumptions.length === 0) return null;
  const shortDate = (d: string) =>
    new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(Date.parse(`${d}T00:00:00Z`));

  return (
    <div className="mb-4 flex gap-2.5 rounded-2xl border border-rule bg-surface px-4 py-3 text-[0.85rem] leading-snug text-graphite">
      <span className="mt-[0.1rem] shrink-0 text-faint">
        <IconClock />
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        {assumptions.map((a) => (
          <p key={a.phrase} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span>
              Read “{a.phrase}” as <span className="font-medium text-ink">{a.chosen}</span>.
            </span>
            {a.alternatives.map((alt) => (
              <button
                key={alt.label}
                type="button"
                disabled={!canAct}
                onClick={() => onPickDate(alt.label)}
                className="rounded-md border border-rule px-2 py-0.5 text-xs text-ink hover:bg-raised disabled:opacity-50"
                title={alt.hasConversations ? undefined : "There are no conversations on that day"}
              >
                Use {alt.label}
                {!alt.hasConversations && <span className="text-faint"> (no chats)</span>}
              </button>
            ))}
          </p>
        ))}

        {memory?.status === "found" &&
          memory.refs.map((r) => (
            <p key={`${r.threadId}-${r.localDate}`}>
              From your conversation on {shortDate(r.localDate)}:{" "}
              <button type="button" onClick={() => onOpenThread(r.threadId)} className="text-ink underline decoration-faint underline-offset-4 hover:decoration-ink">
                {r.title}
              </button>
            </p>
          ))}
        {memory?.status === "none-found" && <p>No past conversation matched, so nothing was recalled.</p>}
      </div>
    </div>
  );
}
