# watch-engine (s2)

## Outcome

Price and change watches run on schedule against fixtures with tiered fetching (HTTP, browser,
stealth), deterministic extractors created once by LLM, self-healing on selector breakage,
observation history, and trigger-to-notifier events.

## Why this boundary

This is the first engine: the recurring loop that makes the product alive. It composes
everything the foundation family built — pg-boss scheduling (s1), fixture state control (s1b),
the provider seam (s1c) — into the check pipeline. It ends at a **notifier port with a test
double**: real Telegram delivery is wired in calendar-wiring (s7), which depends on both this
sprint and telegram-chat.

## Design decisions

- **Tier ladder**: tier 0 = plain HTTP fetch; tier 1 = browser via provider seam; tier 2 =
  browser with stealth. Escalation on block detection; the working tier is persisted per watch
  and re-tried downward only on explicit reset. Block detection is entirely our code reading
  page content — the vendor delivers no block signal (research solari-sdk-surface Q6).
- **Extractors are created once, then deterministic**: on first check (or healing), the LLM
  produces an extractor spec (strategy + selector/pattern) stored on the watch; every
  subsequent check replays it without an LLM call. CI proves extraction with recorded pages and
  mocked LLM responses; a tagged @live-llm test proves real creation.
- **Self-healing is budgeted**: extraction failure triggers one re-creation attempt per
  breakage; repeated failure marks the watch degraded and emits a notifier event instead of
  looping spend.
- **Trigger semantics dedup**: a trigger fires on threshold crossing / content change against
  the last observation, never re-firing on the same value.
- Observation read API for the dashboard is dashboard-read's task (engine-free thin read);
  this sprint only writes observations.

## Specifications

- `specs/watch-check-path.md` (vertical) — scheduler tick → tiered fetch → extract → compare →
  observation row → trigger event to the notifier port, with failure states.
- `specs/tiered-fetching.md` (horizontal) — the fetch ladder, block detection from content,
  escalation policy, per-watch tier persistence.
- `specs/extractor-lifecycle.md` (horizontal) — LLM-created-once extractor specs, deterministic
  replay, budgeted self-healing, degraded state.

## Non-goals

- No Telegram delivery (notifier port + double here; real adapter lands via s3/s7).
- No slot watches (s8 extends the watch kinds).
- No real sites (s9), no dashboards (s4 reads what this writes).
- No per-check LLM calls — the LLM appears only at extractor creation/healing.

## External gates

- `ANTHROPIC_API_KEY` for the tagged @live-llm extractor-creation test (owner: RubiksCubingGod;
  CI proofs run mocked without it).

## Task waves

[watch-domain-model, tier0-http-fetcher] → [scheduler-wiring, browser-tier-fetcher,
llm-extractor-creation] → [self-healing, check-pipeline-integration, watch-config-surface]
