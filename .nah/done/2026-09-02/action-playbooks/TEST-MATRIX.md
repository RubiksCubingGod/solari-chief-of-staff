# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Lifecycle transitions with event assertions; illegal transitions rejected | task-state-machine | integration (Testcontainers + pg-boss) | every push |
| Worker kill/restart mid-run → retry-or-failed, never phantom running | task-state-machine | integration | every push |
| waiting_user: ask parks task, answer resumes with fresh mission, decline cancels, timeout fails, late answer refused | task-state-machine | integration | every push |
| Off-allowlist navigation (direct/redirect/new-tab) aborts with violation event | guardrail-layer | integration (fixtures, LocalProvider) | every push |
| Payment gate asks; scripted decline cancels; no bypass exists (config test) | guardrail-layer | integration + unit | every push |
| Payment detector on recorded payment/non-payment pages | guardrail-layer | unit | every push |
| Toy playbook: step outcomes drive transitions; waiting_user parks/resumes; unknown lookup refuses | cancellation-playbook-path | integration | every push |
| Fakegym accepted path: member cancelled, event trail, recording echo | cancellation-playbook-path | integration | every push |
| Declined / wrong-credentials / wrong-code / blocked-mode / violation — membership unchanged in each | cancellation-playbook-path | integration | every push |
| Task detail: timeline order, scrubbing player on seeded rrweb, absence + error states, cross-user 404 | task-detail-replay | Playwright e2e (seeded) | every push |

The confirmation-code gate makes the waiting_user proof non-fakeable: the code exists only
behind the fixture control plane, so a green accepted path is proof the ask actually happened.
Live Solari recordings and the real Telegram round-trip are s9 and s7 respectively.
