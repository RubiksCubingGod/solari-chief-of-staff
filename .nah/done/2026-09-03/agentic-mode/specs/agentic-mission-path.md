---
schema_version: 1
id: agentic-mission-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: An action task enqueued for a site with no registered playbook
  terminal: >-
    The task ends in an honest terminal state - succeeded with evidence, failed with a reason
    (including budget exhaustion and blocked pages), or waiting_user - with every tool call in
    task_events and the mission's token spend and dollar cost logged on the task
origin:
  summary: The general fallback - an LLM tool loop that runs any mission inside the s5 engine
    under hard budgets, code-enforced guardrails, and full cost accounting.
  refs: [.nah/active/agentic-mode/README.md,
    .nah/active/action-playbooks/specs/task-state-machine.md,
    .nah/active/action-playbooks/specs/guardrail-layer.md]
---

# Agentic mission path

## Outcome

An `AgenticRunner` registered as the fallback in the s5 playbook registry: when no playbook
matches the task's site and action kind, the mission runs a Claude tool loop (claude-opus-5)
against the browser-toolset surface. The loop lives entirely inside s5's frame - the same task
state machine drives transitions, the same UserIO gate handles ask_user, the same guardrails
intercept below the tools (allowlist, payment gate, recording). Budgets (max tool calls, max
tokens, max wall time) are enforced by the runner, not the prompt; hitting one ends the
mission failed with a budget event. Every mission writes its input/output token totals and
computed cost to the task record.

## Path

Enqueue a cancellation task for a fixture site with no playbook → registry falls through to
the agentic runner → loop navigates, reads, clicks through the fixture via tools → at the
confirmation gate the loop calls ask_user → task parks waiting_user with the question → the
scripted answer resumes a fresh mission with prior-mission context summarized in → loop
completes and calls declare_outcome(succeeded, evidence) → task succeeded, cost logged,
tool-call trail in task_events.

## Failure behavior

Blocked-mode fixture → the loop's declare_outcome must be failed (blocked), never a fabricated
success; hard-blocked → failed or an escalation ask_user, per the hostile-mode contract.
Budget exhaustion mid-mission → failed with the budget event and partial cost still logged.
A tool call rejected by guardrails surfaces to the loop as a tool error once; a second
violation ends the mission failed per guardrail-layer. Malformed tool arguments are re-asked
with the validation error, bounded by the tool-call budget. Anthropic API errors retry with
backoff inside the mission's wall-time budget, then fail the mission observably.

## Proof

Integration tests on fixtures via LocalProvider with a scripted LLM transport (recorded tool
sequences, no live API): the full success path with cost and event assertions; ask_user
parking and resume; blocked and hard-blocked endings; budget exhaustion on each budget axis;
guardrail rejection flow. One live-LLM smoke (real claude-opus-5, fixture site) behind the
`ANTHROPIC_API_KEY` gate proving the loop composes with a real model.
