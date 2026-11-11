import { describe, expect, it } from "vitest";
import { zonedToUtc } from "@/lib/dates";
import { openDb } from "@/memory/db";
import { createRepo } from "@/memory/repo";
import { demoDates, DEMO_PROFILE_NAME, seedDemo } from "@/memory/seed";
import { detectIntent } from "./intent";
import { formatMemory } from "./memory-pack";
import { recall } from "./recall";

const NOW = new Date("2026-11-11T08:35:00Z");
const TZ = "Asia/Kolkata";

function demo() {
  const repo = createRepo(openDb(":memory:"), () => NOW);
  const { profileId } = seedDemo(repo, { now: NOW, tz: TZ });
  const scope = { userId: profileId };
  const ask = (message: string, currentThreadId?: string) => recall(repo, { scope, message, now: NOW, tz: TZ, ...(currentThreadId ? { currentThreadId } : {}) });
  return { repo, scope, ask };
}

function withChats(chats: Array<{ date: string; question: string; answer?: string }>) {
  const repo = createRepo(openDb(":memory:"), () => NOW);
  const scope = { userId: repo.createProfile(repo.createDevice(), "U", { tz: TZ }).id };
  for (const c of chats) {
    const t = repo.createThread(scope, c.question.slice(0, 40));
    const at = zonedToUtc(c.date, "10:00", TZ).toISOString();
    repo.addMessage(scope, { threadId: t.id, role: "user", content: c.question, tz: TZ, createdAt: at });
    repo.addMessage(scope, { threadId: t.id, role: "assistant", content: c.answer ?? "ok", tz: TZ, createdAt: at });
  }
  const ask = (message: string) => recall(repo, { scope, message, now: NOW, tz: TZ });
  return { repo, scope, ask };
}

describe("demo seed", () => {
  it("dates the sample history relative to today", () => {
    expect(demoDates("2026-11-11")).toEqual({ lastTuesday: "2026-11-03", lastMonday: "2026-11-09", nov3: "2026-11-03", unrelated: "2026-10-30" });
    expect(demoDates("2026-12-02")).toMatchObject({ lastTuesday: "2026-11-24", lastMonday: "2026-11-30", nov3: "2026-11-03" });
    expect(demoDates("2026-06-10").nov3).toBe("2025-11-03");
  });

  it("is idempotent: resetting keeps the profile and replaces its history", () => {
    const repo = createRepo(openDb(":memory:"), () => NOW);
    const first = seedDemo(repo, { now: NOW, tz: TZ });
    const second = seedDemo(repo, { now: NOW, tz: TZ });
    expect(second.profileId).toBe(first.profileId);
    expect(repo.listThreads({ userId: first.profileId })).toHaveLength(3);
    expect(repo.findDemoProfile(DEMO_PROFILE_NAME)?.isDemo).toBe(true);
  });

  it("adds a separate 3 November conversation when it isn't last Tuesday", () => {
    const later = new Date("2026-12-02T08:00:00Z");
    const repo = createRepo(openDb(":memory:"), () => later);
    const { profileId } = seedDemo(repo, { now: later, tz: TZ });
    const titles = repo.listThreads({ userId: profileId }).map((t) => t.title);
    expect(titles).toContain("Does Supabase pause free projects?");
  });
});

