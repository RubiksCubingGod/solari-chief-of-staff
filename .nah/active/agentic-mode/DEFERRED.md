# Deferred

Nothing deferred during bootstrap.

## browser-toolset

- Shadow DOM and iframes are not digested: the digest walks the main frame's light DOM only. A `<select>` option beyond `maxOptions` (24) is neither shown nor selectable. A click whose navigation starts more than 250 ms after the click (client-side scripting) is read as the old page until the next `read`. Owner: real-site hardening (s9), where real pages decide which of these matter.

## agentic-runner

- The worker does not yet register the agentic mission as the playbook runner's fallback: `scripts/worker.mjs` and `.env.example` (the `ANTHROPIC_API_KEY` line) were held uncommitted by the calendar-wiring sprint throughout this task, so the wiring goes in with `mission-e2e`, which needs it for the live smoke anyway. Until then a task no playbook matches still fails in production with the s5 wording.
- Cost is written straight onto `tasks.llm_usage` by the runner with `drizzle-orm` (playbooks now depends on it) rather than through a ledger helper in `@chief-of-staff/db`: the db barrel was sibling-modified and referenced an untracked module, so nothing could be added to it safely. A `recordLlmUsage` helper beside `recordBrowserSession` is the tidier home once the barrel is quiet; the row write is one line to move.
- The wall-time budget is checked between calls and before each tool, not inside one: a model call waits up to the remaining wall budget and a tool up to its own action timeout, so a mission can overrun the wall budget by one call or one tool. Owner: s9, if real missions show it matters.
- A payment gate parks the task at once (the toolset's `stop` is the confirmation's fingerprint), which the s5 guardrail suites already prove; the agentic suite proves the allowlist path only. `mission-e2e`'s fakegym proofs cover the payment ask through the agentic loop.
