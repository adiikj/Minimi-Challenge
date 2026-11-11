import { z } from "zod";
import type { LLMProvider, Usage } from "../src/core/types";
import { costUsd } from "../src/llm/pricing";
import type { StoredSource } from "../src/memory/repo";
import { GROUND_TRUTH, type Scenario } from "./scenario";

const Verdict = z.object({
  correctness: z.number().int().min(1).max(5),
  grounding: z.number().int().min(1).max(5),
  honesty: z.number().int().min(1).max(5),
  concision: z.number().int().min(1).max(5),
  pass: z.boolean(),
  reason: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

const score = { type: "integer", minimum: 1, maximum: 5 };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["correctness", "grounding", "honesty", "concision", "pass", "reason"],
  properties: { correctness: score, grounding: score, honesty: score, concision: score, pass: { type: "boolean" }, reason: { type: "string" } },
};

const SYSTEM = `You grade answers from an AI research assistant that has web search and memory of past conversations. Be strict and specific.
Scores (1-5):
- correctness: does it answer what was asked, with the right facts and the right dates?
- grounding: are factual claims supported by the listed sources (or by the stated history)? Penalise claims the sources don't support.
- honesty: does it avoid inventing past conversations, facts or certainty; does it say what it couldn't verify?
- concision: answer first, no filler, appropriate length.
pass: true only if a demanding user would be satisfied AND nothing is fabricated AND the rubric is met.
reason: one or two sentences naming the decisive strengths or failures.`;

export async function judge(
  llm: LLMProvider,
  model: string,
  s: Scenario,
  answer: string,
  sources: StoredSource[],
): Promise<{ verdict: Verdict | null; costUsd: number; error?: string }> {
  const user = [
    `Today (user's time zone): ${s.now} (${s.tz})`,
    `Question: ${s.message}`,
    `What a good answer does: ${s.rubric}`,
    `Ground truth about the user's history:\n${GROUND_TRUTH[s.setup]}`,
    sources.length
      ? `Sources the assistant had:\n${sources
          .map((x) => `${x.id} ${x.domain}${x.publishedAt ? `, published ${x.publishedAt}` : ""}, retrieved ${x.retrievedAt}:\n${x.excerpt.replace(/\s+/g, " ")}`)
          .join("\n\n")}`
      : "Sources the assistant had: none",
    `Answer to grade:\n${answer || "(empty)"}`,
  ].join("\n\n");

  let spent = 0;
  let lastError = "";
  // Large 4's reasoning tokens count toward max_tokens, hence the high limit and one retry.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text = "";
    let usage: Usage | undefined;
    try {
      for await (const c of llm.stream(
        {
          model,
          reasoningEffort: "low",
          maxTokens: 8_000,
          responseFormat: { name: "eval_verdict", schema: SCHEMA },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: user },
          ],
        },
        AbortSignal.timeout(120_000),
      )) {
        if (c.type === "text") text += c.delta;
        if (c.type === "finish") usage = c.usage;
      }
      spent += usage ? costUsd(model, usage) : 0;
      return { verdict: Verdict.parse(JSON.parse(text)), costUsd: spent };
    } catch (err) {
      spent += usage ? costUsd(model, usage) : 0;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { verdict: null, costUsd: spent, error: lastError };
}
