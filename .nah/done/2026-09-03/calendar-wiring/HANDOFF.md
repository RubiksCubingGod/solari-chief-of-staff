# Handoff

## 2026-09-02 · implementation · calendar-semantics

### Where the frontier is

- Attempt `attempt-r53d36e82e249456983d178be598b13d1` (single-session, this conversation) owns the sprint. `calendar-semantics` is implemented and its proofs are declared (red recorded at 16:51Z: `Cannot find module './calendar-ledger.js'`); it is being finished. Next: `daily-scan-reminders` and `auto-cancel-enqueue` become ready together, then `telegram-roundtrip`.
- Two sibling implementation sessions share this checkout (`agentic-mode`: `browser-toolset` in progress; `slot-sniping`: `slot-watch-kind` and `dmv-booking-playbook` in progress). Their uncommitted files (`packages/playbooks/src/agentic*`, `packages/watch/src/slot-trigger*`) currently fail `typecheck:tests`, so any gate run on this tree is red on their files, not this sprint's. The gate receipt is re-earned with a bare `nah task finish calendar-semantics` once they commit.

### Assumptions recorded (low-risk, reversible)

- The plan says `packages/engine`; no such package exists. The pure semantics live in `packages/core/src/calendar/` (100 % coverage, unit tests) and the persisted half in `packages/db/src/calendar-ledger.ts` (integration tests), the same split the watch engine uses.
- The plan's `subscription_renewal` kind is the s1 `subscription` kind: a subscription's date is its renewal (`renew_on`), a deadline's is `cancel_by`. Renaming the enum value would ripple through the API, the agent tools, the dashboard and their tests for no behavioural gain, and the spec says the annotations persist "on the s1 schema".
- Entry settings are columns on `calendar_items` with safe defaults: `reminder_lead_days` 3, `auto_cancel` false, `auto_cancel_lead_days` 3, and the mark (`annotation`, `annotation_note`, `annotated_at`, null until an engine writes one). Existing rows and the existing `POST /calendar-items` keep working unchanged; exposing the settings through the route and the chat tool belongs to the arm that needs them (`auto-cancel-enqueue`) or to DEFERRED.md.
- Annotations rank `late < needs_attention < declined < handled`; a mark may replace one no stronger than itself. That is what stops a late reminder from erasing "do not auto-cancel", and anything from erasing "cancelled".
- Reminder window: owed from `date − lead` through the date itself, late on every day but the first; nothing after the date. Auto-cancel window: `renew_on − auto_cancel_lead_days` through `renew_on`, subscriptions only, never once declined or handled. Keys: `calendar_reminders (item_id, due_on)` and `calendar_auto_cancels (item_id, renew_on)`, unique in the database (migration `0007_calendar_semantics`).
- "Today" is the person's calendar day (`calendarDayIn(instant, users.tz)`), not the server's.

### Environment

- Run every Postgres proof and every gate with `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres` (the throwaway local server; it was up at 16:50Z). Never run a `--coverage` gate while a sibling session's coverage run is in flight.

## 2026-09-02 · implementation · daily-scan-reminders

### Where the frontier is

- `calendar-semantics` is done (commit `ac1df2e`, gate red only on sibling files). `daily-scan-reminders` is implemented and green on its declared proofs: red recorded at 17:16Z (`createTelegramOutbound is not a function`), green = `tests/calendar-reminders.integration.test.ts` + `packages/db/src/calendar-scan.integration.test.ts`, rules = the message/clock/adapter units. Next: `auto-cancel-enqueue`, then `telegram-roundtrip`.
- The scan lives in `packages/db/src/calendar-scan.ts` (`runCalendarScan`, `registerCalendarScan`, queue `calendar.scan`), the persisted claim/settle in `calendar-ledger.ts`, the words in `packages/core/src/calendar/message.ts`, the port adapter in `packages/bot/src/reminders.ts` (`createReminderSender`), and the worker's send-only door in `packages/bot/src/runtime.ts` (`createTelegramOutbound`: a grammY `Bot` with the transcript transformer and no polling). `scripts/worker.mjs` registers the scan when `TELEGRAM_BOT_TOKEN` is set and says so on stderr when it is not.
- Production still has no process that polls Telegram (no `scripts/bot.mjs`); the worker only sends. `telegram-roundtrip` owns that entry point. The auto-cancel arm should reuse `createTelegramOutbound` for the task engine's `UserIO.ask` in the worker.

### Assumptions recorded (low-risk, reversible)

- The scan cron is hourly (`0 * * * *`) with reminders held until 09:00 on the person's own clock (`REMINDER_SEND_FROM_HOUR`), not one daily UTC fire: a daily fire is somebody's 2 a.m., and an entry created over chat in the afternoon would wait a day. The (entry, day) key is what keeps hourly scans from sending daily reminders twice. Both are constants; a per-user hour is deferred.
- A reminder for a person with no chat bound is `skipped_unbound` and final for that day; binding later gets the next reminders. Re-arming skipped rows on bind is deferred.
- Overlap safety is the attempts counter as an optimistic lock (`claimReminder`: `UPDATE ... WHERE attempts = seen`). A crash after the claim leaves `pending` with the attempt counted, so the next scan retries and the cap (`REMINDER_SEND_ATTEMPTS` = 3) still bounds it. A crash after the send but before the settle is the one at-least-once window, and is inherent.
- A late send marks the entry `late` with the note `The reminder for <due> went out on <today>.`; the rank rule keeps it from covering `declined`/`handled`.
- Amounts are written as the dashboard writes them (cents as a plain decimal, no currency guessed).
- The root `tests/` package has no `drizzle-orm` dependency; the composed suite reads tables without operators rather than adding one.

