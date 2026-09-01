# Handoff

## Commander's intent

Land the substrate every later sprint builds on — workspace, schema, jobs, API,
CI — with each task's evidence attributable rather than asserted.

## Environment as found

- **No container runtime on this machine.** Docker Desktop is not installed,
  `podman` is absent, and the WSL Ubuntu image has neither. Testcontainers
  cannot start here.
- **PostgreSQL 17.10 is installed** at `C:\Program Files\PostgreSQL\17`. The
  service on 5432 is password-protected and belongs to the user, so it is left
  alone; the binaries are used to run a throwaway trust-auth cluster on
  `127.0.0.1:55432` for local integration proofs.
- Node 24.14, pnpm 11.18, `gh` authenticated as RubiksCubingGod
  (`repo`, `workflow`). No git remote configured yet.

## Decisions taken (assumptions, all reversible)

1. **Test database resolution.** The integration harness resolves in order:
   `TEST_DATABASE_URL` if set, otherwise Testcontainers. Testcontainers stays
   the documented default and is what CI runs, per ARCHITECTURE §9.2. Local
   proofs on this machine go through `TEST_DATABASE_URL`.
   *Deviation to carry into hardening: the Testcontainers branch itself is
   proven on CI, not on this workstation.*
2. **Proof declarations added to `tasks.jsonl`.** Planning left every task with
   `missing-proof` and `missing-resolution-kind`, so the first close recorded
   `verification: not-declared`. Declaring command proofs turns each close into
   an attributed receipt. This sharpens proof only — outcome, architecture,
   seams, and the dependency graph are untouched, so it is a planning delta,
   not a replan.
3. **TypeScript 6.0.3, not 7.0.2.** `typescript-eslint@8.69` declares
   `typescript >=4.8.4 <6.1.0`; TypeScript 7 would silently drop type-aware
   linting.
4. **Package scope `@chief-of-staff/*`,** matching the repository rather than
   the "Majordomo" placeholder name ARCHITECTURE flags as undecided (§13.2).
5. **Shell-free entry points.** `scripts/check.mjs` and `scripts/vitest.mjs`
   exist because NAH spawns proofs without a shell, which cannot run `pnpm` on
   Windows. They are also what `pnpm check` and `pnpm test` now call, so the
   gate is one implementation rather than two.
6. **`web` is a plain TypeScript stub.** Next.js arrives with `dashboard-read`;
   pulling it in now would only slow the gate.
7. **The schema mirrors ARCHITECTURE §5 column-for-column,** with three typed
   refinements rather than additions: columns §5 marks `?` are nullable, and so
   are `tasks.result` and `tasks.finished_at`, because a queued row genuinely
   has neither; the `tier_used` column on `observations` uses a separate
   `fetch_tier` enum (`http|browser|stealth`) because `auto` is a watch policy,
   not a tier that was actually used; and no `created_at` was invented for
   tables where §5 does not list one.
8. **Every closed-vocabulary column is a `pgEnum` built from a
   `@chief-of-staff/core` constant,** so the database and the domain cannot
   drift without a compile error. The vocabulary §5 implies but §3 never named
   is new in `core`: `WATCH_STATUSES`, `FETCH_TIERS`, `TIER_POLICIES`,
   `SITE_CONNECTION_STATUSES`, `CALENDAR_ITEM_STATUSES`, `MESSAGE_DIRECTIONS`,
   `MESSAGE_CHANNELS`.
9. **`.gitattributes` pins `eol=lf`.** `core.autocrlf` is `true` on this
   machine and there was no `.gitattributes`, so a fresh Windows clone would
   have checked out CRLF. Two things here hash file bytes: Drizzle stores a
   hash of each migration SQL file, so a CRLF clone would re-apply migrations a
   LF clone had already applied, and NAH's frontmatter parser rejects CRLF
   managed documents. This also closes the fresh-clone hazard flagged for
   `env-and-readme`.
10. **Workspace imports resolve to source in `tsconfig.test.json`** via
    `paths`, matching the aliases `vitest.config.ts` already uses. Without it,
    linting a cross-package test needed `packages/*/dist` to exist first, so
    `check` failed on a clean tree purely on step order. Package builds still
    resolve through project references and `dist`, which `check: build` proves.
11. **`allowBuilds` in `pnpm-workspace.yaml` is resolved rather than left as
    pnpm's placeholders,** which made `pnpm install` exit 1. `esbuild` is
    allowed to run its postinstall because `drizzle-kit` cannot read a
    TypeScript config without it; `cpu-features`, `protobufjs` and `ssh2` are
    denied, since they are optional native speedups with working pure-JS
    fallbacks.

