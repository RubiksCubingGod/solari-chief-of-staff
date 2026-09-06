---
schema_version: 1
id: slot-snipe-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A slot watch on fakedmv checking while the fixture control plane releases a slot
  terminal: >-
    A booking record in the fixture with the confirmation reference stored on the succeeded
    task and the user notified - or, when the slot is yanked before booking, a
    refused-slot-gone task, a re-armed watch, and a notification saying so
origin:
  summary: The watch-to-task reflex - detection enqueues a booking mission transactionally,
    the mission books under s5 guardrails, and losing the race re-arms instead of failing.
  refs: [.nah/active/slot-sniping/README.md,
    .nah/active/watch-engine/specs/watch-check-path.md,
    .nah/active/action-playbooks/specs/cancellation-playbook-path.md,
    .nah/active/fixture-harness/specs/contested-booking-path.md]
---

# Slot snipe path

## Outcome

Three composed pieces. A `slot` watch kind in the s2 engine: its extractor yields available
slots, and its trigger policy enqueues the booking task in the same transaction as the
observation and pauses the watch. A registered fakedmv booking playbook in the s5 registry:
select the detected slot, fill the applicant details from the watch's config, submit, and
capture the confirmation reference; confirm-gated via UserIO by default, `auto_book` per
watch. And the race outcome: slot unavailable at any booking step ends the mission
refused-slot-gone, re-arms the watch, and notifies via s7's sendToUser.

## Path

Fixture slot released → next check extracts it → trigger fires: observation + enqueued task +
paused watch, atomically → (confirm-gated) user yes → playbook books → fixture `/__test/bookings`
shows the record → task succeeded with the confirmation reference → notification sent. Race
path: control-plane slot-yank between detection and booking → playbook's availability check
finds it gone → refused-slot-gone → watch re-armed → notification. auto_book path: same but no
confirm ask.

## Failure behavior

Trigger idempotence: a re-run check on the same observed slot must not enqueue a second task
while one is pending (the paused watch is the guard; the pause and enqueue commit together).
Decline at the confirm gate → task cancelled, watch re-armed. Booking submit fails for
non-slot reasons (blocked mode, violation) → s5 failure semantics apply and the watch stays
paused for human attention, notified. Re-arm after slot-gone must not instantly re-trigger on
the stale observation - the trigger requires a fresh check's extraction.

## Proof

Integration tests on fakedmv via LocalProvider with scripted UserIO: the full booked path
with booking-record, confirmation-reference, pause/re-arm, and notification assertions;
slot-yank race → refused-slot-gone and re-arm; enqueue idempotence under check re-run;
decline; blocked-mode failure leaving the watch paused; auto_book skipping the ask. Unit
tests for the trigger policy's atomic observation+enqueue+pause behavior.

## Production Path

The reflex runs in the worker process (`scripts/worker.mjs`), which is the only place the
three engines meet. The API's door accepts a `slot` watch (`packages/api/src/routes/watches.ts`
through `watchConfigViolations`), whose condition names the site, the applicant, and
`auto_book`. The watch engine's check (`packages/watch/src/check.ts`) extracts a `slots` value
with the stored extractor, compares it against the last observation, and on a slot that was not
listed last time hands the observation, the row patch and the slot to the trigger port
(`packages/watch/src/slot-trigger.ts`), which pauses the watch, writes the observation and the
`book_slot` task in one Postgres transaction and enqueues the run on the task queue. The task
engine (`packages/db/src/task-engine.ts`) runs the registered fakedmv booking playbook
(`packages/playbooks/src/fakedmv/booking.ts`) under the s5 guardrails; the snipe consequences
(`packages/watch/src/snipe.ts`) wrap that mission so a booking leaves the watch paused, a
refused slot-gone or a decline re-arms it, a non-slot failure leaves it paused for attention, and
each outcome reaches the person through the s2 notifier port, which s7 implements over the bot's
`sendToUser`. The worker registers the booking playbook against `FAKEDMV_URL` beside the
fakegym one.
