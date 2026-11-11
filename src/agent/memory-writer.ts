import { z } from "zod";
import type { LLMProvider, UserScope } from "@/core/types";
import { truncate } from "@/lib/text";
import { costUsd } from "@/llm/pricing";
import type { ClaimInput, Repo, StoredClaim, StoredSource } from "@/memory/repo";
import { domainOf } from "@/search/normalize";

export type WriterJob = {
  scope: UserScope;
  threadId: string;
  messageId: string;
  question: string;
  answer: string;
  observedAt: string;
  sources: StoredSource[];
  existing: StoredClaim[];
  wantTitle: boolean;
};

const nullableString = { type: ["string", "null"] };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

export const EXTRACTION_SCHEMA = object({
  title: nullableString,
  entities: { type: "array", items: object({ name: { type: "string" }, domain: nullableString }) },
  checks: {
    type: "array",
    items: object({
      id: { type: "string" },
      status: { type: "string", enum: ["unchanged", "changed", "unconfirmed", "not_mentioned"] },
      new_value: nullableString,
      effective_from: nullableString,
      source_id: nullableString,
    }),
  },
  facts: {
    type: "array",
    items: object({
      entity: { type: "string" },
      plan: nullableString,
      attribute: { type: "string" },
      value: { type: "string" },
      previous_value: nullableString,
      effective_from: nullableString,
      source_id: nullableString,
    }),
  },
});

const Extraction = z.object({
  title: z.string().nullable(),
  entities: z.array(z.object({ name: z.string(), domain: z.string().nullable() })),
  checks: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["unchanged", "changed", "unconfirmed", "not_mentioned"]),
      new_value: z.string().nullable(),
      effective_from: z.string().nullable(),
      source_id: z.string().nullable(),
    }),
  ),
  facts: z.array(
    z.object({
      entity: z.string(),
      plan: z.string().nullable(),
      attribute: z.string(),
      value: z.string(),
      previous_value: z.string().nullable(),
      effective_from: z.string().nullable(),
      source_id: z.string().nullable(),
    }),
  ),
});
export type Extraction = z.infer<typeof Extraction>;

const SYSTEM = `You turn one assistant answer into structured memory, so that later we can tell whether its facts changed. Reply with JSON only.

checks: one entry for EACH existing fact (F1, F2, …) listed in the input:
- "unchanged": the answer says this value still holds (even if phrased more briefly).
- "changed": the answer states a different current value; put it in new_value exactly as the answer states it.
- "unconfirmed": the answer says it could not confirm it, is unsure, or found conflicting sources.
- "not_mentioned": the answer does not address it.
- source_id: the [S#] the answer cites for that verdict, or null.

facts: checkable facts the answer states as true that are NOT already covered by checks: prices, plan limits, versions, release dates, availability, policies of named products or companies. Not opinions or recommendations. At most 25.
- entity: canonical name ("Neon", "HubSpot Sales Hub"); plan: the plan/tier/edition ("Free", "Pro") or null.
- attribute: a short lowercase noun phrase ("monthly price per seat", "free storage per project").
- value: the CURRENT value exactly as stated, with units or currency. previous_value: only if the answer explicitly gives the value before a change, else null.
- source_id: the [S#] the answer cites for it, or null.

effective_from (both lists): YYYY-MM-DD only if the answer or a source explicitly says when the current value took effect; otherwise null. The answer date is NOT an effective date.

entities: every product or company the answer is about, with its official domain if a source shows it ("neon.com"), otherwise null.
title: if asked for one, a 3–7 word title for the conversation in sentence case, without dates; otherwise null.`;

