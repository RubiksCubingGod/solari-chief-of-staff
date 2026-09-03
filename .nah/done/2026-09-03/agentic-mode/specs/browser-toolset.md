---
schema_version: 1
id: browser-toolset
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [agentic-mission-path, eval-harness]
  cutover: >-
    New capability - no prior path is superseded; playbooks keep driving Page directly, the
    toolset exists only for LLM-driven missions
origin:
  summary: The typed contract between the LLM and the browser - a serialized page digest the
    model can read and a small set of Zod-validated tools it can call, with guardrails
    intercepting below.
  refs: [.nah/active/agentic-mode/README.md,
    .nah/active/browser-substrate/specs/browser-provider-seam.md]
---

# Browser toolset

## Outcome

A `packages/engine` module exposing two things over the provider seam's Page. First, a page
digest builder: URL, title, interactive elements (links, buttons, inputs, selects) each with a
stable reference id and accessible label, and visible text regions - bounded in size so a
pathological page cannot blow the context window (truncation is explicit in the digest, never
silent). Second, the typed tool surface: `navigate`, `click(ref)`, `type(ref, text)`,
`select(ref, option)`, `read` (fresh digest), `ask_user(question)`,
`declare_outcome(status, detail)` - all Zod-validated, all executed against the Page beneath
the s5 guardrail wrapper, so allowlist and payment interception apply to tool calls exactly as
they do to playbook steps.

## Consumers

The agentic runner (agentic-mission-path) is the production consumer; the eval harness drives
the same surface with scripted transports. No other code may reach the Page on an agentic
mission except through these tools.

## Failure behavior

A stale element reference (page changed since the digest) returns a typed stale-ref error
telling the model to `read` again - never a crash. Digest truncation is marked in the digest
itself. Tool execution errors (element not interactable, navigation timeout) return typed
errors with the failure reason; guardrail rejections return the violation reason. Every tool
call and its result is appended to task_events.

## Proof

Unit tests for the digest builder against recorded fixture pages (element refs stable across
rebuilds of an unchanged page, truncation marking, label extraction). Integration tests via
LocalProvider on fixtures for each tool's happy path and typed failures, stale-ref recovery,
and a guardrail-rejected navigate. The production-consumer proof is the agentic-mission-path
suite driving this surface end to end.
