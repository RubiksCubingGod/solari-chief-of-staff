---
schema_version: 1
id: live-smoke-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A scheduled (nightly) or manually dispatched GitHub Actions run
  terminal: An observable green, red, or explicitly-skipped check with a replay URL retrieved
    and a zero-leaked-sessions assertion
origin:
  summary: The composed real-vendor path - CI event through SolariProvider to a live Solari
    browser, page assertion, recording retrieval through the 404-polling window, and clean
    teardown proven by an empty session ledger.
  refs: [.nah/projects/chief-of-staff/research/solari-sdk-surface.md,
    .nah/active/browser-substrate/specs/solari-session-hygiene.md]
---

# Live smoke path

## Outcome

A `@live`-tagged test suite plus a GitHub Actions workflow (nightly schedule + manual dispatch,
never on ordinary pushes) that proves the SolariProvider against the real vendor: create a
recorded session on the default fast pool (no stealth — runs on any plan), load a stable public
page, assert content, tear down cleanly, retrieve the replay.

## Path

Workflow event → `SOLARI_API_KEY` from Actions secrets → `withBrowser(solariProvider,
{recording: true}, …)` → `page.goto` a stable public URL (https://example.com — the cloud
browser cannot reach localhost, so fixtures are out of reach by design) → title assertion →
~2 s pause so rrweb flushes batched events → release (browser.close, which releaseAndWaits) →
poll `getReplayUrl` through expected 404s for up to ~30 s → assert the URL arrives → record
which bytes Node's fetch returns (gzipped vs pre-decompressed NDJSON is an open research
question; the answer gets committed as a comment/type where a future parser will live) → assert
the provider ledger is empty → `dispose()` → workflow status.

## Refused / absent path

Missing `SOLARI_API_KEY` secret → the suite reports an **explicit skipped status** (visible in
the check UI as skipped, with the reason). A silent green without touching the vendor is a spec
violation. A leaked session (non-empty ledger after dispose) fails the run even if the page
assertion passed.

## Cost posture

One session, seconds long, fast pool, no proxy egress: fractions of a cent per run at Starter
rates. Nightly cadence is affordable and is the early-warning line for vendor drift (young
vendor, no third-party production evidence — research coverage note).

## Proof

One workflow run with the secret present: green end-to-end including replay retrieval and the
empty-ledger assert. One run without the secret: explicitly skipped, not green. Both runs
linked from the sprint PR.
