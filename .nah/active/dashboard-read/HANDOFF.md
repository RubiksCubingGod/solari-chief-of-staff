# Handoff

## Frontier

Wave 1 is done. `observation-read-routes` closed at commit `b9fb797` and `next-shell`
closed with findings; both carry attributed proofs. `magic-link-auth` is the only
runnable task now, and `watches-page` and `calendar-tasks-pages` stay gated behind it.

Its five proofs - two red, two green, one gate - are declared in `tasks.jsonl` **before**
dispatch, which is the process correction recorded below. The two RED receipts must be
produced by the worker while the code is still red; the seam sentinels its brief binds it
to are `registerAuthRoutes is not implemented` and `readSession is not implemented`.

## Environment finding: no container runtime on this machine

`node scripts/vitest.mjs run --project integration` fails at
`getContainerRuntimeClient` with "Could not find a working container runtime
strategy". Docker is not installed and is not on PATH. This is an environment
fact, not a repository defect - the integration suites themselves are sound.

Recovery used, without changing a single repository file: the fallback
`packages/db/src/testing/postgres.ts` already documents and implements, and that
`.env.example` already describes under "Tests". A private throwaway PostgreSQL 17
cluster was provisioned from the stock binaries at
`C:\Program Files\PostgreSQL\17\bin`:

- data directory `C:\tmp\cos-testpg`, log `C:\tmp\cos-testpg.log`
- listening on `127.0.0.1:55432` only, superuser `postgres`, password `nahtest`
- started with `pg_ctl -D C:\tmp\cos-testpg -o "-p 55432 -h 127.0.0.1"`

Every proof in this sprint therefore runs with

    TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres

set inline. Verified green before any task was dispatched:
`packages/db/src/postgres-harness.integration.test.ts` (2 tests) and
`packages/api/src/routes.integration.test.ts` (11 tests).

The machine's own PostgreSQL 17 service on 5432 was deliberately left alone: its
credentials are not available to this session, and guessing them or editing its
`pg_hba.conf` would have been a destructive change to something the user owns.

## Concurrency: four implementation attempts share this working tree

(Was three. `packages/agent` joined on 2026-09-01 and its untracked, mid-RED
files are what the `next-shell` gate is red on.)

`nah implement` claimed three stages within three minutes, all with
`workspace: {mode: shared}` on `C:\Users\aarav\chief-of-staff`:

- `dashboard-read` - `attempt-r4349397265d74a07ab2adf263dddcaac` (this session)
- `browser-substrate` - `attempt-rdb47163c72324022bf4f53c8b41eaca1`
- `telegram-chat` - `attempt-rffd45100e3e84eff8117cb620393a658`

Consequences to keep in mind when reading any receipt from this attempt:

- `node scripts/check.mjs` is a repository-wide gate. A red gate may be red for a
  sibling's in-flight work rather than for this sprint's change. Classify before
  repairing, and never repair inside a live owner's files.
- `browser-substrate` is adding an embedded-Postgres rung to
  `packages/db/src/testing/postgres.ts` and `embedded-postgres` to
  `packages/db/package.json`. That solves the same gap a different way. The
  `TEST_DATABASE_URL` rung above takes precedence over it, so the two do not
  conflict and this sprint deliberately did not duplicate that work.
- `pnpm-workspace.yaml` currently carries the unresolved pnpm placeholder
  `'@embedded-postgres/windows-x64': set this to true or false` under
  `allowBuilds`. It is a sibling's file and a live owner exists, so it was left
  untouched. `pnpm ls` still reads the workspace, so it is not a hard block.

## Open, unresolved by this sprint

- `users.email` is nullable and carries no unique index (`packages/db/src/schema.ts`),
  but `magic-link-auth` addresses a user *by email address*. That task will have to
  decide whether it needs a migration, and the decision belongs to whoever picks it
  up rather than being assumed here.

## Closed: observation-read-routes (commit b9fb797)

Green: `observation-reads-green` - the 22-test routes integration suite, passed.
Red: `observation-reads-gate` - `node scripts/check.mjs`, failed. Closed with
`--continue-with-findings`, so the red evidence is preserved for hardening.

**Correction to that finding's recorded reason.** The reason text names
`packages/bot/src/testing/transport.ts:80` as the sole gate failure, which is what
a repo-wide `eslint .` reported when the rationale was written. The gate run that
`nah task finish` actually executed failed somewhere else: on
`packages/web/src/testing/dev-server.ts` (`require-await`, `no-unused-vars`) -
this sprint's own `next-shell` worker, mid-RED at that moment. The substance of
the finding is unchanged and still accurate: the gate was red only outside
`packages/api`, from work in flight elsewhere in the shared tree, and eslint over
`packages/api`, 39 api unit tests, and the 22-test integration suite were all
green. Only the file named in the reason is wrong for that particular receipt.

Two separate live sources of gate contamination are therefore confirmed: the
`telegram-chat` attempt (`packages/bot`, `packages/db`) and this sprint's own
in-flight `next-shell` task (`packages/web`).

## Process correction for the remaining tasks

