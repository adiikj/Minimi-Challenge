import { runChatTurn, type ChatDeps } from "../../src/agent/chat-turn";
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
const QUESTION = "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";

async function run(label: string, prefetch: boolean) {
  const db = openDb(`./data/test-m6-${label}-${Date.now()}.db`);
  const repo = createRepo(db, () => systemClock.now());
  const deps: ChatDeps = {
    repo,
    llm: createMistralProvider({ apiKey: config.mistralApiKey }),
    clock: systemClock,
    search: new SearchService({
      provider: recordingProvider(createTavilyProvider({ apiKey: config.tavilyApiKey }), config.searchFixturesDir),
      reader: createJinaReader(),
      cache: new SearchCache(new SqliteCacheStore(db)),
    }),
    settings: { model: config.model, reasoningEffort: "low", maxTokens: 4000, maxRounds: 4, deadlineMs: 45_000, maxQueriesPerTurn: 12, prefetch },
  };
  const { profileId } = seedDemo(repo, { now: new Date(), tz: TZ });
  const t0 = performance.now();
  let firstFeedback: number | null = null;
  let text = "";
  let trace;
  const statuses: string[] = [];
  for await (const e of runChatTurn({ scope: { userId: profileId }, message: QUESTION, clientTz: TZ }, deps, new AbortController().signal)) {
    if ((e.type === "status" && e.state === "start") || e.type === "text") firstFeedback ??= Math.round(performance.now() - t0);
    if (e.type === "status" && e.state === "start") statuses.push(e.label);
    if (e.type === "text") text += e.delta;
    if (e.type === "done") trace = e.trace;
    if (e.type === "error") console.log(label, "error:", e.message);
  }
  return { label, firstFeedback, trace, statuses, text };
}

const on = await run("prefetch-on", true);
const off = process.argv.includes("--on-only") ? null : await run("prefetch-off", false);

for (const r of [on, off].filter((x): x is NonNullable<typeof x> => x !== null)) {
  const t = r.trace!;
  console.log(`\n===== ${r.label}`);
  console.log(`first visible feedback ${r.firstFeedback} ms | first answer token ${t.firstTokenMs} ms | total ${t.totalMs} ms | rounds ${t.rounds}`);
  console.log(`searches ${t.search.queries} (${t.search.credits} credits) | sources ${t.search.sources} | cost $${t.costUsd.toFixed(4)} | tokens in ${t.usage.inputTokens} (cached ${t.usage.cachedInputTokens}) out ${t.usage.outputTokens}`);
  console.log(`citations used ${t.citations.used.length}, invalid ${t.citations.invalid.length}${t.prefetch ? ` | prefetch ${t.prefetch.queries} queries in ${t.prefetch.ms} ms` : ""}`);
  console.log("statuses:", r.statuses.join(" → "));
  console.log("--- answer (first 900 chars) ---\n" + r.text.slice(0, 900));
}
