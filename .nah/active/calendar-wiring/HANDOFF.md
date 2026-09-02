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
