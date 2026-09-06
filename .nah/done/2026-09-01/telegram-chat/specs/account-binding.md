---
schema_version: 1
id: account-binding
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A one-time binding code issued through the API, then sent by a Telegram user as
    /start <code>
  terminal: The chat id durably bound to the user row (site of all later authorization), or a
    refused state with nothing bound
origin:
  summary: One-time-code account binding - issue, consume, bind, refuse - the authorization
    root for every chat interaction.
  refs: [.nah/active/telegram-chat/README.md]
---

# Account binding

## Outcome

`POST /binding-codes` (authenticated API surface) issues a short-lived one-time code for a
user. The user sends `/start <code>` to the bot; the chat id binds to that user row; every
later message resolves through this binding. Codes expire, are single-use, and binding is
idempotent for the same chat+user.

## Path

Accepted: issue code → /start with it → bound confirmation reply → subsequent message resolves
to the user. Refused, each with a distinct reply and no binding row: expired code, unknown
code, already-consumed code, /start with a code while the chat is already bound to a different
user (must not silently rebind — requires explicit unbind first).

## Failure behavior

Binding writes are transactional with code consumption — a crash between consume and bind
cannot burn a code without binding (single transaction). Unbound chats sending anything other
than /start get exactly one how-to-bind reply per rate window.

## Proof

Integration tests (test transport + Testcontainers): the accepted path end to end; all four
refused states; code expiry; consume+bind atomicity (fault injection between steps); unbound
chatter gets the single how-to-bind reply.
