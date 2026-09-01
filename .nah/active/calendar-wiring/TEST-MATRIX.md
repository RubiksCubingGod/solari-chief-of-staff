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

The live round-trip is this sprint's terminal evidence: it retires the s3 deferral of the
real-bot proof. Everything else runs scripted so CI never depends on Telegram.
