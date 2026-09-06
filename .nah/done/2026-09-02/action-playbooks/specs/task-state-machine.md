---
schema_version: 1
id: task-state-machine
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [cancellation-playbook-path, agentic-mode missions (s6), slot-sniping booking
    tasks (s8), calendar-wiring auto-cancel enqueue (s7)]
  cutover: Greenfield - every browser-acting task runs inside this machine from the start; no
    ad-hoc job-side state.
origin:
  summary: The persisted task lifecycle - queued through running, waiting_user, resumed,
    terminal states - with an append-only task_events audit log, resume-by-rerun semantics, and
    idempotent transitions safe under job retries.
  refs: [.nah/active/action-playbooks/README.md,
    .nah/projects/chief-of-staff/research/solari-sdk-surface.md]
---

# Task state machine

## Outcome

Tasks (s1 schema: tasks + task_events) move through queued → running → succeeded | failed |
cancelled, with waiting_user as the human gate: entering it persists the pending question and
releases all browser resources; answering re-enqueues the task, which resumes by re-running its
mission with the answer available — never by re-attaching a session (Solari endpoints die with
the client; research Approach A). Every transition appends a task_event with cause and payload.
Execution rides the s1 pg-boss harness.

## Invariant

The database is the only task state: a worker crash at any point leaves a task that either
retries to the same outcome or lands observably failed — never a phantom running task. Illegal
transitions (answering a non-waiting task, double-completing) are rejected and recorded.
Transition idempotence makes at-least-once job delivery safe.

## Consumers

The playbook runner here; s6's agentic runner, s8's booking tasks, s7's auto-cancel enqueue all
drive the same machine.

## Failure behavior

Mission errors → failed with the error event; guardrail violations → failed with the violation
event (guardrail-layer spec); waiting_user timeout policy (configurable deadline) → failed with
timeout event, never a silent forever-wait. Answer arriving after timeout is refused and
recorded.

## Proof

Integration tests (Testcontainers + pg-boss): full lifecycle transitions with event assertions;
crash-between-transitions recovery (kill worker mid-run, restart, observe retry-or-failed);
illegal transition rejection; waiting_user → answer → resumed re-run with fresh mission
invocation asserted; timeout path; job-retry idempotence.
