---
schema_version: 1
id: extractor-lifecycle
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [watch-check-path extraction step, slot-sniping slot extraction (s8),
    real-site-hardening live extractor creation (s9)]
  cutover: Greenfield - every watch's extraction runs a stored extractor spec; no ad-hoc
    parsing in check code.
origin:
  summary: LLM-created-once deterministic extractors - creation from a page snapshot, stored
    spec replay on every check, budgeted self-healing on breakage, and an observable degraded
    state when healing fails.
  refs: [.nah/active/watch-engine/README.md,
    .nah/active/fixture-harness/specs/hostile-mode-surfaces.md]
---

# Extractor lifecycle

## Outcome

An extractor spec schema stored on the watch (strategy + selector/pattern + value parsing,
e.g. price-from-selector or content-digest-of-region), a creation step that asks Claude to
produce a spec from a page snapshot and validates it by immediate replay before storing, a
deterministic replay engine used on every check (no LLM), and budgeted self-healing: on
extraction failure, one re-creation attempt per breakage; if replay still fails, the watch is
marked degraded and a notifier event fires.

## Invariant

Checks are LLM-free: between creation and breakage, the marginal cost of a check is zero LLM
tokens. A spec is stored only after it has successfully replayed against the page it was
created from. Healing spend is bounded: one creation call per breakage incident, never a loop.

## Consumers

watch-check-path's extract step; s8 reuses it for slot lists; s9 exercises live creation on
real sites.

## Failure behavior

Creation returning an invalid or non-replaying spec → creation fails observably; the watch
stays in needs-extractor state with the error recorded. Post-healing failure → degraded state +
notifier event, checks continue recording error observations without LLM spend.

## Proof

Unit tests with recorded fixture pages and mocked LLM responses: creation-validate-store,
deterministic replay, invalid-spec refusal. Integration: fakestore redesign mode breaks the
stored selector → healing recreates against the new DOM → next check extracts (the s1b
redesign bait, sprung); forced double-failure → degraded state + notifier event. Tagged
@live-llm test: real Claude call creates a working extractor for a fixture page.
