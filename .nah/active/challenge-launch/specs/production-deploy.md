---
schema_version: 1
id: production-deploy
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: The s9-gated main branch (three green nights, attested checklist) and the chosen host
  terminal: >-
    The full system serving Aarav in production - dashboard reachable over HTTPS, Telegram bot
    live, crons firing, watches checking, a task runnable end to end - and a fresh clone on a
    clean machine reaching a working dev environment by following the README alone
origin:
  summary: The system leaving the laptop - API, workers, web, Postgres, and secrets on the
    chosen host, with the setup path a stranger will actually follow verified honest.
  refs: [.nah/active/challenge-launch/README.md,
    .nah/active/real-site-hardening/specs/live-ops-gate.md]
---

# Production deploy

## Outcome

The pnpm workspace deployed to the chosen host: API + pg-boss workers, managed Postgres with
Drizzle migrations run, packages/web served over HTTPS, the Telegram bot pointed at
production, all secrets (SOLARI_API_KEY, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, database URL,
magic-link secret) in the host's secret store, and the nightly live-ops workflow running
against production configuration. Deploy is reproducible from a documented procedure (or CI
pipeline if the host makes that cheap), not a hand-crafted snowflake. The s9 gate files are
cited as the precondition and the deploy does not start without them.

## Path

Gate check → provision → migrate → deploy services → smoke the spine in production: dashboard
login via magic link, a watch check writing an observation, a Telegram message delivered, one
fixture-target mission end to end with its replay visible. Fresh-clone verification: a clean
machine (or container) follows README setup to green local tests without any secret from the
author's environment beyond what the README says to create.

## Failure behavior

A failed deploy or migration must be rollbackable per the documented procedure without data
loss; the procedure is exercised once (deploy, roll back, redeploy). Production misconfig
surfaces in the smoke, not in silence - each spine step has an observable check. Secrets
never appear in logs, build output, or the repo; the deploy procedure includes the check.

## Proof

The recorded production smoke (each spine step with its evidence), the exercised
rollback-and-redeploy record, the fresh-clone verification record on a clean environment, and
the nightly workflow green against production at least once before launch.
