# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Onboarding records complete per site: tier, ToS check, cost, budget, anomalies | real-watch-proof | committed evidence | once per site |
| Three days of real observation series; delivered change notification; drift episode resolved | real-watch-proof | committed evidence + dashboard | during hardening |
| Connect-flow state transitions, bookkeeping, abandoned timeout, expiry flip, chat link | site-connect-path | integration (scripted provider) | every push |
| Live connect of one real site via live-view; mission runs authenticated; reconnect exercised | site-connect-path | committed evidence (live run) | during hardening |
| Real cancellation: service-confirmed, full trail, replay, decline run, zero leaked sessions | real-action-proof | committed evidence (live run) | during hardening |
| Fixture-analogue rehearsal of the real playbook | real-action-proof | integration (fixtures, LocalProvider) | every push |
| Nightly suite: all case classes report pass/failed/errored distinctly; broken case → red night + Telegram ops alert | live-ops-gate | live workflow | nightly |
| Green/errored/failed counting, two-night errored rule, cost summation | live-ops-gate | unit | every push |
| Three consecutive green nights under cost target; checklist fully attested | live-ops-gate | committed record | pre-s10 gate |

Most of this sprint's proof is recorded operational evidence, not CI - by design: the claim
under test is "works on the real internet", and only the real internet can sign that. The
three-night criterion is calendar time, not work time.