describe("recall: the brief's questions on the demo profile", () => {
  it('"What did I ask you on 3 November? Is your answer still correct today?"', () => {
    const m = demo().ask("What did I ask you on 3 November? Is your answer still correct today?");
    expect(m.status).toBe("found");
    expect(m.resolved).toEqual([{ phrase: "on 3 November", range: { start: "2026-11-03", end: "2026-11-03" }, label: "Tue 3 Nov", role: "anchor" }]);
    expect(m.exchanges.map((e) => e.threadTitle)).toEqual(["Cheapest managed Postgres for a side project"]);
    expect(m.exchanges[0]?.sources.map((s) => s.domain)).toEqual(["neon.com", "supabase.com", "railway.com"]);
    expect(m.intent.changeCheck).toBe(true);
    expect(m.sinceDate).toBe("2026-11-03");
  });

  it('"On Monday we shortlisted 5 CRM tools… has any of them changed pricing since?"', () => {
    const m = demo().ask("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
    expect(m.status).toBe("found");
    expect(m.exchanges).toHaveLength(1);
    expect(m.exchanges[0]?.answer).toContain("Pipedrive");
    expect(m.sinceDate).toBe("2026-11-09");
  });

  it('"Last Tuesday I asked you about Postgres hosting…": default reading has the chat, alternative is shown but empty', () => {
    const m = demo().ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(m.resolved.map((r) => r.label)).toEqual(["Tue 3 Nov"]);
    expect(m.assumptions).toEqual([{ phrase: "Last Tuesday", chosen: "Tue 3 Nov", alternatives: [{ label: "Tue 10 Nov", hasConversations: false }] }]);
    expect(m.exchanges[0]?.question).toMatch(/Postgres/);
    expect(m.sinceDate).toBe("2026-11-03");
  });
});

describe("recall: behaviour", () => {
  it("switches to the other reading when only that day has conversations (data-aware)", () => {
    const m = withChats([{ date: "2026-11-10", question: "Postgres hosting options?" }]).ask("What did I ask you last Tuesday?");
    expect(m.resolved.map((r) => r.label)).toEqual(["Tue 10 Nov"]);
    expect(m.assumptions[0]).toEqual({ phrase: "last Tuesday", chosen: "Tue 10 Nov", alternatives: [{ label: "Tue 3 Nov", hasConversations: false }] });
  });

  it("uses both readings when both days have conversations, and says so", () => {
    const m = withChats([
      { date: "2026-11-03", question: "Neon pricing?" },
      { date: "2026-11-10", question: "Supabase pricing?" },
    ]).ask("What did I ask you last Tuesday?");
    expect(m.resolved.map((r) => r.label)).toEqual(["Tue 3 Nov", "Tue 10 Nov"]);
    expect(m.assumptions[0]?.chosen).toBe("Tue 3 Nov and Tue 10 Nov");
    expect(m.exchanges).toHaveLength(2);
  });

  it("is honest when nothing exists on that day, and offers the nearest days", () => {
    const m = withChats([
      { date: "2026-10-28", question: "Vector databases?" },
      { date: "2026-11-04", question: "Redis alternatives?" },
    ]).ask("What did I ask you on 3 November?");
    expect(m.status).toBe("none-found");
    expect(m.nearest).toEqual({
      searched: "Tue 3 Nov",
      before: { localDate: "2026-10-28", title: "Vector databases?" },
      after: { localDate: "2026-11-04", title: "Redis alternatives?" },
    });
    const text = formatMemory(m, 2026)!;
    expect(text).toContain('status="none-found"');
    expect(text).toContain('Wed 4 Nov ("Redis alternatives?")');
    expect(text).toContain("never invent");
  });

  it("tells the model plainly when the user has no saved conversations at all (live finding)", () => {
    const text = formatMemory(withChats([]).ask("What did I ask you on 3 November?"), 2026)!;
    expect(text).toContain("No conversation found on Tue 3 Nov. This user has no other saved conversations at all.");
  });

  it("finds past chats by topic when no date is given", () => {
    const m = demo().ask("What did you recommend for Postgres hosting?");
    expect(m.status).toBe("found");
    expect(m.exchanges[0]?.threadTitle).toBe("Cheapest managed Postgres for a side project");
  });

  it("does not consult memory for an ordinary question, but keeps the index available", () => {
    const m = demo().ask("What's the weather like in Lisbon in spring?");
    expect(m.status).toBe("not-needed");
    expect(m.index).toHaveLength(3);
    expect(formatMemory(m, 2026)).toMatch(/^<memory>\nRecent conversations \(index only/);
  });

  it("excludes the current thread (it is already in the history)", () => {
    const { repo, scope, ask } = demo();
    const crm = repo.listThreads(scope).find((t) => t.title.startsWith("CRM"))!;
    const m = ask("What did we shortlist on Monday?", crm.id);
    expect(m.status).toBe("none-found");
  });

  it("never recalls another profile's conversations", () => {
    const { repo } = demo();
    const stranger = { userId: repo.createProfile(repo.createDevice(), "Stranger").id };
    const m = recall(repo, { scope: stranger, message: "What did I ask you on 3 November about Postgres?", now: NOW, tz: TZ });
    expect(m.status).toBe("none-found");
    expect(m.index).toEqual([]);
  });
});

describe("memory block", () => {
  it("shows the past exchange with its date, without stale citation markers, and the since-date", () => {
    const text = formatMemory(demo().ask("What did I ask you on 3 November? Is it still correct?"), 2026)!;
    expect(text).toContain('Resolved: "on 3 November" → Tue 3 Nov.');
    expect(text).toContain('<conversation date="Tue 3 Nov" thread="Cheapest managed Postgres for a side project">');
    expect(text).toContain("$0.106 per CU-hour");
    expect(text).not.toMatch(/\[S\d\]/);
    expect(text).toContain("neon.com: Pricing — Neon (retrieved 2026-11-03)");
    expect(text).toContain("since = 2026-11-03");
    expect(text).toContain("<facts_then>\n- Neon (Free) · compute per project = 100 CU-hours/month [seen Tue 3 Nov]");
    expect(text).toContain("- Railway (Free) · availability = no free plan, one-time trial credit only [seen Tue 3 Nov]");
    expect(text).toContain("<official_sites>Neon: neon.com; Supabase: supabase.com; Railway: railway.com</official_sites>");
  });

  it("mentions the alternative reading of an ambiguous date", () => {
    const text = formatMemory(demo().ask("Last Tuesday I asked you about Postgres hosting."), 2026)!;
    expect(text).toContain('"Last Tuesday" could also mean Tue 10 Nov (no conversations that day).');
  });
});

describe("intent", () => {
  it.each([
    ["On Monday we shortlisted 5 CRM tools", true, false],
    ["What did I ask you on 3 November?", true, false],
    ["Is your answer still correct today?", true, true],
    ["Has any pricing changed since then?", false, true],
    ["What's the capital of Peru?", false, false],
  ])("%s → memoryCue=%s changeCheck=%s", (text, memoryCue, changeCheck) => {
    expect(detectIntent(text)).toMatchObject({ memoryCue, changeCheck });
  });
});
