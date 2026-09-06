# Handoff

## Execution handoff

### Layout decision (deviation from ARCHITECTURE §11, recorded as an assumption)

§11 places the watch engine in `packages/core`, but the engine needs the
database and `packages/db` already depends on `core` for its enum
vocabulary, so an engine in core would be a dependency cycle. The split:

- `packages/core/src/watch/` holds the pure domain and the ports (values,
  extractor spec, condition, comparator, notifier port, store port) at 100%
  coverage. Nothing in it touches the network or the database.
- `packages/watch` (`@chief-of-staff/watch`, created by tier0-http-fetcher)
  holds the tier-0 HTTP fetcher, the browser ladder behind the solari seam,
  the Drizzle `WatchStore`, the scheduler registration and the check job
  handler. It depends on core, db, drizzle-orm, solari and agent.
- The extractor-creation LLM loop lives in `packages/agent` next to the chat
  agent, because that is where the scripted-LLM transport and the live-LLM
  gate already are.

A new package needs: its package.json and tsconfig, a root `tsconfig.json`
reference, an entry in `WORKSPACE_PACKAGES` in `vitest.config.ts`, a row in
the README layout table, and (when the job handler lands) registration in
`scripts/worker.mjs`.

### Schema (watch-domain-model)

Migration `0005_watch_engine_state` adds to `watches`: `health`
(enum `watch_health`: healthy | needs_extractor | blocked | degraded, default
healthy), `tier_floor` (`fetch_tier`, default http) and `last_error`
(text). `health` is the engine's finding, distinct from `status` (the
person's wish). `tier_floor` is what the ladder learned: a watch served by a
browser after HTTP was blocked starts at the browser next time.

### Semantics fixed in the domain model

- Price amounts are in the page's own major units (14.99, not 1499). The chat
  tool description still says "in cents" and the CRUD schema still accepts
  `below_cents`; watch-config-surface reconciles both to `drops_below` /
  `rises_above`.
- A price condition is `{drops_below, rises_above}` with at least one set;
  triggers are strict crossings and never re-fire while the value stays on the
  far side. A change condition is `{region}`; the first reading is the
  baseline and never triggers.
- Trigger dedup key = sha256 of canonical JSON of (watch id, condition, value
  identity). Emission is at-least-once; consumers dedup on the key. The
  recording notifier keeps every call and the first event per key.
- A failed check never moves `last_value`; it increments
  `consecutive_failures` and sets `last_error`. A success resets both.
- `parseExtractorSpec({})` is undefined: an empty extractor is "needs one",
  which is how a freshly created watch reads.

### Proof scoping

The `domain-types` gate builds `packages/core` and `packages/db` rather
than running the whole-workspace `tsc -p tsconfig.test.json`: the sibling
action-playbooks sprint keeps an untracked RED test
(`packages/db/src/task-engine.integration.test.ts`) in the shared tree that
fails typecheck by design until its own implementation lands. Every other
file in the workspace typechecks (verified by running the full config and
filtering that one file). `scripts/check.mjs` stays red for the same reason
until that sibling task finishes.

### tier0-http-fetcher

- `packages/watch` exists (core, db, drizzle-orm; fixtures as a dev
  dependency), registered in the root tsconfig, the vitest alias list and the
  README. `scripts/worker.mjs` registration waits for the check job handler.
- `fetchHttp` sends one GET with browser-like default headers, follows
  redirects, and runs the whole request under one `AbortSignal.timeout`. A
  non-2xx status is content (a 403 is a block signal, a 404 a vanished page);
  only a timeout or a network failure is a fetch error, and the two are
  distinct kinds so the ladder never escalates to a browser over a timeout.
