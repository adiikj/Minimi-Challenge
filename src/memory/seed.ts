import { addDays, startOfWeek, weekday, ymd, zonedToUtc, type Ymd } from "@/lib/dates";
import { localDate, safeTimeZone } from "@/lib/time";
import type { Repo, StoredSource } from "./repo";

export const DEMO_PROFILE_NAME = "Demo (sample history)";

type SeedFact = { entity: string; plan?: string; attribute: string; value: string; source: string };
type SeedExchange = {
  date: Ymd;
  time: string;
  question: string;
  answer: string;
  sources: Array<Omit<StoredSource, "retrievedAt" | "excerpt">>;
  facts?: SeedFact[];
  entities?: Array<{ name: string; domain: string }>;
};
type SeedThread = { title: string; exchanges: SeedExchange[] };

export function seedDemo(repo: Repo, opts: { now: Date; tz?: string }): { profileId: string; dates: Record<string, Ymd> } {
  const tz = safeTimeZone(opts.tz);
  const today = localDate(opts.now, tz);
  const dates = demoDates(today);

  const profile = repo.findDemoProfile(DEMO_PROFILE_NAME) ?? repo.createProfile(null, DEMO_PROFILE_NAME, { isDemo: true, tz });
  const scope = { userId: profile.id };
  repo.clearThreads(scope);

  for (const thread of demoThreads(dates)) {
    const t = repo.createThread(scope, thread.title);
    for (const ex of thread.exchanges) {
      const asked = zonedToUtc(ex.date, ex.time, tz);
      const answered = new Date(asked.getTime() + 25_000);
      repo.addMessage(scope, { threadId: t.id, role: "user", content: ex.question, tz, createdAt: asked.toISOString() });
      const a = repo.addMessage(scope, { threadId: t.id, role: "assistant", content: ex.answer, tz, createdAt: answered.toISOString() });
      if (ex.sources.length) {
        repo.saveSources(
          scope,
          a.id,
          ex.sources.map((s) => ({ ...s, retrievedAt: ex.date, excerpt: "(demo history: excerpt not stored)" })),
        );
      }
      if (ex.facts?.length) {
        repo.saveClaims(
          scope,
          { messageId: a.id, threadId: t.id },
          ex.facts.map((x) => ({ entity: x.entity, plan: x.plan ?? null, attribute: x.attribute, value: x.value, sourceLabel: x.source, observedAt: ex.date, confidence: "high" })),
        );
      }
      if (ex.entities?.length) repo.saveEntities(scope, a.id, ex.entities);
    }
  }
  return { profileId: profile.id, dates };
}

export function demoDates(today: Ymd) {
  const lastTuesday = addDays(startOfWeek(today), -6);
  const back = (weekday(today) - 1 + 7) % 7 || 7;
  const lastMonday = addDays(today, -back);
  const year = Number(today.slice(0, 4));
  const nov3 = ymd(year, 11, 3)! <= today ? ymd(year, 11, 3)! : ymd(year - 1, 11, 3)!;
  const unrelated = addDays(lastTuesday, -4);
  return { lastTuesday, lastMonday, nov3, unrelated };
}

