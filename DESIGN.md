# Design

The challenge questions are about time: *"on Monday"*, *"last Tuesday"*, *"has it changed since?"*. A chat agent with search alone cannot answer them. It doesn't know which conversation you mean, what it said then, or what "since" means. So the design centres on three things: **resolving dates in code**, **remembering facts with when they were true**, and **re-checking those facts quickly**.

## Architecture

One model loop with one tool (`web_search`). Before the model runs, code builds the context it needs.

```
message ─► resolve dates ─► recall past answers + their facts ─► prefetch searches ─► model ⇄ web_search ─► answer
           (code)            (SQLite, tens of ms)                (only for "changed?")   (streamed, cited)
                                                                                              │
                                                       fact ledger updated in the background ◄┘
```

| Step | What it does |
|---|---|
| **Date resolver** | Turns "last Tuesday", "on 3 November", "Monday", "since then" into date ranges in the user's time zone. Ambiguous phrases keep both readings, and the one with conversations wins. "Last Tuesday" on a Wednesday is the previous week's Tuesday unless only the other day has chats. The reading is shown as a chip that can be switched with one click. |
| **Recall** | Loads the conversations on those dates (or by full-text topic search when no date is given), with each answer's facts and sources. If nothing matches, it says so and lists the nearest days that do have chats, so the model has no gap to fill with an invented memory. |
| **Prefetch** | For "has it changed?" questions the items are already known (e.g. the 5 CRMs), so code starts their searches before the model's first call: current pricing on the official site, plus news since the recalled date. |
| **Loop** | The model answers from that evidence and searches again only for gaps. Queries in one call run in parallel. Rounds and time are budgeted, and the last round must answer. |
| **Fact ledger** | After each answer, a small model extracts its checkable facts. When an answer re-checks old facts it gives a verdict per fact, and code applies it. |

The volatile parts (date, calendar, memory, evidence) go in the user turn, so the system prompt stays byte-identical and is served from the prompt cache.

### Why this shape

| Option | Why not |
|---|---|
| Chat history + search only | Fails every challenge question. It is the eval baseline. |
| A `recall` tool | A second tool, against the brief. Adds a round trip on every memory turn, and the model has to turn "last Tuesday" into arguments itself. |
| Planner → parallel searches → writer | Pays for a planning call on every turn, including "thanks". Prefetch gets the same parallel fan-out without that extra call, and only when it helps. |
| Intent router → specialised flows | Better per-intent control, but a misrouted turn runs the wrong flow, and there is far more code. Its two best ideas are kept as soft hooks: prefetch and per-fact verdicts. If a hook misfires, a few searches are wasted, and the same loop still answers. |
| Multi-agent researchers | Too slow and expensive for chat, and burns the search quota. |

Pre-assembled memory is weaker than a tool for vague or multi-hop references ("that thing a while back"). Two things mitigate it: full-text topic recall, and a short index of recent conversations that rides along on every turn. The `mem-topic-no-date` eval covers this case.

## Remembering facts with time

Each fact is stored as `entity · plan · attribute = value` with **two dates**:

- **observed**: when we saw it (the day the source was read);
- **effective**: when the change happened, if a source says so.

When a later answer re-checks a fact, the writer returns one verdict per fact: `unchanged`, `changed`, `unconfirmed` or `not_mentioned`. Code applies it. A confirmation stamps `confirmed_at`, and a change creates a new fact and links the old one to it. The rules that keep the ledger honest live in code, not the prompt:

- a value the answer hedged on ("couldn't confirm", "conflicting") never overwrites a fact;
- rephrasings of the same value ("$25/month" vs "$25 per month") are not changes;
- the answer's own date is never taken as an effective date;
- verdicts are accepted only for facts we offered, so they can never touch another user's data.

This is what lets the agent say *"already out of date when I answered on 3 Nov"* (the change predates the answer) instead of *"changed since 3 Nov"*. It is also what makes later questions cheap: a fact re-checked today is answered from the ledger without searching again.

