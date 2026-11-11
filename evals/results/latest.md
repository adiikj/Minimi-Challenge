# Eval results (2026-11-11 07:38 UTC)

Answering model `zai-glm-5-3`, judge `mistral-large-4`, search replayed from fixtures (0 credits). 2 turns in 77 s. Spend: answers $0.033, judge $0.016.

Latency with replayed search measures model time only (search returns instantly).

## All scenarios

| Arm | n | Checks pass | Judge pass | Quality (1–5) | First token (p50) | Total (p50) | Rounds | Searches | Cost / turn |
|---|---|---|---|---|---|---|---|---|---|
| C+ | 2 | 100% | 50% (2/2) | 4.38 | 8.7 s | 11.5 s | 2.0 | 10.0 | $0.0167 |

## Memory scenarios

| Arm | n | Checks pass | Judge pass | Quality (1–5) | First token (p50) | Total (p50) | Rounds | Searches | Cost / turn |
|---|---|---|---|---|---|---|---|---|---|
| C+ | 2 | 100% | 50% (2/2) | 4.38 | 8.7 s | 11.5 s | 2.0 | 10.0 | $0.0167 |

## Per scenario

| Scenario | C+ |
|---|---|
| mem-last-tuesday | ✓ ✓ |
| mem-crm-monday | ✓ ✗ |

Cells: deterministic checks, then judge (✓ pass / ✗ fail). · = not run in that arm.

## Failures

- **mem-crm-monday / C+**: judge: The answer names all five shortlisted CRMs, gives per-tool verdicts with sources, honestly flags the unverified Zoho price and admits the Pipedrive figure was its own error rather than a change since Monday. However, it fabricates the "$5.66B" Braze figure (S10 only gives $47.50/share, no total), and its claim that "four of your five numbers still hold" contradicts its own table where Zoho is unverified.
