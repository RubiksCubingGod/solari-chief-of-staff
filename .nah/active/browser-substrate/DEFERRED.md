# Deferred

Nothing deferred during bootstrap.

## Carried in from `fixture-harness`, not discharged here

`fixture-harness`'s handoff owes two proofs to "when `browser-substrate` lands LocalProvider":

- `hostile-mode-surfaces` — a browser fetch of a `blocked` fixture URL that sees content a plain
  fetch cannot **and** reads `fixture-state:normal` off the materialized document. Today the
  script-materialization step is proven only against a test-owned DOM stub; what is unproven is
  that a real engine's parsing and `DOMContentLoaded` ordering reach the same document. The
  hardening pass found a live defect on exactly this seam, so the gap is load bearing.
- `assisted-cancellation-path` — a browser-driven walk of the fakegym cancellation flow through
  its rendered forms. The server-side branches are already proven over HTTP with a cookie jar.

**Both are now unblocked** — LocalProvider exists, Playwright is a declared dependency, and
`pnpm browsers` installs the Chromium. Neither is done here, deliberately:

- This sprint's accepted scope names "no fixture-site involvement" as a non-goal (README
  §Non-goals). Taking the proofs would be a task-architecture change to a sprint whose three tasks
  are seam, adapter, and live smoke.
- Neither proof exercises anything about `browser-substrate` that its own contract suite does not
  already cover. They prove *fixture* behavior; LocalProvider is only the driver.
- The markup already carries the accessible names and `data-testid` hooks, so neither needs a
  fixture change whenever it is picked up.

**Routing:** discharge each in the sprint that first depends on it — `hostile-mode-surfaces` in
`watch-engine` (tier-2 escalation is the consumer of the `fixture-state` marker), and
`assisted-cancellation-path` in `action-playbooks` (the fakegym flow is that sprint's first
scripted playbook). `fixture-harness` is closed, so this file is the surviving pointer; the owed
rows in its TEST-MATRIX.md still name `browser-substrate` as the debtor and should be re-pointed
when either sprint is scoped.
