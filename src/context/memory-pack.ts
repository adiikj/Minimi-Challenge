import { stripCitations } from "@/lib/citations";
import { dayLabel } from "@/lib/dates";
import { truncate } from "@/lib/text";
import type { StoredClaim } from "@/memory/repo";
import type { MemoryResult } from "./recall";

const QUESTION_CHARS = 600;
const ANSWER_CHARS = 2_400;
const TOTAL_CHARS = 20_000;

export function formatMemory(m: MemoryResult, currentYear: number): string | null {
  const label = (d: string) => dayLabel(d, currentYear);
  const lines: string[] = [];

  if (m.status !== "not-needed") {
    lines.push(
      "Past conversations with this user, retrieved from storage. This is the ONLY record of the past: never invent conversations or what you said. Past answers were true on their date, not necessarily today.",
    );
    for (const r of m.resolved) lines.push(`Resolved: "${r.phrase}" → ${r.label}${r.role === "since" ? " (start of the 'since' window)" : ""}.`);
    for (const a of m.assumptions) {
      const alts = a.alternatives.map((x) => `${x.label}${x.hasConversations ? "" : " (no conversations that day)"}`).join(", ");
      if (alts) lines.push(`"${a.phrase}" could also mean ${alts}. Mention the date you used.`);
    }
  }

  if (m.status === "none-found") {
    const near = m.nearest;
    const nearby = [
      near?.before && `${label(near.before.localDate)} ("${near.before.title}")`,
      near?.after && `${label(near.after.localDate)} ("${near.after.title}")`,
    ].filter(Boolean);
    const context = nearby.length
      ? ` Nearest days with conversations: ${nearby.join("; ")}.`
      : m.index.length === 0
        ? " This user has no other saved conversations at all."
        : "";
    lines.push(
      `<memory_result status="none-found">No conversation found${near ? ` on ${near.searched}` : " on that topic"}.${context} Say so plainly; do not guess what was discussed.</memory_result>`,
    );
  }

  if (m.status === "found") {
    if (m.sinceDate) lines.push(`For "what changed since", use since = ${m.sinceDate}.`);
    let budget = TOTAL_CHARS;
    for (const e of m.exchanges) {
      const sources = e.sources.length
        ? `\n<sources_then>${e.sources.map((s) => `${s.domain}: ${s.title} (retrieved ${s.retrievedAt})`).join("; ")}</sources_then>`
        : "";
      const answerChars = e.facts.length ? ANSWER_CHARS / 2 : ANSWER_CHARS;
      const answer =
        e.answer === null
          ? "(no answer was saved)"
          : `${e.answerStatus === "stopped" ? "(answer was stopped part-way) " : ""}${truncate(stripCitations(e.answer), answerChars)}`;
      const facts = e.facts.length ? `\n<facts_then>\n${e.facts.map((f) => `- ${formatFact(f, label)}`).join("\n")}\n</facts_then>` : "";
      const sites = e.entities.filter((x) => x.domain).map((x) => `${x.name}: ${x.domain}`);
      const official = sites.length ? `\n<official_sites>${sites.join("; ")}</official_sites>` : "";
      const block = `<conversation date="${label(e.localDate)}" thread="${e.threadTitle.replace(/"/g, "'")}">\n<user_asked>${truncate(e.question, QUESTION_CHARS)}</user_asked>\n<you_answered>${answer}</you_answered>${facts}${official}${sources}\n</conversation>`;
      if (block.length > budget) break;
      budget -= block.length;
      lines.push(block);
    }
  }

  if (m.index.length) {
    lines.push(
      `Recent conversations (index only, newest first):\n${m.index
        .map((t) => `- ${t.firstDate === t.lastDate ? label(t.firstDate) : `${label(t.firstDate)} – ${label(t.lastDate)}`}: "${t.title}" (${t.questions} question${t.questions === 1 ? "" : "s"})`)
        .join("\n")}`,
    );
  }

  return lines.length ? `<memory>\n${lines.join("\n")}\n</memory>` : null;
}

export function formatFact(f: StoredClaim, label: (d: string) => string): string {
  const head = `${f.entity}${f.plan ? ` (${f.plan})` : ""} · ${f.attribute} = ${f.value}`;
  const seen = `seen ${label(f.observedAt)}${f.effectiveFrom ? `, effective ${label(f.effectiveFrom)}` : ""}${f.confidence === "low" ? ", unsourced" : ""}`;
  const confirmed = f.confirmedAt && !f.supersededBy ? `; still true on ${label(f.confirmedAt)}` : "";
  const later = f.supersededBy
    ? ` → later found ${f.supersededBy.value} (seen ${label(f.supersededBy.observedAt)}${f.supersededBy.effectiveFrom ? `, effective ${label(f.supersededBy.effectiveFrom)}` : ""})`
    : "";
  return `${head} [${seen}${confirmed}]${later}`;
}
