# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Digest: stable refs, truncation marking, label extraction on recorded pages | browser-toolset | unit | every push |
| Each tool: happy path, typed failures, stale-ref recovery, guardrail-rejected navigate | browser-toolset | integration (fixtures, LocalProvider) | every push |
| declare_outcome classes map to task terminal states; cost logged per mission | agentic-mission-path | integration (scripted transport) | every push |
| Budget exhaustion on each axis → failed with budget event, cost still logged | agentic-mission-path | integration | every push |
| Full mission: success with evidence, ask_user park/resume, blocked + hard-blocked honest endings | agentic-mission-path | integration | every push |
| Live-LLM smoke: real claude-opus-5 completes a fixture mission | agentic-mission-path | smoke (gated on ANTHROPIC_API_KEY) | nightly |
| Scenario suite: success ×2, blocked, hard-blocked, redesign, payment-trap — outcome class + control-plane state | eval-harness | integration (scripted transport) | every push |
| Sabotaged prompt / removed tool makes named scenarios fail | eval-harness | integration | every push |
| Nightly live suite fails below committed baseline; errored ≠ failed | eval-harness | workflow (live LLM, spend-capped) | nightly |

Hostile scenarios reuse the fixture harness's blocked / hard-blocked / redesign modes; a
mission that "succeeds" on a blocked page is an eval failure by definition. Real-site missions
are s9.
