---
schema_version: 1
id: contested-booking-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: An automated client driving a LocalProvider browser - the future slot-sniping booking
    task - reading the fakedmv appointment calendar
  terminal: The control plane holds exactly one booking row naming the winner, or the attempt is
    refused as gone
origin:
  summary: The fixture half of slot-sniping's race proof - a resource that awards itself exactly
    once, so the losing path is exercised rather than described.
  refs: [.nah/active/fixture-harness/README.md, docs/ARCHITECTURE.md]
---

# Contested booking path

## Outcome

fakedmv serves an appointment calendar whose slots are published and withdrawn through the control
plane. A client books a slot; the fixture awards each slot exactly once under concurrency, and tells
a loser that the slot is gone rather than that something went wrong.

## Path

Control plane publishes a slot → calendar lists it → client books → single-winner award → booking
recorded → `GET /__test/bookings` confirms the winner. `POST /__test/slots` publishes and
`DELETE /__test/slots/:id` withdraws, so a test can steal a slot between observation and booking
without racing the fixture's own timing.

## The single-winner invariant

Under two concurrent bookings of one slot, exactly one succeeds, exactly one is refused, and exactly
one booking row exists. This is asserted concurrently, not described — a fixture that awards a slot
twice would let slot-sniping ship a race it never had to survive.

## Failure behavior

- Booking a slot already taken is refused as `gone`, with a code distinct from a transient failure.
  slot-sniping re-arms its watch on `gone` and retries on transient; conflating them would make it
  either spin or give up wrongly, so the distinction is the fixture's obligation, not the engine's
  guess.
- A slot withdrawn between listing and booking yields `gone`, the same refusal as losing the race —
  the client cannot tell why it lost, only that it did, which is the honest real-world shape.
- Booking an unpublished slot id is refused as `gone` rather than 404ing, so one refusal path covers
  every way a slot can be unavailable.

## Proof

Integration tests driving a LocalProvider browser: publish → book → booking row names the winner;
concurrent double-book yields one winner, one typed `gone`, and exactly one booking row; a slot
withdrawn between listing and booking yields `gone`; an unpublished slot id yields `gone`.
