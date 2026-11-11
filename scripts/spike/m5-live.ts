import { buildMemory, runChatTurn, type ChatDeps } from "../../src/agent/chat-turn";
import { MemoryWriter } from "../../src/agent/memory-writer";
import { systemClock } from "../../src/core/clock";
import { parseConfig } from "../../src/core/config";
import { createMistralProvider } from "../../src/llm/mistral";
import { openDb } from "../../src/memory/db";
import { createRepo } from "../../src/memory/repo";
import { SqliteCacheStore } from "../../src/memory/search-cache-store";
import { seedDemo } from "../../src/memory/seed";
import { SearchCache } from "../../src/search/cache";
import { createJinaReader } from "../../src/search/reader";
import { recordingProvider } from "../../src/search/recorder";
import { SearchService } from "../../src/search/service";
import { createTavilyProvider } from "../../src/search/tavily";

const config = parseConfig(process.env);
const TZ = "Asia/Kolkata";
const db = openDb(`./data/test-m5-${Date.now()}.db`);
const repo = createRepo(db, () => systemClock.now());
const llm = createMistralProvider({ apiKey: config.mistralApiKey });
const writer = new MemoryWriter({ llm, repo, model: config.backgroundModel, log: (m, e) => console.error(m, e) });
const deps: ChatDeps = {
  repo,
  llm,
  writer,
  clock: systemClock,
  spendLimitUsd: config.spendLimitUsd,
  search: new SearchService({
    provider: recordingProvider(createTavilyProvider({ apiKey: config.tavilyApiKey }), config.searchFixturesDir),
    reader: createJinaReader(),
    cache: new SearchCache(new SqliteCacheStore(db)),
  }),
  settings: { model: config.model, reasoningEffort: "low", maxTokens: 4000, maxRounds: 4, deadlineMs: 45_000, maxQueriesPerTurn: 12 },
};
const { profileId } = seedDemo(repo, { now: new Date(), tz: TZ });
const scope = { userId: profileId };

async function turn(label: string, message: string) {
  console.log(`\n===== ${label}: ${message}`);
  let text = "";
  for await (const e of runChatTurn({ scope, message, clientTz: TZ }, deps, new AbortController().signal)) {
    if (e.type === "text") text += e.delta;
    else if (e.type === "status" && e.state === "start") console.log("status:", e.label);
    else if (e.type === "memory") console.log("memory:", e.status, e.refs.map((r) => `${r.localDate} ${r.title}`).join(" | "));
    else if (e.type === "done")
      console.log(`done: ${e.trace.totalMs} ms, first token ${e.trace.firstTokenMs} ms, ${e.trace.search.queries} queries (${e.trace.search.credits} credits), $${e.trace.costUsd.toFixed(4)}`);
    else if (e.type === "error") console.log("error:", e.message);
  }
  console.log(`--- answer ---\n${text}`);
}

await turn("A", "What did I ask you on 3 November? Is your answer still correct today?");
await writer.idle();

const old = repo.listThreads(scope).find((t) => t.title.startsWith("Cheapest"))!;
const oldAnswer = repo.listMessages(scope, old.id).find((m) => m.role === "assistant")!;
console.log("\n===== ledger after the background writer (3 Nov facts):");
for (const c of repo.claimsForMessages(scope, [oldAnswer.id]))
  console.log(` ${c.supersededBy ? "SUPERSEDED →" : c.confirmedAt ? "confirmed   " : "untouched   "} ${c.entity} (${c.plan}) · ${c.attribute} = ${c.value}${c.supersededBy ? `  →  ${c.supersededBy.value}` : ""}`);
console.log("thread titles:", repo.listThreads(scope).map((t) => t.title).join(" | "));

const q2 = "Has Neon's free tier changed since we talked on 3 November?";
const mem = buildMemory(repo, { scope, message: q2, now: new Date(), tz: TZ });
console.log("\n===== memory block facts for turn B:");
console.log((mem.text ?? "").split("\n").filter((l) => l.includes("Neon (")).join("\n"));
await turn("B", q2);
await writer.idle();
console.log(`\nTotal model spend in this DB: $${repo.totalSpend().toFixed(4)}`);
