import { describe, expect, it } from "vitest";
import type { StoredClaim } from "@/memory/repo";
import { freshness, shelfLifeDays, threadNeedsRecheck } from "./freshness";

let n = 0;
const claim = (over: Partial<StoredClaim> = {}): StoredClaim => ({
  id: `c${++n}`,
  messageId: "m1",
  threadId: "t1",
  entity: "Neon",
  plan: null,
  attribute: "monthly price",
  value: "$19/month",
  observedAt: "2026-11-03",
  confidence: "high",
  confirmedAt: null,
  supersededBy: null,
  ...over,
});

describe("shelfLifeDays", () => {
  it("gives prices and plan facts a week, versions two weeks, the rest a month", () => {
    expect(shelfLifeDays("monthly price")).toEqual({ days: 7, kind: "prices" });
    expect(shelfLifeDays("database size", "Free")).toEqual({ days: 7, kind: "prices" });
    expect(shelfLifeDays("latest version")).toEqual({ days: 14, kind: "versions" });
    expect(shelfLifeDays("headquarters")).toEqual({ days: 30, kind: "facts" });
  });
});

describe("freshness", () => {
  it("is null for an answer without facts", () => {
    expect(freshness([], "2026-11-11")).toBeNull();
  });

  it("is fresh within the shelf life and stale after it", () => {
    expect(freshness([claim()], "2026-11-10")).toMatchObject({ level: "fresh", checkedOn: "2026-11-03", ageDays: 7, staleKind: null });
    expect(freshness([claim()], "2026-11-11")).toMatchObject({ level: "stale", ageDays: 8, staleKind: "prices", staleFacts: 1, staleSince: "2026-11-03" });
  });

  it("counts a later confirmation as a check", () => {
    const f = freshness([claim({ confirmedAt: "2026-11-10" })], "2026-11-11");
    expect(f).toMatchObject({ level: "fresh", checkedOn: "2026-11-10", ageDays: 1 });
  });

  it("reports facts a later check found changed, with when", () => {
    const f = freshness(
      [claim({ supersededBy: { id: "x", value: "$25/month", observedAt: "2026-11-09", effectiveFrom: null } }), claim({ confirmedAt: "2026-11-09" })],
      "2026-11-11",
    );
    expect(f).toMatchObject({ level: "changed", facts: 2, changed: 1, changedFoundOn: "2026-11-09", checkedOn: "2026-11-09" });
  });

  it("after a re-check, counts only the facts it couldn't confirm as stale", () => {
    const changed = claim({ supersededBy: { id: "x", value: "1 GB", observedAt: "2026-11-11", effectiveFrom: null } });
    const f = freshness([changed, claim({ confirmedAt: "2026-11-11" }), claim({ confirmedAt: "2026-11-11" }), claim()], "2026-11-11");
    expect(f).toMatchObject({ level: "changed", changed: 1, staleFacts: 1, staleSince: "2026-11-03" });
  });

  it("names the most change-prone kind that is stale", () => {
    const f = freshness([claim({ attribute: "headquarters", observedAt: "2026-09-01" }), claim({ attribute: "latest version", observedAt: "2026-10-01" })], "2026-11-11");
    expect(f?.staleKind).toBe("versions");
  });
});

describe("threadNeedsRecheck", () => {
  it("ignores facts already replaced by a newer check", () => {
    const old = claim({ supersededBy: { id: "x", value: "$25", observedAt: "2026-11-11", effectiveFrom: null } });
    expect(threadNeedsRecheck([old, claim({ observedAt: "2026-11-11" })], "2026-11-11")).toBe(false);
    expect(threadNeedsRecheck([claim()], "2026-11-11")).toBe(true);
  });
});
