# Handoff

## 2026-09-02 · implementation · agentic-runner

### Where the frontier is

- `agentic-runner` is built and green on its own proofs: red recorded (`runner-red`, the composed suite could not resolve `./agentic/runner.js`), green 21 passed, rules 63 passed across six unit files, `eslint` and `tsc --build --force` clean on this sprint's files. Coverage of the new modules in a targeted run was about 96 % statements and 90 % branches. Finished with `nah task finish` at `700f657`; the gate receipt is red at `lint` for the sibling reason in finding 1 and NAH carried it as a finding.
- The shared-file part (the `tasks.llm_usage` column, migration `0008_task_llm_usage`, the core `llm-usage` module and `llmUsage: null` in five Task literals) went in first by hand at `40eff61`, staged hunk by hunk through the index so the calendar-wiring sibling's edits to `schema.ts`, the core barrel and the drizzle journal stayed uncommitted. HEAD's journal ends at idx 8; the sibling ships its 0009 pair with its own finish and was told so.
- Next: `mission-e2e` and `eval-scenarios` in parallel (both rows still need `resolution_kind` and proofs patched into `tasks.jsonl`), then `eval-gate`.

### Assumptions recorded

1. Model and price: `AGENTIC_MODEL` is `claude-opus-5` and `OPUS_5_PRICING` is $5 / $25 per MTok for input / output with $6.25 / $0.50 for cache writes / reads, from ARCHITECTURE §7. Cost is charged per call from the API's usage block and accumulated onto `tasks.llm_usage`; an aborted mission keeps what was charged before the abort.
2. Budgets: `DEFAULT_AGENTIC_BUDGETS` is 40 tool calls, 400 000 tokens and 10 minutes of wall time (§3.2). Turns and tool calls are checked before each; tokens are checked after each call with `>=`, so the call that reaches the cap is the last.
3. The model is called through the SDK with `fallbacks: 'default'` under the `server-side-fallback-2026-07-01` beta and a cached system block. Transport errors, 408, 409, 429 and 5xx are retried four times from 500 ms doubling, never past the wall budget; a 4xx rejection ends the mission at once. The live smoke in `mission-e2e` is the first proof that the API accepts that header.
4. The runner writes `tasks.llm_usage` itself with `drizzle-orm` (playbooks now depends on it) instead of through a new db ledger helper, because the db barrel was sibling-modified; see DEFERRED.md.
5. The playbook runner's choice grew an `unmatched` kind: a task that asks for agentic mode, names no site, or names a site without a playbook is handed to the `fallback` mission with an `playbook … unmatched` step; only a non-object input stays `refused`. Without a fallback the wording is `agentic mode has no runner yet`, so s5's behaviour is unchanged until the worker wires the fallback in `mission-e2e`.
6. Secrets in the trail: every step the runner logs is passed through `redactSecrets` with the credential's password, so the trail carries `[redacted]` where the model typed it. The brief itself, which contains the password, is never logged.
7. The scripted model in `agentic/testing/scripted-model.ts` is a real `Anthropic` client (`maxRetries: 0`) whose `fetch` is replaced, so the suite exercises the SDK's request shape, headers and error classes without the network. `packages/playbooks/tsconfig.json` excludes `src/**/testing/**` so it never builds into `dist`.

### Findings

1. **Gate red on live sibling work, carried.** At finish time `lint` fails on the calendar-wiring sibling's uncommitted `packages/db/src/confirm.test.ts` (`no-constant-binary-expression`); behind it `typecheck` fails on that sibling's `packages/db/src/calendar-scan.ts(199,48)` (`AutoCancelArm | undefined`) and on the slot-sniping sibling's `packages/watch/src/snipe*`. Both owners were active throughout; nothing was repaired or committed on their behalf. Re-earn with a bare `nah task finish agentic-mode agentic-runner` once that work is committed and green.
2. **Full-tree coverage run, classified.** One full run this session (148 files, 364 s) failed 9 tests in 7 files, none in this sprint's code. Sibling-owned: the untracked `packages/playbooks/src/auto-cancel.integration.test.ts` suite, `tests/calendar-reminders.integration.test.ts` (3), and `tests/migrate-step` plus both `tests/process-entry-points` cases, which all stop at the `calendar-scan.ts` build error above. Load-induced: `packages/web/src/task-detail-page.integration.test.ts` (`page.goto` 30 s timeout) and the s5 `guardrails` payment-decline and `runner` park-and-resume cases, which ended `failed` at about 30 s; re-run alone afterwards, those two suites pass 23/23. Vitest prints no coverage table when tests fail, so the global thresholds were not read from that run.
3. **Wall-time overrun.** A mission can exceed its wall budget by one in-flight model call or tool; recorded in DEFERRED.md for s9.

