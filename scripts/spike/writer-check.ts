import { MemoryWriter } from "../../src/agent/memory-writer";
import { createMistralProvider } from "../../src/llm/mistral";
import { openDb } from "../../src/memory/db";
import { createRepo } from "../../src/memory/repo";
import { seedDemo } from "../../src/memory/seed";

const NOW = new Date("2026-11-11T08:35:00Z");
const repo = createRepo(openDb(":memory:"), () => NOW);
const { profileId } = seedDemo(repo, { now: NOW, tz: "Asia/Kolkata" });
const scope = { userId: profileId };

const old = repo.listThreads(scope).find((t) => t.title.startsWith("Cheapest"))!;
const oldAnswer = repo.listMessages(scope, old.id).find((m) => m.role === "assistant")!;
const existing = repo.claimsForMessages(scope, [oldAnswer.id]);

const answer = `I've taken "last Tuesday" as Tue 3 Nov (there's no conversation on 10 Nov). Back then I told you: Neon free tier ($0, 100 CU-hours + 0.5 GB), Neon Launch at $0.106/CU-hour + $0.35/GB-month, Supabase free (500 MB) and Pro at $25/mo, Railway Hobby at $5/mo. Let me re-check those now.

Mostly no — but there are two notable updates since 3 Nov (as of today, 11 Nov 2026):

- ✅ **Supabase — unchanged.** Free tier still has 500 MB database; Pro is still $25/month with $10 of compute credits included [S1][S3].
- ⚠️ **Railway — changed.** Railway now has a permanent **Free plan at $0/month with $1 of free monthly resources**, not just a one-time trial credit. Hobby is still $5/month [S2][S7].
- ⚠️ **Neon — free tier got better; paid rate needs a caveat.** The free tier now includes **1 GB storage per project** (up from 0.5 GB) and 100 CU-hours monthly, up to 100 projects [S6]. For Launch, Neon's own explainer lists compute at **$0.14 per CU-hour** (storage still $0.35/GB-month) [S5] — higher than the $0.106 I quoted on 3 Nov, but today's pricing page snippet didn't show the current per-CU-hour rate, so I can't confirm whether it's $0.106 or $0.14 right now.

**Bottom line:** Supabase pricing is the same; Railway is arguably a better deal now with a real free tier; Neon's free storage doubled.`;

const t = repo.createThread(scope, "Last Tuesday I asked you about Postgres hosting");
repo.addMessage(scope, { threadId: t.id, role: "user", content: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", tz: "Asia/Kolkata" });
const a = repo.addMessage(scope, { threadId: t.id, role: "assistant", content: answer, tz: "Asia/Kolkata" });
const src = (id: string, domain: string, title: string) => ({ id, url: `https://${domain}`, domain, title, retrievedAt: "2026-11-11", excerpt: title });

const writer = new MemoryWriter({
  llm: createMistralProvider({ apiKey: process.env.MISTRAL_API_KEY! }),
  repo,
  model: "mistral-small-2603",
  log: (m, e) => console.error(m, e),
});
const t0 = performance.now();
const result = await writer.run({
  scope,
  threadId: t.id,
  messageId: a.id,
  question: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
  answer,
  observedAt: "2026-11-11",
  sources: [
    src("S1", "supabase.com", "Pricing & Fees | Supabase"),
    src("S2", "railway.com", "Pricing | Railway"),
    src("S3", "supabase.com", "Supabase docs: billing"),
    src("S5", "neon.com", "Neon pricing explained"),
    src("S6", "neon.com", "Neon plans"),
    src("S7", "docs.railway.com", "Railway plans"),
  ],
  existing,
  wantTitle: true,
});
console.log("result:", result, `${Math.round(performance.now() - t0)} ms, spend $${repo.totalSpend().toFixed(5)}`);
console.log("title:", repo.getThread(scope, t.id)?.title);
console.log("\nOLD facts after the run:");
for (const c of repo.claimsForMessages(scope, [oldAnswer.id]))
  console.log(` ${c.supersededBy ? "SUPERSEDED →" : c.confirmedAt ? "confirmed   " : "untouched   "} ${c.entity} (${c.plan}) · ${c.attribute} = ${c.value}${c.supersededBy ? `  →  ${c.supersededBy.value}` : ""}`);
console.log("\nNEW facts:");
for (const c of repo.claimsForMessages(scope, [a.id]))
  console.log(` ${c.confidence.padEnd(4)} ${c.entity} (${c.plan}) · ${c.attribute} = ${c.value}${c.previousValue ? ` (was ${c.previousValue})` : ""}${c.effectiveFrom ? ` [effective ${c.effectiveFrom}]` : ""} ${c.sourceLabel ?? ""}`);
console.log("\nentities:", repo.entitiesForMessages(scope, [a.id]).map((e) => `${e.name}=${e.domain}`).join(", "));
