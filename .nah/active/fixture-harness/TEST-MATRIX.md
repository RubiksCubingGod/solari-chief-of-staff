# Test Matrix

Every row states the layer that actually executes it. Where a spec asked for a proof driven by a
LocalProvider browser, the row says what runs today and what is still owed — `browser-substrate`
owns LocalProvider, and HANDOFF.md carries the same obligations in prose.

## Harness contract

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Two concurrent instances of one fixture kind hold independent state | fixture-harness-contract | integration (HTTP) | every push |
| `stop()` releases the port (proven by rebinding it) | fixture-harness-contract | integration (HTTP) | every push |
| `stop()` is idempotent on a repeated call | fixture-harness-contract | integration (HTTP) | every push |
| A failed start registers nothing, so it cannot trip a later leak assert; teardown after it does not throw | fixture-harness-contract | integration (HTTP) | every push |
| An instance left running when its file ends fails the run | fixture-harness-contract | integration (HTTP) | every push |
| Control-plane call against a stopped instance yields a typed error, not a hang | fixture-harness-contract | integration (HTTP) | every push |
| All four fixtures mount `state`, `seed` and `reset`; only the observation targets mount `mode` | fixture-harness-contract | integration (HTTP) | every push |
| `seed` sets a whole instance in one call; `state` reads back everything it knows | fixture-harness-contract | integration (HTTP) | every push |
| `reset` restores the seeded baseline after a mutation, without restarting the instance | fixture-harness-contract | integration (HTTP) | every push |
| A refused `seed` applies nothing — no half-applied state | fixture-harness-contract | integration (HTTP) | every push |
| TypeScript under `fixtures/` lints, typechecks, and builds | fixture-harness-contract | toolchain | local + CI |
| CLI builds fixtures through the same factories the tests use (factory identity, not lookalike) | fixture-harness-contract | integration (HTTP) | every push |
| Documented routes, CLI registry, and compose ports agree (doc drift fails the build) | fixture-harness-contract | integration (file + HTTP) | every push |
| Compose publishes all four ports on loopback, keeping `/__test` off the host network | fixture-harness-contract | integration (file) | every push |

## Observation targets

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Set → render → read-back equality: price, stock, headline, body | observation-target-path | integration (HTTP) | every push |
| A second set changes the rendered value within one instance | observation-target-path | integration (HTTP) | every push |
| Refused control-plane write (negative/non-numeric price, empty headline) leaves the page unchanged | observation-target-path | integration (HTTP) | every push |
| 404 body is distinguishable from the blocked shell | observation-target-path | integration (HTTP) | every push |
| Out-of-stock product renders stock state with no price | observation-target-path | integration (HTTP) | every push |
| Every observable value carries an accessible name and a `data-testid` hook | observation-target-path | integration (HTTP) | every push |
| Two instances of one site stay independent | observation-target-path | integration (HTTP) | every push |

## Cancellation flow

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| fakegym: login → member area → 3-step flow → correct code → `{ cancelled: true }` | assisted-cancellation-path | integration (HTTP, cookie jar) | every push |
| fakegym: final step POSTed without traversal refused; nothing cancelled | assisted-cancellation-path | integration (HTTP) | every push |
| fakegym: a later step refused to a session that skipped an earlier one | assisted-cancellation-path | integration (HTTP) | every push |
| fakegym: wrong/absent code refused, member stays active | assisted-cancellation-path | integration (HTTP) | every push |
| fakegym: retention offer accepted lands `retained`, not `cancelled` | assisted-cancellation-path | integration (HTTP) | every push |
| fakegym: double-cancel idempotent; unauthenticated member area redirects; unauthenticated POST refused | assisted-cancellation-path | integration (HTTP) | every push |
| fakegym: wrong credentials refused without opening a session | assisted-cancellation-path | integration (HTTP) | every push |
| fakegym: code readable only via `/__test/member/:id/code` — absent from every page, response body, and the state dump | assisted-cancellation-path | integration (HTTP) | every push |
| fakegym: member area exposes an accessible name and a hook for every control | assisted-cancellation-path | integration (HTTP) | every push |
| **Owed** — a browser drives the same flow through its rendered forms | assisted-cancellation-path | integration (LocalProvider) | `browser-substrate` |

