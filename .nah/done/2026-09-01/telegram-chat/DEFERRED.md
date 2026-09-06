# Deferred

Nothing deferred during bootstrap.

## Advisory (resolved, with one thing still open): how this sprint's proofs authenticate

Raised while closing `chat-integration-proof`, when the change below was still
uncommitted work in a sibling sprint with a live owner. It has since landed,
the four proofs named below were repaired against it, and all of them are
green. What follows is kept because the decision at the end of it is still
open.

**What changed.** `dashboard-read` has replaced `packages/api/src/caller.ts`
wholesale. The `x-user-id` header is gone — "No fallback to the header remains,
deliberately" — and `resolveCaller` now reads a signed session cookie
(`SESSION_COOKIE_NAME`, `verifySessionToken`, `signSession`). That is the right
change: a caller-chosen header is a caller-chosen identity.

**What it broke.** Every chat tool call goes out through
`createHttpCrudClient`, which sent `CALLER_HEADER`. Once that work landed the
client was unauthenticated and the API answered 401, so these proofs went red
and were repaired:

- `tests/chat-front-door.integration.test.ts` (this task)
- `packages/agent/src/chat-agent.integration.test.ts`
- `packages/api/src/routes.integration.test.ts`
- `packages/api/src/routes/binding-codes.integration.test.ts`

`packages/bot` is untouched: it never had the header, and the composed suite
above reads the API back through the same `CrudClient` port the tools use
rather than setting a header itself. So the repair is one file.

**What was done.** `createHttpCrudClient` now takes a required `credential:
CrudCredential` — a function from caller to headers — and the suites pass
`mintSessionCookie(caller, secret)`, which `@chief-of-staff/api` documents as
test-only.

**What is still open.** That credential is a browser-style user session, and
production will not use one. The decision this sprint cannot make alone is
unchanged: whether the bot process holds the session secret, or whether the API
grows a service-to-service credential that is not a user session at all.
`crud.ts` says so in its own comment. Whoever wires the bot's entry point in
`calendar-wiring` (s7) inherits it, since nothing runs the bot in production
yet.

## Advisory: a reply Telegram refuses is reported, but not retried

Raised in hardening round three, alongside the repair that stopped such a
refusal from ending the polling loop (`harden-reply-failure-stops-bot`).

The outbound door retries per `DEFAULT_SEND_RETRY_POLICY` and writes a
`deliveries` row either way, because a reminder is a queued thing that nobody
is sitting in front of. A reply from the middleware does neither: one attempt,
and on failure a line through `logUpdateFailure`. So a transient Telegram 5xx
loses one answer, where the same 5xx on a reminder would be retried twice more.

Left as it is deliberately. A reply is the second half of a live exchange, not
a queued delivery: the person is in the chat, the failure is now observable,
and resending is a message rather than an incident. Making replies retryable
means either routing them through `sendToUser` — which needs a user id the
middleware does not always have, and would write a delivery row for every
sentence the bot says — or a second retry path beside the first. Both are
bigger than the harm, and s7 is where the bot's entry point is written anyway.
