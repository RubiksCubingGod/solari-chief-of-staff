---
schema_version: 1
id: auto-cancel-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A subscription_renewal calendar entry with auto-cancel enabled reaching its lead-day
    threshold during the daily scan
  terminal: >-
    Either the s5 cancellation playbook has run to a terminal task state after an explicit
    user confirmation over Telegram, or the task died observably (declined, timed out,
    unbound) with the membership untouched and the calendar entry annotated
origin:
  summary: The signature move - a renewal date that turns into a real, confirm-gated
    cancellation task, with the genuine Telegram waiting_user round-trip as this sprint's
    terminal evidence.
  refs: [.nah/active/calendar-wiring/README.md,
    .nah/active/action-playbooks/specs/cancellation-playbook-path.md,
    .nah/active/telegram-chat/specs/bot-io-runtime.md]
---

# Auto-cancel path

## Outcome

The scan's auto-cancel arm: an auto-cancel-enabled renewal entry reaching lead day enqueues an
s5 cancellation task for the entry's linked site connection (exactly once per renewal date,
same idempotence key discipline as reminders). The task's first act is a UserIO confirm
question - "cancel X before it renews on Y?" - delivered over Telegram via s3's
pending-question routing, which this sprint promotes to the production UserIO implementation.
Yes → the s5 playbook mission runs as scoped in s5. No or timeout → task cancelled, entry
annotated, membership untouched. This composes existing machinery; the only new authority is
the enqueue trigger and the Telegram-backed UserIO wiring.

## Path

Fixture-bound entry hits lead day → scan enqueues the task → confirm question lands in chat →
"yes" → fakegym playbook runs (including its own confirmation-code ask) → member cancelled,
entry marked handled. Decline path: "no" → task cancelled, entry annotated do-not-auto-cancel,
reminder behavior continues. Timeout path: no answer → s5's waiting_user timeout fails the
task, entry annotated, nothing cancelled.

## Failure behavior

Entry without a linked site connection or with no registered playbook → no task; a recorded
needs-attention state on the entry surfaced via the dashboard, and the plain reminder still
sends. Re-scan after crash → no duplicate task for the same renewal date. The playbook's own
failure paths are s5's proofs; this spec asserts only that a failed mission leaves the entry
annotated and re-armable.

## Proof

Integration tests on fixtures via LocalProvider with scripted UserIO: confirm-yes through to
cancelled member with full event trail; decline; timeout; unlinked-entry needs-attention;
enqueue idempotence under re-run. The live Telegram round-trip proof: real bot, real confirm
question to Aarav's account, real "yes", task resumes and completes against the fixture -
gated on TELEGRAM_BOT_TOKEN, skip-with-reason when absent.