**Freshness.** Facts have a shelf life by kind: prices and plans 7 days, versions 14, other facts 30. Old answers show when their facts were last checked, or that a later check found a change. **Re-check now** runs a turn against exactly that answer, loaded by id with no retrieval guesswork.

## Search

Tavily, wrapped in a small service:

- parallel fan-out with per-query timeouts;
- a SQLite cache, with identical in-flight queries shared;
- a boost for the vendor's official domain, and a guarantee of at least one source per query;
- full official pages read through Jina Reader for `depth: "thorough"`.

Pricing pages are often undated and are dropped by date filters, so a change check uses two queries per item: current state on the official domain with no date filter, plus news since the date.

Every source gets a stable id (`S1`…). Citations to unknown ids are stripped and counted. Results are fenced as untrusted content, and queries are stripped of the prices the model expects to find. Record and replay make tests and evals free.

## Users, safety, cost

- **Profiles**: the default is one user with no sign-in. Every table and query is scoped by user id, and a profile switcher shows multi-user isolation. Device and profile cookies are HMAC-signed, and a profile is usable only by its own device (the demo profile excepted).
- **Prompt injection**: an eval page tells the agent to ask for a password. It is ignored in every eval arm.
- **Spend guard**: every turn's cost is computed from token usage and stored. Past `SPEND_LIMIT_USD`, the agent stops with a clear message.
- **Models**: GLM 5.3 answers (≈ 0.5 s to first token without search). Mistral Large 4 was tried first, but its reasoning can't go below "low" (2–3 s to first token). Mistral Small 4 writes the ledger, with reasoning off and a strict JSON schema. Large 4 is the eval judge.

## Measured

**Evals.** 11 scenarios (the three challenge questions plus three other memory cases, web, no-search, and injection) × 5 arms. The answering model is real, search is replayed from recorded results, and grading uses deterministic checks plus an LLM judge that sees the sources with their dates. Full report: [evals/results](evals/results/full-run-2026-11-11.md).

| Arm | Checks | Judge pass | Quality (1–5) | Cost / turn |
|---|---|---|---|---|
| Chat + search, no memory | 45 % | 55 % | 3.82 | $0.002 |
| + memory | 100 % | 73 % | 4.52 | $0.005 |
| **+ prefetch (shipped)** | **100 %** | **91 %** | **4.84** | $0.005 |
| shipped, without date resolver * | 80 % | 60 % | 4.20 | $0.007 |
| shipped, without fact ledger * | 100 % | 60 % | 4.60 | $0.007 |

\* memory scenarios only.

On the memory scenarios alone, no-memory passes 17 % and the shipped agent 83 %. Removing either the date resolver or the ledger costs about 25 points: the 3 November question isn't found, or past facts get invented. Web, no-search and safety scenarios pass in every arm.

**Live latency** (GLM 5.3 + Tavily, single runs):

| Turn | Result |
|---|---|
| Chat, no search | first token ≈ 0.5 s |
| One search round (compare two vendors) | 10 s, $0.010 |
| CRM "changed since Monday?" with prefetch | status in 8 ms, first token 6.6–8.3 s vs 12.9 s without, one model round fewer, 10–20 % cheaper |
| Re-check one old answer (9 facts) | 15 s, $0.018 |
| Memory lookup (dates + recall) | 13–62 ms |

Prefetch reliably cuts rounds and cost. Total time isn't always shorter, because Tavily latency varies and the model sometimes searches again for a gap.

## Limits and next steps

- Eval cells are single runs, so one scenario can flip between runs. More scenarios and repeats would tighten the numbers.
- The remaining judge failures: totals that no source states, a price attributed to a neighbouring result, and "no change found" summarised as "still holds".
- Date phrases are English only. Vague or multi-hop references rely on topic search and the index.
- SQLite fits one node. The repository interface is the seam for Postgres.
- Profiles are not authentication. Real accounts would replace the device cookie, and the scoping already exists.