### Environment

- As before: `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres` for every gate and Postgres proof, and never a `--coverage` run concurrently with another session's.
- `packages/playbooks` now depends on `@anthropic-ai/sdk` 0.122.0 and `drizzle-orm`; `pnpm install` after pulling.

### Resume

`nah implement s6`; ready tasks are `mission-e2e` and `eval-scenarios`.

## 2026-09-02 · implementation · browser-toolset

### Where the frontier is

- `browser-toolset` is built and green on its own proofs: red recorded (`toolset-red`, the composed integration suite could not resolve `./agentic/index.js`), green 13 passed, rules 29 passed, lint clean, `tsc --build --force` clean. Coverage of the two new modules is 96–97 % statements and 93 % branches. Finished with `nah task finish` on the server rung at `4f565d4`; the gate receipt is red for the sibling reason in finding 2 and was carried with `--continue-with-findings`.
- Next: `agentic-runner` (its row still needs `resolution_kind` and proofs patched into `tasks.jsonl`, like `browser-toolset` did), then `mission-e2e` and `eval-scenarios` in parallel, then `eval-gate`.

### Assumptions recorded

1. Placement: the spec's `packages/engine` is `packages/playbooks/src/agentic/`. That package already owns the runner, registry and guardrails and depends on core, db, solari and playwright; a new package would have needed fresh build and test wiring for no seam gain. Everything is exported from `@chief-of-staff/playbooks` through `agentic/index.ts`.
2. Zod 4.5.4 (the workspace pin) is the authority for tool inputs; the JSON schema handed to the model is derived from it with `z.toJSONSchema`, `$schema` stripped.

### Design decisions

- Refs are `data-cos-ref` attributes stamped on visible interactive elements. The toolset's counter never reuses a ref across documents; an unchanged page keeps its refs across reads.
- Staleness is a signature (`kind|label|href|name`) taken at digest time and compared at action time: `stale-ref` with reason `unknown`, `missing` or `changed`; hidden or disabled targets are `not-interactable`.
- Digests are bounded by `DEFAULT_DIGEST_LIMITS` (120 elements, 80 regions, 120/400/80 characters, 24 options); what was left out is counted and rendered, and a trailing `…` marks a cut. Main frame, light DOM only (see DEFERRED.md).
- The guard stays beneath the tools: no allowlist pre-check. A violation surfaces as a `guardrail` failure and every later browser tool repeats it; `ask_user` and `declare_outcome` still answer so the runner can end honestly.
- navigate, click and read return the fresh digest; type and select return a field result; ask_user and declare_outcome return typed endings, not page results.
- The trail gets one `tool:<name>` step per call with the input; digests are summarised to counts and truncation, while field results, failures, questions and declared outcomes are kept whole.
- Settling after a click: the browser's main-frame navigation request within 250 ms is the signal that a load started; the commit and `load` are then awaited within the navigation budget. Defaults are 10 s per action and 20 s per navigation; the integration bench uses 1.5 s and 30 s.

### Findings

