---
schema_version: 1
id: guardrail-layer
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [cancellation-playbook-path, agentic-mode tool loop (s6), slot-sniping booking
    (s8), real-site-hardening live actions (s9)]
  cutover: Greenfield - the runner wires guardrails around every mission from the first
    playbook; there is no unguarded execution path to supersede.
origin:
  summary: Code-enforced safety around every browser mission - per-task domain allowlist via
    navigation interception, a payment gate that forces waiting_user before payment-shaped
    submissions with no bypass flag, and always-requested recording with honest echo - so no
    LLM output or playbook bug can exceed the task's authority.
  refs: [.nah/active/action-playbooks/README.md,
    .nah/projects/chief-of-staff/context/architecture-direction.md]
---

# Guardrail layer

## Outcome

A guardrail wrapper the runner installs around every mission's Page: **allowlist** — each task
carries its domain allowlist; navigation (including redirects and new tabs) outside it is
blocked at the provider/page level and aborts the task with a violation event; **payment gate**
— a detector for payment-shaped forms/submissions (card fields, checkout markers) that forces
waiting_user confirmation before proceeding; there is no configuration to disable it;
**recording** — every mission requests recording; the echo (present or honestly unsupported)
is stored on the task.

## Invariant

Guardrails live below the mission: neither a playbook step nor (in s6) an LLM tool call can
navigate around them, because enforcement happens at navigation/request interception, not at
the instruction layer. A guardrail violation is always a terminal, observable task failure —
never a warning.

## Consumers

The playbook runner here; s6 wraps its agentic tool loop in the same layer unchanged; s8 and
s9 inherit it through the runner.

## Failure behavior

Blocked navigation → task failed with the attempted URL in the violation event. Payment
detector firing → waiting_user with the page context in the question; a decline answer cancels
the task. Detector uncertainty errs toward gating (false positives ask; false negatives are
the test target list to grow).

## Proof

Integration tests on fixtures via LocalProvider: off-allowlist navigation (direct, redirect,
new tab) each abort with the violation event; a payment-shaped fixture form triggers the gate
and a scripted decline cancels; recording echo stored (unsupported on LocalProvider —
asserted); unit tests for the payment detector against recorded payment and non-payment pages.
