---
schema_version: 1
id: tiered-fetching
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [watch-check-path, slot-sniping slot checks (s8), real-site-hardening live watches
    (s9)]
  cutover: Greenfield - all watch fetching goes through the ladder from the start; no direct
    HTTP or provider calls in check code.
origin:
  summary: The fetch ladder capability - tier 0 plain HTTP, tier 1 browser via the provider
    seam, tier 2 stealth - with block detection from page content, escalation policy, and
    per-watch tier persistence.
  refs: [.nah/active/watch-engine/README.md,
    .nah/active/browser-substrate/specs/browser-provider-seam.md,
    .nah/projects/chief-of-staff/research/solari-sdk-surface.md]
---

# Tiered fetching

## Outcome

One `fetchPage(watch)` capability returning rendered content plus fetch metadata (tier used,
block verdict, timing). Tier 0 is a plain HTTP GET; tiers 1-2 acquire through the
BrowserProvider seam (tier 2 requests stealth and asserts the echo per the seam invariant).
Block detection classifies content — challenge markers, block-page heuristics, empty-shell
responses — because no vendor signal exists (research Q6). On a block verdict the ladder
escalates within the check; the tier that succeeds is persisted on the watch and reused.

## Invariant

Escalation is monotonic within a check (never downgrade mid-check) and sticky across checks
(persisted tier is the floor until an explicit reset). Cost order is respected: a watch never
uses a browser when its persisted tier is 0 and no block occurs.

## Consumers

watch-check-path now; slot-sniping's availability checks (s8) and real-site live watches (s9)
reuse the ladder unchanged.

## Failure behavior

All tiers blocked → fetch returns a terminal blocked verdict; the check records it observably
(no trigger, watch marked blocked) — surfaced to the user via notifier event, since silent
block-and-stall is the product failure mode that loses trust. Provider acquire failures
propagate as fetch errors distinct from blocks.

## Proof

Integration tests against the fixture hostile modes (fixture-harness
specs/hostile-mode-surfaces.md): plain mode → tier 0 suffices and persists; `blocked` mode →
tier 0 defeated, tier 1 browser fetch succeeds, persisted tier rises to 1; `hard-blocked` mode →
tiers 0-1 defeated, the escalation-marked tier-2 request succeeds (LocalProvider, stealth echo
asserted — the contract, not the vendor, is under test); exhausted ladder → blocked verdict +
notifier event; unit tests for the block classifier on recorded block/challenge/plain pages.
