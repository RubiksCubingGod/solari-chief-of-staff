# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Due computation: both entry types, lead days, boundary dates | reminder-path | unit | every push |
| Annotation transitions persist; idempotence keys unique | reminder-path | integration (Testcontainers) | every push |
| Exactly-once sends under re-run and mid-dispatch crash; unbound skip; late-send after downtime | reminder-path | integration (pg-boss, scripted sink) | every push |
| Chat-created entry picked up by next scan | reminder-path | integration | every push |
| Confirm-yes → fixture member cancelled, full event trail | auto-cancel-path | integration (fixtures, LocalProvider, scripted UserIO) | every push |
| Decline / timeout → membership untouched, entry annotated | auto-cancel-path | integration | every push |
| Unlinked entry → needs-attention, reminder still sent; enqueue idempotent | auto-cancel-path | integration | every push |
| Live: real reminder + real Telegram confirm round-trip completes the fixture mission | auto-cancel-path | live (gated on TELEGRAM_BOT_TOKEN) | on demand + pre-release |
| Mark on an entry shown on the dashboard in the reader's words with its note; an unmarked entry bare (hardening repair) | auto-cancel-path | unit + integration (Next page on Chromium) | every push |
| Unbound person: reminder skip marked on the entry with how to bind, never over a stronger mark; flagged renewal recorded unlinked with no task and the reason on the entry; mark reaches the API (hardening repair) | reminder-path | integration (scan, worker composition, API) | every push |

The live round-trip is this sprint's terminal evidence: it retires the s3 deferral of the
real-bot proof. Everything else runs scripted so CI never depends on Telegram.
