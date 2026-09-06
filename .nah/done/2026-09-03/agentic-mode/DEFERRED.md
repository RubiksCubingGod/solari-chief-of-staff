# Deferred

Nothing deferred during bootstrap.

## browser-toolset

- Shadow DOM and iframes are not digested: the digest walks the main frame's light DOM only. A `<select>` option beyond `maxOptions` (24) is neither shown nor selectable. A click whose navigation starts more than 250 ms after the click (client-side scripting) is read as the old page until the next `read`. Owner: real-site hardening (s9), where real pages decide which of these matter.

## agentic-runner

- The worker does not yet register the agentic mission as the playbook runner's fallback: `scripts/worker.mjs` and `.env.example` (the `ANTHROPIC_API_KEY` line) were held uncommitted by the calendar-wiring sprint throughout this task, so the wiring goes in with `mission-e2e`, which needs it for the live smoke anyway. Until then a task no playbook matches still fails in production with the s5 wording.
- Resolved in hardening (`harden-agentic-runner`): the cost write is `recordTaskLlmUsage` in `@chief-of-staff/db`, beside the other row writers, and playbooks no longer depends on `drizzle-orm`. The note it replaces said the write sat in the runner because the db barrel was sibling-modified at the time.
- The wall-time budget is checked between calls and before each tool, not inside one: a model call waits up to the remaining wall budget and a tool up to its own action timeout, so a mission can overrun the wall budget by one call or one tool. Owner: s9, if real missions show it matters.
- A payment gate parks the task at once (the toolset's `stop` is the confirmation's fingerprint), which the s5 guardrail suites already prove; the agentic suite proves the allowlist path only. `mission-e2e`'s fakegym proofs cover the payment ask through the agentic loop.

## mission-e2e

- The live smoke (`the live agentic smoke @live-llm`) has not run anywhere: there is no `ANTHROPIC_API_KEY` locally or among the repository's GitHub Actions secrets, so the suite skips with its reason in the name and the nightly `live-smoke.yml` guard job skips rather than passes. Owner: the repository owner, who decides whether to add the secret; nothing in the code path is blocked on it.

## eval-scenarios

- The suite runs scripted only. The live run of the same scenarios is `eval-gate`'s nightly, and until a key exists it too will skip.
- `gym-hard-blocked` gives the person no reply, so a live model that asks for help parks the task (`needs_user`); a model that declares blocked ends `failed-blocked`. Both are accepted; the eval does not say which a good model should do.
- Scenario `verify` reads the price off `task.result.detail` as text (`$49.00`), which ties `store-*` to the runner's succeeded-result shape. If the result ever carries a structured value, the assertion should read that instead.

## eval-gate

- The nightly (`.github/workflows/live-evals.yml`) has never run: no `ANTHROPIC_API_KEY` in the repository's secrets, so its guard job skips. The first run that does happen sets nothing itself; its report and candidate baseline arrive as the `live-evals` artifact, and moving the bar is a pull request over `packages/playbooks/src/agentic/eval/baseline.json`. Owner: the repository owner, for the secret.
- Every baseline entry is `pass` by intent, from the scripted suite, not from a live run. A scenario a real model cannot pass yet will show as a regression on the first night, which is the honest reading: the bar was set before the evidence, and the first pull request that lowers it should say why.
- The agent package's live suite (`packages/agent/src/live-llm.integration.test.ts`) and the agentic smoke still have no nightly of their own; `node scripts/live-llm.mjs` with no arguments runs all three, so a workflow for them is one more `run:` line, when someone wants the spend.
- `patiently` (the read-again sequencer for scripted models) exists in `packages/playbooks/src/agentic/eval/scenarios.ts` and, after the mission-suite repair, in `packages/playbooks/src/agentic-mission.integration.test.ts`. Its home is `packages/playbooks/src/agentic/testing/scripted-model.ts`, beside `script`; moving it touches a file every eval proof covers, so it waits for a task that touches both anyway.
- The report's exit code treats a night on which no scenario reached a verdict as a failure (not a regression, not a pass). If the workflow's owner would rather an outage night stay yellow than red, that is one line in `nightlyReport` and one test.

## re-earning the gates

- `packages/web/src/task-detail-page.integration.test.ts` went red once in seven runs on 2026-09-03 (the browser-toolset re-earn gate at 43a16b9): the dashboard's `/tasks/<id>/recording` route answered 404 for two seeded tasks whose pages had just answered 200, in one dashboard instance, under full-gate load only. It passes alone and under the integration project's load; the database and the build directory are per instance; no sibling was running. The API's test stack sets `LOG_LEVEL: 'silent'` (`packages/api/src/testing/auth-stack.ts`), so which 404 fired (`No task ... belongs to you` or `has no recording`) is not on record; a hardening pass that wants the branch can let the stack take the level from the environment for one run. Owner: whoever hardens next; the file is the closed action-playbooks sprint's.

## hardening

- The password reaches the model in the system prompt by design (`describeCredential`: "sign in with email ... and password ..."): the model has to type it, and the digest never shows a password field's value. So the vendor sees it, once per call, for a password credential; a profile credential sends nothing. The trail, the declared outcome, the question the person is asked and a guardrail's reason are scrubbed of it (the last three since `harden-agentic-runner`). Keeping the password out of the prompt would need a `type_secret` tool that fills from the credential source without showing the value, which changes the toolset and the spec's tool list. Owner: real-site hardening (s9), if a site's terms or the owner's comfort call for it.
- The wall-time and tool-call budgets still bound the mission to one overrun: a call in flight when the wall budget runs out finishes (up to the remaining wall time), and a tool in flight finishes on its own action timeout. Unchanged from the agentic-runner note above; `harden-agentic-runner` only made the tool-call count honest.
- `gym-blocked-shell` expects `succeeded`: the fixture's `blocked` mode serves a shell around the normal page, so a model that reads past the shell completes the cancellation. The scenario proves the model is not fooled by a decoy, not that a blocked site is recognised; `gym-hard-blocked` is the one that proves recognition. The names invite the other reading; renaming the scenario changes `baseline.json` and the scripted suite, so it waits for the first baseline pull request.
- `patiently` is still duplicated between the eval scenarios and the mission suite (see eval-gate above); no proof of this round touches both files, so it stays.
- The workspace's branch coverage stands at 90.02% against the 90% threshold with three sibling sprints' uncommitted files in the tree, so any gate can tip on branches that are not the finishing sprint's. The threshold is doing its job; the note is that a red `check: test` with every test passing means the summary lines under it, not a flake.
- `nah diagnostics` warns `browser-proof-without-browser-boundary` for `mission-green`: the specification declares no browser boundary although the proof drives Playwright against the fixtures. A specification field, not a code gap; the next planning revision of an agentic sprint should declare the boundary.

