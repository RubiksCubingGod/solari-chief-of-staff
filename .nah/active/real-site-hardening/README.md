# real-site-hardening (s9)

## Outcome

The system proven against 2-3 chosen real sites with real watches and playbooks, nightly live
smoke green three consecutive runs, per-task cost under target, and the manual release
checklist recorded as attestations.

## Why this boundary

Every prior sprint proves behavior against fixtures we control. This sprint is where the
product meets the internet: real sites, real anti-bot posture, real prices, real Solari
sessions - and the operational evidence (three green nights, cost per task) that s10 is
allowed to ship on. It is deliberately a `reliability` release: almost no new machinery, and
what is new (site onboarding as a repeatable procedure, the live ops gate) exists to make
"works on real sites" a recorded fact rather than a demo anecdote.

## Design decisions

- **Site choice is an open decision (owner: Aarav)** - candidates on the table: a price watch
  on a retail product page, an appointment/slot page, and one real low-stakes cancellable
  service for the action proof. The scope is site-agnostic: every spec and task binds to "the
  chosen sites" so the decision can land at implementation start without re-scoping.
- **Onboarding is a procedure, not heroics**: a documented, repeatable path from candidate URL
  to configured watch/playbook - robots/ToS check recorded, tier choice (HTTP vs browser vs
  stealth), extractor bootstrap, allowlist entry, cost estimate. Each onboarded site leaves
  the procedure better documented.
- **Real actions stay low-stakes and reversible**: the real action proof targets an account we
  own on a service chosen for easy re-subscription; the payment gate and confirm posture stay
  exactly as in s5/s7 - no real-site exception flags.
- **Three consecutive nights is calendar time**: the gate is three green nightly live runs in
  a row, recorded; wall-hour estimates cover the work, not the waiting.
- **Cost is a release criterion**: per-task Solari + Anthropic cost logged (s6 machinery)
  and summed per night; the target number is set with Aarav when sites are chosen.

## Specifications

- `specs/real-watch-proof.md` (vertical) - a real site watched end to end: check, extraction,
  change event, notification, self-heal on drift.
- `specs/real-action-proof.md` (vertical) - one real consequential action executed under full
  guardrails with recording and audit trail.
- `specs/live-ops-gate.md` (horizontal) - the nightly live suite expanded to real sites, cost
  accounting per run, and the attested release checklist.

## Non-goals

- No new engine features - a real-site gap that needs engine work goes back to the owning
  sprint's backlog, not into this one. No scaling beyond single-user. No stealth/proxy
  escalation beyond what the tier policy already allows (plan gating on the Solari side is a
  recorded constraint, not something to engineer around).

## External gates

- Site choices + cost target (owner: Aarav, at implementation start). Solari plan features
  (stealth/proxy) verified before onboarding a site that needs them.

## Task waves

[site-onboarding] → [real-watches, real-action] → [live-suite-expansion] → [cost-and-checklist]
