---
schema_version: 1
id: eval-harness
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [agentic-mission-path]
  cutover: >-
    New capability - adds the regression gate under which all future changes to the loop's
    prompt, tools, and model configuration must land; no prior path is superseded
origin:
  summary: Scenario-based evals for the agentic loop - fixture setup, mission goal, expected
    outcome class, state assertions - run deterministically in CI and live nightly with a
    baseline pass-rate gate.
  refs: [.nah/active/agentic-mode/README.md,
    .nah/active/fixture-harness/specs/hostile-mode-surfaces.md]
---

# Eval harness

## Outcome

An eval runner and scenario format in the repo: each scenario declares fixture setup (site,
seed state, mode), a mission goal, the expected outcome class (succeeded / failed-blocked /
needs_user / failed-budget), and post-state assertions against the fixture control plane. The
starting suite covers: successful cancellation, successful observation-style extraction,
blocked mode (must end failed, site state untouched), hard-blocked mode (must end failed or
escalation ask, never fake success), redesign mode (layout shifted - loop must still succeed
via the digest, not memorized selectors), and a payment-shaped trap page (guardrail must fire).
Two execution modes: scripted-transport in CI on every push (deterministic - recorded model
turns replayed), and live-LLM nightly writing pass/fail per scenario to a committed baseline
file; a run below baseline fails the nightly job.

## Consumers

The agentic runner is the system under test and the production consumer: CI runs the scripted
suite on every change to `packages/engine` agentic code, so no prompt or tool change lands
unevaluated. The nightly live run is the drift detector for model-side change.

## Failure behavior

A live scenario that errors (API outage, fixture crash) records errored - distinct from failed
- and does not silently lower the denominator. Scenario state assertions run even when the
outcome class matches, so a "failed" mission that still mutated site state is an eval failure.
Baseline updates are explicit file edits in a PR, never automatic.

## Proof

The scripted suite green in CI with each scenario's outcome-class and state assertions;
deliberate-regression test (a sabotaged prompt or removed tool makes named scenarios fail,
proving the gate detects what it claims to); nightly workflow runs the live suite under the
Anthropic spend cap and fails below baseline. Unit tests for the runner's outcome
classification and errored-vs-failed accounting.
