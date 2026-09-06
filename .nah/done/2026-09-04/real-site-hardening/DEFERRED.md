# Deferred

## 2026-09-04 - descope of the real-runtime evidence tasks

The sprint's original outcome required evidence that only real elapsed time, an
Anthropic API key, and a real site login can produce. None were available at
close, and inventing the evidence was not an option. Four qualify tasks were
removed from the graph and their obligations deferred to the follow-on
operations sprint (s10). This is a scope reduction, not a completion: the
behaviors below are built in code but were never proven against a live site
over real runtime.

### Tasks removed

| Task | Obligation it carried | Why deferred |
|---|---|---|
| `real-watches` | Three days of observation series on the dashboard, a delivered change notification with its event row, and a drift episode with resolution. | Three days is calendar time; a drift episode is a real-world event. Neither can be produced on demand. |
| `real-action` | An authenticated task run via a saved Solari profile, service-side confirmation, a decline-run record, and a zero-leak ledger check. | Requires a real login through `/connect` (credentials the operator enters) against a site that permits the action. No login was performed. |
| `live-suite-expansion` | The nightly suite running on schedule with a deliberately broken case turning a night red and delivering the ops notification. | The nightly guard (`.github/workflows/live-ops.yml`) requires both `SOLARI_API_KEY` and `ANTHROPIC_API_KEY`; the Anthropic key was absent, so a night is skipped, not run. |
| `cost-and-checklist` | Three consecutive green nights under the cost target and a fully attested checklist. | Depends on the three tasks above and on three elapsed nights. |

### Spec obligations deferred (not the whole specs)

- `specs/real-action-proof.md` - deferred in full. Its only task (`real-action`)
  was removed. The connect flow it builds on (`specs/site-connect-path.md`,
  task `site-connect-flow`) is delivered and unit-proven; only the live
  authenticated action is deferred.
- `specs/real-watch-proof.md` - the *live multi-day proof* portion is deferred
  with `real-watches`. The procedure, the record template, and the single-check
  pipeline are delivered (`onboarding-procedure`, `site-onboarding`) and the
  pipeline is verified live against weather.gov at the free http tier.
- `specs/live-ops-gate.md` - the *live nightly run* portion (a real red night,
  three green nights, reconciled cost) is deferred with `live-suite-expansion`
  and `cost-and-checklist`. The suite code, its unit tests, the workflow file,
  and the release checklist are delivered (`live-suite-code`,
  `release-checklist`).

### What it takes to pick these up in s10

1. `ANTHROPIC_API_KEY` set as a GitHub Actions secret (the live-ops guard needs
   it alongside the existing `SOLARI_API_KEY`).
2. A real `/connect` login to a site the operator holds an account on that
   permits an automated action.
3. A durable Postgres and a worker running the standing weather.gov watch (and
   any others onboarded) for at least three days, so the observation series,
   a delivered notification, and the three green nights accumulate.

Nothing in this list is engine work; it is credentials plus elapsed runtime.
The machinery to consume all of it is already built and unit-proven here.
