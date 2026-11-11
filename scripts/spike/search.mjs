import { writeFileSync, mkdirSync } from "node:fs";
const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });

async function tavily(label, body) {
  const t0 = performance.now();
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ include_usage: true, ...body }),
  });
  const ms = Math.round(performance.now() - t0);
  const json = await res.json();
  writeFileSync(new URL(`tavily-${label}.json`, OUT), JSON.stringify(json, null, 1));
  if (!res.ok) return console.log(label, "HTTP", res.status, JSON.stringify(json).slice(0, 300));
  const r = json.results ?? [];
  console.log(`\n--- ${label}: HTTP ${res.status}, ${ms}ms (server ${json.response_time}s), usage=${JSON.stringify(json.usage)}`);
  console.table(r.map((x) => ({
    domain: new URL(x.url).hostname.replace(/^www\./, ""),
    published: x.published_date ?? "—",
    score: x.score?.toFixed(2),
    contentChars: x.content?.length,
    title: x.title?.slice(0, 50),
  })));
}

await tavily("current-state", {
  query: "Neon Postgres pricing plans", search_depth: "basic", max_results: 5,
  include_domains: ["neon.com", "neon.tech"], include_domains_mode: "prefer",
  chunks_per_source: 3, include_published_date: true,
});
await tavily("events-since", {
  query: "Supabase pricing change announcement", topic: "news", start_date: "2026-10-01",
  search_depth: "basic", max_results: 5, include_published_date: true,
});
await tavily("general-since", {
  query: "HubSpot CRM new features launch", topic: "general", start_date: "2026-11-01",
  search_depth: "basic", max_results: 5, include_published_date: true,
});
await tavily("advanced", {
  query: "Pipedrive pricing per user 2026", search_depth: "advanced", max_results: 5,
  chunks_per_source: 3, include_published_date: true,
});

for (const url of ["https://neon.com/pricing", "https://supabase.com/pricing"]) {
  const t0 = performance.now();
  const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: "text/plain" } });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  writeFileSync(new URL(`jina-${new URL(url).hostname}.txt`, OUT), text);
  const priceLines = text.split("\n").filter((l) => /\$\s?\d/.test(l)).slice(0, 5);
  console.log(`\n--- jina ${url}: HTTP ${res.status}, ${ms}ms, ${text.length} chars`);
  console.log("rate-limit headers:", [...res.headers].filter(([k]) => /rate|limit/i.test(k)));
  console.log("price lines:", priceLines.map((l) => l.trim().slice(0, 120)));
}