12. **The pg-boss harness lives in `packages/db`, not a new `packages/jobs`.**
    ARCHITECTURE §11 fixes the package set, so adding one would be an
    architecture change rather than an implementation choice. pg-boss is
    Postgres infrastructure: it shares the connection string with the schema and
    keeps its own `pgboss` schema in the same database.
13. **Retry defaults are a queue property, not a client property.** pg-boss 12
    accepts `retryLimit`/`retryDelay` on `createQueue`, not on the constructor,
    so `ensureQueue` carries the policy and every job inherits it however it was
    enqueued. Two neighbouring facts cost a cycle each and are worth knowing:
    pg-boss 12 is ESM with a *named* export (`import { PgBoss } from 'pg-boss'`),
    and it asserts `cronWorkerIntervalSeconds` and `cronMonitorIntervalSeconds`
    into 1-45 seconds, which is why both are pinned to 10 rather than a minute.
14. **`enqueue` deliberately takes no deduplication key.** In pg-boss 12
    deduplication is a queue *policy* (`exclusive`, `stately`, `short`) chosen
    when the queue is created; a `singletonKey` sent to a standard queue is
    silently ignored. An option that quietly does nothing is worse than no
    option, and the accepted spec does not ask for one, so the queue that needs
    it - per-watch checks, where a burst of triggers must not pile up - declares
    `policy: 'exclusive'` in the sprint that owns that queue.

15. **The caller is named by an `x-user-id` header, not by a field in any
    request body.** The sprint defers auth to `dashboard-read`, but the routes
    still need an owner for every row. Keeping the identity out of the payload
    means the schemas do not change when real authentication arrives - only the
    `resolveCaller` pre-handler does. An id that is not a uuid is refused by the
    same validation pass as a bad body; a uuid that names no user is a 404, so a
    write is refused before it can reach a foreign key.
16. **Refusals are expressed as Ajv formats, not as handler checks.** `uuid`,
    `http-url`, `iso-date` and `cron-expression` are registered as custom
    formats, so a bad url and a bad schedule come back in the same
    `validation_failed` envelope with a JSON Pointer each, and no handler ever
    runs against a value it would have to re-check. Cron is validated with
    `cron-parser`, the same parser pg-boss schedules on, pinned to the same
    version - and blank is refused explicitly, because `CronExpressionParser`
    reads an empty expression as `* * * * *`.
17. **A watch list is ordered by id and a calendar list by name.** ARCHITECTURE
    §5 gives `watches` no creation timestamp, so there is no "newest first" to
    return; an arbitrary but stable order beats whatever the planner happened to
    produce. `tasks` does have `created_at`, so it is ordered newest first.
18. **`@chief-of-staff/db/testing` is a test-only specifier.** The Postgres test
    helper is excluded from the db package's build and from its `exports`, so it
    is reachable only through the Vitest alias and the matching
    `tsconfig.test.json` path. Both list it before the bare package alias, which
    would otherwise swallow the subpath.

19. **The coverage gate is proven by a nested Vitest run, not by an
    assertion about numbers.** `tests/coverage-gate.test.ts` runs Vitest over
    `tests/fixtures/coverage-gate/`, whose own test passes while leaving one
    branch unexercised, under thresholds imported from the real config rather
    than restated. Lowering the real gate makes the proof of the gate stop
    failing, which is the regression worth catching. The nested run needs its
    own `reportsDirectory`, or the two runs clear each other's temporary
    coverage files.
20. **CI takes its Node and pnpm versions from `package.json`.**
    `pnpm/action-setup` reads `packageManager` when the workflow pins no
    version, and the workflow test asserts no version is pinned there: two
    places to bump is one place to forget. Integration tests take the
    Testcontainers path on the runner, which has a Docker daemon, so no
    `TEST_DATABASE_URL` is set in CI.
21. **The documented setup is proven by running it, not by reading it.**
    `tests/docs.test.ts` can only check that the README and `.env.example`
    describe this repository - that every script and path they name exists,
    that the setup steps are listed in the order they have to happen, and that
    the example file alone configures the server against the database
    `docker compose up` starts. It cannot tell whether step three actually
    works. `tests/migrate-step.integration.test.ts` runs `scripts/migrate.mjs`
    as a real subprocess against a real empty database and asserts the full
    section 5 table set appears, that a second run changes nothing, and that an
    unset `DATABASE_URL` fails with a message naming the variable. This was
    chosen over recording the same facts as a manual attestation: a manual
    proof would be attributed to a human who did not run it, and it would stop
    being true the moment the script drifted.
22. **The integration project also includes `tests/**`.** Repository-level
    integration tests had nowhere to live: the unit project takes
    `tests/**/*.test.ts` but excludes `*.integration.test.ts`, and the
    integration project only looked inside `packages/*/src`. A file at
    `tests/x.integration.test.ts` would have been collected by neither and
    would have passed the gate by never running. The integration include now
    mirrors the unit one.

