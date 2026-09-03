# Chief of Staff

An always-on personal agent that watches things on the web for you, keeps the
deadlines those things create, and does the boring parts of acting on them —
price and slot and change watches, a calendar of renewals and cancel-by dates,
and cancellations carried out in a real browser.

This repository is the substrate the engines land on: the workspace, the
Postgres data model, the job harness, and the HTTP surface. `docs/ARCHITECTURE.md`
is the design it implements; `docs/API.md` is the HTTP surface as a client sees it.

## Requirements

- **Node 22 or newer.** `pnpm check` runs on the version in `.github/workflows/check.yml`.
- **pnpm 11.** Enable it with `corepack enable`; the exact version lives in
  `package.json` under `packageManager`.
- **Docker, optionally.** It runs the development database, and in tests it
  runs the throwaway Postgres each integration suite starts. Without it the
  suite starts an embedded PostgreSQL 17 cluster instead, so a fresh clone is
  still green; only `docker compose up` below needs a daemon.

## Setup

From a fresh clone:

```bash
pnpm install
pnpm browsers
cp .env.example .env
docker compose up -d
pnpm migrate
pnpm check
```

`pnpm browsers` downloads the Chromium the browser provider drives. `pnpm
install` deliberately does not: it is a large download pinned to one Playwright
version, and only the provider contract suite needs it.

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
| `pnpm browsers` | Downloads the pinned Chromium the browser provider drives. |
| `pnpm start` | Runs the API server on `HOST` and `PORT`. |
| `pnpm worker` | Runs the job worker: checks watches on their schedules, reconciles the schedule set once a minute, runs queued tasks through their playbooks in a guarded browser, and scans the calendar every hour for reminders to send over Telegram and for flagged subscriptions to cancel ahead of their renewal, behind a yes over Telegram. |
| `pnpm bot` | Runs the Telegram bot: long-polls for messages, writes the transcript, and carries a reply from someone a task is waiting on back to that task. |
| `pnpm clean` | Removes build output. |

`pnpm start`, `pnpm worker` and `pnpm bot` are the three long-running
processes: one deployable unit runs all of them against the same Postgres (ARCHITECTURE §2). Each
prints what it bound or started, and shuts down on `SIGTERM` — finishing the
request or the job it is already handling before the process exits.

The worker writes extractors through Claude when `ANTHROPIC_API_KEY` is set.
Without it, watches that already have an extractor are still checked, and a
watch that needs one is parked with that reason in its row rather than the
process refusing to start. Every trigger it raises is one JSON line on stdout
until a delivery channel lands.

The worker sends calendar reminders over Telegram when `TELEGRAM_BOT_TOKEN` is
set: every hour, and once at startup, it finds the entries whose lead day has
come on each person's own calendar and sends each one message, in that
person's morning. A reminder is recorded before it is sent, so a scan that
runs twice or dies halfway never sends twice; a send that fails is retried by
the next scan, three times at most, and every outcome is on the entry.
Without the token the worker says so at startup and runs everything else.

A subscription flagged `autoCancel` gets more than a reminder. On its lead
day the scan enqueues one cancellation task for the site its `action` names
(`{ "site": "fakegym" }`, matched to a playbook the worker registered), and
the task's first act is to ask, over Telegram, before it opens a browser:
`Cancel Gym before it renews on 2026-09-12? Amount: 45.00. Reply yes to go
ahead, or no to leave it as it is.` A plain yes runs the playbook, a plain
no ends the task without running any of it, and anything else is asked
again. When the task ends, the entry is marked with what became of it -
handled, declined, or what went wrong - and a flagged entry with no playbook
or no connected site is marked `needs_attention` with the reason instead of
becoming a task. Each renewal is armed once, however many scans see it. `pnpm bot`
carries replies back: a message from someone a task is waiting on is handed
to that task rather than to the assistant. The assistant itself is not on
that process yet - the credential the chat tools present to the API is the
seam `packages/agent/src/crud.ts` names as undecided - so an ordinary
message is answered with a sentence saying so, and every reply to a waiting
task is carried.

## The live Telegram round-trip

