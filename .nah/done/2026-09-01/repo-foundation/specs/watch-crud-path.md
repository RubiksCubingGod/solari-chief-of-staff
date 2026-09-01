---
schema_version: 1
id: watch-crud-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: HTTP client (the Telegram chat tools and dashboard pages that arrive in s3/s4)
  terminal: watch/calendar row persisted and read back, or request refused with a typed error
origin:
  summary: The engine-free CRUD path that telegram-chat and dashboard-read consume, decided in
    project scoping so chat and dashboard stay parallel with the watch engine.
  refs: [.nah/active/repo-foundation/README.md]
---

# Watch and calendar CRUD path

## Outcome

An HTTP client can `POST /watches` (kind, url, schedule, condition), `GET /watches`,
`PATCH /watches/:id` (pause/resume), `POST /calendar-items`, `GET /calendar-items`, and
`GET /tasks` against the Fastify server backed by Postgres. Valid requests persist and read
back; invalid ones are refused with a 4xx typed error envelope, and nothing is persisted.

## Path

HTTP request → Fastify JSON-schema validation → Drizzle write/read → Postgres (Testcontainers
in integration tests) → response. The full §5 schema and its migration set are this spec's
artifact: the path runs only on a database migrated from empty by the shipped migrations.

## Failure behavior

- Malformed body, unknown kind, invalid cron expression, out-of-range values → 4xx with a
  machine-readable error code; no row created.
- Migration set applies to a fresh database and re-applies as a no-op (idempotence proof
  covers the tables with no CRUD surface yet).

## Proof

Integration tests (Vitest + Testcontainers): accepted and refused cases per route family;
migration idempotence; readback equality of persisted values.