`observation-read-routes` has no attributed RED receipt. Its worker did produce a
genuine RED and reported the signature
(`Error: registerObservationRoutes is not implemented`, 22 tests skipped), but a
proof cannot be verified before it is declared, and the proofs were declared only
after the work came back - by which time re-running the RED could no longer
reproduce its expectation.

For `magic-link-auth`, `watches-page`, and `calendar-tasks-pages`: declare the
red, green, and gate proofs in `tasks.jsonl` **before** dispatching, and have the
worker run `nah verify <sprint> <task> <proof-id>` while the code is still red, so
the RED receipt is attributed to the execution that actually observed it.

## Hazard for magic-link-auth: the migration namespace is contended

`magic-link-auth` needs somewhere to store single-use tokens that can be consumed
atomically under a race, and it addresses users by email while `users.email` is
nullable and carries no unique index. Both point at a migration.

The drizzle migration set is sequentially numbered and shares one journal file.
`packages/db/drizzle/0001_unattributed_transcript_rows.sql`,
`packages/db/drizzle/meta/0001_snapshot.json`, and the modified
`packages/db/drizzle/meta/_journal.json` are all **uncommitted and owned by the
telegram-chat attempt** running right now. So:

- **Update as of next-shell closing:** `0000`-`0003` are all committed and the
  journal is clean, so `0004` is free. The rule below still stands.
- Do not assume the next free index is `0001`. Re-read `meta/_journal.json`
  immediately before generating, and regenerate rather than hand-editing.
- `meta/_journal.json` is append-only shared state. Two sprints generating a
  migration concurrently will collide on it, and the loser silently loses its
  entry. If the sibling's rows are present, leave them and add after them.
- `runMigrations` applies the committed SQL in `drizzle/` and is the only path
  (`drizzle-kit push` is deliberately not used), so a missing journal entry means
  a table that exists in `schema.ts` and nowhere in the database.

## Closed: next-shell (with findings)

Its worker did not survive: the task notification came back `failed` - "was running
when the previous Claude Code process exited and did not complete. Its in-process
state was lost." Substantial work was already on disk, so rather than re-dispatch
blindly this session verified the orphaned work directly and read both proofs for
honesty before declaring them.

Why the two proofs are worth believing:

- `packages/web/src/testing/dev-server.ts` boots Next **in process** on an ephemeral
  loopback port, binds the http server before preparing, tears down on a failed
  `prepare()`, and has an idempotent `stop()`. The smoke test asserts server-rendered
  markup, that the page really called `/health` on a stub API, and that stopping twice
  genuinely releases the port - so it proves the shell renders through a real server
  rather than through a render helper.
- `packages/web/src/api-boundary.test.ts` lints synthetic source through the
  repository's own ESLint configuration with `ESLint.lintText`, so no violating file
  ever reaches disk for `eslint .` to trip over. It includes a negative control proving
  the rule does **not** fire on `packages/api/src/index.ts` - without which the test
  would pass equally well against a rule that refused everything everywhere.

### A real defect the gate caught, in this task's own file

The first gate run failed on `packages/web/src/api-boundary.test.ts` - not on a
sibling's file. It passed standalone and timed out under `pnpm check`.

The cause was a wrong assumption rather than flakiness: the worker put a 120s timeout on
the first test alone, reasoning that it absorbs the type-aware TypeScript program build
for the rest of the file. It does not. Under the coverage-instrumented full run every
call costs seconds, and the second test made four of them in a loop against a 5s default.

Repaired two ways, both of which make the proof stronger rather than merely greener:

- The timeout is now the **suite's**, because the cost belongs to every test in the
  file, not to whichever one happens to run first.
- The four forbidden specifiers are lint-checked in one synthetic file instead of four,
  and the assertion is on the **line numbers** of the refusals rather than on a count -
  which is what proves no single specifier slipped through while its neighbours were
  caught. Four type-aware program builds became one.

Measured after the repair: 26 tests, 116s under load, inside the new budget.

### Why the task is closed with findings

The final gate is red with **118 lint errors in exactly two files**, both untracked and
both a live sibling's mid-RED work:

- `packages/agent/src/chat-agent.integration.test.ts`
- `packages/agent/src/testing/scripted-llm.ts`

Every error is one of the `@typescript-eslint/no-unsafe-*` family - the shape of a test
written against a package whose types do not resolve yet. Nothing in `packages/web`,
nothing in the shared configuration this task changed, and nothing in `packages/api`.
Repairing them would mean editing another attempt's in-flight files, so the red evidence
is preserved and handed to hardening instead.

### Correction to the next-shell finding reason

The `--continue-with-findings` reason on commit `38c09b5` names **118** errors across
`packages/agent/src/chat-agent.integration.test.ts` and
`packages/agent/src/testing/scripted-llm.ts`. That was true of the gate run that
produced the evidence. The gate that ran inside `nah task finish` minutes later saw
**one** error - `@typescript-eslint/require-await` at `scripted-llm.ts:94` - because the
sibling was actively repairing those files in between.

