import type { Usage } from "@/core/types";

type Price = { input: number; cachedInput: number; output: number };

const PRICES: Record<string, Price> = {
  "zai-glm-5-3": { input: 1.4, cachedInput: 0.14, output: 4.4 },
  "mistral-large-4": { input: 0.7, cachedInput: 0.07, output: 2.1 },
  "mistral-small-2603": { input: 0.15, cachedInput: 0.015, output: 0.6 },
};

const FALLBACK: Price = { input: 1.4, cachedInput: 0.14, output: 4.4 };

export function priceFor(model: string): Price {
  return PRICES[model] ?? FALLBACK;
}

export function costUsd(model: string, usage: Usage): number {
  const p = priceFor(model);
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (uncached * p.input + usage.cachedInputTokens * p.cachedInput + usage.outputTokens * p.output) / 1_000_000;
}
