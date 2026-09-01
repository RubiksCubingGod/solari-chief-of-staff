# On-demand review — repo-foundation

**This is an on-demand audit, not an assurance pass.** `nah review repo-foundation`
returned `on-demand` at frontier
`e6a3b677b0fdacd6e954070af660067498b38fc33450f11cb597beb4e8d805ff`; assurance and
lifecycle are unchanged, no task state was mutated, and these findings cannot
satisfy independent-review policy. The audit was performed in the implementing
session, so it is an author self-audit — the weakest form of review, and a
reason to run required assurance with a fresh reviewer after `/nah-harden`.

Harness `claude-code` 2.1.252 · model `claude-opus-5` · effort xhigh · session
`42f42e76-c061-427d-86f5-990e573f3993` · HEAD `84b5952`.

## Acceptance criteria traced to behavior

| Task | `done_when` | Owning evidence | Verdict |
|---|---|---|---|
| workspace-toolchain | fresh clone + documented install runs `pnpm check` green, one unit test per stub | `workspace-gate`, `package-stub-units`; 8 × `packages/*/src/index.test.ts` | met |
| postgres-dev-loop | integration test boots Postgres through the shared client, `pnpm check` includes it | `harness-red/green`, `dev-loop-gate`; `packages/db/src/postgres-harness.integration.test.ts` | met |
| schema-migrations | migrations apply to a fresh database, re-apply as a no-op, exported types compile | `migration-red/green`, `schema-gate`; `migrations.integration.test.ts` — *creates every section 5 table*, *re-applies as a no-op*, *round-trips a row* | met |
| pgboss-harness | cron fires, queued job round-trips, failing handler retries then fails observably, job enqueued before a worker restart executes after it | `harness-red/green`, `jobs-gate`; `jobs.integration.test.ts:82` stops the producing harness entirely, then a second harness drains the job | met |
| api-skeleton | app boots, `/health` 200, malformed JSON returns the typed 400 envelope | `app-red/green`, `api-gate`; `app.test.ts:50,57` | met |
| crud-routes | accepted and refused cases per route family, refused requests persisting nothing | `crud-red/green`, `crud-gate`; every refusal case asserts `select().from(...)` is empty (`routes.integration.test.ts:112,125,146,218`) | met |
| ci-workflows | workflow green on the sprint PR **and** a unit test proves the gate fails on a synthetic uncovered branch | `ci-red/green`, `ci-gate`; `tests/coverage-gate.test.ts` | **half met — see F2** |
| env-and-readme | integration boot path uses only documented steps, `pnpm check` passes following the README verbatim | `docs-red`, `migrate-red`, `docs-green`, `migrate-green`, `env-gate` | met |

## Findings

### F1 — Nothing in the workspace can be started (material)

`createApp` (`packages/api/src/app.ts:31`) and `runWorker`
(`packages/db/src/jobs.ts:140`) are never called outside tests. There is no
`main.ts`, no `app.listen`, and no `start` or `dev` script in any manifest.
`AppConfig.host` and `AppConfig.port` (`packages/api/src/config.ts:9,11`) are
parsed, validated, documented in `.env.example`, and read by no code at all.
The `job-scheduling-harness` spec states the harness is "started by the worker
process entry point"; that entry point does not exist.

No task's `done_when` asked for one, so this is a spec-to-task coverage gap
rather than a task that closed dishonestly — but the release outcome
("Fastify API skeleton", a harness the later engines register handlers through)
is not reachable by a person who clones this and wants to run it.

*Acceptance test:* an entry point that binds `config.host:config.port` and
answers `/health`, asserted against an ephemeral port; a worker entry that calls
`runWorker` and shuts down cleanly on SIGTERM; `pnpm start` / `pnpm dev` in the
root manifest, held by `tests/docs.test.ts` like every other documented script.

### F2 — `ci-workflows` is `done` with half its acceptance criterion unmet (material, disclosed)

The task's `done_when` has two clauses. The gate-failure clause is proven
(`tests/coverage-gate.test.ts` runs Vitest over a fixture with one unexercised
branch and requires the run to fail). The first clause — "workflow is green on
the sprint PR" — has never happened: there is no `origin` remote and no pull
request. This is recorded honestly in `DEFERRED.md`, but a reader of
`tasks.jsonl` alone sees `status: done` and would reasonably believe CI is green.

*Acceptance test:* the repository is pushed and the first pull request shows a
green `check` run.

### F3 — The default test path has never executed (material)

Every integration proof in this sprint ran through the `TEST_DATABASE_URL`
escape hatch against a local cluster, because this machine has no container
runtime. `packages/db/src/testing/testcontainers.ts` is excluded from coverage
and has never run — and it is the path a fresh clone takes and the path CI takes.

