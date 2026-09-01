# Fixture sites

Four controllable sites the integration tests boot, seed, and assert against. A test names a
fixture and a state and gets a private instance in exactly that state: instances are in-process on
an ephemeral loopback port, and Vitest runs each test file in its own worker, so isolation comes
from the boot model rather than from a reset call somebody has to remember.

```ts
const store = await startFakestoreFixture();
await store.control.setProduct('drill', { title: 'Cordless Drill', price: 19.99, stock: 'in_stock' });
// ... drive store.url ...
await store.stop();
```

## One boot path

The `start*Fixture()` factories are the only way a fixture comes up. `pnpm fixtures:dev` and the
`fixtures` service in `docker-compose.yml` are entry points into those same factories, never a
second implementation. `fixtures/src/registry.ts` holds that mapping, and
`dev-entrypoint.integration.test.ts` asserts the identity of the factories, checks the ports below
against `docker-compose.yml`, and checks the route lists below against the routes each fixture
actually mounts. Documentation drift fails the build.

## LocalProvider only, permanently

These sites listen on loopback. A Solari cloud browser cannot reach them, so every fixture proof in
every sprint runs on LocalProvider (plain Playwright) or over plain HTTP. Nothing here is reachable
from the `@live` tier, and no fixture proof should expect a Solari session, recording, or replay URL.

## The shared control plane

Every fixture mounts the same three routes, from `mountInstanceRoutes` in `harness.ts` rather than
from four routers that happen to agree:

| Route | Meaning |
| --- | --- |
| `GET /__test/state` | everything the instance knows, as JSON |
| `POST /__test/seed` | set the whole starting state in one call; refused seeds apply nothing |
| `POST /__test/reset` | return the instance to the baseline its last seed established |

Isolation still comes from the boot model, not from `reset` — two instances never share state and
never needed resetting to be independent. `reset` is for a test that wants several rounds against
one instance without paying for another boot.

`POST /__test/mode` is mounted by the observation targets only. Modes are defined by
`hostile-mode-surfaces` for pages an engine *observes*; there is no specified meaning for a
`redesign`ed booking POST, so the flow fixtures do not pretend to have one.

## Hostile modes

Any observation target (`fakestore`, `fakenews`) can be put into a mode through
`POST /__test/mode`, taking effect on the next request to the same URL. `?mode=` on a single
request overrides for that request only, for manual pokes; it never writes the stored mode. An
unknown mode is refused with a 400 and the instance keeps the mode it had.

| Mode | Fetch surface | Selector surface |
| --- | --- | --- |
| `normal` | the page as specified | the normal layout |
| `blocked` | captcha shell to a plain fetch; the body travels base64-encoded in a script, so only a client that executes JavaScript materializes it — and that script flips `fixture-state` to normal with the body, so a client never holds normal content still labelled blocked | normal |
| `hard-blocked` | captcha shell with no recoverable body; the real content is served only to a request carrying the escalation header | normal |
| `redesign` | normal | class names, ids, and nesting rotate to a deterministic second layout |

A mode never changes the URL, and `redesign` never changes the semantic surface: accessible names,
ARIA roles, heading structure, visible text, and `data-testid` hooks stay byte-identical.

### The escalation header

`hard-blocked` serves real content only to a request whose `X-Fixture-Escalation` header exactly
equals the instance's token — seeded with `POST /__test/seed` (field `escalationToken`), defaulting
to `fixture-escalation-token`. The header is supplied by the caller's tier-2 fetch configuration,
not by the browser provider: LocalProvider honestly echoes stealth as *not applied*, so a mode gated
on the provider's own echo would be unreachable in CI forever. Nothing in `packages/solari` knows
these fixtures exist.

This proves that an engine's escalation state machine reached its tier-2 branch, because only that
branch sends the header. It does **not** prove that stealth defeats real bot detection — that claim
belongs to the `@live` tier.

## Sites

### fakestore (port 4301)

A product page carrying a price, a stock state, and a title. An out-of-stock product renders its
availability and no price at all. An unseeded product is served as a 404 whose body is
distinguishable from the blocked shell.

```routes
GET /product/:id
GET /__test/mode
POST /__test/mode
GET /__test/state
POST /__test/seed
POST /__test/reset
GET /__test/product/:id
POST /__test/product/:id
```

### fakenews (port 4302)

An article page carrying a headline and body, with the same mode contract as fakestore.

```routes
GET /article/:id
GET /__test/mode
POST /__test/mode
GET /__test/state
POST /__test/seed
POST /__test/reset
GET /__test/article/:id
POST /__test/article/:id
```

### fakegym (port 4303)

A login, a member area, and a three-step cancellation flow ending at a confirmation-code gate. Flow
progress is held per session on the server, not in the URL. The confirmation code appears on no
reachable page and in no response body: it is readable only through `GET /__test/member/:id/code`,
which is what makes "the engine actually asked the user" provable. Refusals are typed —
`unauthenticated`, `step-skipped`, `wrong-code` — and accepting the retention offer ends the flow in
`retained` rather than `cancelled`.

```routes
GET /
GET /login
POST /login
GET /member
GET /cancel/step-1
POST /cancel/step-1
GET /cancel/step-2
POST /cancel/step-2
GET /cancel/step-3
POST /cancel/step-3
GET /cancel/confirm
POST /cancel/confirm
GET /__test/state
POST /__test/seed
POST /__test/reset
POST /__test/member
GET /__test/member/:id
GET /__test/member/:id/code
```

### fakedmv (port 4304)

An appointment calendar whose slots are published and withdrawn through the control plane. A
contested slot is awarded exactly once under concurrency; losers are refused as `gone`, which is
deliberately distinct from the `transient` refusal that `POST /__test/failure` injects — one means
re-arm, the other means retry.

```routes
GET /appointments
POST /book
GET /__test/state
POST /__test/seed
POST /__test/reset
GET /__test/slots
POST /__test/slots
DELETE /__test/slots/:id
GET /__test/bookings
POST /__test/failure
```

## Running them by hand

```sh
pnpm fixtures:dev            # all four on the ports above
docker compose up fixtures   # the same four, same factories, in a container
```

Both stay on loopback. `/__test/*` is an unauthenticated, mutable control plane, and the only
reason that is acceptable is that an instance is never reachable off the host — so the compose
service publishes `127.0.0.1:<port>:<port>` rather than the bare mapping, and
`dev-entrypoint.integration.test.ts` fails the build if a port loses that binding.

`fixtures/` is deliberately outside the coverage gate (`packages/*/src/**`). Test infrastructure
earns trust from its own behavioral proofs — isolation, teardown, refusal paths — not from a
coverage number on code whose only consumer is tests.
