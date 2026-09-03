---
schema_version: 1
id: reminder-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A calendar entry (deadline or subscription renewal) existing for a bound user, and the
    daily scan cron firing
  terminal: >-
    A reminder message delivered to the user's Telegram exactly once per entry-day, with the
    send recorded - or an observable skip/late record when delivery cannot happen
origin:
  summary: The calendar causing things - a daily idempotent scan that turns dated entries into
    Telegram reminders through s3's sendToUser, surviving crashes and downtime without
    double-sending or silent loss.
  refs: [.nah/active/calendar-wiring/README.md,
    .nah/active/telegram-chat/specs/bot-io-runtime.md]
---

# Reminder path

## Outcome

Typed calendar semantics in `packages/engine` (`deadline`, `subscription_renewal`, per-entry
reminder lead days) and a pg-boss cron scan that each day computes due reminders and delivers
them through s3's `sendToUser`. Each (entry, day) send is recorded with a unique key before
dispatch, so retries, crashes, and re-runs never double-send. Users without a bound Telegram
account get a recorded skip, visible on the dashboard entry, never a silent drop.

## Path

Seeded renewal entry with a 3-day lead → clock at lead day → scan run → one Telegram message
naming the entry and date → send record stored → second scan run same day → no second message.
Deadline entry → same shape. Entry created via s3 chat command → picked up by the next scan
without restart.

## Failure behavior

Telegram send failure → recorded as failed and retried on the next scan, bounded; the record
distinguishes delivered / failed / skipped-unbound / late. Scan window missed (system down) →
next run sends late-marked reminders rather than dropping them. Cron overlap or worker retry →
the send-record key makes delivery idempotent.

## Proof

Integration tests (Testcontainers + pg-boss, scripted sendToUser sink): due computation for
both entry types and lead days, exactly-once under re-run and simulated crash between record
and dispatch, unbound-user skip, late-send after a skipped window, chat-created entry
scheduling. The live delivery of a real reminder is asserted inside the telegram-roundtrip
proof.
