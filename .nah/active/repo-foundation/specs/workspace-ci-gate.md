---
schema_version: 1
id: workspace-ci-gate
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [fixture-harness, browser-substrate, watch-engine, telegram-chat, dashboard-read,
    action-playbooks, agentic-mode, calendar-wiring, slot-sniping]
  cutover: Greenfield - there is no superseded path; every later change set lands only through
    this gate.
origin:
  summary: The enforced quality-gate capability - workspace, toolchain, and CI - that every
    later release lands behind; the testing bar is part of the challenge pitch.
  refs: [.nah/active/repo-foundation/README.md]
---

# Workspace and CI gate

## Outcome

A pnpm workspace with the ARCHITECTURE §11 package layout (core, db, solari, agent, playbooks,
api, bot, web as stubs plus fixtures/ placeholder dir), strict tsconfig, eslint, Vitest, and a
`pnpm check` script (lint + typecheck + unit + integration + build). GitHub Actions runs
`pnpm check` on push with coverage gates: 100% line coverage on `core/`, ≥90% overall. A PR
template carries the manual-checklist stub.

## Invariant

Nothing merges red. The gate is failure-sensitive by construction: a lint error, type error,
failing test, or coverage drop below the thresholds fails the workflow.

## Consumers

Every subsequent release's change sets (all nine feature/tooling sprints) plus the nightly
workflows added in agentic-mode and real-site-hardening, which extend these workflow files.

## Failure behavior

Proven, not assumed: the gate demonstrably fails on a synthetic violation (uncovered branch in
`core/`), asserted via a unit test of the coverage configuration rather than a throwaway commit.

## Proof

Fresh clone → documented setup → `pnpm check` green locally; the same suite green in CI on the
sprint PR; gate failure-sensitivity test in place.
