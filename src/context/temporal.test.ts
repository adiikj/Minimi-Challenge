import { describe, expect, it } from "vitest";
import { addDays, dayLabel, startOfWeek, weekday, ymd, zonedToUtc } from "@/lib/dates";
import { resolveTemporal, type TemporalRef } from "./temporal";

const NOW = new Date("2026-11-11T08:35:00Z");
const TZ = "Asia/Kolkata";

const resolve = (text: string, now = NOW, tz = TZ) => resolveTemporal(text, now, tz);
const one = (text: string, now = NOW, tz = TZ): TemporalRef => {
  const refs = resolve(text, now, tz);
  expect(refs, `expected one date reference in "${text}"`).toHaveLength(1);
  return refs[0]!;
};
const chosen = (r: TemporalRef) => r.candidates[r.chosen];

describe("date helpers", () => {
  it("does calendar maths on local dates", () => {
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(weekday("2026-11-11")).toBe(3);
    expect(startOfWeek("2026-11-11")).toBe("2026-11-09");
    expect(startOfWeek("2026-11-15")).toBe("2026-11-09");
    expect(ymd(2026, 11, 31)).toBeUndefined();
    expect(dayLabel("2026-11-03", 2026)).toBe("Tue 3 Nov");
    expect(dayLabel("2025-11-03", 2026)).toBe("Mon 3 Nov 2025");
  });

  it("converts local wall-clock time to UTC, across DST", () => {
    expect(zonedToUtc("2026-11-03", "10:15", "Asia/Kolkata").toISOString()).toBe("2026-11-03T04:45:00.000Z");
    expect(zonedToUtc("2026-07-01", "09:00", "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedToUtc("2026-12-01", "09:00", "Europe/London").toISOString()).toBe("2026-12-01T09:00:00.000Z");
  });
});

describe("resolveTemporal: the brief's examples", () => {
  it('"On Monday we shortlisted…" → Mon 9 Nov', () => {
    const r = one("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?");
    expect(chosen(r)).toEqual({ start: "2026-11-09", end: "2026-11-09" });
    expect(r.candidates).toHaveLength(1);
  });

  it('"What did I ask you on 3 November?" → 3 Nov 2026', () => {
    const r = one("What did I ask you on 3 November? Is your answer still correct today?");
    expect(chosen(r)).toEqual({ start: "2026-11-03", end: "2026-11-03" });
    expect(r.confidence).toBe("high");
  });

  it('"Last Tuesday" said on a Wednesday is ambiguous: previous week by default, yesterday as the alternative', () => {
    const r = one("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(r.candidates).toEqual([
      { start: "2026-11-03", end: "2026-11-03" },
      { start: "2026-11-10", end: "2026-11-10" },
    ]);
    expect(r.chosen).toBe(0);
    expect(r.confidence).toBe("medium");
  });
});

describe("resolveTemporal: weekdays", () => {
  it('"last Friday" said on a Wednesday is unambiguous (already in the previous week)', () => {
    const r = one("what did we discuss last Friday");
    expect(r.candidates).toEqual([{ start: "2026-11-06", end: "2026-11-06" }]);
  });

  it('"on Wednesday" said on a Wednesday means a week ago, with today as the alternative', () => {
    const r = one("what did I ask on Wednesday?");
    expect(r.candidates).toEqual([
      { start: "2026-11-04", end: "2026-11-04" },
      { start: "2026-11-11", end: "2026-11-11" },
    ]);
  });

  it("accepts short forms and ignores the future", () => {
    expect(chosen(one("on tue we talked"))).toEqual({ start: "2026-11-10", end: "2026-11-10" });
    expect(resolve("let's talk next Tuesday")).toEqual([]);
  });
});

describe("resolveTemporal: absolute dates", () => {
  it.each([
    ["Nov 3", "2026-11-03"],
    ["November 3rd", "2026-11-03"],
    ["3rd of November", "2026-11-03"],
    ["3 Nov 2025", "2025-11-03"],
    ["November 3, 2025", "2025-11-03"],
    ["2026-10-30", "2026-10-30"],
    ["on 25 December", "2025-12-25"],
  ])("%s → %s", (text, date) => {
    expect(chosen(one(`What did I ask ${text}?`))).toEqual({ start: date, end: date });
  });

  it("does not mistake words for months", () => {
    expect(resolve("May I ask you something about March Madness?")).toEqual([]);
  });
});

describe("resolveTemporal: relative phrases", () => {
  it.each([
    ["yesterday", "2026-11-10", "2026-11-10"],
    ["the day before yesterday", "2026-11-09", "2026-11-09"],
    ["earlier today", "2026-11-11", "2026-11-11"],
    ["3 days ago", "2026-11-08", "2026-11-08"],
    ["a few days ago", "2026-11-07", "2026-11-09"],
    ["last week", "2026-11-02", "2026-11-08"],
    ["earlier this week", "2026-11-09", "2026-11-11"],
    ["last month", "2026-10-01", "2026-10-31"],
  ])("%s → %s..%s", (text, start, end) => {
    expect(chosen(one(`What did we talk about ${text}?`))).toEqual({ start, end });
  });

  it("uses the user's time zone for 'today'", () => {
    const lateEvening = new Date("2026-11-10T20:00:00Z");
    expect(chosen(one("yesterday", lateEvening, "Asia/Kolkata"))).toEqual({ start: "2026-11-10", end: "2026-11-10" });
    expect(chosen(one("yesterday", lateEvening, "America/Los_Angeles"))).toEqual({ start: "2026-11-09", end: "2026-11-09" });
  });
});

describe("resolveTemporal: roles and labels", () => {
  it('marks "since <date>" as a since-reference', () => {
    const r = one("Has anything changed since Monday?");
    expect(r.role).toBe("since");
    expect(chosen(r)).toEqual({ start: "2026-11-09", end: "2026-11-09" });
  });

  it("finds several references and labels them for the UI", () => {
    const refs = resolve("Compare what I asked on 3 November with what we discussed yesterday");
    expect(refs.map((r) => r.phrase)).toEqual(["on 3 November", "yesterday"]);
    expect(refs[0]!.labels[0]).toBe("Tue 3 Nov");
  });
});
