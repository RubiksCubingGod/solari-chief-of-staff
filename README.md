# Chief of Staff

An always-on personal agent that watches things on the web for you, keeps the
deadlines those things create, and does the boring parts of acting on them —
price and slot and change watches, a calendar of renewals and cancel-by dates,
and cancellations carried out in a real browser.

This repository is the substrate the engines land on: the workspace, the
Postgres data model, the job harness, and the HTTP surface. `docs/ARCHITECTURE.md`
is the design it implements.

## Requirements

- **Node 22 or newer.** `pnpm check` runs on the version in `.github/workflows/check.yml`.
- **pnpm 11.** Enable it with `corepack enable`; the exact version lives in
  `package.json` under `packageManager`.
- **Docker.** Used for the development database and, in tests, for the
  throwaway Postgres each integration suite starts.

## Setup

From a fresh clone:

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm migrate
pnpm check
```

`pnpm check` is the whole gate — lint, types, unit and integration tests with
the coverage thresholds, and the build. It is the same command CI runs, so if it
passes here it passes there.

## Commands

| Command | What it does |
|---|---|
| `pnpm check` | The full gate: lint, typecheck, tests with coverage, build. |
| `pnpm lint` | ESLint over the workspace. |
| `pnpm typecheck` | `tsc --build` plus the test-only project. |
| `pnpm test` | Unit and integration tests with coverage. |
| `pnpm test:unit` | Unit tests only — seconds, no database. |
| `pnpm test:integration` | Integration tests only — needs Docker or `TEST_DATABASE_URL`. |
| `pnpm build` | Compiles every package through its project references. |
| `pnpm migrate` | Applies the migration set to `DATABASE_URL`. |
| `pnpm start` | Runs the API server on `HOST` and `PORT`. |
| `pnpm worker` | Runs the job worker pool. |
| `pnpm clean` | Removes build output. |

`pnpm start` and `pnpm worker` are the two long-running processes: one
deployable unit runs both against the same Postgres (ARCHITECTURE §2). Each
prints what it bound or started, and shuts down on `SIGTERM` — finishing the
request or the job it is already handling before the process exits.

To change the schema, edit `packages/db/src/schema.ts`, then run
`pnpm --filter @chief-of-staff/db generate` to write a new migration, and
`pnpm migrate` to apply it. Generated migrations are committed.

## Layout

| Package | Contents |
|---|---|
| `packages/core` | The domain vocabulary — the closed sets every other package agrees on. Held to 100% coverage. |
| `packages/db` | Drizzle schema, migrations, the shared Postgres client, and the pg-boss job harness. |
| `packages/api` | The Fastify server: config, the typed error envelope, and the CRUD routes. |
| `packages/solari` | Browser provider — arrives in a later sprint. |
| `packages/agent` | The Claude layer — arrives in a later sprint. |
| `packages/playbooks` | Scripted site flows — arrives in a later sprint. |
| `packages/bot` | The Telegram bot — arrives in a later sprint. |
| `packages/web` | The dashboard — arrives in a later sprint. |
| `fixtures` | Local fixture sites the engines are tested against. |

## Tests

Unit tests run on plain Node. Integration tests need Postgres, and get it one of
two ways:

1. **A throwaway container per suite.** The default, and what CI does. Needs a
   container runtime.
2. **A server you already run.** Set `TEST_DATABASE_URL` and each suite creates,
   then drops, a uniquely named database on it. This is the path on a machine
   with no container runtime.

The coverage gate is 100% on `packages/core` and 90% across the workspace. That
gate is itself tested: `tests/coverage-gate.test.ts` runs the suite over a
fixture that deliberately leaves a branch unexercised and requires the run to
fail.

## Configuration

`.env.example` documents every variable the workspace reads, what it defaults
to, and which ones only matter locally. `tests/docs.test.ts` holds it to that:
the example has to be enough to configure the server on its own, and its
connection string has to match the database `docker compose up` starts.
