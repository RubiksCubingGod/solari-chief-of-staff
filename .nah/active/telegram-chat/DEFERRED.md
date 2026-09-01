# Deferred

Nothing deferred during bootstrap.

## Advisory: `dashboard-read` removes the seam this sprint's proofs call through

Raised while closing `chat-integration-proof`. Not repaired here: the change is
uncommitted work in a sibling sprint with a live owner, and repairing somebody
else's working tree is not this sprint's to do.

**What changed.** `dashboard-read` has replaced `packages/api/src/caller.ts`
wholesale. The `x-user-id` header is gone — "No fallback to the header remains,
deliberately" — and `resolveCaller` now reads a signed session cookie
(`SESSION_COOKIE_NAME`, `verifySessionToken`, `signSession`). That is the right
change: a caller-chosen header is a caller-chosen identity.

**What it breaks.** Every chat tool call goes out through
`createHttpCrudClient`, which sends `CALLER_HEADER`. Once the sibling's work
lands, that client is unauthenticated and the API answers 401, so these
committed proofs go red:

- `tests/chat-front-door.integration.test.ts` (this task)
- `packages/agent/src/chat-agent.integration.test.ts`
- `packages/api/src/routes.integration.test.ts`
- `packages/api/src/routes/binding-codes.integration.test.ts`

`packages/bot` is untouched: it never had the header, and the composed suite
above reads the API back through the same `CrudClient` port the tools use
rather than setting a header itself. So the repair is one file.

**The repair, when their work lands.** `createHttpCrudClient` is the only place
the header appears; give it a way to mint a server-side session for `caller`
instead — their exported `signSession(userId, secret, expiresAt)` is currently
the only door a server-side caller has. That needs a decision this sprint
cannot make alone: whether the bot process holds the session secret, or whether
the API grows a service-to-service credential that is not a user session at
all. Whoever wires the bot's entry point in `calendar-wiring` (s7) inherits it
either way, since nothing runs the bot in production yet.
