# browser-substrate (s1c)

## Outcome

A BrowserProvider seam with LocalProvider (plain Playwright) and SolariProvider (profiles,
recording, stealth) implementations plus withBrowser() session hygiene (browser.close then
solari.close, self-tracked sessions) - CI proves one contract suite on LocalProvider, and a
secrets-gated live smoke opens a page through a real Solari browser, retrieves the recording,
and exits with zero leaked sessions.

## Why this boundary

Every engine that follows (watch-engine tiers, action-playbooks missions, agentic-mode) drives a
browser. This sprint is the only place the Solari SDK's real surface — and its sharp edges — get
encoded, so engines are written against correct assumptions instead of the draft's wrong ones
(`kill()` does not exist; `GET /sessions/:id` is dead; proxy failure is silent; the SDK's own
retry can double-create sessions). Source of record: research/solari-sdk-surface.md
(grade-annotated, verified against shipped `@solarisdk/browser@0.1.2` source).

## The seam invariant

**Requests are wishes; echoes are facts.** A provider echoes what was actually applied
(SessionMeta: proxy presence + tier, timezoneId, recording, storageState tri-state). Consumers
that require a capability assert on the echo, never on successful creation. This generalizes
Solari's documented silent-degradation posture ("assert on response fields, not the 201") into
the provider contract, so LocalProvider honestly echoes "not applied" for stealth/proxy/captcha
and engines behave identically against both.

## Specifications

- `specs/browser-provider-seam.md` (horizontal) — the BrowserProvider interface, SessionMeta
  echo contract, withBrowser() release guarantee, LocalProvider, and the provider contract test
  suite CI runs on LocalProvider.
- `specs/solari-session-hygiene.md` (horizontal) — SolariProvider on SDK `launch()`: lifecycle
  ordering (browser.close per session, solari.close only at dispose), self-tracked session
  ledger, option mapping, degradation echoes, typed error taxonomy, and provider-owned retry
  (SDK transport retry disabled to close the duplicate-create-on-timeout hole).
- `specs/live-smoke-path.md` (vertical) — scheduled/dispatched CI run → real Solari session with
  recording → page assertion → replay URL retrieval → zero-leak ledger assert; missing
  credential is an explicit skip, never a silent green.

## Non-goals

- No stealth, proxy, or captcha **live** proofs — the adapter maps and unit-tests those options,
  but paid-tier live behavior is proven where it is first needed (watch-engine tier-2, then
  real-site-hardening).
- No fixture-site involvement — the Solari cloud browser cannot reach localhost, so the live
  smoke targets a stable public page; fixtures stay the sibling sprint's concern and the
  contract suite drives local static content.
- No live-view / human-in-the-loop login surface — no documented API mints a watchable URL
  (research Q5); this stays an open decision owned before action-playbooks design closes.
- No profile CRUD workflows — the adapter passes `profileId` through and preserves the
  storageState tri-state; profile creation/save flows land with site connections (action-playbooks).
- No engine behavior — nothing here schedules, extracts, or decides.

## Prerequisites and external gates

- repo-foundation: workspace, CI harness, pnpm check conventions.
- **SOLARI_API_KEY** (external gate, owner: RubiksCubingGod): a Solari account + API key must
  exist and be added as a GitHub Actions secret before the live-smoke task can be verified
  end-to-end. Promo code STARTER1MO-MKY4BNDK grants a Starter month. Without the secret the
  smoke proves only its skip path.

## Task waves

provider-seam-local (2h) → solari-adapter (3h) → live-smoke-workflow (2h). Serial by necessity:
the adapter implements the seam, the smoke exercises the adapter.