- An observation always names a tier. `observations.tier_used` stays NOT
  NULL; a check that fails before it fetches records the tier it was about to
  fetch at (the watch's floor). The domain port was changed to match rather
  than the column, because a migration generated in the shared tree would have
  carried the sibling sprint's uncommitted schema edits (see below).
- The Drizzle store maps rows without interpreting them, except that a stored
  observation value that no longer parses as a `WatchValue` reads as null.

### browser-tier-fetcher

- The judgment lives in core (`packages/core/src/watch/ladder.ts`), the
  tiers in the engine. `classifyPage(html, status)` gives one of
  ok / blocked{signal} / gone: 404 and 410 are gone whatever the body says;
  401, 403, 429 and 503 are `block-status`; challenge phrases in the
  visible body text or challenge markup anywhere in the document are
  `challenge-markers`; fewer than 40 visible characters is `empty-shell`.
  The body-text rule is deliberate: the fixture's blocked shell keeps its
  "Checking your browser" title after the script has materialised the real
  content, and a title is not a page. Noscript blocks are excluded from
  visible text for the mirror-image reason.
- `tiersToTry(policy, floor)`: auto climbs from the learned floor; a pinned
  policy is exactly one tier, whatever the floor says. `runLadder` escalates
  only on a blocked verdict, monotonically; a fetch error (timeout, network,
  provider) ends the check at its tier, and gone never escalates. Every
  attempt is kept on the outcome. `tierFloorAfter` only ever rises.
- `fetchBrowser` (packages/watch) serves tiers 1 and 2 through
  `withBrowser`: tier 2 asks the provider for `{ stealth: true }` and sends
  the configured escalation headers; `FetchMeta.stealth` is the provider's
  echo, never the request. The local provider echoes false and the tier-2
  proof asserts exactly that. Playwright's TimeoutError is a `timeout`
  error, `BrowserProviderError` a `provider` error, anything else
  `network` (first line only, without the call log).
- `createFetchLadder({ provider, http?, browserTimeoutMs?, escalationHeaders? })`
  binds the three tiers; `fetchWatchPage(ladder, store, watch)` runs the
  ladder from the watch's floor and persists the floor when it rose. The
  fixture's `x-fixture-escalation` token is test configuration for that
  option; a real deployment passes no escalation headers.
- The blocked-verdict notifier event is left to check-pipeline-integration,
  which is where the notifier and the watch's user are in hand; this task
  ends at the verdict.

### llm-extractor-creation

- Replay lives in core (`packages/core/src/watch/replay.ts`), creation in
  the agent package (`packages/agent/src/extractor.ts`). `replayExtractor`
  runs a stored spec against a page with cheerio and no model: a price reads
  the first match's text (or attribute), a digest joins every match. Its
  four failures are distinct because healing and `last_error` need them
  distinct: `invalid-selector` (the parser refused it), `no-match`,
  `empty` (matched, but no text / no such attribute) and `unparseable`
  (text without a price, which is what a sold-out row looks like).
- `pageSnapshot` is what the model sees: scripts, styles, noscript,
  templates, inline svg, comments and `on*=` handlers removed, whitespace
  collapsed, cut at 60 000 characters with a visible `…[truncated]` mark.
  Everything left is surface a CSS selector can address.
- Creation is one forced `propose_extractor` tool call
  (`tool_choice: {type:'tool'}`) on `claude-opus-5`, not a runner: there is
  one question and one answer shape. The proposal becomes
  `{version:1, strategy:'css', selector, attribute, parse}` with `parse`
  from `parserForKind`, goes through `parseExtractorSpec`, and is replayed
  against the very page it was made from before it is returned. Failures:
  `unsupported-kind` (no call is spent), `unavailable` (API error, status
  in the reason), `no-proposal` (the model's words are kept),
  `invalid-spec`, `replay-failed` (prefixed with the replay failure).
- `provisionExtractor(creator, store, watch, html)` stores a validated spec
  with `health: 'healthy'` and clears `last_error`; otherwise it sets
  `needs_extractor` with the reason and stores nothing. A change watch's
  `condition.region` is passed as the hint; a price watch has none.
- Assumption: the system prompt tells the model to prefer stable hooks
  (data-*, ids, aria-label, itemprop) over class names. That preference is
  what the @live-llm proof checks by replaying the created spec against the
  fixture's redesign; it is the property the self-healing budget is sized
  around, and the scripted proofs cannot fail on it.
- The live proof (`extractor-live`) needs `ANTHROPIC_LIVE_LLM=1` and an
  `ANTHROPIC_API_KEY`; without both it is recorded as skipped with the
  reason in the suite name. It has not been run with a real key in this
  sprint: a key on the machine is not consent to spend it, so the opt-in is
  the operator's.

### watch-config-surface

- The door is in core (`packages/core/src/watch/config.ts`) and the API
  calls it after JSON Schema has settled the shape: `watchConfigViolations`
  returns every semantic refusal at once as `{path, message}` JSON Pointers
  (`/condition/drops_below`, `/schedule`, `/extractor/parse`), and the route
  throws them as `400 validation_failed` with `details`, the same envelope
  the schema layer uses. `HttpError` gained an optional `details` for that;
  the error handler passes it through. The rule the door keeps: what it
  accepts, `parseCondition`, `parseExtractorSpec` and `tiersToTry` can read
  back, and the integration test reads the row back through the engine's
  own Drizzle store to prove it.
- Semantics fixed here: price thresholds are numbers of zero or more in the
  page's own units, `drops_below` above zero, and below `rises_above` when
  both are given; a change region is null or non-blank text of at most 200
  characters; an extractor is `{}` (the model writes one) or a full spec
  whose `parse` matches the kind; the url is http(s) with no credentials
  (they would land in `last_error` and the logs); the schedule parses,
  runs no more often than every five minutes (ARCHITECTURE §10, shortest
  gap between consecutive runs, evaluated in UTC over 500 runs) and comes
  due within a year. `checkSchedule` returns the next run and the shortest
  gap so the scheduler can reuse it.
- Assumption: a `slot` watch is refused at the door (`/kind`) until
  slot-sniping (s8) gives the engine a parser for one. The kind stays in
  the vocabulary and the column enum; only creation is refused, with the
  reason. A slot watch created before this would sit in `needs_extractor`
  forever, which is the silent failure the door exists to prevent.
- Assumption: tier reset is `POST /watches/:id/tier-reset`, an action with
  no body, not a field on PATCH: there is one value to set the floor to,
  and `health` goes back to `healthy` with it (the schema comment on
  `health` already said "only a check or a reset writes it"). `lastError`
  and `consecutiveFailures` are left alone - they are about the last check,
  which still happened.
- `docs/API.md` is new: the envelope, the watch row, the four watch routes
  and the observation series, linked from the README. The chat tool's
  `create_watch` description no longer says "in cents": the engine reads
  thresholds in the page's units, and the tool now says so.

### scheduler-wiring

- The `watches` table is the source of truth and the scheduler never hears
  from the API (assumption: the API process stays free of pg-boss). The
  worker registration (`registerWatchScheduler` in `packages/watch`) reads
  the rows and makes the harness match - one schedule per active watch on
  the `watch-check` queue, keyed by the watch id, carrying `{watchId}` and
  the row's cron - once at startup and once a minute after that on the
  `watch-check.reconcile` queue. A row already on the queue with its cron is
  left alone; a paused or deleted row's schedule is removed; a resumed or
  edited row is re-registered. Against the five-minute floor, a minute is
  the latency of a pause or resume reaching the queue, and it is the same
  path whether the row changed through the API, chat, or by hand.
- The tick handler reads the row again before it does anything
  (`runWatchCheckJob`): a watch that is gone or not `active` is skipped
  without a check, so a tick the cron had already queued when the pause
  landed never runs. The handler hands the row to a `WatchCheck` port; the
  pipeline that fetches, extracts and compares plugs in there
  (check-pipeline-integration), which is also when `scripts/worker.mjs`
  gets its first registration.
- The scheduler honours `status` only, not `health`: a blocked or degraded
  watch keeps ticking, and what to do with such a tick is the pipeline's
  decision (assumption; the alternative, silently stopping checks on a
  verdict the person has not seen, is the failure the health column exists
  to make visible).
- The harness (`packages/db/src/jobs.ts`) gained keyed schedules:
  `schedule(queue, cron, payload, {key})`, `unschedule(queue, key)` and
  `schedules(queue)`, on pg-boss 12's `(name, key)` schedule identity, with
  the cron pinned to UTC (the clock `checkSchedule` judged it by). The
  unkeyed call keeps working, so the task engine's reconcile cron is
  untouched. The two new types are reachable through `JobHarness`; their
  re-export from the db index waits on the sibling sprint committing its
  own uncommitted hunk in that file (`recordBrowserSession`), which cannot
  be split from mine.
- An active row whose schedule the harness will not take (a row that
  reached the table without passing the door) is written on the row as
  `last_error`, its old schedule removed, and reported as `refused`; it is
  never silently skipped.

### self-healing

- **Where it lives.** `packages/agent/src/healing.ts`, not `packages/watch`. The
  step needs the extractor creator, and `packages/watch` does not depend on
  `@chief-of-staff/agent` yet; taking that dependency means a package.json,
  tsconfig reference and lockfile change, and the lockfile is dirty with the
  action-playbooks sprint's uncommitted work. check-pipeline-integration takes
  the dependency when it composes the check. The agent package needed nothing new.
- **Shape.** `extractWatchValue(ports, watch, html)` with ports
  `{ store: Pick<WatchStore,'updateWatch'>, creator, notifier, now? }` returns
  `{ ok: true, route: 'replayed'|'created'|'healed', value }` or
  `{ ok: false, health: 'needs_extractor'|'degraded', reason }`. It patches the
  row itself (spec, health, lastError); the caller records the observation and
  compares. `regionHint` is exported from extractor.ts so re-creation carries a
  change watch's region exactly as first creation does.
- **Budget.** Replay costs nothing. A replay failure on a watch that is not
  degraded buys one creation call against the page as it is now: a proposal
  that reads the page is stored (route `healed`, health healthy); one that does
  not persists `{ health: 'degraded', lastError: reason }` and sends one
  `degraded` event. A degraded watch's later replay failures are reported
  without a model call. A watch with no spec and health `needs_extractor` is
  parked the same way, with the reason it was parked in the message.
  Assumption recorded: `needs_extractor` and `degraded` mean "a person must
  act", not "retry next tick"; the tier-reset endpoint is the reset. The
  incident ends when a value is read again (page came back, or reset), and the
  next breakage buys the next call.
- **Recovery.** Any successful replay on a row that is not healthy patches
  `{ health: 'healthy', lastError: null }`, `blocked` included: a page in hand
  proves the block lifted.
- **Dedup and ordering.** `degradedDedupKey(watchId, reason)` is sha256 over
  `[watchId, 'degraded', reason]`: a job retried after a crash reaches the same
  reason and sends the same key; a later incident after a reset reads
  differently. The state write comes before `notifier.notify`, so a failed
  delivery fails the job with the degraded row already persisted and the retry
  does not spend again.
- **Proof scoping.** Unit tests script the creator port over an in-memory
  store (`packages/agent/src/testing/memory-store.ts`, also the seed for later
  tests). Integration runs the real `createExtractorCreator` over the scripted
  Anthropic client against the fakestore redesign, so the snapshot, proposal
  and replay loop is exercised and only the judgement is written down. The
  Postgres store binding is proved in `packages/watch`; the composed check
  proves the two together. healing.ts at 100% coverage.

### check-pipeline-integration

- **Shape.** `packages/watch/src/check.ts`. `checkWatch(ports, watch)` returns
  a `CheckReport`: `observed { observation, comparison, route }` or
  `failed { observation, reason, transient }`. `createWatchCheck(ports)` is
  the scheduler's `WatchCheck`; it throws only when the failure is transient
  (the site did not answer), so the harness retries the tick under its
  policy, and completes on everything else with the row saying why.
  `registerWatchEngine({ db, ladder, creator, notifier, now? })` is the whole
  engine as one `JobRegistration`: the scheduler with the real check and the
  Drizzle store behind it. `createLogNotifier` (`packages/watch/src/notifier.ts`)
  writes one JSON line per event and is the notifier a deployment runs until
  a delivery channel lands. `createAnthropicClient(apiKey)` lives in the agent
  package because `scripts/worker.mjs` cannot resolve the SDK on its own
  (`hoist=false`), and the agent package is the one that owns it.
- **Order of operations, recorded as assumptions.** The condition is parsed
  before anything is fetched: an unreadable condition is an error observation
  at the watch's floor with no page load. Triggered and blocked events are
  sent before the observation is written, so a failed delivery fails the
  tick with the row untouched and the retry sees the same crossing; the port
  is at-least-once and the dedup key makes the second delivery one trigger.
  Degraded keeps self-healing's persist-then-notify, since there the state
  write is what stops the next model call. A blocked event is sent on the
  transition only (`health !== 'blocked'`), keyed by
  `blockedDedupKey(watchId, tiersTried, signal)`; a row already blocked is
  not reported again every tick, and any served page heals it (self-healing's
  recovery rule). The previous value is the row's `lastValue`, not the last
  observation, so a failed check in between does not move the baseline.
  `transient` is true for a fetch error only; gone, blocked, an unreadable
  condition, and an extractor that could not be written end the tick, and the
  next one is the cron's.
- **Worker.** `scripts/worker.mjs` builds `packages/watch` (its references
  pull agent, core, db and solari), opens the database, runs the browser
  tiers on the local Chromium (the hosted provider joins when s9 reads its
  key here), registers the engine, and disposes the provider and closes the
  pool on shutdown. The extractor writer is built from `ANTHROPIC_API_KEY`;
  without the key the worker says so on stderr at startup and hands the
  engine a creator that answers `unavailable` with that reason, so watches
  with an extractor are still checked and a watch that needs one is parked
  with the reason in its row. The process smoke test now migrates its
  Postgres before launching, because the engine's startup sweep reads
  `watches`; a deployment runs `pnpm migrate` first, as the README says.
- **Dependency.** `packages/watch` now depends on `@chief-of-staff/agent`.
  Committed separately as chore 34a5e21 with only this sprint's three
  lockfile lines, staged through the index (`git hash-object -w` on HEAD's
  lockfile plus the watch importer, then `git update-index --cacheinfo`), so
  the siblings' uncommitted lockfile hunks were never touched.
- **Proof scoping.** `check.integration.test.ts` runs the price path through
  the real worker registration on its own harness, with ticks enqueued by
  hand on a cron that never fires, and the other paths through `checkWatch`
  directly. The creator is scripted at the port: each answer is a selector,
  turned into a spec and replayed against the page it was asked about, so
  only the judgement is written down. Fixtures stay in modes the HTTP tier
  serves; the climb is the ladder's proof. The harness's `attempts` is
  pg-boss's retry count: a limit of one runs the tick twice and reads `1`.
  The worker is proven by `tests/process-entry-points.integration.test.ts`
  (`check-worker`), and `check-unit` covers the log notifier and the client
  factory.

### harden-parked-reason-stable

- **Shape.** `parkedReason(lastError)` in `packages/agent/src/healing.ts`: a
  `last_error` already in the "no extractor: …; reset the watch to try again"
  frame is handed back as it is; anything else (a creation failure's own
  words, or null, which reads "the last attempt to write one failed") is
  framed once. Nothing else moves: `createFirst` still asks the creator only
  when the row is not parked, and the check's write-back is unchanged.
- **Proof.** `packages/watch/src/check.test.ts` is new: the composed
  `checkWatch` over in-file fakes (a memory store with the Drizzle store's
  merge rule, a ladder whose first tier serves one page, a refusing creator,
  the recording notifier). Three ticks: the first parks the row with the
  creator's reason, the second frames it, the third reads the same frame; one
  creation request, no event, three error observations. Red recorded through
  `nah verify` from this hardening session (13:43:21Z, HEAD a5375a0, exit 1,
  "no extractor: no extractor:"), which works here because
  `nah task update --status in_progress --from pending` opened an execution.
  `healing.test.ts` gains the unit statement (a parked row yields its own
  reason, no request). The check integration suite, unchanged, is a green
  proof of this task, so check-pipeline-integration's binding on it is not
  disturbed.
- **Gate rescoped.** `tsc -p tsconfig.test.json --noEmit` was the planned
  gate; at 13:44:30Z it reports one error, in the untracked
  `packages/playbooks/src/guardrails/request-context.integration.test.ts`
  (action-playbooks' hardening, in flight), and nothing in this sprint's
  files. The gate is `tsc --build packages/agent packages/watch` (exit 0,
  13:44:58Z), like the other tasks' gates; the test files were typechecked
  by that same workspace run, which named none of them. ESLint over the three
  files: exit 0.

### harden-two-sided-crossing

- **Shape.** `comparePrice` in `packages/core/src/watch/comparator.ts` now
  judges each bound on its own. `sidesOf(condition, value)` says which bound
  a price is past (at most one can be); a trigger is a bound the current
  price is past that the previous price was not, so a swing from below the
  floor to above the ceiling is news, and "still" names the bound the price
  is still past. `priceSatisfies`, the condition parser, the descriptions and
  `triggerDedupKey` are unchanged, and so is every one-sided case: the
  existing comparator tests pass untouched.
- **Proof.** Two cases in `comparator.test.ts`: the swing both ways
  (21 after 14 → "price 21 rises above 20"; 14 after 21 → "price 14 drops
  below 15") and the same-side moves (13 after 14 → "still drops below 15";
  22 after 21 → "still rises above 20"). Red recorded through `nah verify`
  (14:56:25Z, HEAD 56f858c, exit 1, "still rises above 20"). Green is the
  core suite under its full-coverage gate (14 files, 203 tests, exit 0,
  14:58:07Z); `tsc --build packages/core` and ESLint over both files exit 0.
- **Assumption recorded.** The parser does not order the bounds, so a
  condition with its floor above its ceiling (`drops_below 20, rises_above
  15`) puts every price between them past both bounds at once. Such a price
  triggers once, worded as the floor crossing (`crossingWords` prefers the
  floor), and reads "still drops below" after; the person asked for both and
  gets one. Rejecting an inverted pair is an acceptance change for the config
  surface and is left as a round-2 observation.

### Incidents

- Concurrent edits in the shared checkout: the action-playbooks session was
  editing `packages/db/src/schema.ts` and `packages/core/src/index.ts` at
  the moment `nah task finish watch-domain-model` committed them, so commit
  a453e10 also carries that sprint's `tasks.job_id`, `task_events.seq` and
  the `cancelled`/`rejected` enum members. Their migration
  (`0006_task_lifecycle`) is still uncommitted on their side and reconciles
  the database when it lands; migration `0005` is only the watch columns.
  History was not rewritten. Before every later finish, the shared files
  being committed are diffed for foreign hunks first.

- An orphaned `.nah/active/dashboard-read/events.jsonl.<pid>.<uuid>.tmp`
  from a dead process broke every nah command with "unknown sprint root
  file"; another session removed it before this one could. Nothing in that
  sibling's ledgers was changed here.
- Auto-mode denies compound `cd && ...` shell commands and very long
  multi-heredoc commands are truncated; one file per command works.
- The ladder integration proof once failed its sticky-floor recheck with a
  browser-tier timeout while the whole file ran three times slower than
  usual (a sibling session's test run was sharing the machine). Isolated and
  repeated runs pass; the browser budget in that test was raised to 60 s so
  contention cannot fail it while a hang still does.
- The harness reports `attempts` as pg-boss's `retryCount`. The first draft
  of the down-site test expected `2` after a retry limit of one; the
  harness's own test pins one retry as `attempts: 1` with the handler run
  twice. The test was corrected; the engine was not changed.
- `tsc -p tsconfig.test.json --noEmit` reports one error in the untracked
  `packages/api/src/task-detail.integration.test.ts` (a `status` inserted as
  a plain string). It belongs to a sibling session, is not on this sprint's
  path, and was not touched. `tsc --build packages/watch` and every proof
  here are clean.
- action-playbooks committed its db and playbooks work while this task was in
  flight; the lockfile's remaining working-tree hunks are the web session's
  (`rrweb-player` and friends). Nothing of theirs was committed here.
- `nah task finish check-pipeline-integration` accepted one non-blocking
  evidence finding: README.md, .env.example and TEST-MATRIX.md were committed
  outside command-proof coverage. They are documentation of the worker the
  `check-worker` proof runs; the same finding was accepted for
  watch-config-surface's README change. No proof was red.
- During hardening, `tsc -p tsconfig.test.json --noEmit` picked up a type
  error in action-playbooks' untracked
  `packages/playbooks/src/guardrails/request-context.integration.test.ts`.
  Not this sprint's file, not touched; the harden gate was scoped to the
  package build instead.
- The round-2 reconciles ran as a chain that waits for a quiet checkout. The
  laptop slept 16:01Z-17:36Z and again before 19:15Z while it waited; the
  sibling's full-suite coverage runs resumed after each wake, and the chain
  ran each finish in the gaps (17:41Z, 17:43Z, 19:20Z).

### hardening

Round 1 (2026-09-02T13:23Z, attempt `attempt-rcafc4cbd23ba4fda81500671f54d5f14`,
request `hardening-h87ef3527fe6a88ab`, HEAD b37d057). Audited consumer-backward
across acceptance behaviour, failure paths, composition, testing posture, spec
adherence and repository patterns: the core watch domain, the watch package,
the agent's extractor and healing steps, the API's watch routes and the worker.

**Implementation gaps (repair tasks, `origin: hardening`).**

- `needs-extractor-reason-rewrap` (medium). Surface: `createFirst` in
  `packages/agent/src/healing.ts`, written back by `fail()` in
  `packages/watch/src/check.ts`. Claim (extractor-lifecycle): the watch stays in
  needs-extractor state with the error recorded. Gap: the parked reason wraps
  `watch.lastError`, and `lastError` is the previous tick's reason, so
  `last_error` and every error observation grow by one
  "no extractor: …; reset the watch to try again" frame per tick; the third
  tick already reads "no extractor: no extractor: …; reset…; reset…". Proof
  gap: `healing.test.ts` and `check.integration.test.ts` stop at the second
  tick. Repair: `harden-parked-reason-stable`.
- `two-sided-crossing-suppressed` (medium). Surface: `comparePrice` in
  `packages/core/src/watch/comparator.ts`. Claim (README, watch-check-path): a
  trigger fires on a threshold crossing. Gap: `before` is the whole condition's
  satisfaction, not the bound's, so with `drops_below 15` and `rises_above 20` a
  reading of 21 after 14 is "price 21 still rises above 20" and the person is
  never told. Proof gap: `comparator.test.ts` has no swing across both bounds.
  Repair: `harden-two-sided-crossing`.

**Evidence findings (non-blocking, carried).** Every direct run below is at
HEAD b37d057 on 2026-09-02, outside `nah verify`, which refuses from this
stage; the bindings stay stale, the behaviour behind them is current.

- `check-worker` stale: action-playbooks changed `scripts/worker.mjs` after the
  receipt (9e45bdc, b70e32f: builds the playbooks package, registers the task
  engine beside the watch engine). Direct run 13:30:36Z–13:31:10Z of
  `node scripts/vitest.mjs run --project integration tests/process-entry-points.integration.test.ts`:
  2 passed, 2 skipped, exit 0.
- `config-unit`, `config-integration`, `config-types` stale: siblings changed
  `packages/api/src/errors.ts` and `app.ts`. Direct runs: the `config-types`
  argv exit 0 (13:30:34Z); the `config-unit` argv 19 files, 222 tests under
  the coverage gate, exit 0 (13:31Z); `config-integration` see the round-1
  addendum below.
- `domain-red` reported missing: its receipt (04:43:13Z, exit 1 as a red
  should) predates a rewording of the row. The argv today passes, 150 tests,
  as an implemented red does.
- `ladder-unit` reported missing: its only receipt (05:24:14Z, rev 8d7b95f)
  failed on `packages/core/src/user-io.test.ts`, a sibling's file mid-edit at
  that moment, and the row was reworded after. Direct run: 17 files, 226 tests
  under the coverage gate, exit 0 (13:31Z).
- `extractor-live`: both receipts (05:36:55Z, 06:47:12Z) are "1 skipped". The
  @live-llm suite skips without `ANTHROPIC_LIVE_LLM`, which this runner does
  not set (README external gate, owner RubiksCubingGod). Real creation has not
  been exercised in this checkout.
- ESLint over the sprint's files and `tsc -p tsconfig.test.json --noEmit` both
  exit 0 at b37d057; the sibling's `task-detail` test error is gone.

**Observations, no repair (below medium, or the spec's own choice).**

- Dedup keys are content-only: a trigger is (watch, condition, value), a block
  is (watch, tiers, signal). A change watch that goes A→B→A, or a watch blocked
  again after recovering, repeats a key; the consumer (s7) needs a time window
  on its dedup. The key is the spec's.
- A block transition overwrites `needs_extractor` and `degraded`, so a site
  that alternates refusing and serving buys one creation call per
  block→serve transition. Read as one call per incident, the incident being
  the block; bounded by transitions, each of which is reported.
- `packages/watch/src/check.ts` had no unit-level proof; every branch was
  proven through Postgres and the fixtures. `harden-parked-reason-stable`
  adds `check.test.ts` with in-file fakes, the watch package's pattern.
- The diagnostics readiness warnings (spec sections, task count, browser
  proofs outside a declared boundary, no `resolution_kind` on
  check-pipeline-integration) are planning-level; none is an implementation
  gap, and the accepted revision is not touched here.
- An observation's `checked_at` is the database's clock; the row's
  `last_checked_at` is the check's `now` port. Identical in production.
- The block classifier's text markers ("access denied", "attention required")
  can misread a product page that quotes them; real-site tuning is s9's.

**Round 2** (2026-09-02T15:20Z onward, same attempt
`attempt-rcafc4cbd23ba4fda81500671f54d5f14`, after both repairs landed as
56f858c and dde302f). Fresh dimensions, not the implementation narrative: the
operator's remedies, what runs concurrently, what a row can hold, what the
worker will fetch, and whether the two repairs hold through the composed path.

- **Remedy audit.** Every parked reason ends "reset the watch to try again";
  `POST /watches/:id/tier-reset` sets `health` back to `healthy` and leaves
  `lastError` as the record, so the next tick asks the creator again
  (`createFirst` asks whenever the row is not parked). The remedy the row
  names exists and does what the row implies. No gap.
- **Concurrency.** One cron schedule per active watch, keyed by id; a paused
  or deleted row is skipped by the tick and unscheduled by the sweep. pg-boss
  debounces cron sends per key within a minute only, so a tick that outlives
  the five-minute floor (all three tiers timing out on four attempts) can
  overlap the next; recorded in DEFERRED.md as below medium.
- **Row contents.** The parser accepts a floor above its ceiling; the
  comparator then prefers the floor's words and triggers once. The `Sides`
  comment claimed the case impossible and was corrected in this round
  (537c84e, `crossing-unit` 14 files 203 tests under the coverage gate and
  `crossing-types`, both exit 0); rejecting the pair is a config-surface
  acceptance
  change, deferred.
- **Fetch policy.** A watch URL only has to be http or https; private
  addresses are fetched. Single-operator deployment; deferred for a shared
  one.
- **Composition of the repairs.** Direct runs at bc651d9 (the sibling's fix
  of its playbooks test), outside `nah verify`:
  `packages/watch/src/check.integration.test.ts` 6 passed, exit 0
  (15:20:56Z); `packages/api/src/watch-config.integration.test.ts` 10
  passed, exit 0 (15:21:52Z). Workspace typecheck
  `tsc -p tsconfig.test.json --noEmit` exit 0 at d0c0acc (15:29:45Z–15:30:32Z);
  the sibling's untracked test that broke it in round 1 is committed and
  clean. A first combined run of both integration files timed out in
  `startTestPostgres` while a sibling ran `node scripts/check.mjs` (the
  full suite under coverage); the reruns above were taken after it exited.
- **Stale evidence after the repairs.** Re-earned in place with a bare
  `nah task finish <done-task>`, which reruns that task's stale greens and
  commits fresh receipts: `check-pipeline-integration` 4fc73da
  (`check-integration` 6 passed, `check-unit` 5 files 27 tests,
  `check-worker` 2 passed 2 skipped, `check-types`); `watch-config-surface`
  d0c0acc (`config-unit` 19 files 224 tests under the coverage gate,
  `config-integration` 10 passed, `config-types`); `browser-tier-fetcher`
  f24e76d (`ladder-unit` 18 files 229 tests under the coverage gate, green;
  `ladder-integration` 4 failed of 5 at 15:30:03Z–15:37:07Z, every failure
  "fetch failed at the browser tier: timeout: no response within 60000ms",
  taken while the sibling's full-suite coverage run started at 15:30:07Z;
  recorded by NAH as a non-blocking proof finding) and re-earned at 8c82edc
  once the checkout was quiet (17:43:04Z-17:46:38Z: `ladder-unit` 18 files
  229 tests, `ladder-integration` 5 passed, `ladder-types`, all exit 0);
  `tier0-http-fetcher` 716f376 (19:20:41Z-19:21:54Z: `tier0-unit` 18 files
  229 tests under the coverage gate, `tier0-integration` 5 files 32 tests,
  both exit 0; README.md had been changed by a sibling after the receipt).
  `watch-domain-model` is left as is:
  its `domain-red` reads missing because the row was reworded after the
  receipt, and rerunning a red after implementation records a failed red;
  `domain-green`'s argv is `crossing-unit`'s argv, green at 537c84e, and
  `nah --json diagnostics` at 716f376 (19:22Z) reports no readiness finding
  and `domain-green` as the one receipt left to refresh at implementation
  closure, which the request refresh below performs.
- **Round-1 addendum, `config-integration`.** Direct run 13:38:57Z at
  a5375a0: 10 passed, exit 0.

No critical, high or medium implementation gap remains. Fingerprints from
round 1 (`needs-extractor-reason-rewrap`, `two-sided-crossing-suppressed`)
are closed by their tasks' receipts and did not recur. Round cap is 3; this
stops at 2.

### Next

Hardening rounds 1 and 2 are recorded above; no critical, high or medium gap
remains, so the typed assurance result is submitted for the open request with
`nah lifecycle assurance watch-engine < payload.json` (the hidden lifecycle
group, not `nah stage complete`, which is specification-only). The request must
be the one raised after the repairs (`nah harden` invalidates the stale one,
`nah implement` re-raises it, `nah harden` claims it, all with
`--profile claude-only`). Evidence findings ride along as non-blocking. After
archival, commit the `.nah/done/<date>/watch-engine` move. Candidates seen while
composing the check still stand: Telegram delivery behind `NotifierPort`, the
Solari-provider switch on `SOLARI_API_KEY` (s9), a `startAfter` back-off on
transient retries, and re-exporting `ScheduleOptions` and `ScheduleRecord` from
the db index.

## 2026-09-02T04:29:42.763Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: implementation
- Ready: watch-domain-model, tier0-http-fetcher
- In progress: none
- Root blockers: none
- Done: 0/8
- Receipts: none
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s2`

<!-- nah-checkpoint:9ab171de482ebfda -->
## 2026-09-02T04:44:47.130Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: implementation
- Ready: none
- In progress: watch-domain-model, tier0-http-fetcher
- Root blockers: none
- Done: 0/8
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s2`

<!-- nah-checkpoint:e07bfb543bd5d7b8 -->
## 2026-09-02T05:08:33.028Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: implementation
- Ready: scheduler-wiring, llm-extractor-creation, watch-config-surface
- In progress: browser-tier-fetcher
- Root blockers: none
- Done: 2/8
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s2`

<!-- nah-checkpoint:d5161d96e2af28d9 -->
## 2026-09-02T05:31:34.294Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: implementation
- Ready: scheduler-wiring, watch-config-surface
- In progress: llm-extractor-creation
- Root blockers: none
- Done: 3/8
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c, verification-completed-eventf88cd9fa46d848b6a183a7cd681a5a06, verification-completed-event9aa370d17c994e09abed93c672142746, verification-completed-event82fa9d3e205c436e93134efc71500850
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s2`

<!-- nah-checkpoint:281c29d2807cb0a3 -->
## 2026-09-02T05:53:16.134Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: implementation
- Ready: scheduler-wiring, self-healing
- In progress: watch-config-surface
- Root blockers: none
- Done: 4/8
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c, verification-completed-eventf88cd9fa46d848b6a183a7cd681a5a06, verification-completed-event9aa370d17c994e09abed93c672142746, verification-completed-event82fa9d3e205c436e93134efc71500850, verification-completed-event6562d387b11b4facac2af0f55222312a, verification-completed-event40029118929341208d23fc430855f128, verification-completed-event43fc401ec7d6462ca9721964f5742d61, verification-completed-event201617ba2fba4b0c847a346ffbf20c38
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s2`

<!-- nah-checkpoint:e6da07b3c038605d -->
## 2026-09-02T06:15:23.589Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: implementation
- Ready: check-pipeline-integration
- In progress: self-healing
- Root blockers: none
- Done: 6/8
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c, verification-completed-eventf88cd9fa46d848b6a183a7cd681a5a06, verification-completed-event9aa370d17c994e09abed93c672142746, verification-completed-event82fa9d3e205c436e93134efc71500850, verification-completed-event6562d387b11b4facac2af0f55222312a, verification-completed-event40029118929341208d23fc430855f128, verification-completed-event43fc401ec7d6462ca9721964f5742d61, verification-completed-event201617ba2fba4b0c847a346ffbf20c38, verification-completed-event152d2fe9d2174cb7a0381bd8f77a4ed8, verification-completed-event2d52353665d74b43b804c964a32939c5, verification-completed-evente553c3cf5035418a82867e7880a85e6e, verification-completed-event8562476acb784b07bc08018ebd0c8b67, verification-completed-event3c9e772ec5e0412ba10ea209a183e165, verification-completed-event979076571d5540f08dbc6e31eb2daaee, verification-completed-event622d9e6951134e4199e74bf3420f0f7d
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s2`

<!-- nah-checkpoint:b9eadff64444f271 -->
## 2026-09-02T06:32:12.219Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: implementation
- Ready: none
- In progress: check-pipeline-integration
- Root blockers: none
- Done: 7/8
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c, verification-completed-eventf88cd9fa46d848b6a183a7cd681a5a06, verification-completed-event9aa370d17c994e09abed93c672142746, verification-completed-event82fa9d3e205c436e93134efc71500850, verification-completed-event6562d387b11b4facac2af0f55222312a, verification-completed-event40029118929341208d23fc430855f128, verification-completed-event43fc401ec7d6462ca9721964f5742d61, verification-completed-event201617ba2fba4b0c847a346ffbf20c38, verification-completed-event152d2fe9d2174cb7a0381bd8f77a4ed8, verification-completed-event2d52353665d74b43b804c964a32939c5, verification-completed-evente553c3cf5035418a82867e7880a85e6e, verification-completed-event8562476acb784b07bc08018ebd0c8b67, verification-completed-event3c9e772ec5e0412ba10ea209a183e165, verification-completed-event979076571d5540f08dbc6e31eb2daaee, verification-completed-event622d9e6951134e4199e74bf3420f0f7d, verification-completed-event31eb3c3649214c4caa72db83bc8cab15, verification-completed-event2fd764a2f5b1400ca06f1a1770a712ff, verification-completed-event64be7191d6a944d781b11d6d8b26e60f
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s2`

<!-- nah-checkpoint:1194027a9cde3259 -->
## 2026-09-02T13:24:45.410Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: hardening
- Ready: none
- In progress: none
- Root blockers: none
- Done: 8/8
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c, verification-completed-eventf88cd9fa46d848b6a183a7cd681a5a06, verification-completed-event9aa370d17c994e09abed93c672142746, verification-completed-event82fa9d3e205c436e93134efc71500850, verification-completed-event6562d387b11b4facac2af0f55222312a, verification-completed-event40029118929341208d23fc430855f128, verification-completed-event43fc401ec7d6462ca9721964f5742d61, verification-completed-event201617ba2fba4b0c847a346ffbf20c38, verification-completed-event152d2fe9d2174cb7a0381bd8f77a4ed8, verification-completed-event2d52353665d74b43b804c964a32939c5, verification-completed-evente553c3cf5035418a82867e7880a85e6e, verification-completed-event8562476acb784b07bc08018ebd0c8b67, verification-completed-event3c9e772ec5e0412ba10ea209a183e165, verification-completed-event979076571d5540f08dbc6e31eb2daaee, verification-completed-event622d9e6951134e4199e74bf3420f0f7d, verification-completed-event31eb3c3649214c4caa72db83bc8cab15, verification-completed-event2fd764a2f5b1400ca06f1a1770a712ff, verification-completed-event64be7191d6a944d781b11d6d8b26e60f, verification-completed-eventd513beab23db4d65bd9197efd7e964ec, verification-completed-event9bcd14579d804535b8d3729aa0bf0334, verification-completed-event54a0bbf58c0945c29d892b052957f221, verification-completed-eventa06f61c0be1941be8547bc0783e9032a, verification-completed-event67e5c4facb8d479aaa40c07cf9496472, verification-completed-event2e450e18e4624b28997686186e192e2a, verification-completed-event5727719815154396916f6c8e0a80e1df, verification-completed-event8aecd4628fa04f8eb3a520bbaac36651, verification-completed-event2fa58b9d7d33404eab433ad78b7465d3, verification-completed-event764935a0a6f8411599f980fa893452cc, verification-completed-event2a748d0fb4de45378812f7742ad36ee8, verification-completed-event4a6d11941bb940c3ad235e39e69011f6, verification-completed-eventd8d7d0a801cb4bdeb3deb3a031c2b94b, verification-completed-event24f5a883ab264682a71e159d5212be61, verification-completed-event6c9c7e7824004ce38fd8690b0fd93d2f, verification-completed-event76105353ae174401a381118e161aebf1, verification-completed-event7818e02df0994740925c978c241e33b5, verification-completed-evente12964be4b4542048eda64908052d90d
- Findings: none
- Assurance request: hardening:hardening-h87ef3527fe6a88ab
- Knowledge revisions: none
- Resume: `nah harden s2`

<!-- nah-checkpoint:67ab0349e75f4300 -->
## 2026-09-02T13:38:57.969Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: hardening
- Ready: harden-parked-reason-stable
- In progress: none
- Root blockers: none
- Done: 8/9
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c, verification-completed-eventf88cd9fa46d848b6a183a7cd681a5a06, verification-completed-event9aa370d17c994e09abed93c672142746, verification-completed-event82fa9d3e205c436e93134efc71500850, verification-completed-event6562d387b11b4facac2af0f55222312a, verification-completed-event40029118929341208d23fc430855f128, verification-completed-event43fc401ec7d6462ca9721964f5742d61, verification-completed-event201617ba2fba4b0c847a346ffbf20c38, verification-completed-event152d2fe9d2174cb7a0381bd8f77a4ed8, verification-completed-event2d52353665d74b43b804c964a32939c5, verification-completed-evente553c3cf5035418a82867e7880a85e6e, verification-completed-event8562476acb784b07bc08018ebd0c8b67, verification-completed-event3c9e772ec5e0412ba10ea209a183e165, verification-completed-event979076571d5540f08dbc6e31eb2daaee, verification-completed-event622d9e6951134e4199e74bf3420f0f7d, verification-completed-event31eb3c3649214c4caa72db83bc8cab15, verification-completed-event2fd764a2f5b1400ca06f1a1770a712ff, verification-completed-event64be7191d6a944d781b11d6d8b26e60f, verification-completed-eventd513beab23db4d65bd9197efd7e964ec, verification-completed-event9bcd14579d804535b8d3729aa0bf0334, verification-completed-event54a0bbf58c0945c29d892b052957f221, verification-completed-eventa06f61c0be1941be8547bc0783e9032a, verification-completed-event67e5c4facb8d479aaa40c07cf9496472, verification-completed-event2e450e18e4624b28997686186e192e2a, verification-completed-event5727719815154396916f6c8e0a80e1df, verification-completed-event8aecd4628fa04f8eb3a520bbaac36651, verification-completed-event2fa58b9d7d33404eab433ad78b7465d3, verification-completed-event764935a0a6f8411599f980fa893452cc, verification-completed-event2a748d0fb4de45378812f7742ad36ee8, verification-completed-event4a6d11941bb940c3ad235e39e69011f6, verification-completed-eventd8d7d0a801cb4bdeb3deb3a031c2b94b, verification-completed-event24f5a883ab264682a71e159d5212be61, verification-completed-event6c9c7e7824004ce38fd8690b0fd93d2f, verification-completed-event76105353ae174401a381118e161aebf1, verification-completed-event7818e02df0994740925c978c241e33b5, verification-completed-evente12964be4b4542048eda64908052d90d
- Findings: none
- Assurance request: hardening:hardening-h87ef3527fe6a88ab
- Knowledge revisions: none
- Resume: `nah harden s2`

<!-- nah-checkpoint:8b39a7d8131a944d -->
## 2026-09-02T15:25:22.308Z · claude-code · 45ae039f-e00e-4e13-948f-ad5b68b5d597

- Stage: hardening
- Ready: none
- In progress: none
- Root blockers: none
- Done: 10/10
- Receipts: verification-completed-eventf9a030e762234679a776c654106dfae3, verification-completed-event9789e824d76a428f95c53217a9e16498, verification-completed-eventa31574399605441297b7932a68f714a6, verification-completed-event4862e20c2d65403784f01fb1581052fc, verification-completed-event9296d41a180d4d1ab38bc60ed0d74bf1, verification-completed-eventee43ee96fea44771b590aae16c8a5405, verification-completed-event5851a88014b14e0381d254f991e4713e, verification-completed-event3cdbf761791042d19205518255da8b1c, verification-completed-eventf88cd9fa46d848b6a183a7cd681a5a06, verification-completed-event9aa370d17c994e09abed93c672142746, verification-completed-event82fa9d3e205c436e93134efc71500850, verification-completed-event6562d387b11b4facac2af0f55222312a, verification-completed-event40029118929341208d23fc430855f128, verification-completed-event43fc401ec7d6462ca9721964f5742d61, verification-completed-event201617ba2fba4b0c847a346ffbf20c38, verification-completed-event152d2fe9d2174cb7a0381bd8f77a4ed8, verification-completed-event2d52353665d74b43b804c964a32939c5, verification-completed-evente553c3cf5035418a82867e7880a85e6e, verification-completed-event8562476acb784b07bc08018ebd0c8b67, verification-completed-event3c9e772ec5e0412ba10ea209a183e165, verification-completed-event979076571d5540f08dbc6e31eb2daaee, verification-completed-event622d9e6951134e4199e74bf3420f0f7d, verification-completed-event31eb3c3649214c4caa72db83bc8cab15, verification-completed-event2fd764a2f5b1400ca06f1a1770a712ff, verification-completed-event64be7191d6a944d781b11d6d8b26e60f, verification-completed-eventd513beab23db4d65bd9197efd7e964ec, verification-completed-event9bcd14579d804535b8d3729aa0bf0334, verification-completed-event54a0bbf58c0945c29d892b052957f221, verification-completed-eventa06f61c0be1941be8547bc0783e9032a, verification-completed-event67e5c4facb8d479aaa40c07cf9496472, verification-completed-event2e450e18e4624b28997686186e192e2a, verification-completed-event5727719815154396916f6c8e0a80e1df, verification-completed-event8aecd4628fa04f8eb3a520bbaac36651, verification-completed-event2fa58b9d7d33404eab433ad78b7465d3, verification-completed-event764935a0a6f8411599f980fa893452cc, verification-completed-event2a748d0fb4de45378812f7742ad36ee8, verification-completed-event4a6d11941bb940c3ad235e39e69011f6, verification-completed-eventd8d7d0a801cb4bdeb3deb3a031c2b94b, verification-completed-event24f5a883ab264682a71e159d5212be61, verification-completed-event6c9c7e7824004ce38fd8690b0fd93d2f, verification-completed-event76105353ae174401a381118e161aebf1, verification-completed-event7818e02df0994740925c978c241e33b5, verification-completed-evente12964be4b4542048eda64908052d90d, verification-completed-eventa9f842c422b949258296eec5339eb511, verification-completed-event99a39d4bb661423dbf44c9d8a85bf2be, verification-completed-evente76642e909264d09adc86ce325750b1e, verification-completed-eventad3b36352fd44edc87fd9d4f87083746, verification-completed-event56c779d6b3444a8d85c3c22634d961b6, verification-completed-event049b26d5881e4ddfae60b6ba44f2ab78, verification-completed-event63c60db6046f46ff8b17d3ba80589945, verification-completed-eventb8d145e108ee489a864ae0672fcdd844, verification-completed-event71f4f74b75b24751aea6f13ccc397ddc, verification-completed-event572a9ba9f8ce4de0827412c05fa688d6
- Findings: none
- Assurance request: hardening:hardening-h87ef3527fe6a88ab
- Knowledge revisions: none
- Resume: `nah harden s2`
