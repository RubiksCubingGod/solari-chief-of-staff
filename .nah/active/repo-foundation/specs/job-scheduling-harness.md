---
schema_version: 1
id: job-scheduling-harness
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [watch-engine scheduler ticks, action-playbooks task worker, calendar-wiring daily
    cron]
  cutover: Greenfield - no superseded path; all recurring and queued work runs through this
    harness from the start.
origin:
  summary: Durable scheduled and queued work on plain Postgres via pg-boss - the reusable
    capability behind watch checks, task execution, and calendar scans.
  refs: [.nah/active/repo-foundation/README.md]
---

# Job scheduling harness

## Outcome

A typed pg-boss wrapper in the workspace: register named job handlers, enqueue one-off jobs,
register cron schedules, with retry defaults and a dead-letter/failed state readable for
observability. Runs against the same Postgres as the app schema (own pg-boss schema), started
by the worker process entry point.

## Invariant

Work survives the process: an enqueued job persists in Postgres and executes after a worker
restart. State lives in the database, not in process memory (ARCHITECTURE §5 posture).

## Consumers

watch-engine (per-watch cron ticks), action-playbooks (task execution queue), calendar-wiring
(daily scan cron). Each registers handlers through this harness rather than talking to pg-boss
directly.

## Failure behavior

A handler that throws is retried per policy; after exhaustion the job lands in an observable
failed state (asserted in tests). A worker restart between enqueue and execution does not lose
the job.

## Proof

Integration tests (Testcontainers): cron schedule fires a handler; enqueued job round-trips;
failing handler retries then fails observably; enqueue → stop worker → start worker → job
executes.
