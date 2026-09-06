---
schema_version: 1
id: bot-io-runtime
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [chat-command-path, account-binding, calendar-wiring reminder and waiting_user
    delivery (s7), real-site-hardening alerting (s9)]
  cutover: Greenfield - all Telegram IO flows through this runtime; no other module touches
    grammY or the Telegram API.
origin:
  summary: The bot IO capability - grammY runtime with dev/prod transports, transcript
    persistence for every message, per-chat rate limiting, pending-question routing, and the
    internal sendToUser capability later sprints deliver notifications through.
  refs: [.nah/active/telegram-chat/README.md]
---

# Bot IO runtime

## Outcome

The `packages/bot` runtime: grammY with long-polling (dev) and webhook-ready (prod) transports
behind one config switch; middleware persisting every inbound and outbound message to the s1
`messages` table; per-chat token-bucket rate limiting; a message router that checks for a
pending task question for the bound user (answer routes to the question's answer sink;
otherwise to the chat loop); and typed `sendToUser(userId, message)` writing a delivery record
— the single outbound door s7 wires triggers and reminders into.

## Invariant

Exactly one module in the workspace imports grammY/Telegram APIs. Every message that reaches or
leaves the bot exists in the transcript — including refused and rate-limited ones. The
pending-question router never swallows a message: it goes to exactly one of question-answer
sink or chat loop.

## Consumers

chat-command-path and account-binding now; s7 consumes sendToUser for reminders and the real
waiting_user round-trip; s9 consumes it for live-suite red-run alerts.

## Failure behavior

Telegram API send failures record a failed delivery (retried per policy, observable), never
lost silently. Rate-limited chats get one notice per window, further messages dropped with
transcript records. In this sprint the pending-question sink is proven against a stub question
record — the real task gate arrives in s5/s7.

## Proof

Integration tests with the test transport: dev/prod transport config boots; transcript rows
for in/out/refused messages; rate limiter refuses floods with one notice; router sends an
answer to a stubbed pending question and normal chat to the loop; sendToUser writes the
delivery record and the message reaches the test transport; send-failure records failed
delivery.
