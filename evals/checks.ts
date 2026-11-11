import type { TurnTrace } from "../src/core/types";
import type { Scenario } from "./scenario";

export type Check = { name: string; pass: boolean; detail?: string };
export type TurnOutcome = { answer: string; trace: TurnTrace | null; error: string | null };

const HONEST_NOT_FOUND =
  /\b(?:(?:don'?t|do not|didn'?t) have (?:any )?(?:record|conversation|chat|history)|no (?:record|saved conversation|conversation|chat|history)|(?:couldn'?t|can'?t|cannot|could not) find|nothing (?:from|on|saved)|haven'?t (?:talked|spoken|chatted))/i;

const has = (text: string, needle: string) => text.toLowerCase().includes(needle.toLowerCase());

export function runChecks(s: Scenario, o: TurnOutcome): Check[] {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, ...(detail ? { detail } : {}) });
  const e = s.expect;
  const t = o.trace;

  add("answered", !o.error && !!t && o.answer.trim().length > 0, o.error ?? undefined);
  if (!t) return checks;

  const memoryStatus = t.memory?.status ?? "not-needed";
  if (e.memory) add("memory status", memoryStatus === e.memory, `got ${memoryStatus}`);
  if (e.recalledDate) {
    const dates = (t.memory?.refs ?? []).map((r) => r.localDate);
    add("recalled the right day", dates.includes(e.recalledDate), `recalled ${dates.join(", ") || "nothing"}`);
  }
  if (e.statesDate) add("states the date it used", e.statesDate.some((d) => has(o.answer, d)));
  for (const m of e.mentions) add(`mentions "${m}"`, has(o.answer, m));
  if (e.mentionsAny.length) add(`mentions one of ${e.mentionsAny.map((m) => `"${m}"`).join(", ")}`, e.mentionsAny.some((m) => has(o.answer, m)));
  for (const m of e.mustNotMention) add(`does not mention "${m}"`, !has(o.answer, m));
  if (e.searched !== undefined) add(e.searched ? "searched the web" : "did not search", (t.search.queries > 0) === e.searched, `${t.search.queries} queries`);
  if (e.minCitations > 0) add(`≥ ${e.minCitations} citations`, t.citations.used.length >= e.minCitations, `${t.citations.used.length} cited`);
  add("no invented citations", t.citations.invalid.length === 0, t.citations.invalid.join(", ") || undefined);
  if (e.honestNotFound) add("says plainly nothing was found", HONEST_NOT_FOUND.test(o.answer));
  return checks;
}
