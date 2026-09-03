# Deferred

Nothing deferred during bootstrap.

## browser-toolset

- Shadow DOM and iframes are not digested: the digest walks the main frame's light DOM only. A `<select>` option beyond `maxOptions` (24) is neither shown nor selectable. A click whose navigation starts more than 250 ms after the click (client-side scripting) is read as the old page until the next `read`. Owner: real-site hardening (s9), where real pages decide which of these matter.

## agentic-runner

- The worker does not yet register the agentic mission as the playbook runner's fallback: `scripts/worker.mjs` and `.env.example` (the `ANTHROPIC_API_KEY` line) were held uncommitted by the calendar-wiring sprint throughout this task, so the wiring goes in with `mission-e2e`, which needs it for the live smoke anyway. Until then a task no playbook matches still fails in production with the s5 wording.
- Cost is written straight onto `tasks.llm_usage` by the runner with `drizzle-orm` (playbooks now depends on it) rather than through a ledger helper in `@chief-of-staff/db`: the db barrel was sibling-modified and referenced an untracked module, so nothing could be added to it safely. A `recordLlmUsage` helper beside `recordBrowserSession` is the tidier home once the barrel is quiet; the row write is one line to move.
- The wall-time budget is checked between calls and before each tool, not inside one: a model call waits up to the remaining wall budget and a tool up to its own action timeout, so a mission can overrun the wall budget by one call or one tool. Owner: s9, if real missions show it matters.
- A payment gate parks the task at once (the toolset's `stop` is the confirmation's fingerprint), which the s5 guardrail suites already prove; the agentic suite proves the allowlist path only. `mission-e2e`'s fakegym proofs cover the payment ask through the agentic loop.

## mission-e2e

- The live smoke (`the live agentic smoke @live-llm`) has not run anywhere: there is no `ANTHROPIC_API_KEY` locally or among the repository's GitHub Actions secrets, so the suite skips with its reason in the name and the nightly `live-smoke.yml` guard job skips rather than passes. Owner: the repository owner, who decides whether to add the secret; nothing in the code path is blocked on it.

## eval-scenarios

- The suite runs scripted only. The live run of the same scenarios is `eval-gate`'s nightly, and until a key exists it too will skip.
- `gym-hard-blocked` gives the person no reply, so a live model that asks for help parks the task (`needs_user`); a model that declares blocked ends `failed-blocked`. Both are accepted; the eval does not say which a good model should do.
- Scenario `verify` reads the price off `task.result.detail` as text (`$49.00`), which ties `store-*` to the runner's succeeded-result shape. If the result ever carries a structured value, the assertion should read that instead.