### Environment

- Same as before: `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres` for every Postgres proof and gate. Sibling sessions now have uncommitted edits in `packages/core/src/book-slot*.ts` and `task-lifecycle*.ts` and a new `packages/playbooks/src/fakedmv.integration.test.ts`; the gate on this tree reports on their files as well as ours.

## 2026-09-02 · implementation · auto-cancel-enqueue

### Where the frontier is

- `auto-cancel-enqueue` is implemented against its recorded red (17:38Z, `Cannot find module './auto-cancel.js'`). Green = `packages/playbooks/src/auto-cancel.integration.test.ts` (the whole path: flagged entry → scan → task behind the confirm gate → Telegram-shaped yes/code answers → fakegym playbook → entry marked) plus the bot routing suite over the real ledger and harness, the reminder scan suite, the front door, the API and the outbound/binding/runtime suites; rules = consent, action, message, dispatch, confirm and the bot's question port. Next: `telegram-roundtrip` (the polling entry point `scripts/bot.mjs` and the live suite).
- Shape: `packages/core/src/consent.ts` (`readConsent`, `resolutionOf`: the one reading of yes/no both ends share), `packages/core/src/calendar/action.ts` (`cancellationSiteOf`), `cancellationQuestion` in `message.ts`; `packages/db/src/confirm.ts` (`withConfirmation`, the mission wrapper), `calendar-ledger.ts` (`findAutoCancel`, `armAutoCancel` - row and task in one transaction - `settleAutoCancel`), `calendar-scan.ts` (settlement loop first, then per entry reminder arm then auto-cancel arm; report gains `enqueued`, `unlinked`, `settled`); `packages/playbooks/src/auto-cancel.ts` (`createCancellationPlanner`: site → playbook → connection, or the sentence that goes on the entry); `packages/bot/src/routing.ts` (`createLedgerAnswerSink` over `createUserAnswerSink`; `QUESTION_CLOSED` / `DECLINE_RECORDED` replies), `runtime.ts` (`harness` option; refuses to build with neither harness nor sink), `user-io.ts` (`createTelegramUserIO`). `scripts/worker.mjs` composes the gate, the Telegram question port and the planner when `TELEGRAM_BOT_TOKEN` is set.
- Migration `0009_auto_cancel_outcomes` (three enum values, `settled_at`). Numbered 0009 because `agentic-mode` landed `0008_task_llm_usage` first (commit `40eff61`); the journal at HEAD lists idx 0–8 and this task's finish carries idx 9.

### Assumptions recorded (low-risk, reversible)

- The confirm gate reads `task.input.confirm` (a question, as words) and wraps the mission rather than living in each playbook: "nothing irreversible without a yes" is the worker's promise, and a chat-queued cancel task can ask the same way by carrying the same key. A no that reaches the gate as an answer fails the task `refused`; a no over the bot is a decline (task cancelled) before the gate runs. An unclear reply is asked again, with a fresh deadline each time.
- The row for a renewal is created in the same transaction as its task (`armAutoCancel`), and the run job is sent after commit; a task whose job never went is what the reconcile sweep picks up. A row that exists means the renewal was decided: the arm skips it whatever its state, so a failed cancellation is not retried for the same renewal (deferred: re-arming).
- Endings are written by the scan (`settled`): succeeded → `handled` with `Cancelled on <today>, ahead of the renewal on <renewOn>.`; cancelled → `declined` with `You said no to cancelling it before the renewal on <renewOn>.`; anything else → `failed` on the row, `needs_attention` on the entry, with the last transition's `detail.reason`, or `nobody answered the question in time` (timeout) / `the worker running it went away` (orphaned). The rank rule still decides what lands on the entry.
- The questions and the reminders are held to the same local hour (`REMINDER_SEND_FROM_HOUR`), so a question lands in the person's morning.
- `action.site` is the convention for which site a cancellation runs on; the API and the chat tool document it, and the planner marks an entry without one `needs_attention` (`the entry names no site to cancel on`). A playbook whose `access` is `open` needs no connection.
- The bot's pending-question read requires the `ask_user` payload's `questionId`; an event without one is ignored (the harmless direction), and the sink answers `not_waiting` / `unknown_question` / `expired` / `not_found` with `QUESTION_CLOSED`.

### Environment

- `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres` for every Postgres proof and gate. The sibling sessions still hold uncommitted edits (`packages/watch/src/snipe*`, `fixtures/*`, `packages/db/src/task-engine*`, `packages/core/src/watch/notifier*`, `packages/playbooks/src/agentic/**`); the gate on this tree reports on their files as well as ours.

## 2026-09-03 · implementation · telegram-roundtrip

### Where the frontier is

