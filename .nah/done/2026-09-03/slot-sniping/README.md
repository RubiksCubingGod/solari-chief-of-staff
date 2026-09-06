# slot-sniping (s8)

## Outcome

Slot watches that on trigger immediately enqueue and run a book-this-slot task against fakedmv,
with race-safe re-arm when the slot is gone by booking time.

## Why this boundary

Everything this sprint needs already exists: s2 watches detect the slot, s5 runs playbooks
under guardrails, s7 proved chat confirmation. What is new - and load-bearing for the demo -
is the watch→task reflex: a trigger that enqueues a booking mission in the same transaction
as the observation, and honest handling of the race every sniper loses sometimes (the slot
vanishes between detection and booking). One vertical spec covers the whole reflex; three
tasks land it.

## Design decisions

- **Slot watches are a watch kind, not a new engine**: a slot watch is an s2 watch whose
  extractor yields available slots and whose trigger policy is "on first match, enqueue the
  booking task and pause the watch" (pause prevents duplicate bookings while a mission is in
  flight).
- **Booking is a playbook**: the fakedmv booking playbook runs in s5's frame - allowlist,
  recording, waiting_user - nothing bespoke. Whether booking asks for confirmation first is
  per-watch config (`auto_book` vs confirm-gated), defaulting to confirm-gated per the s5
  consequence posture.
- **Losing the race is a first-class outcome**: slot-taken at booking time ends the mission
  refused-slot-gone (not failed), automatically re-arms the watch, and notifies the user.
  The fixture's slot-yank control-plane hook makes this deterministically testable.
- **Booked means booked**: success requires the fixture's booking record to exist and the
  confirmation reference to be stored on the task - never just "the flow completed".

## Specifications

- `specs/slot-snipe-path.md` (vertical) - slot appears → watch fires → booking task enqueued
  and run → booked with reference, or slot-gone → re-armed, each observable.

## Non-goals

- No real DMV or any real site (s9). No multi-slot preference ranking or bidding strategies -
  first matching slot wins. No new notification machinery (s7's sendToUser is reused).

## Task waves

[slot-watch-kind, dmv-booking-playbook] → [race-rearm]
