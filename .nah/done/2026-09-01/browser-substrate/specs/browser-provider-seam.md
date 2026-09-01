---
schema_version: 1
id: browser-provider-seam
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [watch-engine tier-1/2 fetchers, action-playbooks task missions, agentic-mode tool
    loop, real-site-hardening live runs]
  cutover: Greenfield - no superseded path; every browser touch in the system goes through this
    seam from the first engine onward.
origin:
  summary: One BrowserProvider interface with a SessionMeta echo contract and a withBrowser()
    release guarantee, implemented by LocalProvider and proven by a provider contract suite CI
    runs on every push.
  refs: [.nah/active/browser-substrate/README.md,
    .nah/projects/chief-of-staff/research/solari-sdk-surface.md]
---

# Browser provider seam

## Outcome

A `BrowserProvider` interface in `packages/solari` (ARCHITECTURE §11): request a browser session
with declared options (stealth, proxy, captcha, profileId, recording), receive a Playwright
`BrowserContext`/`Page` handle plus a `SessionMeta` echo of what was actually applied, and
release deterministically. `LocalProvider` implements it on plain Playwright chromium. A
provider contract test suite runs against any implementation; CI runs it on LocalProvider on
every push.

## Invariant

**Requests are wishes; echoes are facts.** `SessionMeta` reports the effective capabilities:
proxy presence and tier, timezoneId, recording availability, storageState tri-state
(undefined = no profile, null = empty profile, object = seeded). A consumer that requires a
capability asserts on the echo. LocalProvider echoes stealth/proxy/captcha as not-applied and
recording as unsupported — honestly, not by faking success.

## Consumers

watch-engine (tier-1/2 fetching and block detection), action-playbooks (recorded task missions),
agentic-mode (tool-loop browsing), real-site-hardening (live runs). Each acquires sessions only
through this interface; none imports a vendor SDK directly.

## Failure behavior

`withBrowser(provider, opts, fn)` guarantees release in a finally path — on success, on thrown
error inside `fn`, and idempotently on double release. Acquire failure throws a typed error and
leaves no tracked session. Providers never swallow release failures silently.

## Proof

Provider contract suite green on LocalProvider in `pnpm check` and CI (drives local static
content, no fixture dependency): acquire → navigate → assert → release; echo correctness for
unsupported options; withBrowser release on success, on error, and double-release idempotence.
