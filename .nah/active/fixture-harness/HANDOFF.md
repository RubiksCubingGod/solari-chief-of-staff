# Handoff

## Carried obligations for later sprints

**One proof is owed to `browser-substrate`.** Two specs describe proofs "driving a LocalProvider
browser", and LocalProvider does not exist yet: `packages/solari` is still a stub, Playwright is not
a declared dependency, and no DOM environment is installed. Adding either here would duplicate
`browser-substrate`'s change surface, so it was not done.

- `hostile-mode-surfaces` — `blocked` is proven on its HTTP half only: a plain fetch gets the
  captcha shell, the shell carries no observable value, and the real body is recoverable only as a
  base64 payload a script client must decode. The other half — that a real browser executing that
  script sees the content — needs a browser. Everything else in that spec is fully proven over HTTP,
  including all of `hard-blocked` (the escalation header is caller-supplied by design, so it never
  needed a browser) and all of `redesign`.
- `assisted-cancellation-path` — proven end to end over HTTP with a cookie jar. The session
  progress, the code gate, and every refusal branch are server-side and behave identically under
  either driver; what is unproven is that a browser can operate the forms.

When `browser-substrate` lands LocalProvider, add: a browser fetch of a `blocked` fixture URL that
sees the content a plain fetch could not, and a browser-driven walk of the fakegym cancellation
flow. Neither should need a fixture change — the markup already carries accessible names and
`data-testid` hooks for exactly this.

**The full `pnpm check` has never run green on this workstation.** No container runtime is installed
(no `docker` on PATH, no Docker Desktop) and there is no local Postgres for `TEST_DATABASE_URL`, so
every Testcontainers-dependent integration file fails. This predates the sprint and is already
recorded in the repo-foundation review. Nothing under `fixtures/` needs a container — the sprint is
scoped "No Postgres" — and all 58 fixture proofs pass.

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
