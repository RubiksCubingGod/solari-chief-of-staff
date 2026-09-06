# agentic-mode (s6)

## Outcome

LLM-driven browser missions for sites without a playbook - tool loop with budgets,
code-enforced guardrails, per-task cost logging, and a regression-gated eval harness against
fixture scenarios including hostile variants.

## Why this boundary

Playbooks cover known sites; the agentic loop is the fallback that makes the product general.
It runs entirely inside s5's machinery — same task state machine, same UserIO gate, same
guardrails wrapped below the LLM — so this sprint adds exactly two things: the loop itself
(browser tools + budgets + cost accounting) and the eval harness that keeps its behavior from
regressing. The eval harness is load-bearing: an LLM-driven feature without a regression gate
degrades invisibly with every prompt or model change.

## Design decisions

- **Tools, not free navigation**: the loop sees a serialized page digest (URL, title,
  interactive elements with stable references, visible text regions) and acts through typed
  Zod tools (navigate, click, type, select, read, ask_user, declare_outcome). Guardrails
  intercept below the tools, so no tool call can exceed task authority.
- **Budgets are hard**: max tool calls, max tokens, max wall time per mission; exhaustion ends
  the mission as failed-with-budget-event, never a silent grind. Every mission logs its token
  spend and cost to the task (per-task cost logging is a product surface, not telemetry).
- **Honest outcomes**: the loop must end with declare_outcome (succeeded with evidence /
  failed with reason / needs_user via ask_user). Hostile scenarios (blocked, hard-blocked)
  must end as failed-blocked or an escalation ask — a mission that "succeeds" on a blocked
  page is an eval failure by definition.
- **Evals are scenarios, not tests**: a scenario = fixture setup + mission goal + expected
  outcome class + state assertions. The suite runs scripted-LLM in CI (deterministic) and
  live-LLM nightly with a baseline pass-rate gate; regressions block merges to the loop's
  prompt/tools.
- **Anthropic spend cap** (open decision, owner Aarav): set the console monthly cap before the
  nightly live evals start running.

## Specifications

- `specs/agentic-mission-path.md` (vertical) — no-playbook task → agentic loop → outcome with
  cost logged, under budgets and guardrails.
- `specs/browser-toolset.md` (horizontal) — the page digest + typed tool surface the loop
  drives.
- `specs/eval-harness.md` (horizontal) — scenario suite, baselines, regression gate, nightly
  live runs.

## Non-goals

- No real sites (s9 points this loop at them). No new guardrail semantics (s5 owns them; this
  sprint may only add detector inputs). No multi-mission planning or memory across tasks.
- No model benchmarking — one configured model (claude-opus-5 per architecture direction),
  evals gate behavior not model choice.

## External gates

- `ANTHROPIC_API_KEY` + console spend cap for nightly live evals (owner: RubiksCubingGod).

## Task waves

[browser-toolset] → [agentic-runner] → [mission-e2e, eval-scenarios] → [eval-gate]
