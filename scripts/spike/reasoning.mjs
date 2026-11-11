const KEY = process.env.MISTRAL_API_KEY;
const API_URL = "https://api.mistral.ai/v1/chat/completions";

async function stream(body) {
  const t0 = performance.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 220)}` };
  let first, firstText, text = "", thinking = "", usage, finish;
  const calls = new Map();
  const dec = new TextDecoder();
  let buf = "";
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:") || line.endsWith("[DONE]")) continue;
      const chunk = JSON.parse(line.slice(5));
      const now = performance.now() - t0;
      const ch = chunk.choices?.[0];
      const d = ch?.delta ?? {};
      if (first === undefined && (d.content || d.tool_calls)) first = now;
      if (typeof d.content === "string" && d.content) { text += d.content; firstText ??= now; }
      else if (Array.isArray(d.content)) for (const c of d.content) {
        if (c.type === "text" && c.text) { text += c.text; firstText ??= now; }
        if (c.type === "thinking") thinking += (c.thinking ?? []).map((t) => t.text ?? "").join("");
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.size;
        const cur = calls.get(i) ?? { id: "", name: "", args: "" };
        cur.id ||= tc.id ?? ""; cur.name ||= tc.function?.name ?? ""; cur.args += tc.function?.arguments ?? "";
        calls.set(i, cur);
        firstText ??= now;
      }
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  }
  return { first: Math.round(first ?? -1), firstText: Math.round(firstText ?? -1), total: Math.round(performance.now() - t0),
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens, outTokens: usage?.completion_tokens,
    thinkingChars: thinking.length, finish, text, calls: [...calls.values()] };
}

const NO_THINK_SYSTEM =
  "You are a fast, concise assistant. Answer directly. Do not deliberate, plan, or think step by step before answering; respond immediately.";
const CHAT = [{ role: "user", content: "In two sentences: why do people use Postgres instead of MySQL?" }];

const probes = {
  async probe() {
    const variants = {
      "effort=none": { reasoning_effort: "none" },
      "effort=minimal": { reasoning_effort: "minimal" },
      "effort omitted": {},
      "effort=low": { reasoning_effort: "low" },
      "prompt_mode=null": { prompt_mode: null, reasoning_effort: "low" },
      "reasoning:{enabled:false}": { reasoning: { enabled: false } },
      "thinking:{type:disabled}": { thinking: { type: "disabled" } },
    };
    for (const [name, extra] of Object.entries(variants)) {
      const r = await stream({ model: "mistral-large-4", messages: CHAT, max_tokens: 400, ...extra });
      console.log(name.padEnd(28), r.error ?? `ok · firstText ${r.firstText}ms · reasoning ${r.reasoningTokens} tok · thinkingChars ${r.thinkingChars}`);
    }
  },

  async chat() {
    const configs = {
      "L4 low": { model: "mistral-large-4", reasoning_effort: "low", messages: CHAT },
      "L4 low + no-think prompt": { model: "mistral-large-4", reasoning_effort: "low", messages: [{ role: "system", content: NO_THINK_SYSTEM }, ...CHAT] },
      "GLM 5.3 low": { model: "zai-glm-5-3", reasoning_effort: "low", messages: CHAT },
    };
    const rows = [];
    for (const [name, body] of Object.entries(configs)) for (let i = 0; i < 5; i++) {
      const r = await stream({ ...body, max_tokens: 400 });
      rows.push({ config: name, firstText: r.firstText, total: r.total, reasoningTok: r.reasoningTokens, err: r.error?.slice(0, 60) });
    }
    console.table(rows);
    summarize(rows, "firstText");
  },

  async search() {
    const tool = { type: "function", function: { name: "web_search", description: "Search the web; pass several queries at once.",
      parameters: { type: "object", properties: { queries: { type: "array", items: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } }, required: ["queries"] } } };
    const sys = { role: "system", content: "Today is 2026-11-11. Use web_search for prices. Never put values you expect to find into queries. Cite sources as [S#]. Answer concisely." };
    const sysNoThink = { role: "system", content: sys.content + " Respond immediately; do not deliberate before calling tools or answering." };
    const user = { role: "user", content: "Has Supabase changed its Pro plan pricing recently? What does it cost now?" };
    const fakeResults = JSON.stringify({ results: [
      { id: "S1", title: "Pricing & Fees | Supabase", url: "https://supabase.com/pricing", published: null, excerpt: "Pro: from $25/month. Includes $10 compute credits. Team: from $599/month." },
      { id: "S2", title: "Supabase announces new pricing (Oct 2026)", url: "https://supabase.com/blog/pricing-update", published: "2026-10-02", excerpt: "Starting 1 Oct 2026 the Pro plan includes 8 GB disk and 250 GB egress; price unchanged at $25." },
    ] });
    const configs = {
      "L4 low": { model: "mistral-large-4", reasoning_effort: "low", system: sys },
      "L4 low + no-think": { model: "mistral-large-4", reasoning_effort: "low", system: sysNoThink },
      "GLM 5.3 low": { model: "zai-glm-5-3", reasoning_effort: "low", system: sys },
    };
    const rows = [];
    for (const [name, cfg] of Object.entries(configs)) for (let i = 0; i < 3; i++) {
      const messages = [cfg.system, user];
      const r1 = await stream({ model: cfg.model, reasoning_effort: cfg.reasoning_effort, messages, tools: [tool], max_tokens: 1500 });
      if (r1.error || !r1.calls.length) { rows.push({ config: name, err: r1.error ?? `no tool call: ${r1.text.slice(0, 50)}` }); continue; }
      messages.push({ role: "assistant", content: "", tool_calls: r1.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) });
      for (const c of r1.calls) messages.push({ role: "tool", name: c.name, tool_call_id: c.id, content: fakeResults });
      const SEARCH_MS = 2000;
      const r2 = await stream({ model: cfg.model, reasoning_effort: cfg.reasoning_effort, messages, tools: [tool], max_tokens: 1500 });
      rows.push({ config: name, r1_toolcall: r1.firstText, r1_total: r1.total, r2_firstText: r2.firstText, r2_total: r2.total,
        e2e_firstAnswerToken: r1.total + SEARCH_MS + r2.firstText, e2e_total: r1.total + SEARCH_MS + r2.total,
        reasoningTok: (r1.reasoningTokens ?? 0) + (r2.reasoningTokens ?? 0), answer: (r2.text || r2.error || "").slice(0, 70).replace(/\n/g, " ") });
    }
    console.table(rows.map(({ answer, ...r }) => r));
    for (const r of rows) console.log(`${r.config}: ${r.answer ?? r.err}`);
    summarize(rows, "e2e_firstAnswerToken");
  },
};

function summarize(rows, key) {
  const by = {};
  for (const r of rows) if (typeof r[key] === "number" && r[key] >= 0) (by[r.config] ??= []).push(r[key]);
  for (const [k, v] of Object.entries(by)) {
    v.sort((a, b) => a - b);
    console.log(`${k.padEnd(26)} median ${key}: ${v[Math.floor(v.length / 2)]}ms  (min ${v[0]}, max ${v.at(-1)})`);
  }
}

const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(probes)) {
  if (wanted.length && !wanted.includes(name)) continue;
  console.log(`\n===== ${name} =====`);
  await fn();
}
