import { describe, expect, it } from "vitest";
import { parseSSE, encodeSSE } from "@/lib/sse";
import { describeNow, localDate, safeTimeZone } from "@/lib/time";
import { costUsd } from "@/llm/pricing";
import { parseConfig } from "./config";
import { ConfigError } from "./errors";

describe("config", () => {
  it("applies defaults and treats empty strings as unset", () => {
    const c = parseConfig({ MISTRAL_API_KEY: "m", TAVILY_API_KEY: "t", AGENT_MODEL: "", AGENT_NOW: "" });
    expect(c).toMatchObject({ model: "zai-glm-5-3", backgroundModel: "mistral-small-2603", fixedNow: undefined, spendLimitUsd: 4 });
  });

  it("fails loudly, naming every missing key", () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/MISTRAL_API_KEY[\s\S]*TAVILY_API_KEY/);
  });

  it("parses a pinned clock", () => {
    const c = parseConfig({ MISTRAL_API_KEY: "m", TAVILY_API_KEY: "t", AGENT_NOW: "2026-11-11T10:00:00+05:30" });
    expect(c.fixedNow?.toISOString()).toBe("2026-11-11T04:30:00.000Z");
    expect(() => parseConfig({ MISTRAL_API_KEY: "m", TAVILY_API_KEY: "t", AGENT_NOW: "next tuesday" })).toThrow(ConfigError);
  });
});

describe("time", () => {
  const instant = new Date("2026-11-10T20:00:00Z");

  it("computes the user's local date, not the server's", () => {
    expect(localDate(instant, "UTC")).toBe("2026-11-10");
    expect(localDate(instant, "Asia/Kolkata")).toBe("2026-11-11");
    expect(localDate(instant, "America/Los_Angeles")).toBe("2026-11-10");
  });

  it("describes now with weekday, time and offset", () => {
    expect(describeNow(instant, "Asia/Kolkata")).toBe("Wednesday, 11 November 2026, 01:30 (Asia/Kolkata, GMT+5:30)");
  });

  it("rejects invalid time zones", () => {
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(safeTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });
});

describe("pricing", () => {
  it("bills cached input at the cached rate and never double-counts", () => {
    const usd = costUsd("zai-glm-5-3", { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000, reasoningTokens: 200 });
    expect(usd).toBeCloseTo((2_000 * 1.4 + 8_000 * 0.14 + 1_000 * 4.4) / 1e6, 10);
  });

  it("prices unknown models conservatively", () => {
    expect(costUsd("mystery", { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })).toBe(1.4);
  });
});

describe("sse", () => {
  it("round-trips events through encode → parse", async () => {
    const events = [{ type: "text", delta: "a\nb" }, { type: "done" }];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(encodeSSE(e));
        c.close();
      },
    });
    const out: unknown[] = [];
    for await (const d of parseSSE(body)) out.push(JSON.parse(d));
    expect(out).toEqual(events);
  });
});
