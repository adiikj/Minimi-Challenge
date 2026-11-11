const res = await fetch("https://api.mistral.ai/v1/models", {
  headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
});
if (!res.ok) { console.error("HTTP", res.status, await res.text()); process.exit(1); }
const { data } = await res.json();
const interesting = /large|small|glm|ministral|medium/i;
const rows = data
  .filter((m) => interesting.test(m.id))
  .map((m) => ({
    id: m.id,
    aliases: (m.aliases ?? []).join(","),
    ctx: m.max_context_length,
    tools: m.capabilities?.function_calling,
    reasoning: m.capabilities?.reasoning ?? m.capabilities?.thinking,
    deprecated: m.deprecation ?? "",
  }));
console.table(rows);
