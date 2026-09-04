# real-site-hardening (s9)

## Outcome

The real-site onboarding procedure is built and proven executable end to end. The onboarding
procedure, the Solari connect flow, and the nightly live-ops suite are implemented and
unit-proven; the fetch->extract->compare->persist->notify pipeline is verified live against a
real, terms-clean site (weather.gov) at the free http tier; and the first candidate sites are
onboarded with complete records (one watching, two dropped on robots/terms). Standing multi-day
watches, an authenticated real action, and three consecutive green live-ops nights are deferred
to a follow-on operations sprint (s10), which requires production credentials and elapsed
runtime.

## Descope (2026-09-04)

The sprint originally aimed to prove the system against real sites *over real runtime* - three
days of live observations, an authenticated real action, and three consecutive green nights.
That evidence is generated only by elapsed calendar time, an Anthropic API key (the nightly
guard requires it), and a real login - none of which were available at close. Rather than
fabricate that evidence, four qualify tasks were removed and their obligations deferred to s10:
`real-watches`, `real-action`, `live-suite-expansion`, and `cost-and-checklist`. What remains
is honestly delivered: the machinery is built and unit-proven, the procedure is executable, and
the watch pipeline is verified live against one clean site. See `DEFERRED.md` for the full trail.

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
- **Logins go through Solari profiles, never stored passwords**: this sprint lands the
  architecture §4 connect flow - the user logs in themselves inside a watchable live-view
  session, we save only the profile id, and expiry surfaces a reconnect link. Fixtures never
  needed this (seeded credentials); real sites do, so it lands here, where the first real
  login exists.
- **Three consecutive nights is calendar time**: the gate is three green nightly live runs in
  a row, recorded; wall-hour estimates cover the work, not the waiting.
- **Cost is a release criterion**: per-task Solari + Anthropic cost logged (s6 machinery)
  and summed per night; the target number is set with Aarav when sites are chosen.

## Specifications

- `specs/real-watch-proof.md` (vertical) - a real site watched end to end: check, extraction,
  change event, notification, self-heal on drift.
- `specs/real-action-proof.md` (vertical) - one real consequential action executed under full
  guardrails with recording and audit trail. **Deferred to s10** with the `real-action` task
  (see `DEFERRED.md`): the connect flow it depends on (`site-connect-path`) is built and
  unit-proven, but a real authenticated action requires a live login this sprint did not perform.
- `specs/site-connect-path.md` (vertical) - connect a real site by logging in yourself in a
  live-view Solari session; only the profile id is stored, expiry offers reconnect.
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

Delivered (after the 2026-09-04 descope):

[onboarding-procedure] → [site-onboarding]; [site-connect-flow]; [live-suite-code];
[release-checklist]

Deferred to s10: [real-watches, real-action] → [live-suite-expansion] → [cost-and-checklist]
