import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChatTurn, type ChatDeps, type MemoryOptions } from "../src/agent/chat-turn";
import { fixedClock } from "../src/core/clock";
import { parseConfig } from "../src/core/config";
import type { TurnTrace } from "../src/core/types";
import { createMistralProvider } from "../src/llm/mistral";
import { openDb } from "../src/memory/db";
import { createRepo, type StoredSource } from "../src/memory/repo";
import { seedDemo } from "../src/memory/seed";
import { SearchCache } from "../src/search/cache";
import { nearestReplayProvider, recordingProvider } from "../src/search/recorder";
import { SearchService } from "../src/search/service";
import { createTavilyProvider } from "../src/search/tavily";
import type { SearchProvider } from "../src/search/types";
import { runChecks, type Check } from "./checks";
import { judge, type Verdict } from "./judge";
import { loadScenarios, type Scenario } from "./scenario";

type Arm = { name: string; memory: MemoryOptions; prefetch: boolean; ablation: boolean };
const ARMS: Arm[] = [
  { name: "A", memory: { enabled: false }, prefetch: false, ablation: false },
  { name: "C", memory: {}, prefetch: false, ablation: false },
  { name: "C+", memory: {}, prefetch: true, ablation: false },
  { name: "C+ -dates", memory: { dates: false }, prefetch: true, ablation: true },
  { name: "C+ -ledger", memory: { facts: false }, prefetch: true, ablation: true },
];
const JUDGE_MODEL = "mistral-large-4";

const args = process.argv.slice(2);
const opt = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = parseConfig(process.env);
const llm = createMistralProvider({ apiKey: config.mistralApiKey });
const record = args.includes("--record");
const withJudge = !args.includes("--no-judge");
const onlyArms = opt("--arms")?.split(",");
const onlyIds = opt("--only")?.split(",");

const scenarios = loadScenarios(join(import.meta.dirname, "scenarios.json")).filter((s) => !onlyIds || onlyIds.includes(s.id));
const arms = ARMS.filter((a) => !onlyArms || onlyArms.includes(a.name));

type Row = {
  scenario: string;
  category: Scenario["category"];
  arm: string;
  checks: Check[];
  checksPassed: boolean;
  verdict: Verdict | null;
  judgeError?: string;
  trace: TurnTrace | null;
  answer: string;
  replayMisses: string[];
  costUsd: number;
  judgeCostUsd: number;
};

function searchProvider(): SearchProvider & { misses: string[] } {
  if (!record) return nearestReplayProvider("tavily", config.searchFixturesDir);
  const live = recordingProvider(createTavilyProvider({ apiKey: config.tavilyApiKey }), config.searchFixturesDir);
  return Object.assign(live, { misses: [] as string[] });
}

async function runOne(s: Scenario, arm: Arm): Promise<Row> {
  const now = new Date(s.now);
  const repo = createRepo(openDb(":memory:"), () => now);
  const scope = { userId: s.setup === "demo" ? seedDemo(repo, { now, tz: s.tz }).profileId : repo.createProfile(repo.createDevice(), "Eval", { tz: s.tz }).id };
  const provider = searchProvider();
  const deps: ChatDeps = {
    repo,
    llm,
    clock: fixedClock(now),
    memory: arm.memory,
    search: new SearchService({ provider, cache: new SearchCache() }),
    settings: { model: config.model, reasoningEffort: "low", maxTokens: 4000, maxRounds: 4, deadlineMs: 45_000, maxQueriesPerTurn: 12, prefetch: arm.prefetch },
  };

  let answer = "";
  let trace: TurnTrace | null = null;
  let error: string | null = null;
  let threadId = "";
  for await (const e of runChatTurn({ scope, message: s.message, clientTz: s.tz }, deps, AbortSignal.timeout(120_000))) {
    if (e.type === "thread") threadId = e.thread.id;
    if (e.type === "text") answer += e.delta;
    if (e.type === "done") trace = e.trace;
    if (e.type === "error") error = e.message;
  }
  const checks = runChecks(s, { answer, trace, error });
  const sources: StoredSource[] = threadId ? (repo.listMessages(scope, threadId).find((m) => m.role === "assistant")?.sources ?? []) : [];
  const j = withJudge && !error ? await judge(llm, JUDGE_MODEL, s, answer, sources) : { verdict: null, costUsd: 0 };
  return {
    scenario: s.id,
    category: s.category,
    arm: arm.name,
    checks,
    checksPassed: checks.every((c) => c.pass),
    verdict: j.verdict,
    ...("error" in j && j.error ? { judgeError: j.error } : {}),
    trace,
    answer,
    replayMisses: provider.misses,
    costUsd: trace?.costUsd ?? 0,
    judgeCostUsd: j.costUsd,
  };
}

