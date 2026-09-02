# Handoff

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
