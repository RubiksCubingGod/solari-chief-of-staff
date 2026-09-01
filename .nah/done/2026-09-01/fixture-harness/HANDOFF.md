# Handoff

## Carried obligations for later sprints

**One proof is owed to `browser-substrate`.** Two specs describe proofs "driving a LocalProvider
browser", and LocalProvider does not exist yet: `packages/solari` is still a stub, Playwright is not
a declared dependency, and no DOM environment is installed. Adding either here would duplicate
`browser-substrate`'s change surface, so it was not done.

- `hostile-mode-surfaces` — `blocked` is proven up to script execution. A plain fetch gets the
  captcha shell and no observable value; the shell's own injected script, run against a
  test-owned DOM stub in `hostile-modes.integration.test.ts`, materializes the body and flips the
  `fixture-state` marker to normal. What a stub cannot prove is that a real engine — parsing,
  script timing, `DOMContentLoaded` ordering — reaches the same document. Everything else in that
  spec is fully proven over HTTP, including all of `hard-blocked` (the escalation header is
  caller-supplied by design, so it never needed a browser) and all of `redesign`.

  Hardening found a real defect on this exact seam and fixed it: the materialized page used to keep
  reporting `fixture-state:blocked` in its head while showing normal content, which would have made
  a watch engine either escalate to tier 2 for a page it already had or discard a good observation.
  A stub caught it only because one was finally written. Treat the remaining browser gap as load
  bearing rather than ceremonial.
- `assisted-cancellation-path` — proven end to end over HTTP with a cookie jar. The session
  progress, the code gate, and every refusal branch are server-side and behave identically under
  either driver; what is unproven is that a browser can operate the forms.

When `browser-substrate` lands LocalProvider, add: a browser fetch of a `blocked` fixture URL that
sees the content a plain fetch could not *and* reads `fixture-state:normal` off the materialized
document, and a browser-driven walk of the fakegym cancellation flow. Neither should need a fixture change — the markup already carries accessible names and
`data-testid` hooks for exactly this.

**The container-runtime blocker is resolved; the note is kept for the trail.** For this sprint's
whole life the full `pnpm check` could not run green here: no container runtime (no `docker` on
PATH, no Docker Desktop) and no local Postgres for `TEST_DATABASE_URL`, so every
Testcontainers-dependent integration file failed. Nothing under `fixtures/` was ever affected — the
sprint is scoped "No Postgres" — and all 69 fixture proofs passed throughout.

`repo-foundation` has since added a third rung to the test-database ladder
(`packages/db/src/testing/embedded.ts`): when no container runtime answers, the stock PostgreSQL
binaries are started in a temp directory on an ephemeral port. Verified on this workstation on
2026-09-01, with no Docker daemon: all seven previously-failing files now obtain a database. Five
pass. The two that still fail do so for an unrelated reason — `registerObservationRoutes` throws
`not implemented`, a deliberate stub belonging to a later API sprint — so no fixture-harness
obligation is outstanding here.

**The `hostile-modes` execution span was terminalized after the fact.** An EPERM during a ledger
repair mid-sprint left its `execution-started` event with no `execution-completed`, so `nah trace`
reported the task as still running and closure recorded "done tasks lack execution timing" as a
finding. Both endpoints were nevertheless present in this ledger — `started_at` on the
`execution-started` event, and the `task-finished` event at `2026-09-01T15:06:23.582Z` — so the
missing row was reconstructed from them rather than estimated: `succeeded`, `duration_ms` 278428.
The span is derived from recorded evidence, not observed live, which is why it is written down
here.

No execution handoff yet.

<!-- nah-checkpoint:1bcc8275e5211ab6 -->
## 2026-09-01T14:31:17.743Z · claude-code · 6ce1a417-c7ca-49b6-9294-3336e62033e0

- Stage: implementation
- Ready: none
- In progress: harness-seam
- Root blockers: none
- Done: 0/6
- Receipts: none
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s1b`

<!-- nah-checkpoint:31f194d5caba067d -->
## 2026-09-01T16:01:16.480Z · claude-code · 6ce1a417-c7ca-49b6-9294-3336e62033e0

- Stage: hardening
- Ready: none
- In progress: none
- Root blockers: none
- Done: 6/6
- Receipts: none
- Findings: none
- Assurance request: hardening:hardening-hac4891b82a3d910c
- Knowledge revisions: none
- Resume: `nah harden s1b`