## Contested booking

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| fakedmv: publish slot → book → booking row names the winner | contested-booking-path | integration (HTTP) | every push |
| fakedmv: concurrent double-book yields one winner, one typed `gone`, one booking row | contested-booking-path | integration (HTTP) | every push |
| fakedmv: many contenders for one slot still leave exactly one booking row | contested-booking-path | integration (HTTP) | every push |
| fakedmv: slot withdrawn between listing and booking yields `gone` | contested-booking-path | integration (HTTP) | every push |
| fakedmv: booking an unpublished slot id yields `gone`, not 404 | contested-booking-path | integration (HTTP) | every push |
| fakedmv: an already-taken slot yields `gone` | contested-booking-path | integration (HTTP) | every push |
| fakedmv: `transient` is distinguishable from `gone`, so a client can tell retry from re-arm | contested-booking-path | integration (HTTP) | every push |
| fakedmv: contention on two instances stays independent | contested-booking-path | integration (HTTP) | every push |

## Hostile modes

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| `blocked`: plain fetch gets the captcha shell on the unchanged URL | hostile-mode-surfaces | integration (HTTP) | every push |
| `blocked`: the served markup withholds every observable value | hostile-mode-surfaces | integration (HTTP) | every push |
| `blocked`: the real content travels only as a payload a script client must decode | hostile-mode-surfaces | integration (HTTP) | every push |
| `blocked`: running the shell's own script yields the content *and* flips the state marker to normal — one self-consistent document | hostile-mode-surfaces | integration (script executed against a test-owned DOM stub) | every push |
| **Owed** — a real browser renders that shell and reads the same document | hostile-mode-surfaces | integration (LocalProvider) | `browser-substrate` |
| `hard-blocked`: a request carrying no escalation marker gets the shell | hostile-mode-surfaces | integration (HTTP) | every push |
| `hard-blocked`: the seeded marker gets the real content | hostile-mode-surfaces | integration (HTTP) | every push |
| `hard-blocked`: absent, malformed, and wrong-valued tokens all get the shell (compared, not detected) | hostile-mode-surfaces | integration (HTTP) | every push |
| `redesign` toggled live: URL unchanged, class names and ids change | hostile-mode-surfaces | integration (HTTP) | every push |
| `redesign`: accessible names, roles, headings, text, and `data-testid` byte-identical to `normal`, on both sites | hostile-mode-surfaces | integration (HTTP) | every push |
| `redesign` is deterministic: the same instance renders the same second layout | hostile-mode-surfaces | integration (HTTP) | every push |
| Unknown mode name refused; instance keeps its current mode | hostile-mode-surfaces | integration (HTTP) | every push |
| Mode set on one instance does not leak to another | hostile-mode-surfaces | integration (HTTP) | every push |
| `?mode=` applies to one request only and never writes the stored mode | hostile-mode-surfaces | integration (HTTP) | every push |
| A stored mode stays in effect across requests until changed back | hostile-mode-surfaces | integration (HTTP) | every push |

## Tiers

The escalation header is supplied by the caller's fetch configuration, not by a browser provider,
so `hard-blocked` never needed a browser and is fully proven today.

No `@live` tier in this sprint, and there never will be one: a Solari cloud browser cannot reach
loopback fixtures, so every proof above runs on LocalProvider or plain HTTP. No manual
attestations: every proof is a command proof.

Fixture tests are integration-project tests without exception — they bind ports. Coverage is not a
proof here: `fixtures/` sits outside the coverage `include` deliberately, and the harness earns
trust from the refusal, isolation, and teardown rows above instead.
