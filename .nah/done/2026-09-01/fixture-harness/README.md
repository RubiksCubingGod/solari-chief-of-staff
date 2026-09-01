# fixture-harness (s1b)

## Outcome

Four fixture sites — fakestore, fakegym, fakedmv, fakenews — that a test boots as a private
in-process instance on an ephemeral 127.0.0.1 port, seeds to an exact state, drives, and asserts
against by reading the fixture's own state back. Hostile modes (blocked, hard-blocked, redesign)
toggle on a live instance without changing its URL. `fixtures/` becomes a real workspace member
covered by lint, typecheck, and the integration project.

## Why this boundary

The whole testing strategy in ARCHITECTURE §9 rests on one claim: agent behavior can be asserted
exactly, because we own the site. Every downstream proof cashes that claim — watch-engine's price
trigger and self-healing, action-playbooks' cancellation, slot-sniping's race, agentic-mode's eval
pass rate. If the fixtures are shared mutable state, those proofs are flaky; if the hostile modes
don't discriminate what they claim to, those proofs are theater. This sprint is where the
assertion substrate is made honest, once, before four sprints depend on it.

## The harness invariant

**A test names a fixture and a state, and gets a private instance in exactly that state.** No
other test can perturb it, and it does not outlive the file that started it. Isolation comes from
the boot model, not from discipline: instances are in-process on ephemeral ports, and Vitest runs
test files in separate worker processes, so module state is isolated by construction rather than
by a reset call somebody has to remember.

## Decisions taken during scoping (2026-09-01, with Aarav)

1. **Per-test-file in-process instances.** Rejected: one shared instance with namespaced state
   (the namespace leaks into watch URLs, which are user-facing rows) and shared-instance-plus-reset
   (kills integration parallelism and reintroduces cross-test flake).
2. **Hostile mode is instance state, not a query parameter.** ARCHITECTURE §9.1's `?mode=redesign`
   cannot prove self-healing: if the mode lives in the query string, "redesign" is a different page
   rather than a site that changed under a live watch. Mode is set through the control plane;
   `?mode=` survives as one-shot shorthand for manual pokes. Recorded as a correction to §9.1.
3. **Two block modes, named for what they actually prove.** `blocked` defeats a plain HTTP fetch
   and yields to any real browser. `hard-blocked` also refuses an ordinary browser and yields only
   to a request carrying the seeded `X-Fixture-Escalation` token, supplied by the caller's tier-2
   fetch configuration. `hard-blocked` proves watch-engine's escalation *state machine* reaches
   tier 2 deterministically; it does not prove stealth beats real bot defenses, and the spec says
   so. That claim stays a `@live` proof in real-site-hardening.

   *Corrected during enhancement:* the approved option said the marker would be one the provider's
   `SessionMeta` echo reports as applied. That condition can never hold — `browser-substrate`
   commits LocalProvider, the only provider that reaches these fixtures, to echoing stealth as
   **not applied**, so the mode would have been unreachable in CI. The token is now supplied by the
   caller, which proves the same claim and keeps fixture knowledge out of `packages/solari`.
4. **fakegym gates cancellation on a confirmation code readable only through the control plane.**
   The honest analog of 2FA: no page the agent can reach carries the code, so the `waiting_user`
   round-trip in action-playbooks can only succeed by actually asking. Rejected: a free-text
   retention reason (an LLM can plausibly fabricate one and skip the ask).

## Specifications

- `specs/fixture-harness-contract.md` (horizontal) — the test-facing capability: boot, address,
  isolate, seed, read, tear down, plus the `fixtures/` workspace and toolchain integration every
  fixture file needs to compile and lint.
- `specs/observation-target-path.md` (vertical) — fakestore and fakenews: a fetching client reads
  a value that equals exactly what the control plane last set.
- `specs/assisted-cancellation-path.md` (vertical) — fakegym: an authenticated client traverses
  the cancellation flow to `{ cancelled: true }`, and cannot pass the final gate without asking
  the user.
- `specs/contested-booking-path.md` (vertical) — fakedmv: a slot is awarded exactly once under
  concurrency, and the loser is told `gone` rather than that something went wrong.
- `specs/hostile-mode-surfaces.md` (horizontal) — blocked, hard-blocked, and redesign: what each
  one discriminates, and the rule that a hostile mode never changes the semantic surface or URL.

## Boundaries

- **LocalProvider only, permanently.** `browser-substrate` established that a Solari cloud browser
  cannot reach our loopback fixtures. Every fixture proof in every later sprint runs on
  LocalProvider (plain Playwright). Nothing here is reachable from the `@live` tier, and no fixture
  proof should ever be written expecting a Solari session, a recording, or a replay URL.
- **No engine behavior.** Nothing here schedules, extracts, diffs, decides, or notifies. The
  fixtures are targets; watch-engine and action-playbooks bring the behavior that aims at them.
- **No extractors or selectors shipped for downstream use.** watch-engine creates its own; if this
  sprint handed it a selector, the self-healing proof would be circular.
- **No Postgres.** Fixture state is in-process and per-instance. "The fixture's own DB" in
  ARCHITECTURE §9.1 means the fixture's own state, read through `/__test`; a real database would
  reintroduce exactly the shared mutable state the isolation decision removes.
- **No eval scenarios.** agentic-mode writes its own scenario set against these fixtures; this
  sprint owes it navigable semantics, not scenarios.
- **`fixtures/` stays outside the coverage gate.** It is at `fixtures/`, per ARCHITECTURE §11, and
  the vitest coverage `include` is `packages/*/src/**`. Deliberate: test infrastructure earns trust
  from its own behavioral proofs (isolation, teardown, refusal paths), not from a coverage number
  on code whose only consumer is tests.

## Prerequisites and external gates

- **repo-foundation, partially.** Only `workspace-toolchain` (done) is a hard prerequisite —
  fixtures need the workspace, strict tsconfig, eslint, and the vitest integration project, all of
  which exist today. **This sprint can start now, ahead of repo-foundation closing.**
- **`docker-compose.yml` exists** (landed by `postgres-dev-loop` while this sprint was being
  scoped), so `fixture-dev-entrypoint` adds a fixtures service to it rather than creating it. Its
  header already states the convention this sprint follows: compose is the local development
  surface, and integration tests get their own throwaway instances instead.
- **No credentials, no external accounts, no secrets.** Unlike browser-substrate, nothing here is
  gated on a vendor, so no proof in this sprint has a skip path.

## Task waves

`harness-seam` (3h) opens the sprint alone. Then three tasks run in parallel:
`observation-fixtures` (2h) → `hostile-modes` (3h), `fakegym-cancel-flow` (3h), and
`fakedmv-slot-booking` (2h). `fixture-dev-entrypoint` (1h) closes once all four sites exist.
Critical path 3 + 2 + 3 + 1 = 9h of implementation against 14h of task work — the parallelism is
real, and only the hostile modes are serialised behind a site they modify.
