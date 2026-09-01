---
schema_version: 1
id: assisted-cancellation-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: An automated client driving a LocalProvider browser - the future action-playbooks
    cancellation mission - arriving unauthenticated at the fakegym front page
  terminal: The control plane reports the member as cancelled, or the attempt ends in a typed
    refusal - retained, step-skipped, wrong-code, or unauthenticated
origin:
  summary: The fixture half of action-playbooks' waiting_user proof - a cancellation flow whose
    final gate cannot be passed without asking the user, so "the engine asked" is asserted rather
    than assumed.
  refs: [.nah/active/fixture-harness/README.md, docs/ARCHITECTURE.md]
---

# Assisted cancellation path

## Outcome

fakegym serves a login, a member area, and a deliberately annoying cancellation flow — retention
offer, "are you sure", "really sure" — ending at a confirmation-code gate. A seeded member can be
driven from unauthenticated to `{ cancelled: true }`, and every way of getting it wrong is refused
distinguishably.

## Path

Front page → login with seeded credentials → cookie session → member area → cancel step 1 (retention
offer) → step 2 → step 3 → confirmation-code gate → cancelled. Flow progress is held server-side per
session, not encoded in the URL, so "did the client actually traverse the flow" is answerable rather
than inferable.

## The confirmation-code gate

The final step demands a code the fixture "emails". The code appears on no page the client can
reach and in no response body; it is readable only through `GET /__test/member/:id/code`.

This is the load-bearing part. action-playbooks proves its `waiting_user` round-trip here: the
mission can only reach `{ cancelled: true }` by pausing and asking, and the scripted UserIO in that
test answers from the control plane. An engine that skips the ask cannot fabricate its way past the
gate — which is why a free-text retention reason was rejected during scoping, since an LLM can
plausibly invent one.

## Failure behavior

- POSTing the final cancel step without having traversed the earlier ones is refused on server-held
  progress; nothing is cancelled.
- A wrong or absent code is refused with a typed reason. The refusal is not a retry hint.
- Accepting the retention offer ends the flow in `retained`, not `cancelled`. The engine must be
  able to fail this way, because a real site will make it.
- Cancelling an already-cancelled member is idempotent, not an error.
- Unauthenticated access to the member area redirects to login rather than erroring.

## Proof

Integration tests driving a LocalProvider browser: the full path to `{ cancelled: true }`; the code
absent from every reachable page and response body; step-skip refused; wrong code refused; retention
accept lands `retained`; double-cancel idempotent; unauthenticated access redirects.
