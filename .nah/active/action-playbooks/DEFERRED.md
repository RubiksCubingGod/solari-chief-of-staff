# Deferred

Nothing deferred during bootstrap.

## 2026-09-02 · hardening

- **Replay tests can 404 under the parallel gate.** In one `check.mjs` run (`guardrails` refresh at `a714c5c`) the two replay tests in `packages/web/src/task-detail-page.integration.test.ts` saw the dashboard's recording route answer 404 for tasks whose pages had just rendered with a player; the suite passes alone on the same tree. Each suite owns its database and auth stack, so the suspect is the six in-process Next dev instances sharing `packages/web` (own `.next/instance-*`, same source tree and file watcher). That harness is `packages/web/src/testing/dev-server.ts` from the dashboard sprints, so the fix belongs there: isolate the watcher (or run the web suites serially) and prove it with a gate that runs all six web suites together. Not this sprint's outcome; left visible.
