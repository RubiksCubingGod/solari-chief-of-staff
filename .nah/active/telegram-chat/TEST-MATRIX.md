# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Transport config boots long-poll and webhook modes | bot-io-runtime | integration (test transport) | every push |
| Transcript rows for inbound/outbound/refused; rate limiter one-notice-per-window | bot-io-runtime | integration | every push |
| Binding accepted path; expired/unknown/consumed/rebind refusals; consume+bind atomicity | account-binding | integration (Testcontainers) | every push |
| Unbound chatter → single how-to-bind reply | account-binding | integration | every push |
| NL → watch create/list/pause with API-visible effects (scripted LLM) | chat-command-path | integration | every push |
| Budget exhaustion, no-tool-fits, CRUD 4xx passthrough, LLM outage | chat-command-path | integration | every push |
| Pending question answer → stub sink; normal chat → loop; exactly one destination | bot-io-runtime | integration | every push |
| sendToUser delivery record + test-transport arrival; unbound typed error; failed delivery recorded | bot-io-runtime | integration | every push |
| Real Claude maps a phrasing variant to the correct tool call | chat-command-path | @live-llm (ANTHROPIC_API_KEY) | nightly + manual |
| Composed front-door suite: bind → ask → effect → reply, all refusals, transcripts complete | chat-command-path | integration | every push |

Real-bot round-trip (live Telegram) is deliberately deferred to calendar-wiring (s7). An
optional manual sanity check with a real token is documented in the sprint README but never a
gate.
