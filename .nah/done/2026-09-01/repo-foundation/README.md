# Repo Foundation

A green-CI pnpm workspace where every later release has a place to land: package layout per
ARCHITECTURE §11, Drizzle schema and migrations for all §5 tables, a pg-boss job harness,
docker-compose Postgres for local dev, a Fastify API skeleton with engine-free CRUD routes
(watches, calendar items, task reads), and CI with lint, type, test, and coverage gates.

## Outcome

A fresh clone follows the documented setup, `pnpm check` runs green locally and in CI, a
Testcontainers Postgres accepts the full migration set idempotently, a cron and a queued job
round-trip through pg-boss, and an HTTP client can create, list, and pause a watch and create a
calendar item — with refused paths (invalid payloads) proven alongside accepted ones. Later
sprints add engines and surfaces without reworking the substrate.

## Boundaries

- Fixture sites are `fixture-harness`; browser providers and the Solari live smoke are
  `browser-substrate`. Nothing here talks to a browser or an LLM.
- CRUD routes are engine-free: no scheduling, no tiering, no extractors, no notifications. The
  watch engine (s2) attaches behavior to rows this sprint only stores.
- The full §5 schema lands here (including tables first consumed later: users,
  site_connections, observations, task_events, messages) — the data model is pinned by
  ARCHITECTURE §5 and landing it once avoids per-sprint migration churn. Tables without a CRUD
  surface are proven only by migration idempotence, deliberately.
- No deployment, no hosting, no production secrets. `.env.example` documents configuration;
  deploy is `challenge-launch`.

## Specifications

- `specs/watch-crud-path.md` — vertical: HTTP client → validation → Postgres → readback, with
  refused states; carries the schema/migration artifact.
- `specs/workspace-ci-gate.md` — horizontal: the enforced quality-gate capability every later
  release lands behind (workspace, lint/tsc, vitest, coverage gates, CI workflows).
- `specs/job-scheduling-harness.md` — horizontal: durable scheduled work on plain Postgres
  (pg-boss, cron, retry-to-observable-failure).

## Non-goals

- No Redis, no microservices, no message broker — pg-boss on the one Postgres, per
  ARCHITECTURE §2.
- No auth on the API yet (dashboard magic-link auth is `dashboard-read`; the API is not
  publicly exposed before then).
- No fixture content, even as placeholders.
