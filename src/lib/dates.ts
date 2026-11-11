export type Ymd = string;
export type LocalDateRange = { start: Ymd; end: Ymd };

const toUtc = (d: Ymd) => {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
};
const fromUtc = (ms: number): Ymd => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: Ymd, n: number): Ymd => fromUtc(toUtc(d) + n * 86_400_000);

export const weekday = (d: Ymd): number => new Date(toUtc(d)).getUTCDay();

export const startOfWeek = (d: Ymd): Ymd => addDays(d, -((weekday(d) + 6) % 7));

export const ymd = (y: number, month1: number, day: number): Ymd | undefined => {
  const ms = Date.UTC(y, month1 - 1, day);
  const out = fromUtc(ms);
  return Number(out.slice(5, 7)) === month1 && Number(out.slice(8, 10)) === day ? out : undefined;
};

export const daysBetween = (a: Ymd, b: Ymd): number => Math.round((toUtc(b) - toUtc(a)) / 86_400_000);

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayLabel(d: Ymd, currentYear?: number): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return `${WD[weekday(d)]} ${day} ${MON[m - 1]}${currentYear === y ? "" : ` ${y}`}`;
}

export function rangeLabel(r: LocalDateRange, currentYear?: number): string {
  return r.start === r.end ? dayLabel(r.start, currentYear) : `${dayLabel(r.start, currentYear)} – ${dayLabel(r.end, currentYear)}`;
}

export function zonedToUtc(date: Ymd, time: string, tz: string): Date {
  const [h, min] = time.split(":").map(Number) as [number, number];
  const wanted = toUtc(date) + (h * 60 + min) * 60_000;
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess = wanted - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

function offsetMs(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}
