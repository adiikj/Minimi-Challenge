import { z } from "zod";
import { ConfigError } from "./errors";

const required = (hint: string) => z.string({ error: `is required (${hint})` }).min(1, `is required (${hint})`);

const EnvSchema = z.object({
  MISTRAL_API_KEY: required("https://console.mistral.ai"),
  TAVILY_API_KEY: required("https://app.tavily.com, free tier"),
  AGENT_MODEL: z.string().min(1).default("zai-glm-5-3"),
  AGENT_BACKGROUND_MODEL: z.string().min(1).default("mistral-small-2603"),
  AGENT_NOW: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "AGENT_NOW must be an ISO date-time"),
  SPEND_LIMIT_USD: z.coerce.number().min(0).default(4),
  DATABASE_PATH: z.string().min(1).default("./data/agent.db"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters").optional(),
  SEARCH_MODE: z.enum(["live", "record", "replay"]).default("live"),
  PREFETCH: z.enum(["on", "off"]).default("on"),
  SEARCH_FIXTURES_DIR: z.string().min(1).default("./evals/fixtures/search"),
});

export type Config = {
  mistralApiKey: string;
  tavilyApiKey: string;
  model: string;
  backgroundModel: string;
  fixedNow: Date | undefined;
  spendLimitUsd: number;
  databasePath: string;
  searchMode: "live" | "record" | "replay";
  searchFixturesDir: string;
  sessionSecret: string | undefined;
  prefetch: boolean;
};

export function parseConfig(env: Record<string, string | undefined>): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".")} ${i.message}`).join("\n");
    throw new ConfigError(`Invalid environment. Copy .env.example to .env and fix:\n${problems}`);
  }
  const e = result.data;
  return {
    mistralApiKey: e.MISTRAL_API_KEY,
    tavilyApiKey: e.TAVILY_API_KEY,
    model: e.AGENT_MODEL,
    backgroundModel: e.AGENT_BACKGROUND_MODEL,
    fixedNow: e.AGENT_NOW ? new Date(e.AGENT_NOW) : undefined,
    spendLimitUsd: e.SPEND_LIMIT_USD,
    databasePath: e.DATABASE_PATH,
    searchMode: e.SEARCH_MODE,
    searchFixturesDir: e.SEARCH_FIXTURES_DIR,
    sessionSecret: e.SESSION_SECRET,
    prefetch: e.PREFETCH === "on",
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}