export function buildWriterMessages(job: WriterJob, factIds: Map<string, StoredClaim>) {
  const sources = job.sources
    .map((s) => `${s.id} ${s.domain} "${s.title}"${s.publishedAt ? ` (published ${s.publishedAt})` : ""}: ${truncate(s.excerpt, 400)}`)
    .join("\n");
  const existing = [...factIds.entries()]
    .map(([fid, c]) => `${fid} ${c.entity}${c.plan ? ` (${c.plan})` : ""} · ${c.attribute} = ${c.value} (observed ${c.observedAt})`)
    .join("\n");
  const user = [
    `Answer date: ${job.observedAt}`,
    `Title needed: ${job.wantTitle ? "yes" : "no"}`,
    `Question:\n${truncate(job.question, 1_500)}`,
    `Answer:\n${truncate(job.answer, 8_000)}`,
    sources ? `Sources:\n${sources}` : "Sources: none",
    existing ? `Existing facts (give a check for each):\n${existing}` : "Existing facts: none (checks must be empty)",
  ].join("\n\n");
  return [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: user },
  ];
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const compact = (s: string) => norm(s).replace(/[^\p{L}\p{N}.$€£%]/gu, "");
const firstNumber = (s: string) => s.match(/\d+(?:[.,]\d+)?/)?.[0];
const keyOf = (c: { entity: string; plan?: string | null; attribute: string }) => `${norm(c.entity)}|${norm(c.plan)}|${norm(c.attribute)}`;
const isDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function sameValue(a: string, b: string): boolean {
  const [x, y] = [compact(a), compact(b)];
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length > 0 && long.startsWith(short) && firstNumber(short) !== undefined && firstNumber(short) === firstNumber(long)) return true;
  const qa = leadingQuantity(a);
  const pa = periods(a);
  const pb = periods(b);
  return qa !== undefined && qa === leadingQuantity(b) && (pa.size === 0 || pb.size === 0 || [...pa].some((p) => pb.has(p)));
}

const leadingQuantity = (s: string) => {
  const m = norm(s).match(/([$€£₹]?\s?\d+(?:[.,]\d+)?)\s*(%|[a-z][a-z-]*)?/);
  const unit = m?.[2] === "per" ? "" : (m?.[2] ?? "");
  return m ? `${m[1]!.replace(/\s/g, "")}|${unit}` : undefined;
};
const PERIOD: Record<string, string> = { hour: "hour", hourly: "hour", day: "day", daily: "day", week: "week", weekly: "week", month: "month", monthly: "month", mo: "month", year: "year", yearly: "year", annual: "year", annually: "year", yr: "year" };
const periods = (s: string) => new Set((norm(s).match(/\b(hourly|hour|daily|day|weekly|week|monthly|month|mo|yearly|year|annually|annual|yr)\b/g) ?? []).map((p) => PERIOD[p]!));

const HEDGE = /\b(?:can(?:'|’)?t|cannot|could(?:n(?:'|’)?t| not)|unable to)\s+(?:confirm|verify)|not sure|unsure|unclear|unverified|conflicting|disagree/i;

// A value the answer only hedged about must never overwrite a stored fact.
export function isHedged(answer: string, value: string): boolean {
  const n = firstNumber(value);
  if (!n) return false;
  const exact = new RegExp(`(?<![\\d.,])${n.replace(/[.,]/g, "\\$&")}(?![\\d]|[.,]\\d)`);
  return answer.split(/(?<=[.!?])\s+|\n+/).some((sentence) => exact.test(sentence) && HEDGE.test(sentence));
}

export type ApplyResult = { saved: number; superseded: number; confirmed: number; entities: number; titled: boolean };