## Open follow-ups

- `unresolved-design-language` fires on `workspace-toolchain` and
  `ci-workflows` because the approved plan text contains the word "stub". It is
  a false positive against human-approved wording and is left alone.
- `drizzle-kit generate` reads `packages/core/dist`, so the migration set can
  only be regenerated after `tsc --build`. `ci-workflows` should order the
  steps that way if it ever regenerates rather than verifies.
- The `check` workflow has never run: there is no GitHub remote and no pull
  request. See `DEFERRED.md` for what that leaves unproven.
- `nah` reports a continuation warning that `project.yaml` sprint estimates
  disagree with `.nah/active/real-site-hardening/sprint.yaml` and
  `fixture-harness/sprint.yaml`. Both belong to a concurrent planning session
  and are left untouched.

<!-- nah-checkpoint:1aca1393fbefb1a5 -->
## 2026-09-01T05:10:00.483Z · claude-code · 42f42e76-c061-427d-86f5-990e573f3993

- Stage: implementation
- Ready: pgboss-harness, api-skeleton, ci-workflows, env-and-readme
- In progress: schema-migrations
- Root blockers: none
- Done: 2/8
- Receipts: verification-completed-event515b446bc2ad47d7b3ef161816a06141, verification-completed-eventac7fdd3081104875a118023c521f1268, verification-completed-event2f6e13365a304a65811d035007958a82, verification-completed-event102c42b8b7994768a2b699f5ab18ea5f, verification-completed-event09f778337ce84fac968aeb2508bbaf35
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s1`

<!-- nah-checkpoint:2ee6897bbe6da93c -->
## 2026-09-01T05:37:40.518Z · claude-code · 42f42e76-c061-427d-86f5-990e573f3993

- Stage: implementation
- Ready: crud-routes, ci-workflows, env-and-readme
- In progress: pgboss-harness
- Root blockers: none
- Done: 4/8
- Receipts: verification-completed-event515b446bc2ad47d7b3ef161816a06141, verification-completed-eventac7fdd3081104875a118023c521f1268, verification-completed-event2f6e13365a304a65811d035007958a82, verification-completed-event102c42b8b7994768a2b699f5ab18ea5f, verification-completed-event09f778337ce84fac968aeb2508bbaf35, verification-completed-event2ee30b72f1fc4875951c51eb061890d6, verification-completed-event904936ca634c4ddfa7bc8a3bb90662cd, verification-completed-evente24d6cda6e7d480d83321a3c291d8502, verification-completed-event0a9495b75a564f2eb1fa7ddfee0ebb13, verification-completed-eventba6d21010b5442da8f28324710033cce, verification-completed-event26014c25cfbf40658199e6ae2ff7c2a7, verification-completed-eventcb454d1750904f258fc0f7ac0d16b6ed
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s1`

<!-- nah-checkpoint:6d119db8322f73dd -->
## 2026-09-01T06:08:09.222Z · claude-code · 42f42e76-c061-427d-86f5-990e573f3993

- Stage: implementation
- Ready: none
- In progress: env-and-readme
- Root blockers: none
- Done: 7/8
- Receipts: verification-completed-event515b446bc2ad47d7b3ef161816a06141, verification-completed-eventac7fdd3081104875a118023c521f1268, verification-completed-event2f6e13365a304a65811d035007958a82, verification-completed-event102c42b8b7994768a2b699f5ab18ea5f, verification-completed-event09f778337ce84fac968aeb2508bbaf35, verification-completed-event2ee30b72f1fc4875951c51eb061890d6, verification-completed-event904936ca634c4ddfa7bc8a3bb90662cd, verification-completed-evente24d6cda6e7d480d83321a3c291d8502, verification-completed-event0a9495b75a564f2eb1fa7ddfee0ebb13, verification-completed-eventba6d21010b5442da8f28324710033cce, verification-completed-event26014c25cfbf40658199e6ae2ff7c2a7, verification-completed-eventcb454d1750904f258fc0f7ac0d16b6ed, verification-completed-eventcdb9ceab1ac04b63b5d6ca93a13cce33, verification-completed-eventb4f9e9120d574cf89c05d0f5494a49a6, verification-completed-event62aee50846364146b3c5a774f5a81229, verification-completed-event8e08ca0d1bb04d4d9918a736a1d69445, verification-completed-eventd247b015db5d47839ffef54cfc2f1f87, verification-completed-eventd9166c7f789f4345a050f2de37e42d51, verification-completed-event376ec887c43b4e47aa64de99b0783f4f, verification-completed-eventc7d21f62fa32482cb3fa6e9496e2e947, verification-completed-event7625dffc116d4635a509ad1c285c610b
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s1`