Every proof above answers Telegram at the API transformer and plays the
person from a script. One suite reaches a real phone instead:
`tests/live-telegram.integration.test.ts` composes the worker and the bot
the way `pnpm worker` and `pnpm bot` do, sends a real reminder, arms a real
cancellation on the fakegym fixture, and waits for the yes - and then the
gym's confirmation code - to come back from the phone. It skips, with the
reason in its name, unless it is run on purpose:

1. Put the bot's token from @BotFather in `.env` as `TELEGRAM_BOT_TOKEN`.
   It is never in `.env.example`.
2. Send the bot a message from the phone, then put that chat's id in `.env`
   as `TELEGRAM_LIVE_CHAT_ID`: the `id` under `message.chat` at
   `https://api.telegram.org/bot<token>/getUpdates`, or `telegram_chat_id`
   on the bound user's row once a chat has bound with `/start <code>`.
3. Stop any `pnpm bot` running on the same token - Telegram allows one
   poller - and make sure the pinned Chromium is installed (`pnpm browsers`).
4. Run `node scripts/live-telegram.mjs` with the phone in hand. It refuses
   to run without both values rather than skipping, because a skipped suite
   exits zero. The phone gets a reminder, then the question; reply `yes`.
   The terminal then prints the gym's code; reply with it. Each answer has
   five minutes, after which the task times out and the run fails honestly.
5. The run ends with one JSON line, `live_telegram_roundtrip`, recording
   when it ran, the task, the questions asked and the replies carried. Paste
   it into the sprint's handoff: that line is the record of the run.

To change the schema, edit `packages/db/src/schema.ts`, then run
`pnpm --filter @chief-of-staff/db generate` to write a new migration, and
`pnpm migrate` to apply it. Generated migrations are committed.

## Layout

| Package | Contents |
|---|---|
| `packages/core` | The domain vocabulary — the closed sets every other package agrees on. Held to 100% coverage. |
| `packages/db` | Drizzle schema, migrations, the shared Postgres client, and the pg-boss job harness. |
| `packages/api` | The Fastify server: config, the typed error envelope, and the CRUD routes. |
| `packages/solari` | The `BrowserProvider` seam every engine drives a browser through, and its implementations. |
| `packages/agent` | The Claude layer — arrives in a later sprint. |
| `packages/watch` | The watch engine: the fetch tier ladder, the Drizzle watch store, and the scheduled check that runs each watch. |
| `packages/playbooks` | Scripted site flows — arrives in a later sprint. |
| `packages/bot` | The Telegram bot: the one runtime every Telegram message crosses, the transcript it writes, and the replies it carries back to waiting tasks. |
| `packages/web` | The Next.js dashboard: the shell its pages land in, and the HTTP client it reads them through. Lint refuses a database import here — the API is the only door. |
| `fixtures` | Local fixture sites the engines are tested against. |

## Tests

Unit tests run on plain Node. Integration tests need Postgres, and walk a ladder
of three ways to get it, in this order:

1. **A server you already run.** Only when `TEST_DATABASE_URL` is set. Each
   suite creates, then drops, a uniquely named database on it.
2. **A throwaway container per suite.** What CI does. Needs a container runtime.
3. **An embedded cluster.** The stock PostgreSQL 17 binaries, started in a
   temporary directory on an ephemeral port, reached when step 2 finds no
   container runtime. It needs no daemon, no administrator, and no connection
   string from anyone, which is what keeps a machine without Docker from being
   a machine that cannot run the tests.

`TEST_POSTGRES_STARTER` pins one rung and turns the fallback off — how a machine
that has Docker reproduces what a machine without it does.

The provider contract suite additionally needs the Chromium `pnpm browsers`
downloads. It drives static content it serves itself, so it needs no fixture
site and no network.

The coverage gate is 100% on `packages/core` and 90% across the workspace. That
gate is itself tested: `tests/coverage-gate.test.ts` runs the suite over a
fixture that deliberately leaves a branch unexercised and requires the run to
fail.

## Configuration

`.env.example` documents every variable the workspace reads, what it defaults
to, and which ones only matter locally. `tests/docs.test.ts` holds it to that:
the example has to be enough to configure the server on its own, and its
connection string has to match the database `docker compose up` starts.
