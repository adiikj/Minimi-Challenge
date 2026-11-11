import type { Freshness } from "@/context/freshness";
import { IconAlert, IconClock, IconRefresh } from "./icons";

type Props = {
  freshness: Freshness;
  today: string;
  canAct: boolean;
  onRecheck: () => void;
};

export const shortYmd = (d: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(Date.parse(`${d}T00:00:00Z`));

const daysSince = (d: string, today: string) => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000));
const ago = (days: number) => (days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`);

export function FreshnessNote({ freshness: f, today, canAct, onRecheck }: Props) {
  if (f.level === "fresh" && f.checkedOn === today) return null;

  let icon = <IconClock />;
  let text: React.ReactNode;
  if (f.level === "changed") {
    icon = <IconAlert />;
    text = (
      <>
        <span className="text-ink">
          {f.changed === f.facts ? (f.facts === 1 ? "The fact" : `All ${f.facts} facts`) : `${f.changed} of ${f.facts} facts`} here{" "}
          {f.changed === 1 ? "was" : "were"} found to have changed
        </span>
        {f.changedFoundOn ? ` on ${shortYmd(f.changedFoundOn)}` : ""}.
        {f.staleFacts && f.staleSince
          ? ` ${f.staleFacts === f.facts - f.changed ? (f.staleFacts === 1 ? "The other one was" : `The other ${f.staleFacts} were`) : f.staleFacts === 1 ? "1 other was" : `${f.staleFacts} others were`} last checked ${shortYmd(f.staleSince)}, ${ago(daysSince(f.staleSince, today))}.`
          : ""}
      </>
    );
  } else if (f.level === "stale" && f.checkedOn && f.ageDays !== null) {
    const what = f.staleKind === "prices" ? "Prices" : f.staleKind === "versions" ? "Versions" : "Facts";
    text = (
      <>
        {what} last checked {shortYmd(f.checkedOn)}, <span className="text-ink">{ago(f.ageDays)}</span>. They may have changed since.
      </>
    );
  } else {
    text = <>Facts last checked {f.checkedOn ? `${shortYmd(f.checkedOn)}, ${ago(f.ageDays ?? 0)}` : "earlier"}.</>;
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[0.85rem] leading-snug text-graphite">
      <p className="flex min-w-0 items-start gap-2">
        <span className="mt-[0.1rem] shrink-0 text-faint">{icon}</span>
        <span>{text}</span>
      </p>
      <button
        type="button"
        onClick={onRecheck}
        disabled={!canAct}
        className="flex items-center gap-1.5 rounded-full border border-rule px-3 py-1 text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
      >
        <IconRefresh className="size-3" />
        Re-check now
      </button>
    </div>
  );
}
