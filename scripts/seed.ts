import { openDb } from "../src/memory/db";
import { createRepo } from "../src/memory/repo";
import { DEMO_PROFILE_NAME, seedDemo } from "../src/memory/seed";

try {
  process.loadEnvFile(".env");
} catch {
}

const now = process.env.AGENT_NOW ? new Date(process.env.AGENT_NOW) : new Date();
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dbPath = process.env.DATABASE_PATH || "./data/agent.db";

const repo = createRepo(openDb(dbPath), () => now);
const { dates } = seedDemo(repo, { now, tz });

console.log(`Seeded "${DEMO_PROFILE_NAME}" in ${dbPath} (time zone ${tz}):`);
console.log(`  Postgres hosting chat ........ ${dates.lastTuesday}  ("last Tuesday")`);
console.log(`  CRM shortlist ................ ${dates.lastMonday}  ("on Monday")`);
console.log(`  3 November ................... ${dates.nov3}`);
console.log(`  Unrelated chat ............... ${dates.unrelated}`);
console.log(`Open the app, pick "${DEMO_PROFILE_NAME}" in the profile menu, and ask the brief's questions.`);