1. **Own suite under gate load, repaired.** The first full-tree coverage run (17:04 local, six web suites' Next dev servers alongside) failed the link-click test because its opening `navigate` exceeded the bench's 10 s budget (`Timeout 10000ms exceeded`); alone the suite had passed three times. Repaired before finishing: the bench navigation budget is Playwright's default 30 s, settle is keyed on the navigation request rather than a 250 ms commit window, Playwright's trailing full stop is stripped from reasons, and navigate has its own timeout wording. Re-run: 42 passed.
2. **Gate red on live sibling work, carried.** The gate stops at its first red step, and at finish time two live siblings own that step: `lint` fails with 110 errors in the calendar-wiring sibling's untracked test files (`packages/bot/src/reminders.test.ts`, `packages/core/src/calendar/message.test.ts`, `packages/db/src/calendar-scan.integration.test.ts`, `tests/calendar-reminders.integration.test.ts`, written against modules that do not exist yet), and behind it `typecheck:tests` fails on the slot-sniping sibling's untracked `packages/watch/src/slot-trigger.integration.test.ts` while its uncommitted `packages/core/src/watch/*.ts` edits fail four unit suites in core and agent (`WATCH_VALUE_KINDS` now lists `slots`). Both owners were active during this task (calendar-semantics finished at `ac1df2e`; `dmv-booking-playbook` execution started 20:56Z and new `packages/watch` files kept appearing), so nothing was repaired or committed on their behalf. The toolset's gate is re-earned with a bare `nah task finish agentic-mode browser-toolset` once that work is committed and green.
3. **Observation outside this sprint.** In the same full-tree run `packages/web/src/auth-guard.integration.test.ts` ("refuses a link that has already been followed") failed a strict-mode `getByRole('alert')`: the page's alert and Next's `__next-route-announcer__` both matched. Timing-dependent (the announcer mounts after hydration), not this sprint's code; noted for the dashboard harness's owner.

### Environment

- Run every gate and Postgres proof with `TEST_DATABASE_URL=postgres://postgres:nahtest@127.0.0.1:55432/postgres` (the throwaway local server), and never a `--coverage` run concurrently with another session's.
- Probes that import playwright or zod must run from a package directory such as `packages/playbooks`, not the repository root.

### Resume

`nah implement s6`; the next ready task is `agentic-runner`.


<!-- nah-checkpoint:89f79c4f3c7bf67a -->
## 2026-09-02T20:41:58.124Z · claude-code · b4c47fe6-9724-4b90-9dd4-2c37dd394dbf

- Stage: implementation
- Ready: none
- In progress: browser-toolset
- Root blockers: none
- Done: 0/5
- Receipts: none
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s6`

<!-- nah-checkpoint:31aa2c34303ae300 -->
## 2026-09-02T21:04:25.275Z · claude-code · b4c47fe6-9724-4b90-9dd4-2c37dd394dbf

- Stage: implementation
- Ready: none
- In progress: browser-toolset
- Root blockers: none
- Done: 0/5
- Receipts: verification-completed-eventc5dffd1811e14aa281e72838d1c624c2
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s6`

<!-- nah-checkpoint:b09154258b826d72 -->
## 2026-09-02T21:21:17.710Z · claude-code · b4c47fe6-9724-4b90-9dd4-2c37dd394dbf

- Stage: implementation
- Ready: agentic-runner
- In progress: none
- Root blockers: none
- Done: 1/5
- Receipts: verification-completed-eventc5dffd1811e14aa281e72838d1c624c2, verification-completed-eventc1c01c5972264ed5a0f621725309f369, verification-completed-event90f555b4e8b448e483a15d3babb7a970, verification-completed-event6cbcab21bd1348089328e24acce131c1
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s6`

<!-- nah-checkpoint:76d9978d3e1c9a92 -->
## 2026-09-02T21:42:43.750Z · claude-code · b4c47fe6-9724-4b90-9dd4-2c37dd394dbf

- Stage: implementation
- Ready: none
- In progress: agentic-runner
- Root blockers: none
- Done: 1/5
- Receipts: verification-completed-eventc5dffd1811e14aa281e72838d1c624c2, verification-completed-eventc1c01c5972264ed5a0f621725309f369, verification-completed-event90f555b4e8b448e483a15d3babb7a970, verification-completed-event6cbcab21bd1348089328e24acce131c1, verification-completed-event952b731c7c8a480c9d582dd1ac81addf
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s6`

<!-- nah-checkpoint:207b0fe87028079d -->
## 2026-09-02T22:08:26.966Z · claude-code · b4c47fe6-9724-4b90-9dd4-2c37dd394dbf

- Stage: implementation
- Ready: mission-e2e, eval-scenarios
- In progress: none
- Root blockers: none
- Done: 2/5
- Receipts: verification-completed-eventc5dffd1811e14aa281e72838d1c624c2, verification-completed-eventc1c01c5972264ed5a0f621725309f369, verification-completed-event90f555b4e8b448e483a15d3babb7a970, verification-completed-event6cbcab21bd1348089328e24acce131c1, verification-completed-event952b731c7c8a480c9d582dd1ac81addf, verification-completed-event8b6a910337714702bfd7c3093419e326, verification-completed-event2a68406192ac415ab59ac40fe3af83eb, verification-completed-event53e68f1006284bf783c5dbbcdd03c6c3
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s6`