export function applyExtraction(repo: Repo, job: WriterJob, factIds: Map<string, StoredClaim>, x: Extraction): ApplyResult {
  const sourceIds = new Set(job.sources.map((s) => s.id));
  const sourceOf = (id: string | null) => (id && sourceIds.has(id) ? id : null);
  const effective = (d: string | null) => (isDate(d) && d !== job.observedAt ? d : null);
  const canonical = new Map(job.existing.map((c) => [norm(c.entity), c.entity]));
  const at = { messageId: job.messageId, threadId: job.threadId };

  let saved = 0;
  let superseded = 0;
  let confirmed = 0;
  const handled = new Set<string>();

  const record = (c: ClaimInput): string => {
    saved++;
    return repo.saveClaims(job.scope, at, [c])[0]!;
  };

  for (const check of x.checks) {
    const old = factIds.get(check.id);
    if (!old || handled.has(old.id)) continue;
    handled.add(old.id);
    const sourceLabel = sourceOf(check.source_id);
    const base = { entity: old.entity, plan: old.plan ?? null, attribute: old.attribute, observedAt: job.observedAt, sourceLabel };
    const proposed = check.status === "changed" ? check.new_value?.trim() : undefined;
    const changedTo = proposed && !isHedged(job.answer, proposed) ? proposed : undefined;

    if (check.status === "unchanged" || (changedTo && sameValue(old.value, changedTo))) {
      if (repo.confirmClaim(job.scope, old.id, job.observedAt)) confirmed++;
      record({ ...base, value: old.value, confidence: sourceLabel ? "high" : "low" });
    } else if (changedTo) {
      const newId = record({
        ...base,
        value: changedTo,
        previousValue: old.value,
        effectiveFrom: effective(check.effective_from),
        confidence: sourceLabel ? "high" : "low",
      });
      if (repo.supersede(job.scope, old.id, newId)) superseded++;
    }
  }

  const checkedKeys = new Set(job.existing.filter((c) => handled.has(c.id)).map(keyOf));
  const seen = new Set<string>();
  for (const f of x.facts.slice(0, 25)) {
    const entity = canonical.get(norm(f.entity)) ?? f.entity.trim();
    const attribute = f.attribute.trim().toLowerCase();
    const value = f.value.trim();
    const key = keyOf({ entity, plan: f.plan, attribute });
    if (!entity || !attribute || !value || seen.has(key) || checkedKeys.has(key)) continue;
    seen.add(key);
    const sourceLabel = sourceOf(f.source_id);
    const newId = record({
      entity,
      plan: f.plan?.trim() || null,
      attribute,
      value,
      previousValue: f.previous_value?.trim() || null,
      sourceLabel,
      observedAt: job.observedAt,
      effectiveFrom: effective(f.effective_from),
      confidence: sourceLabel ? "high" : "low",
    });
    const match = job.existing.find((c) => !handled.has(c.id) && keyOf(c) === key);
    if (match) {
      handled.add(match.id);
      if (sameValue(match.value, value)) {
        if (repo.confirmClaim(job.scope, match.id, job.observedAt)) confirmed++;
      } else if (sourceLabel && repo.supersede(job.scope, match.id, newId)) {
        superseded++;
      }
    }
  }

  const entities = x.entities
    .map((e) => ({ name: canonical.get(norm(e.name)) ?? e.name.trim(), domain: e.domain ? domainOf(e.domain) : null }))
    .filter((e) => e.name);
  if (entities.length) repo.saveEntities(job.scope, job.messageId, entities);

  const title =
    job.wantTitle && x.title?.trim()
      ? x.title
          .trim()
          .replace(/\s+(?:since|as of|on|from)\s+.*$/i, "")
          .replace(/[."]+$/g, "")
      : null;
  const titled = title ? repo.renameThread(job.scope, job.threadId, title) : false;

  return { saved, superseded, confirmed, entities: entities.length, titled };
}

export class MemoryWriter {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private deps: { llm: LLMProvider; repo: Repo; model: string; log?: (msg: string, err?: unknown) => void }) {}

  enqueue(job: WriterJob): void {
    this.tail = this.tail.then(() => this.run(job)).catch(() => {});
  }

  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  async run(job: WriterJob): Promise<ApplyResult | null> {
    if (!job.answer.trim()) return null;
    const factIds = new Map(job.existing.slice(0, 40).map((c, i) => [`F${i + 1}`, c]));
    const messages = buildWriterMessages(job, factIds);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        let text = "";
        let usage;
        for await (const chunk of this.deps.llm.stream(
          {
            model: this.deps.model,
            messages,
            reasoningEffort: "none",
            maxTokens: 3_000,
            responseFormat: { name: "memory_extraction", schema: EXTRACTION_SCHEMA },
          },
          AbortSignal.timeout(60_000),
        )) {
          if (chunk.type === "text") text += chunk.delta;
          if (chunk.type === "finish") usage = chunk.usage;
        }
        if (usage) this.deps.repo.logSpend("memory-writer", this.deps.model, costUsd(this.deps.model, usage));
        return applyExtraction(this.deps.repo, job, factIds, Extraction.parse(JSON.parse(text)));
      } catch (err) {
        if (attempt === 2) this.deps.log?.("[memory-writer] giving up on a job; raw messages stay searchable", err);
      }
    }
    return null;
  }
}
