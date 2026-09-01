---
schema_version: 1
id: fixture-harness-contract
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [watch-engine, action-playbooks, agentic-mode, slot-sniping]
  cutover: Greenfield - supersedes the `fixtures/` placeholder README, which reserved the
    directory but left it outside the workspace, the tsconfig project, and the test globs.
origin:
  summary: The test-facing capability every fixture proof runs on - boot, address, isolate,
    seed, read, tear down - plus the toolchain integration `fixtures/` needs to compile at all.
  refs: [.nah/active/fixture-harness/README.md, docs/ARCHITECTURE.md]
---

# Fixture harness contract

## Outcome

A test calls `startFakestore()` (or `startFakegym`, `startFakedmv`, `startFakenews`) and receives
`{ url, control, stop }`: a base URL on an ephemeral `127.0.0.1` port, a typed control-plane client
for seeding and reading that instance's state, and a teardown. Instances are in-process; Vitest
runs test files in separate worker processes, so two files exercising the same fixture kind hold
genuinely separate state. `fixtures/` is a workspace member that lints, typechecks, and builds.

## Invariant

A test names a fixture and a state, and gets a private instance in exactly that state — unaffected
by any other test, and not outliving the file that started it. Isolation is a property of the boot
model, not of a reset call somebody has to remember to make.

**One boot path.** The `start*()` factories are the only way a fixture comes up. The development
CLI and the docker-compose service are entry points into those same factories, never second
implementations, so a fixture cannot behave one way under test and another way in front of a human.

## Consumers

- watch-engine: boots fakestore and fakenews per test file, sets prices and content, asserts the
  observation history it derives.
- action-playbooks: boots fakegym, seeds a member, reads `cancelled` back after the mission.
- slot-sniping: boots fakedmv, publishes and steals slots between observation and booking.
- agentic-mode: boots every kind across its eval scenarios, including hostile variants.

## The control plane

Every fixture mounts a `/__test` router with the same shape: `POST /__test/reset` (return the
instance to its seeded baseline), `POST /__test/seed` (set the whole starting state in one call),
`GET /__test/state` (read everything the fixture knows), `POST /__test/mode` (set the hostile mode,
per `hostile-mode-surfaces`), plus per-fixture readers and mutators named in the fixture specs.
The client returned by `start*()` is typed against that surface, so a downstream test that seeds a
field the fixture does not have fails at typecheck rather than silently no-opping.

`/__test` is reachable only because the instance is loopback and short-lived. It is not
authenticated and must never be modelled as production-shaped API surface.

## Toolchain integration

Verified as absent and therefore in scope, re-checked at enhancement: `pnpm-workspace.yaml`
covers only `packages/*`; `tsconfig.json` references the eight packages and nothing else;
`tsconfig.test.json` includes `packages/*/src/**/*.ts`, `packages/*/*.config.ts`, `tests/**/*.ts`,
and `*.config.ts`, none of which reach `fixtures/`; `vitest.config.ts` hardcodes
`WORKSPACE_PACKAGES` for its source aliases and scopes both projects to `packages/*` and `tests/`. eslint runs type-checked against `tsconfig.test.json`
with no ignore for `fixtures/`, so TypeScript placed there today fails lint outright with a
file-not-in-project error.

This spec lands the workspace glob, the tsconfig references and test include, and the vitest
source aliases and integration include. It leaves the coverage `include`
(`packages/*/src/**/*.ts`) untouched: `fixtures/` sits outside the gate deliberately, per the
sprint README. Fixture tests belong to the integration project, never the unit project — they
bind ports.

## Failure behavior

Proven, not assumed:

- Two instances of the same fixture kind, started concurrently in one test, hold independent state:
  mutating one leaves the other at its seeded baseline.
- `stop()` releases the port — proven by rebinding the same port after teardown, not by trusting
  the close callback.
- `stop()` is idempotent, and a `stop()` after a failed start does not throw.
- An instance left running when its file ends fails the run rather than leaking into the next one.
- A control-plane call against a stopped instance produces a typed error, not a hang.

## Proof

Integration tests (Vitest, integration project): concurrent-instance isolation; port release after
teardown; idempotent and post-failure teardown; leak assert; typed error on a stopped instance.
Toolchain integration is proven by `pnpm check` staying green with TypeScript under `fixtures/`.
