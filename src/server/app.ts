import "server-only";
import { dirname, join } from "node:path";
import type { ChatDeps } from "@/agent/chat-turn";
import { MemoryWriter } from "@/agent/memory-writer";
import { clockFor } from "@/core/clock";
import { getConfig, type Config } from "@/core/config";
import { loadOrCreateSecret } from "@/identity/cookies";
import { createMistralProvider } from "@/llm/mistral";
import { migrate, openDb, type Db } from "@/memory/db";
import { createRepo, type Repo } from "@/memory/repo";
import { SqliteCacheStore } from "@/memory/search-cache-store";
import { SearchCache } from "@/search/cache";
import { createJinaReader } from "@/search/reader";
import { recordingProvider, replayProvider } from "@/search/recorder";
import { SearchService } from "@/search/service";
import { createTavilyProvider } from "@/search/tavily";
import type { SearchProvider } from "@/search/types";

export type App = { repo: Repo; chat: ChatDeps; secret: string };

// Only the DB connection survives hot reloads; everything else is rebuilt so code changes apply.
const g = globalThis as unknown as { __minimiDb?: { path: string; db: Db } };
let app: App | undefined;

function database(path: string): Db {
  if (g.__minimiDb?.path !== path) g.__minimiDb = { path, db: openDb(path) };
  migrate(g.__minimiDb.db);
  return g.__minimiDb.db;
}

export function getApp(): App {
  if (app) return app;
  const config = getConfig();
  const clock = clockFor(config.fixedNow);
  const db = database(config.databasePath);
  const repo = createRepo(db, () => clock.now());
  const llm = createMistralProvider({ apiKey: config.mistralApiKey });

  app = {
    repo,
    secret: loadOrCreateSecret(config.sessionSecret, join(dirname(config.databasePath), "secret")),
    chat: {
      repo,
      clock,
      llm,
      writer: new MemoryWriter({ llm, repo, model: config.backgroundModel, log: (msg, err) => console.warn(msg, err) }),
      spendLimitUsd: config.spendLimitUsd,
      search: new SearchService({
        provider: searchProvider(config),
        reader: createJinaReader(),
        cache: new SearchCache(new SqliteCacheStore(db)),
      }),
      settings: {
        model: config.model,
        reasoningEffort: "low",
        maxTokens: 4000,
        maxRounds: 4,
        deadlineMs: 45_000,
        maxQueriesPerTurn: 12,
        prefetch: config.prefetch,
      },
    },
  };
  return app;
}

function searchProvider(config: Config): SearchProvider {
  if (config.searchMode === "replay") return replayProvider("tavily", config.searchFixturesDir);
  const live = createTavilyProvider({ apiKey: config.tavilyApiKey });
  return config.searchMode === "record" ? recordingProvider(live, config.searchFixturesDir) : live;
}
