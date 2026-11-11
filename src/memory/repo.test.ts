import { describe, expect, it } from "vitest";
import type { TurnTrace } from "@/core/types";
import { openDb } from "./db";
import { MIGRATIONS } from "./migrations";
import { createRepo, toFtsQuery } from "./repo";
import { SqliteCacheStore } from "./search-cache-store";

function setup(at = "2026-11-11T08:00:00Z") {
  const db = openDb(":memory:");
  let now = new Date(at);
  const repo = createRepo(db, () => now);
  return { db, repo, setNow: (iso: string) => (now = new Date(iso)) };
}

const trace = (costUsd = 0.01): TurnTrace => ({
  model: "m",
  rounds: 1,
  totalMs: 100,
  firstTokenMs: 50,
  usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
  costUsd,
  truncated: false,
  search: { queries: 0, credits: 0, cacheHits: 0, sources: 0, ms: 0 },
  citations: { used: [], invalid: [] },
});

describe("migrations", () => {
  it("creates the schema and records the version", () => {
    const { db } = setup();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.at(-1)!.version);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["devices", "users", "threads", "messages", "messages_fts", "message_sources", "turn_traces", "search_cache"]));
  });
});

describe("profile isolation (by construction)", () => {
  it("never returns one profile's data to another, through any read path", () => {
    const { repo } = setup();
    const device = repo.createDevice();
    const alice = { userId: repo.createProfile(device, "Alice").id };
    const bob = { userId: repo.createProfile(device, "Bob").id };

    const ta = repo.createThread(alice, "Postgres hosting");
    const qa = repo.addMessage(alice, { threadId: ta.id, role: "user", content: "Compare Neon and Supabase postgres pricing", tz: "UTC" });
    const aa = repo.addMessage(alice, { threadId: ta.id, role: "assistant", content: "Neon is usage-based [S1].", tz: "UTC" });
    repo.saveSources(alice, aa.id, [{ id: "S1", url: "https://neon.com/pricing", domain: "neon.com", title: "Neon", retrievedAt: "2026-11-11", excerpt: "…" }]);
    repo.saveTrace(alice, aa.id, trace());

    const tb = repo.createThread(bob, "Postgres hosting too");
    repo.addMessage(bob, { threadId: tb.id, role: "user", content: "postgres for my side project", tz: "UTC" });

    expect(repo.listThreads(bob).map((t) => t.id)).toEqual([tb.id]);
    expect(repo.getThread(bob, ta.id)).toBeUndefined();
    expect(repo.listMessages(bob, ta.id)).toEqual([]);
    expect(repo.recentHistory(bob, ta.id)).toEqual([]);
    expect(repo.searchMessages(bob, "postgres").map((m) => m.threadId)).toEqual([tb.id]);
    expect(repo.searchMessages(alice, "postgres").map((m) => m.id)).toEqual([qa.id]);
    expect(() => repo.addMessage(bob, { threadId: ta.id, role: "user", content: "sneaky", tz: "UTC" })).toThrow();
    expect(() => repo.saveSources(bob, aa.id, [])).toThrow();
    expect(() => repo.saveTrace(bob, aa.id, trace())).toThrow();
    expect(repo.deleteThread(bob, ta.id)).toBe(false);
    expect(repo.listThreads(alice)).toHaveLength(1);
  });

  it("only lets a device rename or delete its own non-demo profiles", () => {
    const { repo } = setup();
    const d1 = repo.createDevice();
    const d2 = repo.createDevice();
    const mine = repo.createProfile(d1, "Mine");
    const theirs = repo.createProfile(d2, "Theirs");
    const demo = repo.createProfile(null, "Demo", { isDemo: true });

    expect(repo.listProfiles(d1).map((p) => p.name)).toEqual(["Mine", "Demo"]);
    expect(repo.renameProfile(d1, theirs.id, "Hacked")).toBe(false);
    expect(repo.deleteProfile(d1, theirs.id)).toBe(false);
    expect(repo.deleteProfile(d1, demo.id)).toBe(false);
    expect(repo.renameProfile(d1, mine.id, "Me")).toBe(true);
    expect(repo.getProfile(mine.id)?.name).toBe("Me");
  });
});

