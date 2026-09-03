# Handoff

No execution handoff yet.

<!-- nah-checkpoint:3a05dec7dd2d9d40 -->
## 2026-09-02T20:44:57.000Z · claude-code · 5565ff5b-c667-4fc6-b670-fb11aca34d52

- Stage: implementation
- Ready: slot-watch-kind, dmv-booking-playbook
- In progress: none
- Root blockers: none
- Done: 0/3
- Receipts: none
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s8`

<!-- nah-checkpoint:4fe869176dcdc064 -->
## 2026-09-02T21:02:01.470Z · claude-code · 5565ff5b-c667-4fc6-b670-fb11aca34d52

- Stage: implementation
- Ready: none
- In progress: slot-watch-kind, dmv-booking-playbook
- Root blockers: none
- Done: 0/3
- Receipts: verification-completed-event77f008e7164b4045b4528e8f7dfda6ca
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s8`

<!-- nah-checkpoint:e5e096b9e24663a4 -->
## 2026-09-02T21:21:51.245Z · claude-code · 5565ff5b-c667-4fc6-b670-fb11aca34d52

- Stage: implementation
- Ready: none
- In progress: dmv-booking-playbook
- Root blockers: none
- Done: 1/3
- Receipts: verification-completed-event77f008e7164b4045b4528e8f7dfda6ca, verification-completed-event9f91d60e9f07485a8bd1e8cf0ac65c9c, verification-completed-event51629180de3f4af8be83b3609b3df207, verification-completed-eventcfe30aea7c964c65b01de5c9451805ec
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s8`

## Assumptions and decisions (implementation, 2026-09-02)

Recorded by the implementing session; each is reversible and taken from the accepted plan and engineering context rather than waited on.

- **Refused is a task failure by cause.** A booking that does not book because the site or the person said no ends `failed` with transition cause `refused` (new core cause, running→failed) and transition detail `{ reason, detail: { code } }`. `code` is one of the core `BOOK_SLOT_REFUSALS`: `slot-gone` or `not-confirmed`. `bookSlotRefusal(transitionDetail)` reads it back; anything else is an ordinary failure. This keeps refused-slot-gone "(not failed)" per the README as a distinct, machine-readable outcome without a fourth terminal status.
- **Booked means booked.** The `book` step reads the fixture's booking record off the page and hands `reference` and `bookedAt` back through the new `StepOutcome.done.result`, which the runner folds into the task result under its own `playbook`/`steps` fields. `parseBookSlotBooked(task.result)` is the read side. The fixture now mints `DMV-` + six digits as the reference.
- **Open-access playbooks.** `definePlaybook({ access: 'open' })` skips the site-connection and credential lookup and opens a plain session; `PlaybookContext.connection`/`credential` are optional. fakedmv has no account, so its playbook is open; fakegym stays `connection` and its login step guards the (now typed) absence with a "connect this site" failure.
- **Re-check is the first step, always.** Steps re-run from the top after an answer, so the availability re-check after the person's yes is automatic: the yank race ends refused `slot-gone` in the fresh session before anything is filled in. A `409 gone` at submit maps to the same refusal; `503 transient` is an ordinary failure (the slot is still there, nothing to re-arm for).
- **Confirm gate.** The question text carries the slot label and applicant; only an explicit yes-word books, anything else is `not-confirmed`; a decline never reaches the step (the engine cancels the task). `auto_book` skips the gate and records `confirmed: 'auto'`.
- **Re-arm semantics for race-rearm.** `slot-gone` re-arms with the baseline cleared (the slot may return and would be news); `not-confirmed` re-arms with the baseline kept (the person saw that slot and said no); booked leaves the watch paused and notifies; any other failure or a guard violation leaves the watch paused for a human, notified. The watch's `booking` notification is the s7 `sendToUser` seam; no new notification machinery.
- **No-port slot checks fail quietly.** A slot watch on a worker without a booking trigger fails the check (not transient) without notifying; a re-released identical slot shares the trigger's dedup key.
- **Deferred to race-rearm:** fakedmv mode state (blocked shell), `packages/watch/src/snipe.ts` consequences, `scripts/worker.mjs` wiring, and the composed proof suite.
- **slot-watch-kind-gate** was recorded red only because sibling sprints' RED files broke repo-wide lint at the time; the tree is clean now and the gate is to be re-earned with a bare `nah task finish slot-sniping slot-watch-kind`.

<!-- nah-checkpoint:b872be6e3f2a0c96 -->
## 2026-09-02T21:55:41.101Z · claude-code · 5565ff5b-c667-4fc6-b670-fb11aca34d52

- Stage: implementation
- Ready: none
- In progress: race-rearm
- Root blockers: none
- Done: 2/3
- Receipts: verification-completed-event77f008e7164b4045b4528e8f7dfda6ca, verification-completed-event9f91d60e9f07485a8bd1e8cf0ac65c9c, verification-completed-event51629180de3f4af8be83b3609b3df207, verification-completed-eventcfe30aea7c964c65b01de5c9451805ec, verification-completed-eventa1df4aaf4fd64fa789c3bf83596f885c, verification-completed-event43d874ab2a9a4474911b458824c9aeb3, verification-completed-event6e5ba621f2834885a7f9ab7ee16a7f70, verification-completed-eventcf0be3b811ea4f48910b07ee7737c55b, verification-completed-event4e27cd3ff801460996738a7aad8cc862
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s8`