- `telegram-roundtrip` is implemented against its recorded red (03:53Z, `liveTelegramSkipReason is not a function`). Green = `packages/bot/src/live-telegram.test.ts` with `tests/docs.test.ts` (the gate on the live suite, and the pins that keep both halves of the opt-in blank in `.env.example`), plus `tests/live-telegram.integration.test.ts` skipping with its reason in the suite name beside the reminder scan suite. Both receipts are recorded. The live proof `telegram-roundtrip-live` (`node scripts/live-telegram.mjs`) is red on this machine and stays a finding: `.env` here holds only `SOLARI_API_KEY`, there is no `TELEGRAM_BOT_TOKEN` and no phone. The finish carries it with `--continue-with-findings`; hardening inherits it.
- What the live run needs, from the owner: the bot's token from @BotFather in `.env`; the id of the chat between the bot and the phone that will answer, as `TELEGRAM_LIVE_CHAT_ID` (README, "The live Telegram round-trip", says where it is); Chromium installed (`pnpm browsers`); no other poller on the token; then `node scripts/live-telegram.mjs` with the phone in hand. Reply `yes`, then the code the terminal prints, five minutes each. The run's last line, `live_telegram_roundtrip`, is the record of the run; paste it here.
- Shape: `packages/bot/src/live-telegram.ts` (`liveTelegramSkipReason`: the flag read by meaning, the token, a numeric chat id; exported from the bot index), `tests/live-telegram.integration.test.ts` (a real polling bot, the task engine behind the confirm gate, the fakegym playbook on local Chromium; a reminder lands, the yes and the code come back, the member is cancelled, the next scan settles the row), `scripts/live-telegram.mjs` (refuses without token and chat rather than skipping, and is the only thing that sets the flag), `scripts/bot.mjs` = `pnpm bot` (the production poller: default pg-boss schema, the ledger answer sink, refuses `TELEGRAM_TRANSPORT=webhook`; an ordinary message gets one sentence, see DEFERRED). `tsconfig.test.json` maps `@chief-of-staff/fixtures` so root tests typecheck against the fixture.
- `tests/calendar-reminders.integration.test.ts` asserted whole scan reports and broke when `auto-cancel-enqueue` added `enqueued`, `unlinked` and `settled`; that task's green should have listed it. Fixed here (three zeros in three reports). `daily-scan-reminders` is stale on that file and is re-earned with a bare `nah task finish calendar-wiring daily-scan-reminders` after this finish.
- `auto-cancel-enqueue` landed at `b31bd10` with its gate recorded as a finding: 12 timeouts in 5 files under a sibling's concurrent coverage run (the playbook runner suite passes alone, 15/15; the Next page suites are the known 30-40s load timeouts). Re-record with `nah verify calendar-wiring auto-cancel-enqueue auto-cancel-enqueue-gate --retry` once the coverage tree is free. Order agreed by message: `slot-sniping` re-earns its gates first, `agentic-mode` and this sprint after, one coverage run at a time.

### Assumptions recorded (low-risk, reversible)

- `pnpm bot` does not compose the assistant. The credential the chat tools present to the API is the seam `packages/agent/src/crud.ts` names as undecided, and a launcher is not where that gets decided. An ordinary message is answered with one sentence saying so; every reply to a waiting task is carried. Recorded in DEFERRED.
- The live suite is gated three ways (`TELEGRAM_LIVE_ROUNDTRIP` opt-in, token, numeric chat) and skips with the reason in the suite name, so `pnpm check` never reaches a phone even on a machine with a token. A skipped suite exits zero, which is why the launcher refuses instead of skipping.
- The suite runs on the pg-boss schema `pgboss_live_telegram` with a five-minute `waitingUserTimeoutMs`, so a run nobody answers fails in about ten minutes rather than hanging.

### Environment

- Unchanged: `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres` for every Postgres proof and gate. Three sessions share this checkout; coverage runs are serialized by message and `coverage/.tmp` is checked before a gate.
- Suspended 2026-09-03 04:05Z as `blocked`: the finish's gate (`node scripts/check.mjs`) needs the coverage tree, and `slot-sniping` holds it for its serial gate retries (vitest --coverage PID 17692 at 04:03Z, 45-60 minutes expected). Agreed queue: slot-sniping, then this finish, then agentic-mode's mission-e2e gate. Wake signals: slot-sniping's message, its idle notice, or its two finish commits. Resume: `nah task update calendar-wiring telegram-roundtrip --status in_progress --from blocked`, then `nah task finish calendar-wiring telegram-roundtrip <the twelve files> --continue-with-findings ...` with `TEST_DATABASE_URL` set, then message agentic-mode.
- Resumed 04:16Z after slot-sniping's handover; the gate ran and exited at lint (66 errors, all in agentic-mode's untracked red `packages/playbooks/src/agentic/eval/scripted.integration.test.ts`, unresolved imports under typed lint). Nothing else ran. Suspended again 04:24Z as `blocked`: agentic-mode asked at 04:23Z to shape that red so lint passes or land its green; time-box 30 minutes, after which the finish goes ahead with the gate recorded as a sibling-owned finding and hardening re-earns it. Slot-sniping's full gate at `a0e76a0` (this working tree included) was green apart from the two agentic-mode items, 1509 tests.
- Resumed 04:27Z on agentic-mode's lint fix (its eval modules written; `dabd815` repairs build:web). Gate re-run 04:28Z-04:57Z: lint, typecheck and typecheck:tests passed; the test phase went red from Postgres contention on the shared 55432 server (32 pg-boss `Connection terminated due to connection timeout`, `timeout exceeded when trying to connect`, integration suites at 24 minutes, 22 timeouts in 11 files including `auto-cancel.integration.test.ts`, which passes alone), coinciding with agentic-mode's integration runs on the same server. Finished with both findings (`telegram-roundtrip-live`: no token here; `telegram-roundtrip-gate`: contention). Re-earn: `nah verify calendar-wiring telegram-roundtrip telegram-roundtrip-gate --retry` in a quiet window, and keep every other vitest run off 55432 while any gate runs.
- `telegram-roundtrip` finished at `7c4c2fa` (with findings) at 05:00Z; all four tasks are done. Remaining before `nah stage implementation-complete calendar-wiring`: re-earn `telegram-roundtrip-gate` and `auto-cancel-enqueue-gate` with `nah verify ... --retry`, and re-earn `daily-scan-reminders`' stale green and gate with a bare `nah task finish calendar-wiring daily-scan-reminders`, three serialized gates in one quiet window (about 90 minutes). The window opens when agentic-mode reports its two back-to-back gates (mission-e2e, eval-scenarios) have exited; its eval-gate runs after the window, so message it when the last gate here ends. `implementation-complete` refreshes stale proofs itself and then `nah verify` refuses until hardening, so the re-earning comes first.

