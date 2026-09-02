# Handoff

## 2026-09-02 · implementation · userio-gate

### Where the frontier is

- `task-state-machine` done at `8d7b95f` (with findings: the gate receipt is red on the watch-engine sibling's live work, see below).
- `userio-gate` implemented and proven; closing with `nah task finish`.
- Next ready: `guardrails` and `replay-embed-page`; then `playbook-runner` (needs `guardrails`), then `fakegym-cancellation`. Still sequential in the shared tree: every gate proof is the whole workspace.

### What landed

- `packages/core/src/user-io.ts`: the port. `UserQuestion` (the recorded `ask_user` payload plus `taskId` and `userId`), `UserIO.ask(question)` outbound, `UserAnswerSink.resolve(taskId, questionId, resolution)` inbound with `UserResolution = answer | decline` and `UserResolutionOutcome` (accepted, or refused with the ledger's reason / `not_found`). `scriptedUserIO(sink, script, { delayMs? })` is the double: the nth line answers the nth question, `ignore` or a question past the script stays unanswered, replies land after `ask` has returned, and `asked`, `outcomes`, `settled()` let a proof watch it.
- `packages/db/src/user-io.ts`: `createUserAnswerSink(ledger, now?)` - an answer goes to `answerTask`, a decline to `declineTask`.
- `packages/db/src/task-ledger.ts`: `declineTask(db, taskId, { questionId }, now?)` moves `waiting_user → cancelled` by `declined`. The checks an answer and a decline share (`not_waiting`, `unknown_question`, `expired` with the lazy timeout) are one `openQuestion` step, so both refuse and record identically. `AnswerOutcome` is now the port's `UserResolutionOutcome`.
- `packages/db/src/task-engine.ts`: `TaskEngineOptions.userIO?`. After `askUser` commits, the engine delivers `{ taskId, userId, ...question }`; a delivery that throws leaves a `step` event (`deliver_question`, `failed`, the message) and the question stands.

### Assumptions recorded (low-risk, reversible)

- **Port in core, sink in db.** Telegram (s7) implements `UserIO` and calls the sink; the API and dashboard can call the sink with no channel at all. The scripted double is in core as well - pure and unit-tested to the 100% bar - so playbook and guardrail proofs import it from the vocabulary package rather than from a test helper.
- **A decline is a transition, not a reply.** No `user_reply` row is written; the `declined` transition's detail carries the `questionId`. `acceptedAnswers` and `TaskAnswer` are unchanged, because no mission ever runs again on a decline.
- **Delivery failure is not task failure.** The question and its deadline are committed before delivery is attempted; a failed delivery is recorded as a `step` named `deliver_question` so a timeline can tell "never reached the person" from "the person never answered". Retrying delivery belongs to s7 (the `deliveries` table is there for it).
- **The gap between commit and delivery.** A worker that dies after `askUser` commits and before `ask` returns loses the delivery: the retried job finds the task parked and does nothing. Same fallback as above - the dashboard shows the question, the deadline fails the task. Recorded for s7.
- **`userIO` is optional on the engine.** Proofs of the machine run without one; `playbook-runner` must pass one when it wires the production worker.

### Findings

- **What the task-state-machine gate receipt actually says.** By the time `nah task finish` ran `task-lifecycle-gate`, the sibling had fixed its lint errors, so the receipt is red one step later: the test step fails on five of the sibling's in-progress `packages/watch/src/fetch/ladder.integration.test.ts` tests (819 passed / 4 skipped, 91 files). The findings reason on that task names the lint errors seen an hour earlier; the receipt's stdout is the authority. Both are the same live sibling work, and hardening should re-run the gate once the watch-engine ladder task lands.

### Receipts

- RED: `node scripts/vitest.mjs run --project integration packages/db/src/user-io.integration.test.ts` → exit 1, `Cannot find module './user-io.js'` (attributed as `userio-red`, recorded before any implementation file existed).
- GREEN: same command → 6 passed. Rules: `node scripts/vitest.mjs run --project unit packages/core/src/user-io.test.ts packages/core/src/task-lifecycle.test.ts` → 12 passed. The engine suite re-run after the ledger refactor → 11 passed. Core coverage on the new module: full.
- Gate: `node scripts/check.mjs` → see the ledger receipt.

### Resume

`nah implement s5`

## 2026-09-02 · implementation · task-state-machine

### What landed

- `packages/core/src/task-lifecycle.ts`: the transition table (cause → from → to), `transitionTarget`, `TERMINAL_TASK_STATUSES`, `REJECTION_REASONS`, and the payload types for every `task_events` type. `TASK_STATUSES` gained `cancelled`; `TASK_EVENT_TYPES` gained `rejected`.
- `packages/db/src/task-ledger.ts`: every status change goes through a row lock plus the table. `transitionTask`, `claimTaskRun`, `enqueueTaskRun`, `askUser`, `answerTask`, `expireQuestion`, `orphanTask`, `readTaskTimeline`, `pendingQuestion`, `acceptedAnswers`, `appendTaskEvent`. Queues `tasks.run` and `tasks.timeout`.
- `packages/db/src/task-engine.ts`: `registerTaskEngine({ db, mission, waitingUserTimeoutMs?, now? })` registers the run handler, the timeout handler, the `tasks.reconcile` cron (every minute) and sweeps once at start. `runTaskJob` and `reconcileTasks` exported for direct use. `Mission` returns `succeeded | failed | ask`.
- Schema: `tasks.job_id` (the job entitled to run the task), `task_events.seq` (identity; the timeline's order). Migration `0006_task_lifecycle` (the watch-engine sibling took 0005).
- Harness: `enqueue(queue, payload, { startAfter })` and a `schema` property on `JobHarness`.

### Assumptions recorded (low-risk, reversible)

- **Placement.** Rules in core, ledger and engine in db. The API needs the ledger (create, enqueue, answer) without a browser dependency and the worker already builds db. Playbooks, guardrails and the runner go in `packages/playbooks`.
- **Ask releases the browser by construction.** A mission that needs a person *returns* `ask`; the handler ends, the job completes, nothing holds a session. Resume is a fresh mission invocation with `answers` populated, never a continuation.
- **Failure detail lives on the transition event, not `result`.** `result` is written on `succeeded` only. A failed task's reason is the `transition` event's `detail`.
- **Timeout is a held job.** `askUser` enqueues `tasks.timeout` with `startAfter = expiresAt`; the answer path also expires lazily when the deadline passed before the timer fired; the sweep expires overdue questions if the timer job was lost. Default deadline 24h (`DEFAULT_WAITING_USER_TIMEOUT_MS`).
- **Job identity guards duplicates.** `claimTaskRun` refuses a delivery whose job id is not the row's `job_id`; `enqueueTaskRun` only enqueues a `queued` task. Two enqueues before delivery: one runs, one steps aside. A redelivered job after settlement is a no-op with no events.
- **Sweep, not the API, enqueues API-created tasks for now.** `POST /tasks` still only inserts; the reconcile sweep enqueues a queued task with no live job within a minute. Direct enqueue from the API lands with `playbook-runner` when the mission exists to run.
- **Production worker wiring is owed to `playbook-runner`.** `scripts/worker.mjs` still registers nothing; there is no mission to give it yet. `startWorker(options, [registerTaskEngine({ db, mission, userIO })])` is the intended line.
- **Hard-kill window.** A worker killed with SIGKILL (not `stop({graceful:false})`) leaves its job `active` until pg-boss's `expireInSeconds` (queue default 900s) lapses; the row reads `running` for that window, then the retry/orphan path applies. The harness does not expose per-queue expiry; add one if a shorter window is wanted.

### Findings

- **Shared-tree sweep.** The watch-engine sibling's `nah task finish` (commit `a453e10`) committed `packages/core/src/index.ts` and `packages/db/src/schema.ts` with this task's then-uncommitted edits in them (the `cancelled`/`rejected` values, the `export * from './task-lifecycle.js'` line, `job_id`, `seq`). HEAD therefore referenced a module and columns that did not exist at HEAD until this task's commit. No repair needed beyond finishing this task promptly; noted so the next shared-file edit is committed in the same breath as the files it needs.
- Migration numbering: generated 0006 from a HEAD-based schema copy so it carries only this task's delta; snapshot chains from the sibling's 0005.
- **Gate blocked by live sibling work.** The workspace gate is one command over the whole tree, so the watch-engine sprint's uncommitted work fails it for every sprint at once. Not repaired here: the files are untracked and their owner is active. Hardening should re-run the gate once that sprint's ladder task lands.
- **Ledger rename race.** `nah verify` lost a rename over `events.jsonl` to the `nah dev` watcher (`EPERM`), leaving a dangling `verification-started` and a `.tmp`; removed the `.tmp` and re-recorded with `nah verify --retry`.

### Receipts

- RED: `node scripts/vitest.mjs run --project integration packages/db/src/task-engine.integration.test.ts` → exit 1, `Cannot find module './task-engine.js'`. The attributed receipt was recorded after the fact by running the declared proof with `task-engine.ts` moved out of the tree - the exact absence the signature names - because the original red run predated the proof declaration and was never attributed.
- GREEN: same command → 11 passed, 30s.
- Rules: `node scripts/vitest.mjs run --project unit packages/core/src/task-lifecycle.test.ts packages/core/src/index.test.ts` → passed (with schema and API vocabulary tests).
- Gate: `node scripts/check.mjs` → red (receipt `task-lifecycle-gate`): lint passed by then, and the test step failed on five of the sibling's in-progress `packages/watch/src/fetch/ladder.integration.test.ts` tests. The step-by-step run just before it on the same tree: typecheck and typecheck:tests pass; the test step is 780 passed / 4 skipped across 86 files and fails only the core 100% coverage threshold, where the sibling's untracked `ladder.ts` (lines 1/6, functions 0/5) is the sole file short; build and build:web pass. Closed with `--continue-with-findings`.

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

<!-- nah-checkpoint:a6bffae8aef5bccd -->
## 2026-09-02T05:28:57.379Z · claude-code · 8054cf2e-8aef-4bfd-8b27-56afcffb8a6f

- Stage: implementation
- Ready: guardrails, replay-embed-page
- In progress: userio-gate
- Root blockers: none
- Done: 1/6
- Receipts: verification-completed-eventc75e501c0b9844b68b468c29ec17058f, verification-completed-event95b4de8e04a649ba9bc73a37d079a346, verification-completed-eventa20f3fd88c57419d85f34c6fe29fd100, verification-completed-event3cc439ae178d481b9d6c6c5f86365f90, verification-completed-event9711a9c6a8a24baa903d024f4fb5e8a1
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s5`
