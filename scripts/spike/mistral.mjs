import { writeFileSync, mkdirSync } from "node:fs";

const KEY = process.env.MISTRAL_API_KEY;
const API_URL = "https://api.mistral.ai/v1/chat/completions";
const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web. Pass several queries at once when comparing things; they run in parallel.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              q: { type: "string" },
              since: { type: "string", description: "YYYY-MM-DD" },
              domains: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["general", "news"] },
            },
            required: ["q"],
          },
        },
      },
      required: ["queries"],
    },
  },
};

async function stream(label, body) {
  const t0 = performance.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) return { label, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}` };

  const raw = [];
  let ttftAny, ttftText, text = "", thinking = "", finish, usage;
  const toolCalls = new Map();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      raw.push(chunk);
      const now = performance.now() - t0;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? {};
      if (ttftAny === undefined && (delta.content || delta.tool_calls)) ttftAny = now;
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        ttftText ??= now;
      } else if (Array.isArray(delta.content)) {
        for (const c of delta.content) {
          if (c.type === "text" && c.text) { text += c.text; ttftText ??= now; }
          if (c.type === "thinking") thinking += (c.thinking ?? []).map((t) => t.text ?? "").join("");
        }
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? toolCalls.size;
        const cur = toolCalls.get(i) ?? { id: "", name: "", args: "", deltas: 0 };
        cur.id ||= tc.id ?? "";
        cur.name ||= tc.function?.name ?? "";
        cur.args += tc.function?.arguments ?? "";
        cur.deltas++;
        toolCalls.set(i, cur);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  }
  const total = performance.now() - t0;
  writeFileSync(new URL(`${label}.json`, OUT), JSON.stringify(raw, null, 1));
  return {
    label,
    ttftAnyMs: Math.round(ttftAny ?? -1),
    ttftTextMs: Math.round(ttftText ?? -1),
    totalMs: Math.round(total),
    finish,
    usage,
    chunks: raw.length,
    textPreview: text.slice(0, 160).replace(/\n/g, " "),
    thinkingChars: thinking.length,
    toolCalls: [...toolCalls.values()].map((t) => ({ id: t.id, name: t.name, deltas: t.deltas, args: t.args })),
  };
}

const sections = {
  async tools() {
    const messages = [
      { role: "system", content: "You are a research assistant. Today is 2026-11-11. Use web_search for anything time-sensitive." },
      { role: "user", content: "Compare the current entry-level paid pricing of Neon, Supabase and Railway for Postgres hosting." },
    ];
    for (const model of ["mistral-large-4", "zai-glm-5-3"]) {
      const r = await stream(`tools-${model}`, {
        model, messages, tools: [WEB_SEARCH_TOOL], tool_choice: "auto", parallel_tool_calls: true,
        reasoning_effort: "low", max_tokens: 2000,
      });
      console.log(JSON.stringify(r, null, 1));
    }
  },

  async roundtrip() {
    const model = "mistral-large-4";
    const messages = [
      { role: "system", content: "Today is 2026-11-11. Use web_search for prices. Cite sources as [S#]." },
      { role: "user", content: "What does Neon's Launch plan cost right now?" },
    ];
    const first = await stream("roundtrip-1", { model, messages, tools: [WEB_SEARCH_TOOL], reasoning_effort: "low", max_tokens: 1500 });
    console.log(JSON.stringify(first, null, 1));
    if (!first.toolCalls?.length) return;
    messages.push({
      role: "assistant", content: "",
      tool_calls: first.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })),
    });
    for (const t of first.toolCalls) {
      messages.push({
        role: "tool", name: t.name, tool_call_id: t.id,
        content: JSON.stringify({ results: [{ id: "S1", title: "Neon pricing", url: "https://neon.com/pricing", retrievedAt: "2026-11-11", excerpt: "Launch: usage-based, from $5/month minimum. Scale: from $5/month..." }] }),
      });
    }
    const second = await stream("roundtrip-2", { model, messages, tools: [WEB_SEARCH_TOOL], reasoning_effort: "low", max_tokens: 1500 });
    console.log(JSON.stringify(second, null, 1));
  },

  async speed() {
    const configs = [
      { model: "mistral-large-4", reasoning_effort: "low" },
      { model: "mistral-large-2512" },
      { model: "mistral-small-2603", reasoning_effort: "none" },
      { model: "zai-glm-5-3", reasoning_effort: "low" },
    ];
    const messages = [{ role: "user", content: "In two sentences: why do people use Postgres instead of MySQL?" }];
    const rows = [];
    for (const cfg of configs) {
      for (let i = 0; i < 3; i++) {
        const r = await stream(`speed-${cfg.model}-${i}`, { ...cfg, messages, max_tokens: 400 });
        rows.push({ model: cfg.model, run: i, ttftText: r.ttftTextMs, total: r.totalMs, out: r.usage?.completion_tokens, think: r.thinkingChars, err: r.error?.slice(0, 80) });
      }
    }
    console.table(rows);
  },

  async cache() {
    const longSystem = "You are a careful research assistant.\n" + Array.from({ length: 300 }, (_, i) => `Rule ${i}: always cite sources and state as-of dates for prices and versions.`).join("\n");
    for (let i = 0; i < 3; i++) {
      const r = await stream(`cache-${i}`, {
        model: "mistral-large-4", reasoning_effort: "low", max_tokens: 50,
        messages: [{ role: "system", content: longSystem }, { role: "user", content: `Say OK ${i}.` }],
      });
      console.log(i, r.totalMs + "ms", JSON.stringify(r.usage));
    }
  },

  async structured() {
    const schema = {
      type: "object", additionalProperties: false,
      properties: {
        title: { type: "string" },
        claims: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              entity: { type: "string" }, attribute: { type: "string" }, value: { type: "string" },
              sourceId: { type: ["string", "null"] }, effectiveFrom: { type: ["string", "null"] },
            },
            required: ["entity", "attribute", "value", "sourceId", "effectiveFrom"],
          },
        },
      },
      required: ["title", "claims"],
    };
    const t0 = performance.now();
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mistral-small-2603", reasoning_effort: "none", max_tokens: 800,
        response_format: { type: "json_schema", json_schema: { name: "memory_extract", schema, strict: true } },
        messages: [
          { role: "system", content: "Extract factual claims from the assistant answer." },
          { role: "user", content: "ANSWER: Neon's Launch plan starts at $19/month [S1]; Supabase Pro is $25/month [S2], raised from $20 effective 2026-10-01 [S3]." },
        ],
      }),
    });
    const json = await res.json();
    console.log("HTTP", res.status, Math.round(performance.now() - t0) + "ms");
    console.log(JSON.stringify(json.choices?.[0]?.message?.content ?? json, null, 1));
    console.log("usage", JSON.stringify(json.usage));
  },
};

const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(sections)) {
  if (wanted.length && !wanted.includes(name)) continue;
  console.log(`\n===== ${name} =====`);
  try { await fn(); } catch (e) { console.error(name, "failed:", e); }
}
