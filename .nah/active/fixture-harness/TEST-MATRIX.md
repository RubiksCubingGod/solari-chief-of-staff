# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Two concurrent instances of one fixture kind hold independent state | fixture-harness-contract | integration | every push |
| `stop()` releases the port (proven by rebinding it) | fixture-harness-contract | integration | every push |
| `stop()` is idempotent; `stop()` after a failed start does not throw | fixture-harness-contract | integration | every push |
| An instance left running when its file ends fails the run | fixture-harness-contract | integration | every push |
| Control-plane call against a stopped instance yields a typed error, not a hang | fixture-harness-contract | integration | every push |
| TypeScript under `fixtures/` lints, typechecks, and builds in `pnpm check` | fixture-harness-contract | toolchain | local + CI |
| Set → render → read-back equality: price, stock, headline, body | observation-target-path | integration | every push |
| Refused control-plane write (negative/non-numeric price) leaves the page unchanged | observation-target-path | integration | every push |
| 404 body is distinguishable from the blocked shell | observation-target-path | integration | every push |
| Out-of-stock product renders stock state with no price | observation-target-path | integration | every push |
| fakegym: login → member area → 3-step flow → correct code → `{ cancelled: true }` | assisted-cancellation-path | integration (LocalProvider browser) | every push |
| fakegym: final step POSTed without traversal refused; nothing cancelled | assisted-cancellation-path | integration | every push |
| fakegym: wrong/absent code refused, member stays active | assisted-cancellation-path | integration | every push |
| fakegym: retention offer accepted lands `retained`, not `cancelled` | assisted-cancellation-path | integration | every push |
| fakegym: double-cancel idempotent; unauthenticated member area redirects | assisted-cancellation-path | integration | every push |
| fakegym: code readable only via `/__test`, absent from every reachable page and body | assisted-cancellation-path | integration | every push |
| fakedmv: publish slot → book → booking row names the winner | contested-booking-path | integration | every push |
| fakedmv: concurrent double-book yields one winner, one typed "gone", one booking row | contested-booking-path | integration | every push |
| fakedmv: slot withdrawn between listing and booking yields "gone", not a transient error | contested-booking-path | integration | every push |
| fakedmv: booking an unpublished slot id yields `gone`, not 404 | contested-booking-path | integration | every push |
| `blocked`: plain fetch gets the shell, LocalProvider browser gets content, same URL | hostile-mode-surfaces | integration | every push |
| `hard-blocked`: browser with no header gets the shell; seeded token gets content | hostile-mode-surfaces | integration | every push |
| `hard-blocked`: absent, malformed, and wrong-valued tokens all get the shell | hostile-mode-surfaces | integration | every push |
| `redesign` toggled live: URL unchanged, class names and ids change | hostile-mode-surfaces | integration | every push |
| `redesign`: accessible names, roles, text, and `data-testid` byte-identical to `normal` | hostile-mode-surfaces | integration | every push |
| `redesign` is deterministic: the same instance renders the same second layout | hostile-mode-surfaces | integration | every push |
| Unknown mode name refused; instance keeps its current mode | hostile-mode-surfaces | integration | every push |
| Mode set on one instance does not leak to another | hostile-mode-surfaces | integration | every push |
| CLI builds fixtures through the same factories the tests use | fixture-harness-contract | integration | every push |
| Documented routes, CLI registry, and compose ports agree (doc drift fails the build) | fixture-harness-contract | integration | every push |

No `@live` tier in this sprint, and there never will be one: a Solari cloud browser cannot reach
loopback fixtures (`browser-substrate`), so every proof above runs on LocalProvider or plain HTTP.
No manual attestations: every proof is a command proof.

Fixture tests are integration-project tests without exception — they bind ports. Coverage is not a
proof here: `fixtures/` sits outside the coverage `include` deliberately, and the harness earns
trust from the refusal and isolation rows above instead.