const rows: Row[] = [];
const started = Date.now();
for (const s of scenarios) {
  for (const arm of arms) {
    if (arm.ablation && !s.ablations) continue;
    const row = await runOne(s, arm);
    rows.push(row);
    const failed = row.checks.filter((c) => !c.pass).map((c) => c.name);
    console.log(
      `${row.checksPassed ? "✓" : "✗"} ${s.id.padEnd(18)} ${arm.name.padEnd(10)} judge ${row.verdict ? (row.verdict.pass ? "pass" : "FAIL") : "—   "} ` +
        `${row.trace ? `${(row.trace.totalMs / 1000).toFixed(1)}s ${row.trace.rounds}r $${row.costUsd.toFixed(4)}` : ""}` +
        `${failed.length ? `  failed: ${failed.join("; ")}` : ""}${row.replayMisses.length ? `  replay misses: ${row.replayMisses.length}` : ""}`,
    );
  }
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)]! : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function summary(subset: Row[]) {
  const judged = subset.filter((r) => r.verdict);
  const traced = subset.filter((r) => r.trace);
  return {
    n: subset.length,
    checks: pct(subset.filter((r) => r.checksPassed).length, subset.length),
    judge: `${pct(judged.filter((r) => r.verdict!.pass).length, judged.length)} (${judged.length}/${subset.length})`,
    quality: judged.length ? mean(judged.map((r) => (r.verdict!.correctness + r.verdict!.grounding + r.verdict!.honesty + r.verdict!.concision) / 4)).toFixed(2) : "–",
    firstToken: sec(median(traced.map((r) => r.trace!.firstTokenMs ?? r.trace!.totalMs))),
    total: sec(median(traced.map((r) => r.trace!.totalMs))),
    rounds: mean(traced.map((r) => r.trace!.rounds)).toFixed(1),
    searches: mean(traced.map((r) => r.trace!.search.queries)).toFixed(1),
    cost: `$${mean(subset.map((r) => r.costUsd)).toFixed(4)}`,
  };
}

const lines: string[] = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
lines.push(`# Eval results (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`, "");
lines.push(
  `Answering model \`${config.model}\`, judge \`${withJudge ? JUDGE_MODEL : "off"}\`, search ${record ? "live (recorded)" : "replayed from fixtures (0 credits)"}. ` +
    `${rows.length} turns in ${Math.round((Date.now() - started) / 1000)} s. ` +
    `Spend: answers $${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(3)}, judge $${rows.reduce((a, r) => a + r.judgeCostUsd, 0).toFixed(3)}.`,
  "",
  "Latency with replayed search measures model time only (search returns instantly).",
  "",
);

const groups: Array<[string, (r: Row) => boolean]> = [
  ["All scenarios", () => true],
  ["Memory scenarios", (r) => r.category === "memory"],
  ["Other scenarios (web, no-search, safety)", (r) => r.category !== "memory"],
];
for (const [title, filter] of groups) {
  const subset = rows.filter(filter);
  if (!subset.length) continue;
  lines.push(`## ${title}`, "", "| Arm | n | Checks pass | Judge pass | Quality (1–5) | First token (p50) | Total (p50) | Rounds | Searches | Cost / turn |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of ARMS) {
    const s = subset.filter((r) => r.arm === arm.name);
    if (!s.length) continue;
    const m = summary(s);
    lines.push(`| ${arm.name} | ${m.n} | ${m.checks} | ${m.judge} | ${m.quality} | ${m.firstToken} | ${m.total} | ${m.rounds} | ${m.searches} | ${m.cost} |`);
  }
  lines.push("");
}

lines.push("## Per scenario", "", `| Scenario | ${ARMS.filter((a) => rows.some((r) => r.arm === a.name)).map((a) => a.name).join(" | ")} |`, `|---|${ARMS.filter((a) => rows.some((r) => r.arm === a.name)).map(() => "---").join("|")}|`);
for (const s of scenarios) {
  const cells = ARMS.filter((a) => rows.some((r) => r.arm === a.name)).map((a) => {
    const r = rows.find((x) => x.scenario === s.id && x.arm === a.name);
    if (!r) return "·";
    return `${r.checksPassed ? "✓" : "✗"}${r.verdict ? (r.verdict.pass ? " ✓" : " ✗") : ""}`;
  });
  lines.push(`| ${s.id} | ${cells.join(" | ")} |`);
}
lines.push("", "Cells: deterministic checks, then judge (✓ pass / ✗ fail). · = not run in that arm.", "", "## Failures", "");
for (const r of rows.filter((x) => !x.checksPassed || (x.verdict && !x.verdict.pass))) {
  const failed = r.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  lines.push(`- **${r.scenario} / ${r.arm}**: ${failed.length ? `checks: ${failed.join("; ")}. ` : ""}${r.verdict && !r.verdict.pass ? `judge: ${r.verdict.reason}` : ""}`);
}

const outDir = join(import.meta.dirname, "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ config: { model: config.model, judge: withJudge ? JUDGE_MODEL : null, record }, rows }, null, 1));
writeFileSync(join(outDir, "latest.md"), `${lines.join("\n")}\n`);
console.log(`\n${lines.join("\n")}\n\nSaved evals/results/latest.md and evals/results/${stamp}.json`);