function demoThreads(d: ReturnType<typeof demoDates>): SeedThread[] {
  const threads: SeedThread[] = [
    {
      title: "Cheapest managed Postgres for a side project",
      exchanges: [
        {
          date: d.lastTuesday,
          time: "10:15",
          question: "What's the cheapest managed Postgres for a small side project? Compare Neon, Supabase and Railway.",
          answer: `For a small side project, **Neon's free tier** is the cheapest place to start, with Supabase close behind. Railway is cheap too but has no permanent free tier.

| | Free tier | First paid step |
|---|---|---|
| **Neon** | $0: 100 CU-hours of compute and 0.5 GB storage per project; scales to zero when idle [S1] | Launch: usage-based, $0.106 per CU-hour + $0.35 per GB-month [S1] |
| **Supabase** | $0: 500 MB database, 2 active projects; paused after 1 week of inactivity [S2] | Pro: $25/month, includes $10 of compute credits [S2] |
| **Railway** | No free tier, only a one-time trial credit [S3] | Hobby: $5/month, includes $5 of usage [S3] |

**My pick:** Neon if you only need Postgres; Supabase if you also want auth and file storage.`,
          sources: [
            { id: "S1", url: "https://neon.com/pricing", domain: "neon.com", title: "Pricing — Neon" },
            { id: "S2", url: "https://supabase.com/pricing", domain: "supabase.com", title: "Pricing & Fees | Supabase" },
            { id: "S3", url: "https://railway.com/pricing", domain: "railway.com", title: "Pricing | Railway" },
          ],
          facts: [
            { entity: "Neon", plan: "Free", attribute: "compute per project", value: "100 CU-hours/month", source: "S1" },
            { entity: "Neon", plan: "Free", attribute: "storage per project", value: "0.5 GB", source: "S1" },
            { entity: "Neon", plan: "Launch", attribute: "compute price", value: "$0.106 per CU-hour", source: "S1" },
            { entity: "Neon", plan: "Launch", attribute: "storage price", value: "$0.35 per GB-month", source: "S1" },
            { entity: "Supabase", plan: "Free", attribute: "database size", value: "500 MB", source: "S2" },
            { entity: "Supabase", plan: "Free", attribute: "inactivity pause", value: "after 1 week", source: "S2" },
            { entity: "Supabase", plan: "Pro", attribute: "monthly price", value: "$25/month", source: "S2" },
            { entity: "Railway", plan: "Free", attribute: "availability", value: "no free plan, one-time trial credit only", source: "S3" },
            { entity: "Railway", plan: "Hobby", attribute: "monthly price", value: "$5/month including $5 of usage", source: "S3" },
          ],
          entities: [
            { name: "Neon", domain: "neon.com" },
            { name: "Supabase", domain: "supabase.com" },
            { name: "Railway", domain: "railway.com" },
          ],
        },
      ],
    },
    {
      title: "CRM shortlist for a 20-person sales team",
      exchanges: [
        {
          date: d.lastMonday,
          time: "16:40",
          question: "We're a 20-person sales team. Shortlist 5 CRM tools for us, with per-seat pricing.",
          answer: `Here's a shortlist of 5 CRMs that fit a 20-person sales team (list price per seat per month, billed annually):

| CRM | Plan to start with | Per seat | Why it's on the list |
|---|---|---|---|
| **HubSpot Sales Hub** | Professional | $90 [S1] | Best all-in-one if marketing already uses HubSpot |
| **Pipedrive** | Advanced | $29 [S2] | Simplest pipeline view; fast to adopt |
| **Salesforce Sales Cloud** | Pro Suite | $100 [S3] | Most customisable; biggest ecosystem |
| **Zoho CRM** | Professional | $23 [S4] | Lowest cost for a full feature set |
| **Freshsales** | Growth | $9 [S5] | Built-in phone and email; cheapest |

For 20 seats that's roughly **$180 to $2,000 per month**. Next step: trial Pipedrive and HubSpot side by side for two weeks.`,
          sources: [
            { id: "S1", url: "https://www.hubspot.com/pricing/sales", domain: "hubspot.com", title: "Sales Hub pricing | HubSpot" },
            { id: "S2", url: "https://www.pipedrive.com/en/pricing", domain: "pipedrive.com", title: "Pricing | Pipedrive" },
            { id: "S3", url: "https://www.salesforce.com/sales/pricing/", domain: "salesforce.com", title: "Sales Cloud pricing | Salesforce" },
            { id: "S4", url: "https://www.zoho.com/crm/zohocrm-pricing.html", domain: "zoho.com", title: "Zoho CRM pricing" },
            { id: "S5", url: "https://www.freshworks.com/crm/pricing/", domain: "freshworks.com", title: "Freshsales pricing | Freshworks" },
          ],
          facts: [
            { entity: "HubSpot Sales Hub", plan: "Professional", attribute: "price per seat", value: "$90/month, billed annually", source: "S1" },
            { entity: "Pipedrive", plan: "Advanced", attribute: "price per seat", value: "$29/month, billed annually", source: "S2" },
            { entity: "Salesforce Sales Cloud", plan: "Pro Suite", attribute: "price per seat", value: "$100/month, billed annually", source: "S3" },
            { entity: "Zoho CRM", plan: "Professional", attribute: "price per seat", value: "$23/month, billed annually", source: "S4" },
            { entity: "Freshsales", plan: "Growth", attribute: "price per seat", value: "$9/month, billed annually", source: "S5" },
          ],
          entities: [
            { name: "HubSpot Sales Hub", domain: "hubspot.com" },
            { name: "Pipedrive", domain: "pipedrive.com" },
            { name: "Salesforce Sales Cloud", domain: "salesforce.com" },
            { name: "Zoho CRM", domain: "zoho.com" },
            { name: "Freshsales", domain: "freshworks.com" },
          ],
        },
      ],
    },
    {
      title: "Cold email to a CTO",
      exchanges: [
        {
          date: d.unrelated,
          time: "11:05",
          question: "Help me write a short cold email to a CTO about our database monitoring tool.",
          answer: `**Subject:** Catching slow queries before your users do

Hi {first name},

Most teams find out a query got slow when a customer complains. {Product} watches your Postgres and MySQL instances and flags regressions within minutes, with the exact query and the change that caused it.

Would a 15-minute walkthrough next week be useful?

{Your name}`,
          sources: [],
        },
      ],
    },
  ];

  if (d.nov3 !== d.lastTuesday && d.nov3 !== d.lastMonday && d.nov3 !== d.unrelated) {
    threads.push({
      title: "Does Supabase pause free projects?",
      exchanges: [
        {
          date: d.nov3,
          time: "09:30",
          question: "Does Supabase pause free-tier projects if they're inactive?",
          answer: "Yes. Supabase pauses free-tier projects after **1 week of inactivity**; you can restore them from the dashboard [S1]. Paid (Pro) projects are never paused [S1].",
          sources: [{ id: "S1", url: "https://supabase.com/pricing", domain: "supabase.com", title: "Pricing & Fees | Supabase" }],
          facts: [{ entity: "Supabase", plan: "Free", attribute: "inactivity pause", value: "after 1 week", source: "S1" }],
          entities: [{ name: "Supabase", domain: "supabase.com" }],
        },
      ],
    });
  }
  return threads;
}
