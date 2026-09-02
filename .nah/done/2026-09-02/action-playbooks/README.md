# action-playbooks (s5)

## Outcome

The action engine in playbook mode - persisted task state machine with a waiting_user gate
behind a UserIO port (scripted IO in proofs), fakegym cancellation playbook end-to-end, session
recording stored on the task, code-enforced guardrails (domain allowlist, payment gate), and
the dashboard task detail with replay embed.

## Why this boundary

This is the sprint where the agent first *does* something on a website with consequences, so it
is also the sprint where every safety property becomes code: the state machine that makes tasks
resumable and auditable, the guardrails that no LLM output can bypass, and the human gate that
turns "the agent asked" into a provable event. Agentic-mode (s6) runs *inside* this machinery —
nothing here assumes an LLM drives the browser.

## Design decisions

- **Tasks are resumed, not re-attached.** A waiting_user task releases its browser session and
  resumes by running a fresh mission with the answer in hand — Solari sessions die with their
  client and cannot be re-attached (research solari-sdk-surface, Approach A). The state machine
  and every playbook step contract are built on this.
- **The waiting_user proof cannot be faked.** fakegym's cancellation requires a confirmation
  code readable only through the fixture control plane (fixture-harness decision, 2026-09-01):
  the only way to the cancelled state is a real UserIO question and a real answer. Proofs use
  scripted IO; the live Telegram round-trip lands in s7.
- **Guardrails are code, not prompt.** Per-task domain allowlist enforced by navigation
  interception at the provider/page level; a payment-gate detector that forces waiting_user
  before any payment-shaped submission; recording always requested, its echo recorded
  (LocalProvider echoes unsupported — honest absence, per the seam invariant). Violations abort
  the task into an observable failed state.
- **Playbooks are typed step programs** against the provider Page with explicit step outcomes,
  registered in a playbook registry keyed by site + action kind. The retention detour on
  fakegym is handled as a first-class step, as real sites demand.
- The dashboard task detail extends s4's task shell: event timeline plus replay embed (rrweb
  player) when a recording exists; seeded-recording proof here, live Solari replay in s9.

## Specifications

- `specs/task-state-machine.md` (horizontal) — persisted lifecycle, task_events audit log,
  waiting_user gate + resumption, idempotent transitions.
- `specs/guardrail-layer.md` (horizontal) — allowlist, payment gate, recording posture;
  violation semantics.
- `specs/cancellation-playbook-path.md` (vertical) — enqueue → run → confirmation-code gate →
  answer → cancelled fixture state, recording reference stored; refused and declined paths.
- `specs/task-detail-replay.md` (vertical) — task detail page with event timeline and replay
  embed from stored recording data.

## Non-goals

- No LLM-driven navigation (s6). No real sites (s9). No Telegram wiring of UserIO (s7 — the
  port + scripted double live here).
- No autonomous payments, ever — the payment gate has no bypass flag.
- No slot booking (s8 registers its own playbook).

## Task waves

[task-state-machine] → [userio-gate, guardrails] → [playbook-runner] → [fakegym-cancellation,
replay-embed-page]
