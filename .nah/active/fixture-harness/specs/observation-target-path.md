---
schema_version: 1
id: observation-target-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A fetching client - plain HTTP (watch-engine tier 0) or a LocalProvider browser page
    (tier 1) - requesting a fakestore product page or a fakenews article
  terminal: The value the client reads equals exactly what the control plane last set, or the
    fixture serves a documented refusal state (missing product, removed article)
origin:
  summary: The watch-facing half of the fixture set - a page whose observable value is settable
    and readable, so a price trigger or a content diff can be asserted rather than eyeballed.
  refs: [.nah/active/fixture-harness/README.md, docs/ARCHITECTURE.md]
---

# Observation target path

## Outcome

**fakestore** serves a product page carrying a price, a stock state, and a title. **fakenews**
serves an article page carrying a headline and body. Both are settable through the control plane
(`POST /__test/product/:id`, `POST /__test/article/:id`) and readable back through it
(`GET /__test/product/:id`, `GET /__test/article/:id`), and the rendered page always agrees with
the control plane's answer.

## Path

Control plane sets state → in-process store → server-rendered HTML → client fetch (HTTP or browser)
→ the value the client extracts. The round-trip is the whole point: watch-engine asserts "the
observation history recorded 19.99 because the fixture was at 19.99", and that sentence is only
true if the render and the control plane cannot disagree.

## Extraction surface

Semantic HTML with accessible names and roles, and a stable non-class hook (`data-testid`) on each
observable value. Two obligations follow from downstream consumers:

- watch-engine's extractors are LLM-created against the page and must survive `redesign` mode, so
  the semantic surface is the durable one and CSS classes are explicitly not a contract.
- agentic-mode drives these pages from the accessibility tree with no selector at all, so every
  observable value and every control has an accessible name.

This spec ships no selectors for downstream use. watch-engine derives its own; handing it one would
make the self-healing proof circular.

## Failure behavior

- A price set to a non-numeric or negative value is refused by the control plane with a typed 4xx;
  the rendered page is unchanged.
- Requesting an unseeded product or article returns a 404 page whose body is distinguishable from a
  blocked shell — watch-engine must be able to tell "gone" from "blocked", and they are different
  observations with different consequences.
- A product marked out of stock renders the stock state without a price, so an extractor that
  assumes a price is always present fails loudly rather than recording a stale one.

## Proof

Integration tests: set → render → read-back equality for price, stock, headline, and body; a second
set changes the rendered value within the same instance; refused control-plane writes leave the
page unchanged; 404 body distinguishable from the blocked shell; out-of-stock renders without a
price.
