---
schema_version: 1
id: live-ops-gate
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [real-watch-proof, real-action-proof]
  cutover: >-
    Expands the browser-substrate nightly live smoke into the release-gating live suite; the
    old single-session smoke is subsumed as its first case
origin:
  summary: The operational ratchet - nightly live runs over real Solari sessions and real
    watches, per-run cost accounting, and the attested manual release checklist that s10
    ships on.
  refs: [.nah/active/real-site-hardening/README.md,
    .nah/active/browser-substrate/specs/live-smoke-path.md,
    .nah/active/agentic-mode/specs/eval-harness.md]
---

# Live ops gate

## Outcome

The nightly live workflow grown from browser-substrate's single smoke into the release gate:
real Solari session lifecycle, the real-site watch checks, one fixture-target mission through
the production engine, and the s6 live eval suite - each case reporting pass/fail/errored
distinctly, with per-run Solari and Anthropic cost summed and logged against the agreed
target. The release criterion is mechanical: three consecutive green nights recorded, cost
under target each night. Alongside it, the manual release checklist (secrets not in repo,
session-leak ledger clean, guardrail config armed, replay spot-check, cost review) lives in
the repo and each item is attested by name and date before s10 may ship.

## Consumers

The real-watch and real-action proofs feed cases into the suite; s10's production-deploy
consumes the gate - it may not proceed without the three-night record and the attested
checklist. Nightly failure notifies via Telegram (ops notification through the product's own
sendToUser - the system watches itself).

## Failure behavior

An errored case (API outage, site down) is distinct from failed and breaks the consecutive
count only when errors persist two nights running - one bad third-party night does not
silently reset honesty, but it never counts as green either. Cost overrun is a failure even
when all cases pass. The checklist admits no programmatic bypass; unattested items block by
construction (the deploy task in s10 cites the attestation file).

## Proof

The workflow runs on schedule with all case classes reporting; a deliberately broken case
turns the night red and fires the Telegram ops notification; cost summation matches per-task
records; the committed three-night record and fully attested checklist exist before s10
begins. Unit tests for the green/errored/failed counting and cost-summation logic.
