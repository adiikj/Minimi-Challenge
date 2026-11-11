import { readFileSync } from "node:fs";
import { z } from "zod";

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(["memory", "web", "no-search", "safety"]),
  now: z.string(),
  tz: z.string(),
  setup: z.enum(["empty", "demo"]),
  message: z.string(),
  ablations: z.boolean().default(false),
  expect: z.object({
    memory: z.enum(["found", "none-found", "not-needed"]).optional(),
    recalledDate: z.string().optional(),
    statesDate: z.array(z.string()).optional(),
    mentions: z.array(z.string()).default([]),
    mentionsAny: z.array(z.string()).default([]),
    mustNotMention: z.array(z.string()).default([]),
    searched: z.boolean().optional(),
    minCitations: z.number().default(0),
    honestNotFound: z.boolean().optional(),
  }),
  rubric: z.string(),
});
export type Scenario = z.infer<typeof Scenario>;

export function loadScenarios(path: string): Scenario[] {
  return z.array(Scenario).parse(JSON.parse(readFileSync(path, "utf8")));
}

export const GROUND_TRUTH: Record<Scenario["setup"], string> = {
  empty: "This user has no saved conversations at all.",
  demo: [
    "The user's saved history (demo profile):",
    "- Fri 30 Oct: asked for a cold email to a CTO about a database monitoring tool.",
    "- Tue 3 Nov: asked for the cheapest managed Postgres for a side project, comparing Neon, Supabase and Railway. The answer said: Neon free tier is cheapest (100 CU-hours, 0.5 GB per project; Launch $0.106/CU-hour + $0.35/GB-month), Supabase Free 500 MB (paused after a week idle) and Pro $25/month, Railway had no free plan (one-time trial credit) and Hobby $5/month incl. $5 usage.",
    "- Mon 9 Nov: shortlisted 5 CRMs for a 20-person sales team: HubSpot Sales Hub Professional $90, Pipedrive Advanced $29, Salesforce Sales Cloud Pro Suite $100, Zoho CRM Professional $23, Freshsales Growth $9 (per seat per month, billed annually).",
    "There are no other conversations (none on 5 Nov or 10 Nov).",
  ].join("\n"),
};
