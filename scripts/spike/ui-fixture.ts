import type { TurnTrace } from "../../src/core/types";
import { zonedToUtc } from "../../src/lib/dates";
import { openDb } from "../../src/memory/db";
import { createRepo } from "../../src/memory/repo";
import { seedDemo } from "../../src/memory/seed";

const path = process.argv[2] ?? "./data/test-ui.db";
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date();
let clock = now;
const repo = createRepo(openDb(path), () => clock);
const { profileId, dates } = seedDemo(repo, { now, tz });
const scope = { userId: profileId };

const postgres = repo.listThreads(scope).find((t) => t.title.startsWith("Cheapest"))!;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
clock = zonedToUtc(today, "09:12", tz);
const t = repo.createThread(scope, "Postgres hosting pricing updates");
repo.addMessage(scope, { threadId: t.id, role: "user", content: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", tz, createdAt: clock.toISOString() });
const answer = `Mostly no, but two things changed since Tue 3 Nov (checked today):

| Fact from 3 Nov | Verdict |
|---|---|
| Neon Free: 0.5 GB storage per project | ⚠️ now **1 GB per project** [S1] |
| Neon Launch: $0.106 per CU-hour | ✅ still holds [S2] |
| Supabase Pro: $25/month | ✅ still holds [S3] |
| Railway: no free plan | ⚠️ now a **Free plan with $1 of monthly usage credit** [S4] |

**Bottom line:** the recommendation holds. Neon is still the best free pick for plain Postgres, and its free storage doubled. Railway is now a real free option for very small projects.`;
const a = repo.addMessage(scope, { threadId: t.id, role: "assistant", content: answer, tz, createdAt: new Date(clock.getTime() + 6_300).toISOString() });
const src = (id: string, url: string, domain: string, title: string, publishedAt?: string) => ({
  id, url, domain, title, retrievedAt: today, excerpt: "(fixture)", ...(publishedAt ? { publishedAt } : {}),
});
repo.saveSources(scope, a.id, [
  src("S1", "https://neon.com/pricing", "neon.com", "Pricing — Neon"),
  src("S2", "https://neon.com/docs/introduction/plans", "neon.com", "Neon plans — Neon Docs", "2026-10-30"),
  src("S3", "https://supabase.com/pricing", "supabase.com", "Pricing & Fees | Supabase"),
  src("S4", "https://railway.com/pricing", "railway.com", "Pricing | Railway"),
  src("S5", "https://example-review.dev/neon", "example-review.dev", "Neon Review 2026: Plans and Limits", "2026-06-18"),
]);
const trace: TurnTrace = {
  model: "zai-glm-5-3", rounds: 2, totalMs: 6_300, firstTokenMs: 600,
  usage: { inputTokens: 9_000, cachedInputTokens: 2_000, outputTokens: 600, reasoningTokens: 0 },
  costUsd: 0.0101, truncated: false,
  search: { queries: 4, credits: 4, cacheHits: 0, sources: 5, ms: 2_100 },
  citations: { used: ["S1", "S2", "S3", "S4"], invalid: [] },
  memory: {
    status: "found",
    assumptions: [{ phrase: "Last Tuesday", chosen: "Tue 3 Nov", alternatives: [{ label: "Tue 10 Nov", hasConversations: false }] }],
    refs: [{ threadId: postgres.id, title: postgres.title, localDate: dates.lastTuesday }],
    ms: 2,
  },
  prefetch: { queries: 6, sources: 5, ms: 1_800 },
  spans: [
    { kind: "memory", label: "Memory: 1 past conversation", startMs: 0, ms: 2 },
    { kind: "prefetch", label: "Prefetch: 3 items", startMs: 3, ms: 1_800, queries: ["Neon pricing", "Neon announcement", "Supabase pricing", "Supabase announcement", "Railway pricing", "Railway announcement"], cacheHits: 1 },
    { kind: "model", label: "Model, round 1 → search", startMs: 1_810, ms: 1_350, usage: { inputTokens: 4_100, cachedInputTokens: 2_000, outputTokens: 90, reasoningTokens: 0 } },
    { kind: "search", label: "Search: 1 query", startMs: 3_170, ms: 300, queries: ["Neon Launch compute price per CU-hour"], cacheHits: 0 },
    { kind: "model", label: "Model, round 2", startMs: 3_480, ms: 2_810, firstTextMs: 4_050, usage: { inputTokens: 4_900, cachedInputTokens: 0, outputTokens: 510, reasoningTokens: 0 } },
  ],
};
repo.saveTrace(scope, a.id, trace);

const old = repo.claimsForMessages(scope, repo.messageIds(scope, postgres.id, "assistant")).find((c) => c.attribute === "storage per project")!;
const [newId] = repo.saveClaims(scope, { messageId: a.id, threadId: t.id }, [
  { entity: "Neon", plan: "Free", attribute: "storage per project", value: "1 GB", previousValue: "0.5 GB", observedAt: today, confidence: "high" },
]);
repo.supersede(scope, old.id, newId!);
console.log(`fixture ready in ${path}: demo profile ${profileId}, QA thread ${t.id}`);