Partially retired by inspection during this audit: `startContainer` is
type-correct against the installed `@testcontainers/postgresql@12.1.0` —
`constructor(image: string)`, `.start()`, and `getConnectionUri()` all match
`build/postgresql-container.d.ts`, and the file compiles in the build step. The
residual risk is environmental (daemon availability, image pull, five containers
per run), not API shape.

*Acceptance test:* one `pnpm test:integration` with Docker present and
`TEST_DATABASE_URL` unset, or the first CI run.

## Risks carried forward (scoped out, not defects)

- **`x-user-id` is unauthenticated identity.** Any client may name any user.
  Auth is deferred to `dashboard-read` (handoff decision 15) and
  `packages/api/src/caller.ts` is the single seam it lands in. This must not
  reach a deployed host first.
- **Unpaginated reads.** `GET /watches`, `GET /calendar-items`, and `GET /tasks`
  return the caller's full table. Correct at foundation scale; `dashboard-read`
  should add limits.
- **No enqueue deduplication** (decision 14). pg-boss 12 makes it a queue
  policy; `policy: 'exclusive'` at `createQueue` is the recorded fix.
- **`testcontainers.ts` sits outside the coverage denominator.** Justified on a
  workstation without Docker; on CI it does run and could be counted.

## What is genuinely solid

- Refusal cases assert that nothing was persisted, not merely that the status
  was 4xx.
- Migration idempotence is proven against a real database, not asserted.
- Job durability is proven across a full harness stop/start, not merely across
  a worker that had not started yet.
- No secret leaks: all 209 tracked files were scanned for every value in `.env`;
  no match. `.env` and `coverage/` are both gitignored.
- `nah diagnostics repo-foundation` is clean — 0 blocking findings.

## Verification evidence

`pnpm check` at HEAD: lint, typecheck, typecheck:tests, test, build all passed.
23 test files, 124 tests. Coverage: statements 99.61% (258/259), branches 95.87%
(93/97), functions 100% (75/75), lines 99.58% (240/241), against thresholds of 90
global and 100 on `packages/core/src/**/*.ts`. All 8 tasks `done` with current
receipts; 25 declared command proofs across the sprint.

## Draft delivery packet

Not published: the repository has no remote, and `nah diagnostics` reports the
project-management provider unconfigured with writes disabled. Retained here as
the handoff artifact.

**Title:** `repo-foundation: workspace, section 5 schema, job harness, CRUD API, and the CI gate`

**Body:**

> ## What this changes
>
> Closes the `repo-foundation` sprint — all 8 tasks, against specs
> `workspace-ci-gate`, `watch-crud-path`, and `job-scheduling-harness`.
>
> A pnpm workspace with the ARCHITECTURE section 11 package layout; the full
> section 5 Drizzle schema with a generated migration set; a typed pg-boss job
> harness with retry defaults and observable failure; a Fastify server with a
> typed error envelope and engine-free CRUD over watches, calendar items, and
> task reads; and `pnpm check` wired to GitHub Actions with the section 9.3
> coverage gate.
>
> ## Proof
>
> 25 command proofs across 8 tasks — a RED before every GREEN except the
> initial scaffold (`workspace-toolchain`, which had no prior state to fail
> against), and a full-gate receipt per task. `pnpm check`: 23 files, 124 tests, 99.61% statements, 100%
> functions, `packages/core` at 100%.
>
> Re-run by hand: `pnpm test:integration` **with Docker running and
> `TEST_DATABASE_URL` unset** — every proof in this branch took the
> `TEST_DATABASE_URL` path, so the Testcontainers default is unexercised.
>
> ## Manual checks
>
> - [ ] Ran against a real site or a real Solari session, not only fixtures — *n/a, no engine yet*
> - [ ] Telegram conversation reads the way a person would expect — *n/a*
> - [ ] Dashboard renders correctly at a phone width — *n/a*
> - [ ] Recording or replay artifacts play back — *n/a*
> - [ ] Nothing new is written to the logs that should not be there
> - [ ] `.env.example` still documents every variable this needs

## Rollout and recovery

Nothing is deployed and nothing can be: see F1. `pnpm migrate` is forward-only —
the generated set has no down migrations, so recovery from a bad migration on a
real database is restore-from-backup. Worth deciding before the first
non-throwaway database exists.

## Recommended follow-up, in order

1. Push the repository and open the first pull request — retires F2 and F3 in
   one run, and is the only thing standing between this sprint and a truthful
   "CI is green".
2. Decide whether F1 belongs to this sprint (a repair task, which re-enters
   implementation and hardening) or to `browser-substrate`. It is a genuine gap
   against the `job-scheduling-harness` spec text either way.
3. Run `/nah-harden repo-foundation`, then required assurance with a fresh
   reviewer. This audit does not substitute for it.
