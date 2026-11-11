import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nearestReplayProvider, recordingProvider, replayProvider } from "./recorder";
import type { SearchProvider } from "./types";

describe("record / replay", () => {
  it("replays exactly what was recorded, without calling the live provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minimi-fixtures-"));
    let liveCalls = 0;
    const live: SearchProvider = {
      name: "tavily",
      search: async (q) => {
        liveCalls++;
        return { results: [{ url: "https://neon.com/pricing", title: "Pricing", content: q.q, score: 0.9 }], credits: 2 };
      },
    };
    const signal = new AbortController().signal;
    const q = { q: "Neon pricing", domains: ["neon.com"] };

    const recorded = await recordingProvider(live, dir).search(q, "thorough", signal);
    const replayed = await replayProvider("tavily", dir).search(q, "thorough", signal);

    expect(replayed).toEqual(recorded);
    expect(liveCalls).toBe(1);
  });

  it("fails loudly on a query that was never recorded (never falls back to a live call)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minimi-fixtures-"));
    await expect(replayProvider("tavily", dir).search({ q: "unseen" }, "fast", new AbortController().signal)).rejects.toThrow(
      /No recorded search/,
    );
  });

  it("nearest replay: matches a reworded query to the closest recording, and misses honestly", async () => {
    const replay = nearestReplayProvider("tavily", join(process.cwd(), "evals/fixtures/search"));
    const signal = new AbortController().signal;
    const close = await replay.search({ q: "Supabase Pro plan pricing", domains: ["supabase.com"] }, "fast", signal);
    expect(close.results.length).toBeGreaterThan(0);
    const far = await replay.search({ q: "best hiking boots for winter" }, "fast", signal);
    expect(far.results).toEqual([]);
    expect(replay.misses).toEqual(["best hiking boots for winter"]);
  });

  it("can replay recorded live fixtures", async () => {
    const replay = replayProvider("tavily", join(process.cwd(), "evals/fixtures/search"));
    const res = await replay.search({ q: "Supabase pricing plans", domains: ["supabase.com"] }, "thorough", new AbortController().signal);
    expect(res.results.length).toBeGreaterThan(0);
  });
});