The substance is unchanged and the classification stands: the gate was red only in
`packages/agent`, a live sibling's untracked work, and never in this task's files. The
count in the recorded reason is a snapshot of a moving tree, not a stable number.
Recorded here rather than left silently wrong.

### A red herring worth recording: POST /tasks answering 404

An earlier gate run failed four `POST /tasks` tests in
`packages/api/src/routes.integration.test.ts` with `expected 404 to be 201/400`. That
looked like a regression in this sprint's own committed API work. It is not, and the
reasoning is worth keeping because the same shape will recur in this tree:

- Re-run in isolation minutes later: **27/27 passed**, repeatedly.
- One of the four sends a deliberately invalid body and expects 400. A probe against
  this app's own Fastify configuration confirms that a bad body with a valid header
  returns 400 and `preHandler` never runs - so those 404s could **not** have come from
  `resolveCaller`, which was the obvious suspect.
- `git status` then showed `packages/api/src/routes/tasks.ts` and
  `packages/api/src/routes.integration.test.ts` as **modified and uncommitted**: a live
  sibling is editing the task routes right now. The gate had read that file mid-edit, in
  a state where `POST /tasks` was not registered.

The lesson for whoever next reads a red gate in this tree: check `git status` for a
modified file under the failure before believing a regression in committed work.

### `.env.example` was deliberately left out of the commit

`next-shell` documents `API_BASE_URL` there. That file also carries browser-substrate's
uncommitted `SOLARI_API_KEY` / `SOLARI_LIVE_SMOKE` block and its edit to the header
comment. `nah task finish` commits the **working-tree** content of every path it is
given, so naming `.env.example` would have swept a live sibling's uncommitted work into
this sprint's commit under this task's attribution.

The documentation line stays in the working tree and will land with whichever task
commits `.env.example` next. Nothing in `done_when` or in any proof depends on it: the
gate does not read `.env.example`, and `packages/web/src/config.ts` refuses a missing
`API_BASE_URL` at boot with its own tested error.

### The sprint ledger needed repair

`nah` writes `events.jsonl` atomically through a temp file. One of those renames did not
land: `events.jsonl` held a `verification-started` for `web-shell-gate` at 18:09:38 with
no completion, while an orphaned `events.jsonl.23624.<uuid>.tmp` beside it held the
`verification-completed` at 18:10:31. The writing process was already dead. Left alone
it would have shown a verification running forever, and `nah diagnostics` flagged the
stray file as an unknown sprint root file.

Repaired by appending the one missing event verbatim - lines 1-29 were byte-identical
and line 30 differed only in key order, so the temp was the same ledger plus its
terminal event - and moving the temp out of the repository. `nah diagnostics` is clean
again. If a sprint root ever grows a `*.tmp` beside `events.jsonl`, compare by event
`id` and append what is missing; do not copy the temp over the ledger blind.

## Environment notes for the remaining tasks

- The private Postgres cluster is still up on `127.0.0.1:55432`, `max_connections = 100`.
  Four sprints now share this workstation and each `pnpm check` runs eight vitest workers
  with their own pools. Two concurrent full checks already produce 5s-timeout failures in
  unrelated packages (`packages/api/src/server.test.ts`,
  `packages/solari/src/solari.retry.test.ts`). Prefer to run the gate when no other
  `check.mjs` is running, and read timeout failures in packages you did not touch as
  contention until proven otherwise.
- Chromium is installed and `.github/workflows/check.yml` already runs
  `pnpm browsers --with-deps` before `pnpm check`, so a Playwright e2e reaches CI with no
  workflow change. Playwright lives in `packages/solari/node_modules`; using it from
  `packages/web` needs `"playwright": "1.62.1"` in that package's devDependencies plus a
  committed `pnpm-lock.yaml`, because CI installs with `--frozen-lockfile`.
- There is no separate e2e runner. An e2e is an `.integration.test.ts` under
  `packages/<pkg>/src/`, driving `chromium` against `startWebDevServer`.

## Prior art magic-link-auth should read before designing tokens

`telegram-chat` has already solved single-use codes: `bindingCodes` in
`packages/db/src/schema.ts` is `code text not null unique`, `expiresAt`, `consumedAt`,
and its comment explains the choice - a code is spent rather than deleted, so a second
attempt can be told apart from a code that never existed and answered differently.
Mirror that shape and that distinction rather than inventing a new one.

`packages/api/src/caller.ts` is the identity seam to replace. Its own comment is the
mandate: real authentication "replaces this hook alone, and every route schema stays
exactly as it is." The existing suite centralises this in one `asOwner()` helper
(`packages/api/src/routes.integration.test.ts`, around line 53) plus two inline uses for
the unknown-caller and malformed-caller refusals, so the change is contained. Do not
leave an `x-user-id` fallback: it would let any caller claim any user id.

<!-- nah-checkpoint:9da9a5e808551cf7 -->
## 2026-09-01T17:23:59.355Z · claude-code · 7ad24642-5b42-442f-b780-c55978ff1b5e