## 2026-09-03 · implementation complete · hardening requested

### What happened

- At 05:22Z `nah implement calendar-wiring` was re-run to get a live attempt back after the typed suspension had ended the first one (`stage-attempt-terminal`, outcome `suspended`). With all four tasks done, NAH recorded an automatic replan (`7984ac0`, one planning-ready event, no graph change), adopted a new attempt, accepted the findings below as non-blocking, requested hardening (`hardening-ha5fce7ce328a4b38`) and completed the attempt, all without running a proof. The gate re-earning planned for the quiet window therefore belongs to hardening. Agentic-mode was handed the coverage tree at 05:25Z for its eval-gate.

### Findings handed to hardening

- Stale greens: `calendar-semantics-green` (`packages/core/src/calendar/dates.ts` changed after verification), `daily-scan-reminders-green` (`packages/core/src/calendar/message.ts`), `auto-cancel-enqueue-green` (`packages/bot/src/index.ts`). Each changed under a later task in this sprint; the suites pass on the current tree (the reminder and auto-cancel suites ran green during the telegram-roundtrip greens at 05:20Z).
- Red gates: `auto-cancel-enqueue-gate` (03:47Z, 12 timeouts in 5 files under a sibling's concurrent coverage run) and `telegram-roundtrip-gate` (04:57Z, 22 timeouts in 11 files from Postgres contention on the shared 55432 server). Neither is a logic failure; slot-sniping's quiet gate over this tree at `a0e76a0` was green with 1509 tests. `daily-scan-reminders-gate` (2026-09-02 21:25Z) predates the later tasks and is stale.
- Missing: `telegram-roundtrip-live`, which needs the owner's `TELEGRAM_BOT_TOKEN`, `TELEGRAM_LIVE_CHAT_ID` and a phone; `node scripts/live-telegram.mjs` (README, "The live Telegram round-trip").

### For the hardening session

- Open with `nah harden calendar-wiring`. Inside the attempt, a bare `nah task finish calendar-wiring <task>` re-earns a done task's stale proofs, and `nah verify calendar-wiring <task> <proof> --retry` re-records a red gate. Run the three gates one at a time in a quiet window: no other vitest against 55432 while any gate runs, `coverage/.tmp` empty before starting, about 30 minutes each on a quiet box, `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres` set in the launching call. Agentic-mode's eval-gate is running from 05:25Z; message that session (`chief-of-staff-4b`) before the first gate.
- The hardening result goes to `nah lifecycle assurance calendar-wiring` on stdin.
- Triage #1 `auth-guard-suite-strict-mode-violation-on-getbyrole-alert-under-gate-load` (filed 05:43Z, not this sprint's file: `packages/web/src/auth-guard.integration.test.ts` from dashboard-read's magic-link-auth). Under gate load the test at line 178, "refuses a link that has already been followed", hits a Playwright strict-mode violation: `getByRole('alert')` resolves to the sign-in page's `<p role="alert">` and, once Next has hydrated, `#__next-route-announcer__` as well. It passed in this sprint's gates and failed twice in agentic-mode's (373cc3a). Fix: `getByRole('alert').filter({ hasText: /already been used/ })`, or exclude the announcer. Any gate here may show it until then.

### Automatic replan (recorded for the trace)

- Commander's intent: unchanged, calendar subscriptions and deadlines from chat or dashboard, daily reminders, auto-cancel behind a confirm gate, and the live Telegram round-trip.
- Current plan: the four-task graph, unchanged.
- What changed: only the ledger documents (HANDOFF, DEFERRED) since the planning revision; the replan re-recorded planning-ready over them.
- What breaks: nothing in the graph; the proof ledger carries the stale and red receipts above.
- Proposed solution: re-earn in hardening as described.
- Patterns used: the same proof shapes (red, green, rules, gate) and the serialized-gate protocol between sessions.
- Graph and proof delta: none.

## 2026-09-03 · hardening · round one

### What was audited

- Attempt `attempt-r5162398e5b154c2f9aa02eb2c289cfe5` (single-session, profile `claude-only`, this conversation) owns the hardening; the open assurance request is `hardening-ha5fce7ce328a4b38`. Round one read consumer-backward from the person's surfaces - the dashboard calendar page, the Telegram reminder and question, the entry the API returns - through `packages/db/src/calendar-scan.ts`, `calendar-ledger.ts`, `confirm.ts`, the bot's `user-io.ts`, `reminders.ts` and `routing.ts`, the playbooks planner, `scripts/worker.mjs` and `scripts/bot.mjs`, against both specs, the task graph and the receipts as they stood at 06:44Z.

### Findings (medium, repaired in this sprint)

- **Marks never reach the reader.** Surface: `packages/web/src/app/calendar/page.tsx` through `packages/web/src/calendar/view-model.ts` and the `CalendarItem` type in `packages/web/src/api-client.ts`. Claim: both specs say the entry is annotated so the dashboard can say what became of it; the API returns `annotation`, `annotationNote` and `annotatedAt`, and the page drew name, kind, date, amount and status only, so every mark the scan wrote was invisible where it was meant to be read. Proof gap: no proof read a mark through the page, and the page suite seeded no marked entry. Fingerprint: `calendar-wiring/dashboard/mark-not-rendered`. Repair: `dashboard-entry-marks` (origin: hardening, spec `auto-cancel-path`): the client type carries the three fields, the view-model words each mark (`Late reminder`, `Needs attention`, `Auto-cancel declined`, `Cancelled`) with the engine's note, the page prints them in the entry's `<dl>`, and the seed helper in `packages/api/src/testing/auth-stack.ts` can plant a mark.
- **A person nobody can reach is lost in a table.** Surface: `runCalendarScan` in `packages/db/src/calendar-scan.ts`, `sendReminder` and `armCancellation`. Claim: the reminder-path spec promises an unbound person a recorded skip; the row was `skipped_unbound` and the entry carried nothing, so the dashboard showed a clean entry whose reminder never went. On the auto-cancel arm it was worse: the planner checks site, playbook and connection but not the chat, so a flagged renewal of an unbound person became a task whose confirm question threw `NoBindingError`, parked for `DEFAULT_WAITING_USER_TIMEOUT_MS` (24 h), failed, and the next scan marked the entry "nobody answered the question in time" - a question they never received. Proof gap: the scan suite's unbound case asserted the row only, and no suite put a flagged entry in front of an unbound person. Fingerprint: `calendar-wiring/scan/unbound-person-unmarked`. Repair: `unbound-entry-marks` (origin: hardening, spec `reminder-path`): the skip marks the entry `needs_attention` with the day owed and the bot's own binding instructions; the arm reads `users.telegram_chat_id` from the row it already joins and records the renewal `unlinked` with `no Telegram chat is bound to ask over` before the planner is consulted, so no task is made; the rank rule still keeps either mark from covering a person's `declined`.

### Findings (low, recorded, not repaired)

- The bot's `findPendingQuestion` hands a reply to the newest waiting question for the person; two tasks waiting on one person at once would both be answered by the newer. One renewal is armed per lead day, so today that is one question per person; recorded in DEFERRED for when several playbooks can wait at once.
- The confirm gate re-asks an unclear reply without bound, and each re-ask restarts the 24 h wait. Bounded by the person's patience rather than the code; recorded in DEFERRED.
- A crash between the port's send and the row's settle is the one at-least-once window `daily-scan-reminders` already recorded; inherent to record-before-dispatch without a two-phase port.
- Already deferred and unchanged: a failed cancellation is final for its renewal date; the dashboard form still creates entries with default lead days and no auto-cancel; a worker without `TELEGRAM_BOT_TOKEN` runs no scan, by design and said on stderr.

### Proof findings carried (non-blocking, visible)

- `telegram-roundtrip-live` is missing on this machine: no `TELEGRAM_BOT_TOKEN`, no phone. Owner-only; DEFERRED says how to run it.
- Gates recorded red under sibling coverage runs or, for the two sibling gates of 07:07Z, this sprint's own RED window: `auto-cancel-enqueue-gate` and `telegram-roundtrip-gate`. Greens and gates stale on files later tasks and these repairs touched: `calendar-semantics`, `daily-scan-reminders`, `auto-cancel-enqueue`. After the two repair finishes: `nah verify` the stale greens on 55433, then bare `nah task finish` and `nah verify --retry` for the gates, one coverage run at a time as the tree frees up. Whatever is still red or stale when the assurance result goes in is listed there as it stands; nothing is re-declared to look green.

### Environment

- This sprint's single suites and `nah verify` runs use a private throwaway server: `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55433/postgres` (PostgreSQL 17, data `C:/tmp/cos-testpg-cw`, log `C:/tmp/cos-testpg-cw.log`, started with `pg_ctl -o "-p 55433 -c max_connections=300 -c fsync=off -c synchronous_commit=off"`). Gates run on the shared 55432 server. Four sessions share the checkout (`slot-sniping`, `agentic-mode`, `real-site-hardening` and this one); coverage runs are serialized by message, and `coverage/.tmp` plus the process list are checked before every gate. `slot-sniping` is landing migration 0010 (`deliveries.dedup_key`); nothing here needs a migration.
- The RED edits for the two repairs referenced `row.mark` before the view-model had it, which is a `no-unsafe-return` lint error for the whole checkout: for about ten minutes around 07:05Z every sibling gate went red at the lint step. GREEN removed it (lint and typecheck clean at 07:13Z). In a shared checkout, a RED should fail at runtime, not at lint, or the window should be minutes.

## 2026-09-03 · hardening · round two

### What was audited

- Both repairs are done and committed: `dashboard-entry-marks` at `da65cdc` (green 22/22 re-run by the finish; gate red on `packages/solari/src/index.test.ts`, a sibling's uncommitted export surface, 1630 other tests passed) and `unbound-entry-marks` at `5ccd903` (green 25/25; gate red at lint on the sibling's untracked `packages/watch/src/live-ops/report.ts`). Both reds were sibling work, fixed by its owner at 08:22Z, and are re-earned with bare finishes once that work is committed (see Environment). Round two read the committed diff on dimensions round one did not: overlap and crash windows, transaction boundaries, rendering safety, spec wording, repository pattern.

### Findings (none critical, high or medium)

- Overlap: the unbound mark is written by the scan that won `claimReminder`, and the unreachable renewal by the `INSERT` that won the (entry, renewal) key, so two scans at once leave one mark and one row, as before.
- Crash window (low): `sendReminder` settles the row `skipped_unbound` and then marks the entry. A crash between the two leaves a skip nobody can see, and the row is final so no scan revisits it. Same class as the send-then-settle window `daily-scan-reminders` recorded; annotating before settling would close it for this branch because the unbound path never touches the wire and the mark is idempotent. Recorded in DEFERRED, not repaired: one more proof cycle on a contended tree for a window the accepted design already carries elsewhere.
- Transaction boundary: `recordAutoCancel` and the entry mark for an unreachable person are two statements, the same shape as the planner's `unlinked` branch; a crash between them leaves the row decided and the entry bare. Same finding as above, same disposition.
- Rendering: the note carries `/start <code>` literally; React escapes it and the page suite asserts the text is on the card, so nothing is interpreted as markup. A mark with no note prints "no details recorded" rather than an empty definition.
- Spec adherence: reminder-path's "recorded skip" is now on the entry; auto-cancel-path's `needs_attention` covers "nobody to ask" alongside "no site, no playbook", and the annotation vocabulary's comment says so. README says both.
- Marks never clear (low, recorded): after the person binds a chat, the entry keeps `Needs attention` with the dated note until a stronger mark lands, because a delivered reminder writes no mark and the rank rule has no "cleared" transition. The note is dated and true, so it misleads nobody, but a clear on the next delivered send would need a rank-rule exception. Recorded in DEFERRED.

### Outcome of the re-earns (10:11Z to 10:47Z, tree quiet, gates on 55433)

- Seven bare finishes, one coverage gate at a time, all committed: `dashboard-entry-marks` 0502dc1, `unbound-entry-marks` 1ccf7c0, `calendar-semantics` f768276 then d950c4c, `daily-scan-reminders` 007e8f0, `auto-cancel-enqueue` 2d802fa, `telegram-roundtrip` 63c6c34. Every green and rules proof is current again (no `stale-verification-receipt` warning remains) and six gates are green: 1722 tests passed, 17 skipped, every check step passed, four to six minutes each.
- `calendar-semantics-gate` went red once at 10:28Z on two browser tests in `packages/web/src/task-detail-page.integration.test.ts` (a replay-player wait past 60 s and a fetch-error wording assertion), the same two `real-site-hardening` had seen flake under load and pass alone; the retry at 10:41Z passed the whole gate. Recorded here as load flakiness in a sibling's page suite, not a break; the first red receipt stays in the ledger under the green one.
- `telegram-roundtrip-live` is still red: no `TELEGRAM_BOT_TOKEN` or `TELEGRAM_LIVE_CHAT_ID` here, and the suite fails rather than skips by design. Because it is declared before `telegram-roundtrip-gate`, the finish stopped at it and the gate keeps its old red receipt of 04:57Z, earned under a sibling coverage collision. The same `scripts/check.mjs` passed in full five times between 10:17Z and 10:47Z on this exact tree, which is the evidence that receipt lacks; both stay visible as non-blocking proof findings in the assurance result, nothing is re-declared.

### Environment

- Coverage-tree order agreed by message: `agentic-mode` seven finishes from 08:21Z, then `real-site-hardening` four finishes (they commit `packages/db/src/index.ts`, `packages/bot/src/index.ts`, `packages/agent/src/tools.ts`, `.env.example`, `package.json`, `tests/docs.test.ts`, all in this sprint's original covered lists, which is why this sprint's bare re-earns wait for those commits rather than sweeping them), then this sprint's six bare re-earns (two repair gates, four original tasks), then the request refresh (`nah harden` → `nah implement` → `nah harden`, profile `claude-only`) and `nah lifecycle assurance calendar-wiring`.

<!-- nah-checkpoint:7337cfa37c3fd896 -->
## 2026-09-02T20:41:14.564Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: implementation
- Ready: calendar-semantics
- In progress: none
- Root blockers: none
- Done: 0/4
- Receipts: none
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s7`

<!-- nah-checkpoint:987377adc75b332c -->
## 2026-09-02T21:03:43.612Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: implementation
- Ready: auto-cancel-enqueue
- In progress: daily-scan-reminders
- Root blockers: none
- Done: 1/4
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s7`

<!-- nah-checkpoint:114598d1ab997f0a -->
## 2026-09-02T21:24:54.780Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: implementation
- Ready: auto-cancel-enqueue
- In progress: daily-scan-reminders
- Root blockers: none
- Done: 1/4
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169, verification-completed-event0f7d38a3259f4f06bef425916da2584a, verification-completed-event52de377fb36c4605be04bbce04b47101, verification-completed-eventbe3cec0072a04b98885b40a4006ece58
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s7`

<!-- nah-checkpoint:99b8870ca6ddac70 -->
## 2026-09-02T21:55:19.108Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: implementation
- Ready: none
- In progress: auto-cancel-enqueue
- Root blockers: none
- Done: 2/4
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169, verification-completed-event0f7d38a3259f4f06bef425916da2584a, verification-completed-event52de377fb36c4605be04bbce04b47101, verification-completed-eventbe3cec0072a04b98885b40a4006ece58, verification-completed-event206c6dfdfa7545af8e1ee21c94ae0016, verification-completed-eventd011ae43b2584a6bad9bfa686b8f4cb6
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s7`

<!-- nah-checkpoint:9e20321b77b7d241 -->
## 2026-09-03T03:57:43.415Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: implementation
- Ready: none
- In progress: telegram-roundtrip
- Root blockers: none
- Done: 3/4
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169, verification-completed-event0f7d38a3259f4f06bef425916da2584a, verification-completed-event52de377fb36c4605be04bbce04b47101, verification-completed-eventbe3cec0072a04b98885b40a4006ece58, verification-completed-event206c6dfdfa7545af8e1ee21c94ae0016, verification-completed-eventd011ae43b2584a6bad9bfa686b8f4cb6, verification-completed-event38bea905fdc343b4a98d91b34cee86f3, verification-completed-evente071455dbbfd4383ab255bec89cdd3b5, verification-completed-eventdc1f829f1bc64ae086eb6737c20fce9f, verification-completed-eventc00ce32f18d2407b83d97072d442a5d8, verification-completed-event93ba4feb85c24f688829ada0956a65a8, verification-completed-event7d328988cf9442fa972b7cee6265fbf9, verification-completed-event81df4ea64965408088dd311bc8faa57a
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s7`

<!-- nah-checkpoint:8a8b77fdae098209 -->
## 2026-09-03T04:05:56.461Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: implementation
- Ready: none
- In progress: none
- Root blockers: none
- Done: 3/4
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169, verification-completed-event0f7d38a3259f4f06bef425916da2584a, verification-completed-event52de377fb36c4605be04bbce04b47101, verification-completed-eventbe3cec0072a04b98885b40a4006ece58, verification-completed-event206c6dfdfa7545af8e1ee21c94ae0016, verification-completed-eventd011ae43b2584a6bad9bfa686b8f4cb6, verification-completed-event38bea905fdc343b4a98d91b34cee86f3, verification-completed-evente071455dbbfd4383ab255bec89cdd3b5, verification-completed-eventdc1f829f1bc64ae086eb6737c20fce9f, verification-completed-eventc00ce32f18d2407b83d97072d442a5d8, verification-completed-event93ba4feb85c24f688829ada0956a65a8, verification-completed-event7d328988cf9442fa972b7cee6265fbf9, verification-completed-event81df4ea64965408088dd311bc8faa57a
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s7`

<!-- nah-checkpoint:c09bdbbb95e74a51 -->
## 2026-09-03T06:44:41.132Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: hardening
- Ready: none
- In progress: none
- Root blockers: none
- Done: 4/4
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169, verification-completed-event0f7d38a3259f4f06bef425916da2584a, verification-completed-event52de377fb36c4605be04bbce04b47101, verification-completed-eventbe3cec0072a04b98885b40a4006ece58, verification-completed-event206c6dfdfa7545af8e1ee21c94ae0016, verification-completed-eventd011ae43b2584a6bad9bfa686b8f4cb6, verification-completed-event38bea905fdc343b4a98d91b34cee86f3, verification-completed-evente071455dbbfd4383ab255bec89cdd3b5, verification-completed-eventdc1f829f1bc64ae086eb6737c20fce9f, verification-completed-eventc00ce32f18d2407b83d97072d442a5d8, verification-completed-event93ba4feb85c24f688829ada0956a65a8, verification-completed-event7d328988cf9442fa972b7cee6265fbf9, verification-completed-event81df4ea64965408088dd311bc8faa57a, verification-completed-event6692e8451ddd4c18bd39b65d36b9adb1, verification-completed-event0a5d441f92d24099b688662709408ec2, verification-completed-event1b94a82c835b4a8bab1f50e21e1a0725, verification-completed-eventb3147150dbc34931b791b3f931e9a64e, verification-completed-event2f1f5889fa0c4b849fcaee0837b05a79, verification-completed-event219c905316da4ab6882d73e491b23e53, verification-completed-event1636252919b64bbea8484d746d7c42ce, verification-completed-event5aaf906bc53f4b3e8dcd9fc2b9d485fb
- Findings: none
- Assurance request: hardening:hardening-ha5fce7ce328a4b38
- Knowledge revisions: none
- Resume: `nah harden s7`

<!-- nah-checkpoint:cf032983ed6ec59a -->
## 2026-09-03T07:06:39.431Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: hardening
- Ready: none
- In progress: dashboard-entry-marks, unbound-entry-marks
- Root blockers: none
- Done: 4/6
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169, verification-completed-event0f7d38a3259f4f06bef425916da2584a, verification-completed-event52de377fb36c4605be04bbce04b47101, verification-completed-eventbe3cec0072a04b98885b40a4006ece58, verification-completed-event206c6dfdfa7545af8e1ee21c94ae0016, verification-completed-eventd011ae43b2584a6bad9bfa686b8f4cb6, verification-completed-event38bea905fdc343b4a98d91b34cee86f3, verification-completed-evente071455dbbfd4383ab255bec89cdd3b5, verification-completed-eventdc1f829f1bc64ae086eb6737c20fce9f, verification-completed-eventc00ce32f18d2407b83d97072d442a5d8, verification-completed-event93ba4feb85c24f688829ada0956a65a8, verification-completed-event7d328988cf9442fa972b7cee6265fbf9, verification-completed-event81df4ea64965408088dd311bc8faa57a, verification-completed-event6692e8451ddd4c18bd39b65d36b9adb1, verification-completed-event0a5d441f92d24099b688662709408ec2, verification-completed-event1b94a82c835b4a8bab1f50e21e1a0725, verification-completed-eventb3147150dbc34931b791b3f931e9a64e, verification-completed-event2f1f5889fa0c4b849fcaee0837b05a79, verification-completed-event219c905316da4ab6882d73e491b23e53, verification-completed-event1636252919b64bbea8484d746d7c42ce, verification-completed-event5aaf906bc53f4b3e8dcd9fc2b9d485fb, verification-completed-event73a15d0ca0cd47bb931191843129ef3d, verification-completed-eventc1e01351ac0c40bba0937bd084554684
- Findings: none
- Assurance request: hardening:hardening-ha5fce7ce328a4b38
- Knowledge revisions: none
- Resume: `nah harden s7`

<!-- nah-checkpoint:87060d0be9f0b87c -->
## 2026-09-03T08:22:21.490Z · claude-code · b8abf8c9-a507-44ba-9b6c-8d7931dcac38

- Stage: hardening
- Ready: none
- In progress: none
- Root blockers: none
- Done: 6/6
- Receipts: verification-completed-eventb00ec200c92a4f3184e2e2cbaba3319f, verification-completed-event2557ebbfbe2448f0a4cd942e3301c8b4, verification-completed-event8bf3b349674648f085402cabffdbafa5, verification-completed-eventf08ca4a32830436a8d162714acf0c169, verification-completed-event0f7d38a3259f4f06bef425916da2584a, verification-completed-event52de377fb36c4605be04bbce04b47101, verification-completed-eventbe3cec0072a04b98885b40a4006ece58, verification-completed-event206c6dfdfa7545af8e1ee21c94ae0016, verification-completed-eventd011ae43b2584a6bad9bfa686b8f4cb6, verification-completed-event38bea905fdc343b4a98d91b34cee86f3, verification-completed-evente071455dbbfd4383ab255bec89cdd3b5, verification-completed-eventdc1f829f1bc64ae086eb6737c20fce9f, verification-completed-eventc00ce32f18d2407b83d97072d442a5d8, verification-completed-event93ba4feb85c24f688829ada0956a65a8, verification-completed-event7d328988cf9442fa972b7cee6265fbf9, verification-completed-event81df4ea64965408088dd311bc8faa57a, verification-completed-event6692e8451ddd4c18bd39b65d36b9adb1, verification-completed-event0a5d441f92d24099b688662709408ec2, verification-completed-event1b94a82c835b4a8bab1f50e21e1a0725, verification-completed-eventb3147150dbc34931b791b3f931e9a64e, verification-completed-event2f1f5889fa0c4b849fcaee0837b05a79, verification-completed-event219c905316da4ab6882d73e491b23e53, verification-completed-event1636252919b64bbea8484d746d7c42ce, verification-completed-event5aaf906bc53f4b3e8dcd9fc2b9d485fb, verification-completed-event73a15d0ca0cd47bb931191843129ef3d, verification-completed-eventc1e01351ac0c40bba0937bd084554684, verification-completed-event5090418801a74162b6c696c5bbb8bcb0, verification-completed-event8dd8def12edd475abc9119e6bb64b808, verification-completed-eventc7264cf88a9145fe9385442570c3ce5f, verification-completed-event59165f834661484c80f836739a31aeef, verification-completed-event265b67e0ff9b4e638401f3c6f11997f4, verification-completed-event823d344f6aab494cb5f2f1694e15e93a
- Findings: none
- Assurance request: hardening:hardening-ha5fce7ce328a4b38
- Knowledge revisions: none
- Resume: `nah harden s7`