## Assumptions and decisions (race-rearm, 2026-09-02)

Recorded by the implementing session; each is reversible and taken from the accepted plan and engineering context rather than waited on.

- **The consequence is applied once, from two places.** `settleSnipe(ports, taskId)` runs in one transaction under the task's row lock, applies the consequence (booked → watch stays paused; slot-gone or a person passing → `rearmWatch`; anything else → paused), tells the notifier a `booking` event, and records a `snipe` step on the task's trail, which is the idempotence marker. The task engine's new `settled` hook calls it the moment this worker settles a run or expires a question; the watch engine's sweep (`watch-check.snipe`, every minute and once at start) calls it for a task settled elsewhere - a decline through a channel, an orphan - or one the hook could not finish. The notifier is told inside the transaction, so a failed delivery rolls the re-arm back and the sweep retries under the same dedup key (`bookingDedupKey(watchId, taskId, outcome)`).
- **Why a hook and not a mission wrapper.** A decline is settled by `declineTask` in the ledger from the bot or API process; the worker's mission never sees it. The hook gives immediacy for what the worker settles; the sweep gives completeness for the rest. A hook that throws puts a `settled_hook` failed step on the trail and leaves the task settled.
- **Timeout re-arms with the baseline kept.** Nobody answering is treated like not confirming: the slot they were not asked about in time is not offered again, the next release is. Cancelled without a decline transition also re-arms with the baseline kept; a refusal code the engine has no word for, an error, a violation, or an orphan leaves the watch paused with the transition's own reason.
- **The booking event is the fourth notifier event.** `BookingEvent { type: 'booking', taskId, slot, outcome: 'booked'|'rearmed'|'paused', reference, reason }` on the existing `NotifierPort`; s7's `sendToUser` seam carries it, no new machinery. The only consumer outside core/watch is `packages/agent/src/healing.ts`, which uses the port type only.
- **fakedmv gains the four fixture modes.** Its calendar is the page the slot watch observes, so it now carries `normal`, `blocked`, `hard-blocked` and `redesign` through the shared `createModeState`, with `redesign` rendering the same slots as a table under different classes and identical semantics; `POST /book` answers JSON in every mode. `fixtures/src/control-plane.integration.test.ts` and `fixtures/README.md` previously said fakedmv must not claim the mode route because a redesigned booking POST had no meaning; both were updated with the new rationale. The blocked-mode proof uses `hard-blocked`: `blocked` serves a shell whose script materialises the body, so a browser-driven playbook sees normal content there.
- **`rearmWatch` takes a `TaskDatabase`** (database or transaction) so the re-arm runs under the task's row lock.
- **No devDependency for playbooks in watch.** The proof imports `@chief-of-staff/playbooks` through the vitest alias and `tsconfig.test.json` paths; no `pnpm install` was run in this sprint.
- **Worker wiring.** `scripts/worker.mjs` registers `fakedmvBooking` (origin `FAKEDMV_URL`, default `http://127.0.0.1:4304`) beside the fakegym cancellation and passes `settled: (taskId) => watch.settleSnipe(snipe, taskId)` to the task engine; the sweep is registered by `registerWatchEngine`.
- **Gate status.** `pnpm typecheck` is red at HEAD-plus-tree only in the calendar-wiring sibling's uncommitted `packages/db/src/calendar-scan.ts`; repo-wide lint is red only in the agentic-mode sibling's untracked files. Every proof scoped to this sprint's files is green; the gate is to be re-earned with a bare `nah task finish` once the siblings commit.

