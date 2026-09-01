---
schema_version: 1
id: solari-session-hygiene
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: horizontal
  consumers: [every browser-provider-seam consumer when configured for Solari, live-smoke-path]
  cutover: Greenfield - SolariProvider is the only code in the system that imports
    "@solarisdk/browser"; no other module may touch the vendor SDK.
origin:
  summary: SolariProvider on SDK launch() with correct lifecycle ordering, a self-tracked
    session ledger, degradation echoes, typed error taxonomy, and provider-owned retry that
    closes the SDK's duplicate-create-on-timeout hole. Every rule cites
    research/solari-sdk-surface.md.
  refs: [.nah/projects/chief-of-staff/research/solari-sdk-surface.md,
    .nah/projects/chief-of-staff/context/architecture-direction.md]
---

# Solari session hygiene

## Outcome

`SolariProvider` implements the seam on `@solarisdk/browser@0.1.2` via `launch()` (attach path
A — single-process provider owns the whole session lifetime; the loopback-endpoint constraint
does not bite us). All Solari sharp edges are encoded here, once, behind the seam.

## Lifecycle rules (each cites the research)

1. **Per-session teardown is `browser.close()`** — it closes the browser AND releaseAndWaits the
   session; closing the browser alone would hold the slot until `expiresAt` (research Q2).
2. **`solari.close()` only at `provider.dispose()`**, after all sessions are released — it stops
   the local proxy only, does NOT release sessions, and skipping it hangs the Node process
   (research Q2).
3. **Self-tracked session ledger**: no `GET /sessions` list exists and `GET /sessions/:id` is
   permanently dead, so the provider registers every id from the create response and removes it
   only on confirmed release. The ledger is readable so tests and the smoke can assert zero
   leaks. A failed release keeps its entry and surfaces (TS SDK: 404 + `InvalidSessionId` is a
   leak, not a success) (research Q2, hard gap 4).
4. **Provider-owned retry, SDK transport retry disabled** (`maxAttempts: 1`): the shipped SDK
   retries `POST /sessions` unconditionally on transport error, so a create that succeeds
   server-side but times out client-side would mint a second billable session whose id we never
   see. The provider never blind-resends session-create after a client-side timeout — it
   surfaces a typed failure and relies on the ~3.5-minute orphan reaper (research, Approach A).
5. **Degradation echoes**: after create, `session.proxy` presence, `proxy.tier`, and
   `timezoneId` are copied into SessionMeta (proxy resolution never errors — an unproxied
   session still returns 201). storageState tri-state is preserved (research Q3, Q6).
6. **Option mapping with preflight**: stealth/proxy/captcha/profileId/recording map to SDK
   create options; the documented cross-field rules (proxy and captcha each require stealth) are
   validated client-side into typed errors before spending a round trip (research Q6, Q7).
7. **Typed error taxonomy**: 429 `ConcurrencyLimitExceeded` → non-retryable capacity error (the
   docs are explicit that retrying cannot help); 502/503/504 → retryable; 402
   `FeatureRequiresPlan` and 428 client-version mismatch → configuration errors (research Q8).

## Consumers

Anything acquiring sessions through the seam when the deployment is configured for Solari, plus
the live smoke. No other module imports the vendor SDK — the import boundary is part of this
spec's claim.

## Failure behavior

`launch()` failure self-releases via the SDK before throwing (verified in shipped source), so a
thrown acquire does not leak. withBrowser guarantees release on engine errors. Release failure
retains the ledger entry and logs loudly. Dispose with live sessions releases them first, then
closes the client.

## Proof

Mocked-transport unit tests (inject the HTTP layer; no live calls in this spec — live proof
belongs to live-smoke-path): create/release ordering including dispose-after-release; ledger
add/remove and failed-release retention; **timeout-after-server-success sends exactly one
`POST /sessions`**; response omitting `proxy` echoes unproxied; 429 maps non-retryable; proxy
preflight rejects proxy-without-stealth locally; contract suite compiles against SolariProvider.
