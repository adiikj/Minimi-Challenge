import { addDays, rangeLabel, startOfWeek, weekday, ymd, type LocalDateRange, type Ymd } from "@/lib/dates";
import { localDate } from "@/lib/time";

export type TemporalRef = {
  phrase: string;
  candidates: LocalDateRange[];
  chosen: number;
  labels: string[];
  confidence: "high" | "medium" | "low";
  role: "anchor" | "since";
};

type Match = { index: number; length: number; candidates: LocalDateRange[]; chosen?: number; confidence: TemporalRef["confidence"] };
type Rule = { re: RegExp; resolve: (m: RegExpExecArray, today: Ymd) => Omit<Match, "index" | "length"> | null };

const day = (d: Ymd): LocalDateRange => ({ start: d, end: d });

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIndex = (m: string) => MONTHS.findIndex((full) => full.startsWith(m.toLowerCase().slice(0, 3))) + 1;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const FULL_WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function pastDate(today: Ymd, month: number, dayOfMonth: number, year?: string): Ymd | null {
  const thisYear = Number(today.slice(0, 4));
  if (year) return ymd(Number(year), month, dayOfMonth) ?? null;
  const candidate = ymd(thisYear, month, dayOfMonth);
  if (!candidate) return null;
  return candidate <= today ? candidate : (ymd(thisYear - 1, month, dayOfMonth) ?? null);
}

const exact = (d: Ymd | null) => (d ? { candidates: [day(d)], confidence: "high" as const } : null);

const RULES: Rule[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/gi, resolve: (m) => exact(ymd(+m[1]!, +m[2]!, +m[3]!) ?? null) },
  {
    re: new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4}))?`, "gi"),
    resolve: (m, today) => exact(pastDate(today, monthIndex(m[2]!), +m[1]!, m[3])),
  },
  {
    re: new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"),
    resolve: (m, today) => exact(pastDate(today, monthIndex(m[1]!), +m[2]!, m[3])),
  },
  { re: /\b(?:the\s+)?day before yesterday\b/gi, resolve: (_, t) => exact(addDays(t, -2)) },
  { re: /\byesterday\b/gi, resolve: (_, t) => exact(addDays(t, -1)) },
  { re: /\b(?:earlier today|this (?:morning|afternoon|evening))\b/gi, resolve: (_, t) => exact(t) },
  {
    re: /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+(?:ago|back)\b/gi,
    resolve: (m, t) => exact(addDays(t, -(NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1])))),
  },
  {
    re: /\b(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\s+(?:ago|back)\b/gi,
    resolve: (_, t) => ({ candidates: [{ start: addDays(t, -4), end: addDays(t, -2) }], confidence: "low" }),
  },
  {
    re: /\b(?:last|previous)\s+week\b/gi,
    resolve: (_, t) => ({ candidates: [{ start: addDays(startOfWeek(t), -7), end: addDays(startOfWeek(t), -1) }], confidence: "high" }),
  },
  { re: /\b(?:earlier\s+)?this\s+week\b/gi, resolve: (_, t) => ({ candidates: [{ start: startOfWeek(t), end: t }], confidence: "high" }) },
  {
    re: /\b(?:last|previous)\s+month\b/gi,
    resolve: (_, t) => {
      const firstThis = `${t.slice(0, 8)}01`;
      const lastPrev = addDays(firstThis, -1);
      return { candidates: [{ start: `${lastPrev.slice(0, 8)}01`, end: lastPrev }], confidence: "high" };
    },
  },
  { re: /\b(?:earlier\s+)?this\s+month\b/gi, resolve: (_, t) => ({ candidates: [{ start: `${t.slice(0, 8)}01`, end: t }], confidence: "high" }) },
  {
    re: /\b(?:(next|last|this past|past|previous|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)\b/gi,
    resolve: (m, today) => {
      const modifier = m[1]?.toLowerCase();
      const word = m[2]!.toLowerCase();
      if (modifier === "next") return null;
      if (!modifier && !FULL_WEEKDAYS.has(word)) return null;
      const target = WEEKDAYS[word]!;
      const delta = (weekday(today) - target + 7) % 7;
      if (modifier === "last") {
        if (delta === 0) return exact(addDays(today, -7));
        const recent = addDays(today, -delta);
        return recent >= startOfWeek(today)
          ? { candidates: [day(addDays(recent, -7)), day(recent)], confidence: "medium" }
          : exact(recent);
      }
      if (delta === 0) return { candidates: [day(addDays(today, -7)), day(today)], confidence: "medium" };
      return exact(addDays(today, -delta));
    },
  },
];

export function resolveTemporal(text: string, now: Date, tz: string): TemporalRef[] {
  const today = localDate(now, tz);
  const year = Number(today.slice(0, 4));
  const found: Array<Match & { phrase: string }> = [];

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const r = rule.resolve(m, today);
      if (r) found.push({ ...r, index: m.index, length: m[0].length, phrase: m[0].trim() });
    }
  }

  found.sort((a, b) => a.index - b.index || b.length - a.length);
  const kept: typeof found = [];
  for (const f of found) {
    const prev = kept.at(-1);
    if (prev && f.index < prev.index + prev.length) {
      if (f.length > prev.length) kept[kept.length - 1] = f;
      continue;
    }
    kept.push(f);
  }

  return kept.map((f) => ({
    phrase: f.phrase,
    candidates: f.candidates,
    chosen: f.chosen ?? 0,
    labels: f.candidates.map((c) => rangeLabel(c, year)),
    confidence: f.confidence,
    role: /\bsince\s+$/i.test(text.slice(0, f.index)) ? "since" : "anchor",
  }));
}
