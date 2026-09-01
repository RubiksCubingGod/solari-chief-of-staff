# calendar-wiring (s7)

## Outcome

Calendar subscriptions and deadlines created via chat or dashboard, daily cron reminders, auto-cancel
before renewal enqueuing a confirm-gated cancellation task, and the real Telegram waiting_user
round-trip proven end to end.

## Why this boundary

This is the sprint where the calendar stops being data and starts causing things. s1 owns the
calendar CRUD schema, s3 owns the bot runtime and `sendToUser`, s5 owns tasks and the UserIO
gate - s7 composes them: a daily scan that turns dates into Telegram reminders, and the
auto-cancel path that turns a renewal date into a real cancellation task gated on the user's
"yes" in chat. It also carries the one proof no fixture can give: the real Telegram
round-trip, live bot, real phone.

## Design decisions

- **Calendar entries are typed**: `deadline` (remind only) and `subscription_renewal` (remind,
  and optionally auto-cancel with a per-entry flag + lead days). Semantics live in one module;
  the scan and the dashboard both consume it.
- **The daily scan is idempotent**: one pg-boss cron job; each entry-day reminder is keyed so
  re-runs and crashes never double-send. Missed windows (system down over the send time) send
  late rather than never, marked as late.
- **Auto-cancel never acts alone**: reaching the lead-day threshold enqueues a cancellation
  task; the s5 payment/consequence posture applies - the task immediately asks the user to
  confirm via Telegram before any browser mission starts. No reply by the deadline = task
  cancelled, reminder still sent. Decline = task cancelled, calendar entry annotated.
- **Telegram is the UserIO transport now**: s3's pending-question routing becomes the real
  UserIO implementation for tasks; the scripted double remains for tests. The live round-trip
  proof (real bot, real ask, real answer, task resumes) is this sprint's terminal evidence.
- **TELEGRAM_BOT_TOKEN gate**: live proofs skip-with-reason when absent (owner: RubiksCubingGod,
  via BotFather).

## Specifications

- `specs/reminder-path.md` (vertical) - calendar entry → daily scan → Telegram reminder
  delivered, idempotently.
- `specs/auto-cancel-path.md` (vertical) - renewal entry with auto-cancel → enqueued
  cancellation task → Telegram confirm gate → mission runs or task dies, honestly either way.

## Non-goals

- No new calendar CRUD (s1 owns schema and routes; s4 owns the pages). No new cancellation
  logic (s5's playbook runs unchanged). No recurring-event engine - entries are dated rows,
  recurrence is out of scope for the challenge.

## Task waves

[calendar-semantics] → [daily-scan-reminders, auto-cancel-enqueue] → [telegram-roundtrip]
