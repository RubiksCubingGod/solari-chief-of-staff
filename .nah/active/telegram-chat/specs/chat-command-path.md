---
schema_version: 1
id: chat-command-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A natural-language Telegram message from a bound user
  terminal: A CRUD effect visible through the API (or an honest refusal) and a reply message,
    both persisted to the transcript
origin:
  summary: The chat command path - inbound message through binding resolution, one budgeted
    Claude tool loop over CRUD-wrapping tools, effect, and reply - proven with scripted LLM
    transcripts and one live-LLM test.
  refs: [.nah/active/telegram-chat/README.md]
---

# Chat command path

## Outcome

A bound user says "watch this product and tell me if it drops under $20" with a URL; the tool
loop calls the watch-create tool (thin wrapper over the s1 CRUD route); the watch exists via
the API; the reply confirms with the created watch's identity. List and pause requests work the
same way through their tools. The loop is budgeted (max tool calls per message) and every
message pair lands in the transcript.

## Path

Telegram update → grammY → binding resolution → rate-limit check → Claude tool loop (Zod tools:
watch create/list/pause, calendar create/list, task status read) → CRUD API call → reply.
Refused states, each with a distinct polite reply and no side effects: unbound chat (one
how-to-bind reply), rate-limited, tool-budget exhausted, and a request no tool fits (the loop
must say so, not invent an action).

## Failure behavior

CRUD API refusals (typed 4xx from s1 validation) surface to the user as the validation reason,
not a generic error. LLM/API outage → apologetic retry-later reply, message still transcripted,
no partial effects. A tool loop can never call a tool outside its registered set.

## Proof

Integration tests with grammY test transport and scripted tool-runner transcripts: accepted
create/list/pause paths with API-visible effects; each refused state; CRUD-refusal passthrough;
outage behavior. One tagged @live-llm test: a real Claude call turns a phrasing variant into
the correct tool call.