## Checkpoint after race-rearm (2026-09-02, session 5565ff5b)

- **race-rearm is done with findings** (commit `25f4053c`): green (snipe + task-engine integration, 18 tests) and rules (20 tests) passed; the gate was recorded red with exit 4294967295 because this session killed its own `check.mjs` run on purpose - the calendar-wiring sibling's `auto-cancel-enqueue` finish had entered `vitest --coverage` thirteen seconds earlier and two coverage runs in one checkout kill each other through `coverage/.tmp`. Re-record with `nah verify slot-sniping race-rearm race-rearm-gate --retry` once no other coverage run is alive.
- **`scripts/worker.mjs` is deliberately not in the race-rearm commit.** The file holds this sprint's hunk (the `fakedmvBooking` registration, the `snipe` ports and `settled: (taskId) => watch.settleSnipe(snipe, taskId)`) and calendar-wiring's hunk (`db.withConfirmation`, `bot.createTelegramUserIO`, `playbooks.createCancellationPlanner`), and the sibling's hunk references modules still untracked in their sprint, so committing the whole file would have broken `pnpm worker` at HEAD. Everything this sprint's hunk needs is at HEAD now; the sibling agreed to carry the file in its finish. If that finish is abandoned, commit `scripts/worker.mjs` from this sprint once `packages/db/src/confirm.ts`, `packages/bot/src/user-io.ts` and `packages/playbooks/src/auto-cancel.ts` are in.
- **Red gates to re-earn while the implement attempt is live:** `slot-watch-kind-gate`, `dmv-booking-playbook-gate` (bare `nah task finish slot-sniping <task>`) and `race-rearm-gate` (`--retry`), one at a time, after checking for a live `vitest --coverage`. Repo-wide lint and typecheck were clean at 23:41 local with the sibling's untracked files in the tree; the killed gate run had shown `tests/calendar-reminders.integration.test.ts` failing (3 tests), which is calendar-wiring's in-progress work or contention, not this sprint's.
- **Then:** `nah stage implementation-complete slot-sniping attempt-rc19c4de9b74c492e95b5e3ee91bf03b3`, detached with a log, to request hardening.

## Checkpoint: implementation complete, hardening requested (2026-09-03, session 5565ff5b)

- Stage: hardening requested - `nah stage implementation-complete` returned `assurance-requested`, request `hardening-hf3dc412bbbe494aa` (frontier digest `a1e878c2…`), at 03:46:58Z.
- Done: 3/3. Bare re-finishes at HEAD: `race-rearm` → `ae6751b` (gate red: two `packages/web` page tests hit Playwright's 30 s `page.goto` timeout under full-coverage load; 1507 others passed), `slot-watch-kind` → `f5b773a` (gate red only at `build:web`: `packages/web/src/tasks/view-model.test.ts` sets `llmUsage` on the web api-client `Task` type, which lacks it - agentic-mode's HEAD, owner told), `dmv-booking-playbook` → `a0e76a0` (gate red at `typecheck:tests` on agentic-mode's untracked `packages/playbooks/src/agentic/eval/scripted.integration.test.ts`, their RED in progress; all 1509 tests passed on the slot-watch-kind run).
- Findings carried into the request: `slot-watch-kind-red` reported missing, `dmv-booking-playbook-gate` and `race-rearm-gate` red. Every proof scoped to this sprint's own files is green; the gate is red only for sibling-owned reasons, so hardening should re-run the gates once agentic-mode's web client type and eval modules land.
- `scripts/worker.mjs` is at HEAD with this sprint's hook via calendar-wiring's `b31bd10` and agentic-mode's `c5afb93`; the tree copy equals HEAD.
- Coverage etiquette agreed with the sibling sessions: one `vitest --coverage` at a time in this checkout; the order after this sprint's gates was calendar-wiring (telegram-roundtrip gate, then its auto-cancel-enqueue retry), then agentic-mode (mission-e2e). Check `Get-CimInstance Win32_Process` for `run --coverage` before any gate.
- Resume: `nah harden slot-sniping` (same profile), then `nah lifecycle assurance slot-sniping` with the typed result on stdin.
