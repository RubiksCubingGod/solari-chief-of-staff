---
schema_version: 1
id: task-detail-replay
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: An authenticated user opening a task from the s4 task history shell
  terminal: A task detail page showing the event timeline and, when recording data exists, a
    working replay player; honest absence when it does not
origin:
  summary: The trust surface - every consequential action auditable as a timeline and watchable
    as a replay - extending the s4 dashboard shell with the task detail page and rrweb player.
  refs: [.nah/active/action-playbooks/README.md,
    .nah/active/dashboard-read/specs/read-dashboard-pages.md]
---

# Task detail replay

## Outcome

The task detail page in `packages/web`, linked from s4's task history shell: task facts,
the full task_events timeline (transitions, questions, answers, violations, errors), and a
replay section embedding an rrweb player when the task has recording data - with an explicit
"no recording available" state otherwise (LocalProvider tasks; the honest-absence posture from
the seam invariant). The detail read route is extended with events and recording reference.

## Path

Seeded task with events and a seeded rrweb recording → detail page renders the timeline in
order and the player scrubs the recording. Seeded task without recording → timeline plus the
explicit absence state. waiting_user task → the pending question is visible. Cross-user task id
→ 404.

## Failure behavior

A corrupt or unfetchable recording renders a visible replay-error state, never a broken page;
the timeline still renders. The replay decompression finding recorded by browser-substrate's
live smoke (gzipped vs pre-decompressed NDJSON) is consumed here where the player's loader is
written.

## Proof

Playwright e2e with seeded Testcontainers data: timeline order and content for a rich event
trail; player renders and scrubs a seeded rrweb file; absence state; pending-question
visibility; corrupt-recording error state; cross-user 404. Integration tests for the extended
detail route.
