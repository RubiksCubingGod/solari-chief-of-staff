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
