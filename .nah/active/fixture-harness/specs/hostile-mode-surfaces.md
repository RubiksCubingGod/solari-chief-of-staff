---
schema_version: 1
id: hostile-mode-surfaces
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [watch-engine, agentic-mode]
  cutover: Supersedes ARCHITECTURE section 9.1's query-parameter formulation (`?mode=blocked`,
    `?mode=redesign`), which cannot express a site changing under a live watch. The parameter
    survives as one-shot shorthand; the control plane is the contract.
origin:
  summary: The adversarial surfaces watch-engine's tier escalation and self-healing proofs aim
    at, specified so those proofs discriminate what they claim to discriminate.
  refs: [.nah/active/fixture-harness/README.md, docs/ARCHITECTURE.md,
    .nah/projects/chief-of-staff/context/architecture-direction.md]
---

# Hostile mode surfaces

## Outcome

Any observation-target instance can be put into `normal`, `blocked`, `hard-blocked`, or `redesign`
mode through `POST /__test/mode`, taking effect on the next request to the same URL. `?mode=` on a
single request overrides for that request only, for manual pokes.

## Invariant

**A hostile mode changes the fetch surface or the selector surface. It never changes the URL, and
`redesign` never changes the semantic surface.**

The URL half is what makes self-healing provable: a watch created against a page must see that page
change shape underneath it. A mode in the query string is a different page, not a redesign.

The semantic half is what keeps `redesign` honest in two directions at once. watch-engine's
LLM-authored CSS selector breaks, so self-healing has something real to heal. agentic-mode, which
drives the accessibility tree and holds no selector, should not notice the redesign at all — and
that non-event is itself an assertable claim about the design.

## The modes

**`normal`** — the page as `observation-target-path` specifies it.

**`blocked`** — a captcha shell: the served HTML carries captcha markup and no observable value, and
the real content is injected by client-side script after load. A plain HTTP fetch (tier 0) sees only
the shell; any real browser (tier 1) sees the content. This discriminates exactly what it claims to:
JavaScript execution.

**`hard-blocked`** — the shell is served to an ordinary browser too. The real content is served
only to a request carrying `X-Fixture-Escalation` with the exact token the instance was seeded with
(`POST /__test/seed`, field `escalationToken`), defaulting to a documented constant.

The header is supplied by the caller's tier-2 fetch configuration, not by the provider. This is
deliberate and it is the only design that works: `browser-substrate` established that LocalProvider
— the only provider that can reach these fixtures at all — honestly echoes stealth as **not
applied**, so a mode gated on "the provider echo reports stealth as applied" would be unreachable in
CI forever. Nothing in `packages/solari` learns about fixtures.

What this proves: watch-engine's escalation state machine reached its tier-2 branch, because only
that branch is configured to send the header, and records `tier_used=2`. What it does not prove:
that stealth defeats real bot detection. That claim belongs to the `@live` tier in
real-site-hardening, and any downstream test citing `hard-blocked` as evidence of stealth efficacy
is misreading it.

**`redesign`** — CSS class names, element ids, and DOM nesting rotate to a second stable layout.
Accessible names, ARIA roles, heading structure, visible text, and `data-testid` hooks are byte-identical
to `normal`. The rotation is deterministic, not random: the same instance in `redesign` always renders
the same second layout, so a failure is reproducible.

## Consumers

- watch-engine: `blocked` for tier-0 → tier-1 escalation, `hard-blocked` for the tier-2 branch and
  `tier_used` recording, `redesign` for selector breakage and self-healing.
- agentic-mode: hostile eval scenario variants, including the redesign-immunity claim.

## Failure behavior

- The blocked shell's body is distinguishable from a 404 body (`observation-target-path`): "blocked"
  and "gone" must never be confused, since one escalates and the other ends the watch.
- Setting a mode on an instance takes effect on the next request and persists until changed or reset;
  it does not leak across instances, which follows from the harness contract.
- `hard-blocked` with an absent, malformed, or wrong-valued `X-Fixture-Escalation` header serves
  the shell — the token is compared, not merely detected as present.
- An unknown mode name is refused with a typed 4xx; the instance stays in its current mode rather
  than silently falling back to `normal`.

## Proof

Integration tests: plain fetch of `blocked` yields the shell, LocalProvider browser fetch of the same
URL yields content; `hard-blocked` yields the shell to a browser sending no header and content to
one sending the seeded token; absent, malformed, and wrong-valued tokens all yield the shell. `redesign` toggled on a live instance keeps
the URL, changes class names and ids, and leaves accessible names, roles, text, and `data-testid`
values byte-identical — asserted by diffing the two renders on both axes. Unknown mode refused.
