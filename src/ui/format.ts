export const timeOfDay = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ms);

export const dayKey = (ms: number) => new Date(ms).toDateString();

const relative = (ms: number, nowMs: number): "Today" | "Yesterday" | null => {
  const d = new Date(ms).toDateString();
  if (d === new Date(nowMs).toDateString()) return "Today";
  if (d === new Date(nowMs - 86_400_000).toDateString()) return "Yesterday";
  return null;
};

export function dayLabel(ms: number, nowMs: number): string {
  return relative(ms, nowMs) ?? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(ms);
}

export function chapterLabel(ms: number, nowMs: number): { date: string; relative: string | null } {
  return {
    date: new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(ms),
    relative: relative(ms, nowMs),
  };
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

export function dollars(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(3)}`;
}
