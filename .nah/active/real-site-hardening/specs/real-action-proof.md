---
schema_version: 1
id: real-action-proof
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A consequential action task enqueued against a real service account we own
  terminal: >-
    The real service confirms the action took effect, the task holds the full audit trail and
    Solari recording, and every guardrail behaved exactly as on fixtures - or the attempt
    ended in an honest refused/failed state with the account untouched
origin:
  summary: One real consequential action - a genuine cancellation on a low-stakes account we
    own - proving the guardrails, the confirm gate, and the recording pipeline against a
    site that never agreed to be easy.
  refs: [.nah/active/real-site-hardening/README.md,
    .nah/active/action-playbooks/specs/cancellation-playbook-path.md,
    .nah/active/action-playbooks/specs/guardrail-layer.md]
---

# Real action proof

## Outcome

A playbook (or s6 agentic mission, whichever the chosen service warrants - the choice is
recorded) executing a real cancellation on a service account owned for this purpose, run
through the full production path: Telegram confirm gate, allowlist scoped to the service,
payment gate armed, Solari session with recording requested and echo-verified, rrweb replay
watchable on the dashboard afterward. Re-subscription after the proof is part of the
procedure so the proof is repeatable.

## Path

Enqueue via chat → confirm ask on the real Telegram → yes → Solari session, mission steps
through the real flow (retention detour and all) → service's own UI/email confirms the
cancellation → task succeeded with events, cost, and recording → replay reviewed on the task
detail page. Decline run: same setup, answer no → task cancelled, account untouched -
executed at least once for the record.

## Failure behavior

Any allowlist or payment-gate firing during the real run fails/parks the task exactly per s5
- no real-site bypasses exist to loosen them. If the service blocks automation outright, the
recorded outcome is the honest failure plus the site's posture in the onboarding record;
choosing a different service is Aarav's call. Session hygiene per browser-substrate: the
run leaves zero leaked Solari sessions (ledger check after the run).

## Proof

The evidence bundle: the succeeded task's event trail, cost record, recording echo, and
replay; the decline-run record; the service-side confirmation (screenshot/email reference);
the session-ledger zero-leak check; the re-subscription note. Plus one rehearsal of the same
playbook against its fixture analogue proving no fixture/real behavioral divergence in the
engine path.
