# Deferred

Nothing deferred during bootstrap.

## How a server-to-server caller authenticates to the API is undecided

`magic-link-auth` replaced the `x-user-id` header with a signed session cookie, which is the
right credential for a browser and the wrong one for the Telegram bot: the bot has no browser,
and it acts on behalf of a user it identified by chat binding rather than by following a link.

The header could not stay. It was an unconditional bypass — anything able to reach the API could
claim to be any user by typing a UUID — so keeping it would have made this sprint's outcome a
fiction. And the session could not simply be minted server-side: `mintSessionCookie` is a test
credential by contract, and forging one in production is the exact thing the magic-link flow
exists to prevent.

So `packages/agent/src/crud.ts` now takes a **required, undefaulted**
`credential: (caller) => Record<string, string>` and sends what it is handed. Every current call
site is a test that mints its own cookie against a secret it configured, which is legitimate.
There is no production call site yet, so nothing is broken today — but the moment the bot is
wired to a real API, somebody has to decide what it presents.

**When a task owns this**, the likely shapes are a signed service token naming the acting user,
or an mTLS/private-network trust boundary with the user id carried in a header the network makes
unforgeable. Whichever is chosen, the test that belongs with it is the one that proves a caller
without the credential cannot act as a user — the property the old header never had. Do not
resolve it by giving `credential` a default; that default would be the bypass again, wearing a
different name.

## The `uuid` Ajv format is shadowed by ajv-formats, so `isUuid` never decides a request

Found while working this sprint, out of scope for every task in it, and left unfixed
deliberately: the fix touches route schemas across `packages/api` that a live sibling attempt
is editing.

`packages/api/src/formats.ts` registers its own `uuid` format, whose regex demands a version
nibble of 1-5 and a variant nibble of 8/9/a/b. But that file's own comment on `isIsoInstant`
already records the hazard it did not then apply to `uuid`:

> It is not registered as `iso-date-time`, which would read better: Fastify compiles schemas
> through ajv-formats, whose own `iso-date-time` makes the zone optional and silently wins over
> a format of that name declared here.

`uuid` is a name ajv-formats also ships, so the same silent win happens. Measured against a
bare Fastify configured exactly as `packages/api/src/app.ts` configures it
(`allErrors: true`, `coerceTypes: false`, `formats: AJV_FORMATS`), four of six cases disagree:

| value | `isUuid` | the server |
|---|---|---|
| `3f2504e0-4f89-41d3-9a0c-0305e82c3301` (v4) | accept | accept |
| `018f7b2c-1234-7abc-8def-0123456789ab` (version nibble 7) | refuse | **accept** |
| `018f7b2c-1234-0abc-8def-0123456789ab` (version nibble 0) | refuse | **accept** |
| `3f2504e0-4f89-41d3-ca0c-0305e82c3301` (variant nibble c) | refuse | **accept** |
| `urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3301` | refuse | **accept** |
| `not-a-uuid` | refuse | refuse (400) |

So `isUuid` is exported, unit-tested, and dead in the HTTP path: the suite asserts a stricter
contract than the server enforces, which is worse than having no check, because the test reads
as evidence for something untrue.

The consequence is not only cosmetic. The `urn:uuid:` form reaches the database, and Postgres
refuses it there instead:

```
select 'urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3301'::uuid
  -> 22P02 invalid input syntax for type uuid
```

A `pg` error carries no `statusCode`, and `packages/api/src/app.ts:82` reads
`error.statusCode ?? 500`, so a malformed id arrives as a **500 `internal_error`** rather than
as the 400 the validation pass exists to produce. Every route with a `:id` param is affected -
`watches`, `tasks`, `calendar-items`, and `GET /watches/:id/observations`.

**The fix, when a task owns it:** rename the format the way `iso-instant` was renamed - a name
ajv-formats does not ship - and update every `format: 'uuid'` in the route schemas to match.
Add a case to the API's validation tests for a version-7 UUID and for the `urn:uuid:` form, so
the rename is proven rather than assumed. Do not simply delete `isUuid` in favour of
ajv-formats' version: the strictness is wanted, and `urn:uuid:` reaching a query is the reason.
