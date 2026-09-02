# Handoff

## 2026-09-02 · implementation · task-state-machine

### Where the frontier is

- `task-state-machine` implemented and proven; closing with `nah task finish`.
- Next ready after close: `userio-gate`, `guardrails`, `replay-embed-page` (all blocked only by `task-state-machine`). Executing sequentially in the shared tree because every gate proof is the whole workspace.

### What landed

- `packages/core/src/task-lifecycle.ts`: the transition table (cause → from → to), `transitionTarget`, `TERMINAL_TASK_STATUSES`, `REJECTION_REASONS`, and the payload types for every `task_events` type. `TASK_STATUSES` gained `cancelled`; `TASK_EVENT_TYPES` gained `rejected`.
- `packages/db/src/task-ledger.ts`: every status change goes through a row lock plus the table. `transitionTask`, `claimTaskRun`, `enqueueTaskRun`, `askUser`, `answerTask`, `expireQuestion`, `orphanTask`, `readTaskTimeline`, `pendingQuestion`, `acceptedAnswers`, `appendTaskEvent`. Queues `tasks.run` and `tasks.timeout`.
- `packages/db/src/task-engine.ts`: `registerTaskEngine({ db, mission, waitingUserTimeoutMs?, now? })` registers the run handler, the timeout handler, the `tasks.reconcile` cron (every minute) and sweeps once at start. `runTaskJob` and `reconcileTasks` exported for direct use. `Mission` returns `succeeded | failed | ask`.
- Schema: `tasks.job_id` (the job entitled to run the task), `task_events.seq` (identity; the timeline's order). Migration `0006_task_lifecycle` (the watch-engine sibling took 0005).
- Harness: `enqueue(queue, payload, { startAfter })` and a `schema` property on `JobHarness`.

### Assumptions recorded (low-risk, reversible)

- **Placement.** Rules in core, ledger and engine in db. The API needs the ledger (create, enqueue, answer) without a browser dependency and the worker already builds db. Playbooks, UserIO, guardrails and the runner go in `packages/playbooks`.
- **Ask releases the browser by construction.** A mission that needs a person *returns* `ask`; the handler ends, the job completes, nothing holds a session. Resume is a fresh mission invocation with `answers` populated, never a continuation.
- **Failure detail lives on the transition event, not `result`.** `result` is written on `succeeded` only. A failed task's reason is the `transition` event's `detail`.
- **Timeout is a held job.** `askUser` enqueues `tasks.timeout` with `startAfter = expiresAt`; the answer path also expires lazily when the deadline passed before the timer fired; the sweep expires overdue questions if the timer job was lost. Default deadline 24h (`DEFAULT_WAITING_USER_TIMEOUT_MS`).
- **Job identity guards duplicates.** `claimTaskRun` refuses a delivery whose job id is not the row's `job_id`; `enqueueTaskRun` only enqueues a `queued` task. Two enqueues before delivery: one runs, one steps aside. A redelivered job after settlement is a no-op with no events.
- **Sweep, not the API, enqueues API-created tasks for now.** `POST /tasks` still only inserts; the reconcile sweep enqueues a queued task with no live job within a minute. Direct enqueue from the API lands with `playbook-runner` when the mission exists to run.
- **Production worker wiring is owed to `playbook-runner`.** `scripts/worker.mjs` still registers nothing; there is no mission to give it yet. `startWorker(options, [registerTaskEngine({ db, mission })])` is the intended line.
- **Hard-kill window.** A worker killed with SIGKILL (not `stop({graceful:false})`) leaves its job `active` until pg-boss's `expireInSeconds` (queue default 900s) lapses; the row reads `running` for that window, then the retry/orphan path applies. The harness does not expose per-queue expiry; add one if a shorter window is wanted.
- **`declined` cause is in the table; the ledger op lands with `userio-gate`** (decline → cancelled is that task's done_when).

### Findings

- **Shared-tree sweep.** The watch-engine sibling's `nah task finish` (commit `a453e10`) committed `packages/core/src/index.ts` and `packages/db/src/schema.ts` with this task's then-uncommitted edits in them (the `cancelled`/`rejected` values, the `export * from './task-lifecycle.js'` line, `job_id`, `seq`). HEAD therefore referenced a module and columns that did not exist at HEAD until this task's commit. No repair needed beyond finishing this task promptly; noted so the next shared-file edit is committed in the same breath as the files it needs.
- Migration numbering: generated 0006 from a HEAD-based schema copy so it carries only this task's delta; snapshot chains from the sibling's 0005.
- **Gate blocked by live sibling work.** The workspace gate is one command over the whole tree, so the watch-engine sprint's uncommitted stub fails it for every sprint at once (lint and core coverage). Not repaired here: the file is untracked and its owner is active. Hardening should re-run the gate once that sprint's ladder task lands.
- **Ledger rename race.** `nah verify` lost a rename over `events.jsonl` to the `nah dev` watcher (`EPERM`), leaving a dangling `verification-started` and a `.tmp`; removed the `.tmp` and re-recorded with `nah verify --retry`.

### Receipts

- RED: `node scripts/vitest.mjs run --project integration packages/db/src/task-engine.integration.test.ts` → exit 1, `Cannot find module './task-engine.js'`. The attributed receipt was recorded after the fact by running the declared proof with `task-engine.ts` moved out of the tree - the exact absence the signature names - because the original red run predated the proof declaration and was never attributed.
- GREEN: same command → 11 passed, 30s.
- Rules: `node scripts/vitest.mjs run --project unit packages/core/src/task-lifecycle.test.ts packages/core/src/index.test.ts` → passed (with schema and API vocabulary tests).
- Gate: `node scripts/check.mjs` → red at lint, entirely in the watch-engine sibling's untracked `packages/core/src/watch/ladder.ts` (10 `no-unused-vars`). Run step by step on the same tree: typecheck and typecheck:tests pass; the test step is 780 passed / 4 skipped across 86 files and fails only the core 100% coverage threshold, where `ladder.ts` (lines 1/6, functions 0/5) is the sole file short; build and build:web pass. Closed with `--continue-with-findings` naming that file.

### Resume

`nah implement s5`

<!-- nah-checkpoint:63e4f17bd6dcab5d -->
## 2026-09-02T05:04:36.254Z · claude-code · 8054cf2e-8aef-4bfd-8b27-56afcffb8a6f

- Stage: implementation
- Ready: none
- In progress: task-state-machine
- Root blockers: none
- Done: 0/6
- Receipts: none
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s5`