- Stage: implementation
- Ready: none
- In progress: next-shell
- Root blockers: none
- Done: 1/5
- Receipts: verification-completed-event8e7c513a275d4bb2ab2299ac1498c201, verification-completed-eventf42df3f48c344d3bb98ac3efda4c8cad
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s4`

## Resolved before dispatch: how a web e2e gets a seeded database

`watches-page` and `calendar-tasks-pages` both need a Playwright e2e against a **seeded**
database, and there is a real obstruction in the way that is worth settling once here rather
than twice in two briefs.

The obstruction: `next-shell` landed a lint boundary that refuses `@chief-of-staff/db`,
`@chief-of-staff/db/testing`, `drizzle-orm` and `pg` from every file under
`packages/web/**/*.{ts,tsx}` - tests included - and `packages/web/src/api-boundary.test.ts`
asserts `@chief-of-staff/db/testing` by name among the refused specifiers. So the seeding
route every other package uses is closed to web on purpose.

Seeding over HTTP does not rescue it. The sparkline needs an observation series, and
observations have no write route: `GET /watches/:id/observations` is the only one, because
writing them belongs to the engine in a later sprint. There is no door to seed them through.

**Take the fixture out of `packages/web` instead of opening a hole in the boundary.** The
repository already has the precedent, and `vitest.config.ts` documents the reasoning at the
`@chief-of-staff/db/testing` alias: a source-only subpath, excluded from the package build and
from its published exports, aliased explicitly so tests resolve it while nothing shipped can.

Mirror it exactly:

- Add `packages/api/src/testing/fixture.ts` exporting one helper that starts test Postgres,
  runs migrations, inserts the seed, boots the Fastify app, and returns the base URL, the seed
  it planted, and a `stop()`. The API package is the right home because it is the one package
  that already owns both the database and the HTTP surface.
- Alias `@chief-of-staff/api/testing` to it in `vitest.config.ts`, listed **before** the bare
  `@chief-of-staff/api` entry - the existing comment explains why: the bare alias would
  otherwise swallow the subpath.
- Add `"@chief-of-staff/api": "workspace:*"` to `packages/web` devDependencies, which is what
  `packages/agent` and `packages/bot` already do for the db helper they use the same way.

The web e2e then imports `@chief-of-staff/api/testing` and nothing else. The boundary stays
absolute, `api-boundary.test.ts` needs no edit, and no exception has to be carved for test
files - which is the outcome worth having, because an exception for
`*.integration.test.ts` would also let a page be tested against the database directly and
quietly retire the claim the boundary exists to make.

### Two smaller facts the same tasks will hit

- `packages/web/src/api-client.ts` has `listWatches`, `setWatchStatus`, `listCalendarItems` and
  `listTasks`, but **no** `listObservations`. The sparkline route shipped in
  `observation-read-routes` has no client method yet; `watches-page` adds it. Note the response
  contract while writing it: the route returns the series **oldest-first**, already reversed
  server-side so a sparkline plots the array as it arrives, and it takes `from`, `to` and
  `limit` with `additionalProperties: false` and a default ceiling of 100.
- `TEST-MATRIX.md` says these run against "Testcontainers". There is no container runtime on
  this workstation - see the environment note above. `startTestPostgres` falls through its own
  documented ladder to `TEST_DATABASE_URL`, which is the repository's own supported path and
  needs no file changed to use. The matrix row names the intent, not a requirement that the
  container starter be the one that serves.

## In flight: magic-link-auth, with one red already banked

`auth-flow-red` is **recorded and passed** on the ledger (git revision `38c09b5`, exit 1,
stopping at `registerAuthRoutes is not implemented` through
`createApp` -> `registerRoutes` -> `registerAuthRoutes`). It was captured by this session
rather than by its worker: the worker stalled on a watchdog with the seam still unimplemented,
so the red was still genuinely real and was banked before anything else touched the file. The
remaining four proofs were still unrun at that point.

### A NAH mechanic worth knowing before declaring any future red

`findStaleCommandProofs` begins with
`if (proof.kind !== "command" || proof.stage === "red") return [];` - **red-stage proofs are
never staleness-checked.** Green and gate proofs are: each receipt stores a sha256 per covered
file and any later edit makes it stale.

So a red proof *should* name the implementation file it expects to change, not only the test.
That is the intended shape rather than a hazard: the red proves the composed path stops at that
seam, and the seam has to change to go green. `auth-flow-red` covering both
`packages/api/src/routes/auth.ts` and `packages/api/src/auth.integration.test.ts` is correct
and will not block closure.

Two neighbouring facts from the same code, because both cost this session time:

- Staleness is only computed for tasks already at `status: done`, and it surfaces as a warning
  reading "will refresh at implementation closure" - not as a refusal.
- Receipts are **not** inline on the task row in `tasks.jsonl`. They are `verification-completed`
  events in `events.jsonl`; the verdict is `receipt.outcome` (`"passed"`), and a `failure_reason`
  key appears only on failures. Reading the task row for a `receipt` field finds nothing and
  proves nothing.

## The auth seam regressed committed work in another package, and this session repaired it

Worth reading before the next task changes anything shared: the reasoning here overturned an
instruction this session had itself given, because the facts changed underneath it.

When `magic-link-auth` was dispatched, `packages/agent/src/crud.ts` was **untracked** - a live
sibling's in-flight work - so the brief told the worker to leave `packages/agent/**` alone and
to report the consequence instead. That was right at the time. By the time the worker finished,
commit `23a3e0a task(telegram-chat): finish chat-integration-proof` had landed and those files
were **tracked and clean**. The sibling's task was finished, telegram-chat's executions were all
ended, and browser-substrate was closed. No live owner existed.

So the 18 failures the worker reported as "red outside my scope" were not a sibling's mid-RED
noise. They were committed, previously-passing work that this sprint's own change broke:
`packages/agent/src/chat-agent.integration.test.ts` (11) and
`tests/chat-front-door.integration.test.ts` (7), both authenticating through a client that
still sent `x-user-id`, which the API now refuses with 401. A regression this session caused is
this session's to repair, not hardening's to inherit.

### Why the obvious fix was the wrong one

The worker proposed having `crud.ts` call `mintSessionCookie`. Two documented contracts forbid
it, and both are worth preserving:

- `mintSessionCookie`'s own comment: *"It is deliberately not a production credential path.
  Minting a session without consuming a link is exactly what the magic-link flow exists to
  prevent, so the only thing that may call this is a test that already knows the server's own
  secret because it configured it."*
- `crud.ts`'s own comment, on reading the error envelope structurally rather than importing its
  type: *"a compile-time dependency on it would make the agent unbuildable without the server it
  is deliberately only a client of."*

A fix that made the agent import the API package to forge browser sessions in production would
have satisfied the gate and quietly repealed both.

### What was done instead

Identity is now **supplied** to the client rather than invented by it. `HttpCrudClientOptions`
takes a required, undefaulted `credential: (caller) => Record<string, string>`, and
`createHttpCrudClient` sends exactly what it is handed. This mirrors the `CredentialSource`
shape `packages/web/src/api-client.ts` already uses, so it is this repository's existing answer
rather than a new invention.

The two integration suites pass a fixed `SESSION_SECRET` into `createApp` and mint their own
cookie - the sanctioned use, since they own the secret they sign with. `crud.test.ts` gained a
test that the old code could not have passed: that the credential is asked **once per request**
with the right caller, and that no `x-user-id` is added on the client's own initiative.

Making `credential` required rather than defaulted is the deliberate part. There is no
production call site of `createHttpCrudClient` yet - only tests and one re-export - so nothing
real broke, and whoever wires the bot up in production is now forced to decide what it presents
instead of inheriting a default that would be wrong.

### The question this names but does not answer

**How a server-to-server caller authenticates to the API is genuinely undecided.** The magic-link
session is a browser credential; the Telegram bot has no browser and acts on behalf of a user it
identified by chat binding. That is a real design decision belonging to whichever sprint wires
the bot to the API in production, and it is recorded in `DEFERRED.md` rather than guessed at
here. The seam is shaped so that decision has somewhere to land.

## The gate caught a second real defect: two Next dev servers cannot share a build directory

`magic-link-auth` added `packages/web/src/auth-guard.integration.test.ts`, which boots a
dashboard through `startWebDevServer`. `packages/web/src/smoke-page.integration.test.ts` already
did. Vitest runs test files in parallel, and both suites passed when run one at a time - so the
first sign of trouble was the gate:

```
⨯ Another next dev server is already running.
- Local:  http://localhost:56518
- PID:    36324
- Dir:    C:\Users\aarav\chief-of-staff\packages\web
```

This is not flakiness and not workstation contention. Next 16 takes an exclusive lock and the
loser does not retry or degrade - it calls `process.exit(1)` inside the test worker, which
vitest reports as `process.exit unexpectedly called with "1"` and a second, misleading
`Cannot read properties of undefined (reading 'close')` from the teardown of a server that never
started. Read together those two failures look like a broken test file; they are one lock.

The lock's location settles the fix. In `next/dist/server/lib/router-utils/setup-dev-bundler.js`:

```js
lockfile = await Lockfile.acquireWithRetriesOrExit(
  path.join(distDir, 'lock'), 'next dev', true, JSON.stringify(serverInfo), ...
)
```

The lock lives **inside `distDir`**, so instances that do not share a build directory do not
share a lock. That much was right. What was wrong was the lever.

`next()` accepts a `conf` option, and `startWebDevServer` passed `conf: { distDir:
'.next/instance-<uuid>' }`. **Next discards it.** The option is forwarded to `loadConfig` as
`customConfig` (`next/dist/server/next.js`), and the key that config is cached under records
only whether one was supplied (`next/dist/server/config.js`):

```js
const keyData = JSON.stringify({
    dir,
    phase,
    hasCustomConfig: Boolean(customConfig),
    ...
});
```

Two configs that differ only in what they say are the same key, so the first load wins for the
life of the process and every instance keeps the default `.next`.

A probe settles that faster than any amount of reading: boot one dev server with
`conf: { distDir: '.next/probe-instance' }` and ask the filesystem what happened.

```
PROBE probe-dir-exists: false
PROBE next-entries: dev
```

The directory is never created. The isolation had never existed - not once, not partially - and
the two-suite run that was taken as proof of it passed only because two suites happened not to
overlap, which is precisely the failure this section was written about.

**The lever that works is a config file on disk**, which Next loads itself and does not route
through that cache. `packages/web/next.config.mjs` reads `distDir` from `NEXT_DIST_DIR`, and
`startWebDevServer` sets that variable to `.next/instance-<uuid>` before `prepare()` and restores
it in `stop()` - alongside the `API_BASE_URL` it already hands over the same way, because Next
reads its configuration from the environment exactly as a deployed app does. Unset, which is
every case but these tests, leaves Next on its default, so `next build` and `pnpm check` are
untouched. The same probe against the config file creates the directory and puts the `dev` lock
inside it.

That helper's own doc comment already promised this: *"the instance belongs to one test file, two
files cannot collide on a port or on a build directory"*. It was true about ports and silently
false about build directories from the moment a second suite existed - and stayed false through a
fix that read correctly, matched the source, and did nothing.

### The pattern worth naming

This is the second defect in this sprint that only the composed gate could find, after the
`api-boundary.test.ts` timeout recorded above. Both had the same shape: **green in isolation,
red under `pnpm check`, because the thing that breaks is a resource the isolated run never
contends for** - a type-aware ESLint program built while a coverage-instrumented suite runs, and
now a dev-server lock held by a sibling test file.

Two lessons for the remaining page tasks, which will add more `startWebDevServer` callers:

- **A web integration suite that passes on its own has not been tested yet.** Run it in one
  command with every other suite that boots a dashboard. All three now pass together - 3 files,
  15 tests, 88s - and that is the condition the gate reproduces, so it is the condition to
  reproduce first.
- **A fix aimed at a framework's internals is not finished when it reads correctly.** The `conf`
  route was plausible, cited the right source, and was inert. Ask the filesystem what actually
  happened before recording it as proven; a passing run is evidence about scheduling until the
  contended case is the one that ran.

### Fixing the lock made the gate slower, and two other suites said so

Worth recording because it is counter-intuitive: repairing the dev lock made the next gate run
*harder*, not easier. Before the fix the third dashboard died instantly - `process.exit(1)` costs
nothing - so the gate had been running two dev servers and reporting a failure. Afterwards it
runs three, all compiling with Turbopack, and two unit tests that had never been near a timeout
fell over at 7.7s and 8.2s against vitest's 5s default:

- `packages/api/src/app.test.ts` - every test boots a real Fastify instance, plugins registered
  and route schemas compiled by Ajv.
- `packages/api/src/server.test.ts` - the only API test that binds a socket.

Both now carry a suite budget of `60_000`, the same shape and for the same reason as
`api-boundary.test.ts` above: the cost belongs to every test in the file rather than to whichever
runs first, because each test pays it again. Neither assertion changed; neither test is
measuring speed, and a 5s budget on a real server boot is a benchmark wearing a unit test's
clothes.

### A route the browser proves is a route coverage cannot see

`packages/web/src/app/watches/pause/route.ts` was **7 of 7 branches uncovered** while a passing
e2e clicked its button, posted its form and read back the status it set. That is not a gap in the
e2e. The dashboard runs in its own dev server, so nothing it executes is instrumented by the
vitest process that is measuring - and the global branch threshold fell to 89.28% on the strength
of one small file.

`packages/web/src/watches/pause-route.test.ts` closes it, and is a better test than a number
would have needed: the browser can prove the route works, but it cannot post a form with no `id`
or a status the domain does not have, so the guards were unprovable from outside. The rule for
`calendar-tasks-pages`: **every `.ts` under `src/app/` needs a unit test of its own**, however
thoroughly a browser exercises it. `.tsx` is outside the coverage glob and does not, which is the
other half of why logic belongs in `.ts` and presentation in `.tsx`.

## The watches page found a redirect that quietly changes host, and drops the session doing it

`watches-page` added the one write this read dashboard performs: a pause/resume form posting to
`/watches/pause`, which calls the CRUD route and 303s back to the list. It failed on the first
green run, and the failure is worth keeping because nothing before it could have found it.

The browser posted the form, the route answered `303`, and the browser arrived at
**`http://localhost:55608/login`** - signed out, at the sign-in page, having just been signed in.

The route was building its redirect the way the two routes before it did:

```ts
new URL('/watches', request.url).toString()
```

`request.url` does not report the host the browser dialled. In this configuration Next fills it
in as `localhost` whatever the request's `Host` header said, so a browser on `127.0.0.1` was
being sent to `localhost` - a different origin as far as a cookie jar is concerned. The session
cookie is host-only by deliberate design (`.env.example`: no `Domain` unless the API and the
dashboard are on separate subdomains), so it was not sent, so the guard did exactly what it
should and bounced an unauthenticated request to `/login`.

The fix is a **relative `Location`**, which HTTP has always allowed and which leaves the browser
on the host it already chose:

```ts
return new Response(null, { status: 303, headers: { location: '/watches' } });
```

### Why the two older routes had the same bug and nobody knew

`/logout` and `/login/request` were written the same way in `magic-link-auth` and are now fixed
the same way. Neither was *failing*, and that is the whole lesson: their proofs assert on the
path they land on (`waitForURL(/\/login\?sent=1$/u)`), and the path survives a host swap
perfectly. Only a redirect whose destination needs the session to still be attached can tell the
difference - and `/watches/pause` is the first one this sprint has had. A test that matches on
`pathname` is blind to the origin by construction; if a later section adds a form post that has
to stay signed in, assert on the full URL, not the path.

### One smaller trap, for the pages still to come

`page.getByRole('alert')` finds Next's own dev-tools live region - an empty `role="alert"` the
dev server puts in the same `<body>` - so an assertion that the page shows no error has to be
scoped to the page: `page.locator('main').getByRole('alert')`. Unscoped, it counts the framework
and fails against a page that is perfectly fine.

## What `calendar-tasks-pages` can pick up unchanged

The fixture now seeds, not just authenticates. `startAuthStack(...).seedAccount({ email, watches })`
creates an account with rows under it and hands back exactly what it planted, so every assertion
reads off the seed rather than off a fixture's private knowledge:

```ts
watcher = await stack.seedAccount({
  email: 'watcher@example.test',
  watches: [{ url: LAPTOP, series: [149, 139, 129] }, { url: GPU }],
});
```

Two accounts are seeded in `watches-page.integration.test.ts` rather than one, and that is not
thoroughness for its own sake: a single-account fixture cannot express the property that matters
most, because a page that ignores the session entirely still passes it. The calendar and task
pages need the same shape - `seedAccount` takes only `watches` today and wants
`calendarItems` and `tasks` adding beside it, in the same "echo back what was planted" style.

The API side those pages need is already built and closed: `GET /calendar-items` and `GET /tasks`
landed in s1, and `packages/web/src/api-client.ts` already exposes `listCalendarItems` and
`listTasks`. No new routes are required - which is worth stating plainly, because the sprint
README's design notes anticipated task read routes as part of this sprint and they turned out to
already exist.

Two conventions from the watches page are worth copying rather than reinventing:

- **Logic in `.ts`, presentation in `.tsx`.** The coverage gate includes `packages/*/src/**/*.ts`
  and nothing else, so anything with a branch worth proving belongs in a `.ts` module with a unit
  test - `watches/view-model.ts` and `watches/sparkline-path.ts` - and the `.tsx` stays thin
  enough that reading it is the whole review.
- **What a browser cannot provoke, prove against the loader.** A real API that is working cannot
  be made to refuse on cue without breaking the run it is in the middle of, so the outage, the
  refusal, and the one-row-failed-while-the-rest-are-fine cases live in `view-model.test.ts`. The
  e2e claim says so explicitly rather than implying the browser proved them.

## The outage the sprint kept promising to show was a 500 nobody could see

The task's `done_when` asked for "a simulated API failure renders the visible error state", and
every page in this package had been built to do exactly that: `describeRefusal` turns an
unreachable API into `the API did not answer`, and each loader returns it as a page state rather
than throwing. The `calendar-tasks-pages` red proved the loaders were the only thing missing -
and, incidentally, that none of that machinery could ever run.

The red log said it in one line:

```
[browser] Uncaught ApiUnreachableError: The API at http://127.0.0.1:50131/auth/session did not answer.
AssertionError: /watches said: : expected '' to contain 'Your watches could not be loaded'
```

`/watches` rendered nothing at all. `readSession` swallows only `ApiError` with status 401 and
rethrows everything else, and both of its callers - `middleware.ts` and `app/layout.tsx` - ran
before any page did. During an outage the guard threw, the shell threw, and the dashboard
answered 500 to every guarded path. The banner three tasks had built was unreachable code.

The comment on `readSession` had reasoned this out and got it right for the world it was written
in: an API that is unreachable "has not said this visitor is signed out - it has said nothing",
and turning that into a redirect would send everybody to a sign-in page that cannot work either.
True, and it is still true. What changed underneath it is that the pages now have somewhere to
put the fact. A legible 500 was the best available answer when nothing could draw an outage; it
stopped being the best answer once every page could.

So `readSession` keeps its contract - it answers who is asking, or it throws - and a second
reading sits beside it:

```ts
export type SessionReading =
  | { readonly state: 'signed-in'; readonly session: Session }
  | { readonly state: 'signed-out' }
  | { readonly state: 'unverifiable' };
