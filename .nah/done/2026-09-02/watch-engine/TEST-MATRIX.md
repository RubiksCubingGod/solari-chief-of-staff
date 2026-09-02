# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Comparator threshold/change semantics; trigger dedup; notifier double records | watch-check-path | unit | every push |
| Active watch ticks; paused stops; delete deregisters; restart-survival tick | watch-check-path | integration | every push |
| Fakestore price path: mutate → tick → observation → exactly one trigger; dedup on repeat | watch-check-path | integration (fixtures + Testcontainers) | every push |
| Fakenews change path; fetch-failure observation state | watch-check-path | integration | every push |
| Down site → tick retried per job policy, one observation per run; failed delivery → retry delivers once; worker boots the engine on a migrated Postgres and stops on SIGTERM | watch-check-path | integration (fixtures + Testcontainers + process smoke) | every push |
| Block classifier on recorded block/challenge/plain pages | tiered-fetching | unit | every push |
| blocked mode → tier 1; hard-blocked → escalation-marked tier 2; persisted tier rises; plain stays tier 0 | tiered-fetching | integration (LocalProvider) | every push |
| Exhausted ladder → blocked verdict + notifier event | tiered-fetching | integration | every push |
| Creation-validate-store; deterministic replay; invalid-spec refusal (mocked LLM) | extractor-lifecycle | unit | every push |
| Redesign breaks extraction → healing recreates → next check extracts | extractor-lifecycle | integration | every push |
| Double-failure → degraded state, one notifier event, no further LLM calls | extractor-lifecycle | integration | every push |
| Real Claude call creates a working extractor for a fixture page | extractor-lifecycle | @live-llm (needs ANTHROPIC_API_KEY) | nightly + manual |
| Valid watch configs drive checks; invalid refuse typed 4xx; tier reset clears floor | watch-check-path | integration | every push |
| Parked watch (creator refused) reads the same reason on the second and third tick; one creation request; no event (hardening) | extractor-lifecycle | unit (composed check over in-file fakes) | every push |
| Two-sided price condition: swing across both bounds triggers; same side stays quiet naming the bound (hardening) | watch-check-path | unit | every push |

Stealth at tier 2 is proven against the seam contract (echo asserted) on LocalProvider — real
Solari stealth behavior is deliberately deferred to real-site-hardening (s9).
