# telegram-chat (s3)

## Outcome

A bound Telegram bot where natural language becomes structured CRUD API calls through one
Claude tool loop, with one-time-code account binding, pending-question routing, transcript
persistence, and rate limiting.

## Why this boundary

The chat surface is the product's front door and is deliberately engine-free: every chat tool
is a thin wrapper over the s1 CRUD API, so this sprint lands in parallel with watch-engine and
needs only repo-foundation. The **real** Telegram round-trip for task questions (waiting_user)
is deliberately not here — it is proven in calendar-wiring (s7), where chat, engines, and the
task gate first coexist. Here the pending-question router is built and proven with a test
transport against a stub question record.

## Design decisions

- grammY runtime, long-polling in dev, webhook-ready config for production (activated at
  challenge-launch). CI proofs use grammY's test transport — no network, no live bot.
- One Claude tool loop (Anthropic tool runner + Zod tools) per incoming message, with tool
  wrappers for: watch create/list/pause, calendar item create/list, task create ("cancel my
  gym" lands a queued task row; execution is s5's) and status read. The loop
  has a hard tool-call budget per message. CI proofs script the LLM (mocked tool-runner
  transcripts); one tagged @live-llm test exercises a real Claude call.
- Binding: the API issues a one-time code (consumed later by dashboard/CLI); the user sends
  `/start <code>`; the chat id binds to the user row. Unbound chats get exactly one
  how-to-bind reply and are otherwise refused.
- Every inbound and outbound message persists to the s1 `messages` table (transcript is a
  product feature and a debugging tool).
- An internal typed `sendToUser` capability (outbound message + delivery record) is exposed for
  later sprints — s7 connects watch triggers and reminders to it. No notifier wiring here.
- Rate limiting per chat (token bucket) refuses floods with a polite message, protecting both
  the Anthropic budget and the API.

## Specifications

- `specs/chat-command-path.md` (vertical) — message in → bound user → Claude tool loop → CRUD
  effect → reply out, with refused states (unbound, over-budget, rate-limited, nonsense).
- `specs/account-binding.md` (vertical) — code issued → /start consumed → chat bound; refused
  states (bad code, reused code, already-bound chat).
- `specs/bot-io-runtime.md` (horizontal) — grammY runtime, transports, transcript persistence,
  rate limiting, pending-question routing, and the internal sendToUser capability.

## Non-goals

- No notification delivery wiring (s7 connects triggers/reminders to sendToUser).
- No real-bot round-trip proof (s7); a manual live sanity check with a real token is optional
  here, never a gate.
- No group-chat support; one chat binds to one user.
- No payment/confirmation semantics (the waiting_user gate lands in s5, wired to Telegram in s7).

## External gates

- `TELEGRAM_BOT_TOKEN` (owner: RubiksCubingGod, via BotFather) — optional here (manual sanity
  check only), required by s7's live round-trip and challenge-launch.
- `ANTHROPIC_API_KEY` for the tagged @live-llm test.

## Task waves

[bot-runtime] → [account-binding, claude-tool-loop, outbound-send] → [pending-question-routing]
→ [chat-integration-proof]

## Optional manual live-bot sanity check

Never a gate, and deliberately not scripted. CI proves the whole front door
against grammY's test transport in `tests/chat-front-door.integration.test.ts`,
and the real Telegram round-trip belongs to `calendar-wiring` (s7). This sprint
ships the runtime a process will start, not the process: nothing in `scripts/`
runs the bot yet, which is why the steps below are done by hand.

What it buys, and the only thing it buys, is the one fact no test transport can
report: that a real token, a real long poll and a real phone agree with each
other. Needs `TELEGRAM_BOT_TOKEN` (minted with @BotFather) and
`ANTHROPIC_API_KEY` in `.env`; both stay blank in `.env.example`.

1. `docker compose up -d`, `pnpm migrate`, then `pnpm start` in its own
   terminal. The chat tools reach the API over HTTP like any other client, so
   the API has to be up for anything past `/start` to work.
2. Start a runtime by hand against that API — `createBotRuntime` from
   `@chief-of-staff/bot` with `config: loadBotConfig()`, the process database,
   and a `chatLoop` built the way `chatLoopOver` builds one in the composed
   suite: `createChatAgent` over a real `Anthropic` client and
   `createHttpCrudClient({ baseUrl })`. Then `await runtime.start()`. Nothing is
   committed for this; the wiring is five lines and s7 lands the real one.
3. Insert a `binding_codes` row for your user, send `/start <code>` from
   Telegram, and expect the confirmation reply.
4. Ask for something in your own words — "watch <url> and tell me if it drops
   below £20". Expect a reply that names what it did, a matching `watches` row,
   and two `messages` rows for the exchange.
5. Whatever happens is a finding, not evidence. A pass records nothing; a
   failure becomes a task.
