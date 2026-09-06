---
schema_version: 1
id: watch-check-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A pg-boss cron tick for an active watch (created through the s1 CRUD API)
  terminal: An observation row persisted and, on threshold crossing or content change, a
    deduplicated trigger event delivered to the notifier port; failures land in observable
    watch state
origin:
  summary: The composed check pipeline - scheduled tick through tiered fetch, deterministic
    extraction, comparison, observation persistence, and trigger emission - proven end to end
    against controlled fixture state.
  refs: [.nah/active/watch-engine/README.md,
    .nah/done/2026-09-01/repo-foundation/specs/job-scheduling-harness.md]
---

# Watch check path

## Outcome

An active watch is checked on its schedule: fetch via the tier ladder, extract via the stored
extractor, compare against the last observation, persist a new observation, and emit a trigger
event to the notifier port when the watch's condition crosses (price threshold, content
change). Pause/resume from the CRUD surface is respected by the scheduler.

## Path

Accepted: fakestore price set to 14.99 under a 15.00 threshold → next tick → observation row
with 14.99 → exactly one trigger event on the notifier double; the following tick at the same
price emits none (dedup). Change watch on fakenews: article mutated → trigger with a content
digest; unchanged → none. Refused/failure: fetch fails (site down) → observation-with-error
state, no trigger, retry per job policy; extraction fails → hands off to the self-healing path
(extractor-lifecycle spec); paused watch → no ticks run.

## Failure behavior

Every failure lands in queryable state (watch status, last error, task/job failed state from
the s1 harness) — nothing fails silently. Trigger emission is at-least-once with dedup by
(watch, condition, value) so a job retry cannot double-notify.

## Proof

Integration tests against booted fixtures with Testcontainers Postgres: the accepted price and
change paths above, dedup across ticks, pause honored, fetch-failure state, and
trigger-after-retry emitting exactly one event.
