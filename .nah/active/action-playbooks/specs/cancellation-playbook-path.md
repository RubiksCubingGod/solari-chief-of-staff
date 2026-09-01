---
schema_version: 1
id: cancellation-playbook-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A cancellation task enqueued through the API for a fakegym membership
  terminal: >-
    The fixture's member record confirms cancellation with the task succeeded and its events
    and recording reference stored - or an observable refused/declined/failed state with the
    membership untouched
origin:
  summary: The first consequential action end to end - enqueue, playbook mission through login,
    retention detour, and the confirmation-code gate that only a real UserIO answer can pass,
    to a cancelled fixture state with a full audit trail.
  refs: [.nah/active/action-playbooks/README.md,
    .nah/active/fixture-harness/specs/transaction-target-path.md]
---

# Cancellation playbook path

## Outcome

A registered fakegym cancellation playbook: typed steps for login (credentials from the task's
site_connection record - fixture credentials in proofs), navigation to cancellation, the
retention-offer detour, and the confirmation-code gate. At the gate the mission enters
waiting_user with a question; the answer (the code, readable only through the fixture control
plane - so only a real ask can succeed) resumes the task, the mission re-runs to completion,
and `/__test/member` shows cancelled. Task events tell the whole story; the recording echo is
stored.

## Path

Accepted: enqueue → running → steps through detour → waiting_user(question) → scripted IO
answers with the control-plane code → resumed → cancelled state + succeeded task. Declined:
the user answers "stop" → task cancelled, membership untouched. Refused/failed, each with the
membership unchanged and a distinct event trail: wrong credentials (login step fails), wrong
code (site refuses, one retry then failed), allowlist violation (fails per guardrail-layer),
fixture in blocked mode (mission fails observably - block handling policy beyond failure is
s6/s9 territory).

## Failure behavior

Every failure path asserts the fixture's member record is unchanged - the engine must never
half-cancel. The resumed mission is a fresh browser session by construction (state machine
spec); the playbook re-runs already-completed steps idempotently against site state (login
again, navigate again).

## Proof

Integration tests on fixtures via LocalProvider with scripted UserIO: the accepted path with
member-state, event-trail, and recording-echo assertions; declined; wrong credentials; wrong
code; blocked mode; allowlist violation - each asserting membership unchanged.
