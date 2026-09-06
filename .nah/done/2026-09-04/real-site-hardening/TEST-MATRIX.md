# Test Matrix

After the 2026-09-04 descope, this sprint's delivered proofs are the ones that
do not require real elapsed runtime, an Anthropic key, or a real login. The
rows that do are deferred to s10 with their tasks (see `DEFERRED.md`).

## Delivered by this sprint

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Onboarding records complete per site: tier, ToS check, cost, budget, anomalies | real-watch-proof | committed evidence | once per site |
| Single-check pipeline (fetch->extract->compare->persist->notify) verified live against a terms-clean site at the free http tier | real-watch-proof | committed evidence (one-off) | onboarding |
| Connect-flow state transitions, bookkeeping, abandoned timeout, expiry flip, chat link | site-connect-path | integration (scripted provider) | every push |
| Green/errored/failed counting, two-night errored rule, cost summation | live-ops-gate | unit | every push |
| Nightly workflow exists on schedule + dispatch, secrets-gated (SOLARI + ANTHROPIC), reporting each case class distinctly | live-ops-gate | workflow file + unit | every push |

## Deferred to s10 (evidence needs real runtime / credentials / a login)

| Proof | Spec | Why deferred |
|---|---|---|
| Three days of real observation series; delivered change notification; drift episode resolved | real-watch-proof | three days of calendar time + a real drift event |
| Live connect of one real site via live-view; mission runs authenticated; reconnect exercised | site-connect-path | a real login the operator performs |
| Real cancellation: service-confirmed, full trail, replay, decline run, zero leaked sessions | real-action-proof | a real authenticated action on a real account |
| Fixture-analogue rehearsal of the real playbook | real-action-proof | bound to the deferred real-action task |
| Nightly suite live: broken case -> red night + Telegram ops alert | live-ops-gate | a live nightly run, which needs the Anthropic key in CI |
| Three consecutive green nights under cost target; checklist fully attested | live-ops-gate | three elapsed nights + operator sign-off |

Most of the deferred proof is recorded operational evidence, not CI - by design:
the claim under test is "works on the real internet", and only the real internet
can sign that. The three-night criterion is calendar time, not work time.