describe("deleting a profile forgets everything", () => {
  it("cascades to threads, messages, sources, traces and the full-text index", () => {
    const { db, repo } = setup();
    const device = repo.createDevice();
    const p = repo.createProfile(device, "Temp");
    const scope = { userId: p.id };
    const t = repo.createThread(scope, "x");
    repo.addMessage(scope, { threadId: t.id, role: "user", content: "remember the kraken", tz: "UTC" });
    const a = repo.addMessage(scope, { threadId: t.id, role: "assistant", content: "ok [S1]", tz: "UTC" });
    repo.saveSources(scope, a.id, [{ id: "S1", url: "https://k.com", domain: "k.com", title: "K", retrievedAt: "2026-11-11", excerpt: "e" }]);
    repo.saveTrace(scope, a.id, trace());
    repo.saveClaims(scope, { messageId: a.id, threadId: t.id }, [{ entity: "K", attribute: "x", value: "1", observedAt: "2026-11-11", confidence: "low" }]);
    repo.saveEntities(scope, a.id, [{ name: "K", domain: "k.com" }]);

    expect(repo.deleteProfile(device, p.id)).toBe(true);
    const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(["threads", "messages", "message_sources", "turn_traces", "claims", "entities"].map(count)).toEqual([0, 0, 0, 0, 0, 0]);
    expect((db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'kraken'").get() as { n: number }).n).toBe(0);
  });
});

describe("messages", () => {
  it("stores the user's local calendar date, not the server's (\"what did I ask on 3 Nov?\")", () => {
    const { repo } = setup();
    const scope = { userId: repo.createProfile(repo.createDevice(), "U").id };
    const t = repo.createThread(scope, "t");
    const ist = repo.addMessage(scope, { threadId: t.id, role: "user", content: "a", tz: "Asia/Kolkata", createdAt: "2026-11-02T18:00:00Z" });
    const ny = repo.addMessage(scope, { threadId: t.id, role: "user", content: "b", tz: "America/New_York", createdAt: "2026-11-03T00:00:00Z" });
    expect(ist.localDate).toBe("2026-11-02");
    expect(ny.localDate).toBe("2026-11-02");
  });

  it("returns a thread with each answer's sources (in S-order) and trace", () => {
    const { repo } = setup();
    const scope = { userId: repo.createProfile(repo.createDevice(), "U").id };
    const t = repo.createThread(scope, "t");
    repo.addMessage(scope, { threadId: t.id, role: "user", content: "q", tz: "UTC" });
    const a = repo.addMessage(scope, { threadId: t.id, role: "assistant", content: "a [S2] [S10]", tz: "UTC" });
    const src = (id: string) => ({ id, url: `https://${id}.com`, domain: `${id}.com`, title: id, retrievedAt: "2026-11-11", excerpt: "e" });
    repo.saveSources(scope, a.id, [src("S10"), src("S2"), src("S1")]);
    repo.saveTrace(scope, a.id, trace(0.02));

    const [q, ans] = repo.listMessages(scope, t.id);
    expect(q?.sources).toEqual([]);
    expect(ans?.sources.map((s) => s.id)).toEqual(["S1", "S2", "S10"]);
    expect(ans?.trace?.costUsd).toBe(0.02);
  });

  it("builds model history without failed answers or their unanswered questions", () => {
    const { repo, setNow } = setup();
    const scope = { userId: repo.createProfile(repo.createDevice(), "U").id };
    const t = repo.createThread(scope, "t");
    const add = (role: "user" | "assistant", content: string, status: "done" | "error" | "stopped", at: string) => {
      setNow(at);
      repo.addMessage(scope, { threadId: t.id, role, content, status, tz: "UTC" });
    };
    add("user", "q1", "done", "2026-11-11T08:00:00Z");
    add("assistant", "a1", "done", "2026-11-11T08:00:01Z");
    add("user", "q2", "done", "2026-11-11T08:01:00Z");
    add("assistant", "", "error", "2026-11-11T08:01:01Z");
    add("user", "q3", "done", "2026-11-11T08:02:00Z");
    add("assistant", "partial a3", "stopped", "2026-11-11T08:02:01Z");
    expect(repo.recentHistory(scope, t.id).map((m) => m.content)).toEqual(["q1", "a1", "q3", "partial a3"]);
  });

  it("makes safe full-text queries out of arbitrary user text", () => {
    expect(toFtsQuery('Postgres "hosting" OR NEAR(x) -- drop')).toBe('"postgres" OR "hosting" OR "or" OR "near" OR "drop"');
    expect(toFtsQuery("?! a")).toBe("");
  });
});

describe("SqliteCacheStore", () => {
  it("persists and expires search results", () => {
    const { db } = setup();
    const store = new SqliteCacheStore(db);
    store.set("k", { results: [], credits: 1 }, 1000);
    expect(store.get("k")).toEqual({ value: { results: [], credits: 1 }, expiresAt: 1000 });
    store.delete("k");
    expect(store.get("k")).toBeUndefined();
  });
});
