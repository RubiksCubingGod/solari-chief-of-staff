---
schema_version: 1
id: real-watch-proof
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A watch configured on a chosen real site through the documented onboarding procedure
  terminal: >-
    Observations accumulating on schedule from the real site, a genuine change event
    delivering a Telegram notification, and a recorded self-heal (or attended fix) after
    real drift - all visible on the dashboard
origin:
  summary: The watch engine leaving the nest - real pages, real tier decisions, real drift -
    with the onboarding procedure documented well enough to repeat on the next site.
  refs: [.nah/active/real-site-hardening/README.md,
    .nah/active/watch-engine/specs/watch-check-path.md,
    .nah/active/watch-engine/specs/extractor-lifecycle.md]
---

# Real watch proof

## Outcome

Two or more of the chosen real sites watched in production configuration: onboarded via the
documented procedure (robots/ToS check recorded, fetch tier chosen and justified, extractor
bootstrapped from live pages, allowlist entries, per-check cost estimate), checking on their
real schedule through the s2 engine, with observations, change events, and notifications all
flowing through unmodified s2/s3/s4 machinery. The onboarding procedure itself is a committed
document improved by each site it onboards.

## Path

Onboard site A (price-shaped) and site B (availability-shaped) → watches check on schedule for
at least three days → observation series visible on the dashboard → a real or induced change
(e.g. watch a page we can legitimately influence, or accept a naturally occurring one) →
change event → Telegram notification with the real values. Extractor drift on a real layout
change → tier-appropriate self-heal per s2's lifecycle, or a recorded attended fix when
self-heal fails.

## Failure behavior

A site that defeats the chosen tier (blocks, challenges) gets a recorded tier escalation
decision - not silent retries; if the top allowed tier fails, the watch pauses
needs-attention with a notification, exactly as s2 specifies. Every real-site anomaly
(rate-limit response, consent interstitial, geo wall) is recorded in the onboarding document
with the disposition taken. Checks respect per-site minimum intervals; no real site is
checked more than its recorded budget.

## Proof

The recorded evidence bundle per site: onboarding record, three days of observation series,
one delivered change notification (screenshot + event row), and one drift episode with its
resolution. CI cannot prove this; the proof is the committed records plus the live-ops-gate
nightly runs covering these watches.