```

Three answers rather than two, because "no session" and "no answer" are different facts and the
two callers want different things done with them. The middleware redirects the first and lets
the second past. The layout draws the signed-out shell for both.

**Letting an unverifiable request past is the part worth defending, and the defence is
structural rather than a judgement call.** Nothing in `packages/web` reads the database - the
lint boundary in `api-boundary.test.ts` enforces that, and it is the reason that test exists.
Every fact on every page arrives through the API, and the API authenticates each of those reads
itself; this guard has never been the thing keeping one account's rows away from another, it is
the thing that sends a signed-out browser somewhere useful. A browser waved through during an
outage reaches pages that can only tell it the API did not answer, and is checked again on the
next request. The alternative - redirecting - bounces a signed-in reader to a sign-in page that
needs the same dead API to mail them a link, and tells them they are signed out when what
happened is that a server is down.

Only `ApiUnreachableError` becomes `unverifiable`. An API answering 500 is running, and
something in it is broken; that is a defect worth the legible 500 `readSession` already
produces, and folding it in here would wave requests past the guard for a reason nobody had
looked at. `session.test.ts` pins both halves of that line.

Two things follow for later sprints:

- **s5's run detail inherits this for free.** It lands behind the same middleware and inside the
  same layout, so it needs no outage handling of its own beyond what every page already does:
  return the refusal as a page state.
- **A page that ever renders account data without asking the API would break the argument
  above.** There is no such page today and the lint boundary makes one hard to write by
  accident, but if one is ever added - a cache, a cookie carrying more than an opaque session -
  the middleware's `unverifiable` branch is the thing to revisit first.

## The gate ran out of memory, and said so in four other suites' voices

Adding this task's e2e made a fourth suite that boots a Next dev server and a Chromium beside
it. The gate then failed like this:

```
FAIL |integration| packages/db/src/jobs.integration.test.ts
Error: Hook timed out in 120000ms.       (beforeAll: startTestPostgres)
FAIL |integration| packages/db/src/migrations.integration.test.ts
Error: Hook timed out in 120000ms.
FAIL |integration| packages/db/src/worker.integration.test.ts
Error: Hook timed out in 120000ms.
FAIL |unit| packages/web/src/api-boundary.test.ts
Error: Test timed out in 180000ms.       (× refuses a direct database import ... 213333ms)
```

Four suites, none of them touched by this task, in two different packages and both projects.
The `TypeError: Cannot read properties of undefined (reading 'stop')` that follows each hook
timeout is just `afterAll` tidying up a container that never started.

None of it is a logic failure. `node scripts/vitest.mjs run --project integration` passes all
251 integration tests on its own, solari's twelve included. What fails is the whole run
together, and the reason is the machine: 24 cores but 15.7 GB of memory, of which about 4 GB
were free. Vitest's forks pool defaults to one process per core, so two dozen test files are in
flight at once - several of them a Postgres container, several a Next dev server compiling
routes with a browser attached. The box starts swapping, and a container that would accept
connections in eight seconds takes more than two minutes.

`--maxWorkers=8` turned the same run green: 643 passed, 0 failed, 279s against the 233s the
failing run took to get less far. So it is now in `vitest.config.ts`:

```ts
const MAX_CONCURRENT_TEST_FILES = Math.min(8, availableParallelism());
```

Capped rather than fixed, so a four-core CI runner still gets four rather than eight fighting
over four.

**The lesson is about diagnosis, not about the number.** This is the second time this sprint
that adding a dev-server suite has made unrelated suites fail on time, and both times the first
reading was "those suites are flaky". They were not. An oversubscribed run does not report
memory pressure - it reports whatever was slowest to finish while it was starving, which is
whichever suites happened to be scheduled together, which is why the failure set looked
arbitrary and moved between runs. Before raising a timeout in a suite you did not touch, run
that project on its own: if it passes there and fails in the full gate, the timeout is not the
problem and raising it just moves the failure somewhere else.

The earlier entry in this file that raised `app.test.ts` and `server.test.ts` to 60-second suite
budgets was this same effect, treated as two local problems. Those budgets are harmless and can
stay, but with the pool capped they are no longer load-bearing.

## Isolating the dev servers put a moving target inside the tree two tests walk

With the pool capped the gate got further and failed somewhere new:

```
FAIL |unit| tests/solari-boundary.test.ts > the Solari vendor boundary > is one module, and it is the adapter
Error: ENOENT: no such file or directory,
  open 'packages/web/.next/instance-25f1b6c6-0f0b-44c8-9bac-691fc21ca213/dev/types/cache-life.d.ts'
```

Also mine, and a consequence of the dev-lock fix earlier in this sprint. `startWebDevServer`
gives every instance its own `.next/instance-<uuid>` and `stop()` removes it. The two vendor
boundary tests - `tests/solari-boundary.test.ts` and `tests/telegram-boundary.test.ts` - walk
`packages`, `fixtures`, `scripts` and `tests` looking for anything that imports a vendor SDK,
skipping `node_modules` and `dist`. Nothing skipped `.next`, so the scan walks into a directory
a dev server is in the middle of deleting: `readdirSync` lists a name, `rm -rf` removes it, and
`readFileSync` opens nothing.

Both now skip a shared `BUILD_OUTPUT` set of `node_modules`, `dist` and `.next`. That is the
right answer regardless of the race - `.next` holds generated `.d.ts` files, which are build
output being scanned as if they were workspace source - but the race is why it had to be fixed
rather than left.

Worth knowing for anything else that walks the repository: **`packages/web/.next` now contains
directories that appear and vanish while tests run.** A tree walk that does not exclude it is
not flaky in the usual sense; it is reading a directory whose lifetime is another suite's test
body. `eslint.config.js` and the `tsconfig` globs already exclude it, which is why lint and both
typechecks never saw this.
