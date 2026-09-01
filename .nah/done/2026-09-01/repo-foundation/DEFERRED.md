# Deferred

## `check` workflow green on the sprint PR — `ci-workflows`

The workflow is written, and everything about it that can be proven without
GitHub is: `tests/ci-workflow.test.ts` asserts it fires on push and on pull
request, installs from the lockfile, runs the same `pnpm check` a developer
runs, and takes its Node and pnpm versions from the workspace manifest rather
than restating them. `tests/coverage-gate.test.ts` proves the gate this workflow
runs actually refuses work, by running Vitest over a fixture with one unexercised
branch under the thresholds `core/` is held to and requiring that run to fail.

What is not proven is the run itself. This repository has no `origin` remote and
no pull request, so no workflow has ever executed. Creating the remote and
pushing is an outward-facing action nobody has asked for yet, and the API tokens
for it are not this session's to use.

**Resolves when:** the repository is pushed to GitHub and the first pull request
shows a green `check` run. Until then, treat "CI is green" as an untested claim,
not a fact. The likely first failures are environmental rather than logical: the
Testcontainers path (never exercised here, since this machine has no container
runtime) and the pnpm store cache key.
