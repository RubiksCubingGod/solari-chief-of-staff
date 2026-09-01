# Handoff

No execution handoff yet.

## Shared-tree lockfile race (blocking `provider-seam-local` closure)

`provider-seam-local` is implemented and all five declared proofs have green receipts
(seam-red, local-red, seam-green, local-green, seam-gate). Closure waits on one thing only.

The working tree is shared with a live sibling session working `dashboard-read`. A single
`pnpm-lock.yaml` now carries both changes: my `playwright@1.62.1` under `packages/solari` and
their `embedded-postgres@17.10.0-beta.17` under `packages/db`, plus four `@embedded-postgres/*`
entries their uncommitted `pnpm-workspace.yaml` `allowBuilds` change authorizes. Their
`packages/db/package.json` and `pnpm-workspace.yaml` are still uncommitted.

Evidence, not inference: the tree's lockfile `packages/db` importer declares `embedded-postgres`
as a devDependency that HEAD's `packages/db/package.json` does not request. Committing the
lockfile with only my files fails `pnpm install --frozen-lockfile` with an outdated-lockfile
error; omitting it fails the same command the other way, because `packages/solari/package.json`
would then request a dependency the lockfile lacks.

Classified `live-owner`, which `.nah/config.yaml` lists as retryable. Deliberately not repaired
in place: regenerating a HEAD-only lockfile would overwrite a file a live session is still
writing. Order matters and favours waiting - if the sibling commits first, HEAD is inconsistent
only for the seconds `nah task finish` takes; if I commit first it stays inconsistent for as long
as they keep working. Resolution: wait for their manifest commit, then finish immediately.

**Resolved to a bounded wait (re-probe, 17:2x).** The owner is `chief-of-staff-3c`, which confirmed
the change is its own - `embedded-postgres` as a third rung on the test-database ladder
(server -> container -> embedded) - and that all three files land atomically in one
`nah task finish telegram-chat bot-runtime`, ETA ~10-15 minutes. That downgrades this from an
open-ended live-owner wait to a bounded one, so no repair is warranted.

An in-place repair was built and then abandoned on purpose. A scratch git worktree at HEAD, with
only `packages/solari/package.json` applied, produced a lockfile that is exactly HEAD plus
`playwright@1.62.1`, `playwright-core@1.62.1` and `fsevents@2.3.2`, removing nothing (the single
changed line is `packages/solari: {}` expanding). Swapping that in for the commit and restoring
the shared copy immediately after was refused by this session's permission classifier, correctly:
it is a write to a file a live session is using. It was surfaced to the operator rather than
routed around, and the owner's ETA made it unnecessary. The worktree has been torn down and the
working-tree lockfile was never modified.

Note for whoever reads the history: the sibling's commit will carry this sprint's `playwright`
lockfile entries without `packages/solari/package.json`, so HEAD fails
`pnpm install --frozen-lockfile` for the minute between their commit and this task's. That
window is unavoidable with one lockfile and two live sessions; it was taken in the direction
where this session closes it rather than opens it.

## Live smoke findings (`live-smoke-workflow`)

Two things a fake could not have told us. Both were found by the first real vendor run, and both
are now pinned by tests.

**The vendor ships no default context.** `@solarisdk/browser`'s own type comment says "Sessions
ship with a default context at `contexts()[0]`". They do not. A freshly launched session reports
`contexts().length === 0`, and a context appears only once something opens one. The adapter treated
that as an internal error, so *every* real acquire aborted - while all 34 unit tests passed, because
the fake handle returned a context and so encoded the documentation rather than the behaviour.
Observed against the real gateway: Chromium 151.0.7922.34, launch ~750ms, contexts 0 rising to 1
after `newPage()`. `acquire()` now opens the context itself, and still reuses a shipped one if the
vendor ever starts honouring its comment. This is the whole argument for the live smoke existing:
it is the only test in the package that could have caught it.

**The replay arrives already decompressed.** The API reports `contentEncoding: "gzip"` and the
presigned response also carries `content-encoding: gzip` - which is precisely why what a Node caller
receives is *not* gzipped: undici inflates it on the way past. One `example.com` visit yielded 2427
bytes of plain NDJSON, after 4 polls through the 404 window. A replay parser written against Node's
`fetch` must not gunzip; one using a client that does not auto-decompress must. Both ways of being
wrong fail quietly, so the shape is reported by `runLiveSmoke` and asserted by the live suite, and
the mechanism is covered without spending anything by a local-server test that serves identical
bytes with and without the header.

**Cost control.** The live suite sits in the ordinary `integration` project rather than being
excluded in `vitest.config.ts`, so it stays typechecked, linted and loadable; `SOLARI_LIVE_SMOKE` is
what keeps it from running. A key alone is not consent to spend it - which matters here, because the
gate machine has a real key in `.env`. `node scripts/live-smoke.mjs` is the deliberate opt-in, and it
refuses to run without a key rather than skipping, because a skipped suite exits zero and would
report a live run that never happened.

## What `live-smoke-workflow` cannot close by itself

`done_when` asks for two CI runs linked from the sprint PR. The composed vendor path is proven here
(`live-green`, against the real gateway), but the workflow-run half needs three things this session
has no authority for, recorded as a `credential` external gate:

1. `SOLARI_API_KEY` added as a GitHub Actions repository secret.
2. A push - nothing in this sprint has been pushed yet.
3. A sprint PR linking one secret-configured run (green) and one without (the `live-smoke` job
   reports **skipped**, by way of the `guard` job, because a green run that called nothing is the
   one outcome the workflow must never produce).

## Gate state at closure

`smoke-gate` runs the whole workspace gate in a tree shared with two live sibling sessions
(`dashboard-read`, `telegram-chat`). Failures seen there and attributed, none in this sprint's files:
`packages/web/**` is `dashboard-read`'s uncommitted work in progress; `packages/api` and
`packages/db` timeouts are machine starvation and pass in isolation. `packages/solari` and
`tests/ci-workflow.test.ts` are green, and the live suite reports **skipped** in the ordinary run
rather than failing it - which is the half of the claim this sprint owns.

<!-- nah-checkpoint:72457f6ad6cab5e7 -->
## 2026-09-01T16:46:26.829Z · claude-code · 51522b6a-8e7b-496e-8bbd-9ba19dc976a1

- Stage: implementation
- Ready: none
- In progress: provider-seam-local
- Root blockers: none
- Done: 0/3
- Receipts: verification-completed-eventec080702588541d386e48ad5e2390023, verification-completed-event24e6d36e25234c8aa18f546f6d6cedbd, verification-completed-event0b6fa0f3101f48e98ec63bea73d9076d, verification-completed-event5f906eee98ba4f9ab62c97e37dc5e029, verification-completed-event45fee2f370b740299b34d72d69cc2d38
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s1c`

<!-- nah-checkpoint:3f38f5a81f12ff2d -->
## 2026-09-01T17:28:54.157Z · claude-code · 51522b6a-8e7b-496e-8bbd-9ba19dc976a1

- Stage: implementation
- Ready: none
- In progress: live-smoke-workflow
- Root blockers: none
- Done: 2/3
- Receipts: verification-completed-eventec080702588541d386e48ad5e2390023, verification-completed-event24e6d36e25234c8aa18f546f6d6cedbd, verification-completed-event0b6fa0f3101f48e98ec63bea73d9076d, verification-completed-event5f906eee98ba4f9ab62c97e37dc5e029, verification-completed-event45fee2f370b740299b34d72d69cc2d38, verification-completed-event44698e11ce644c92b69207245a3ff19c, verification-completed-event3b2ab2d8c94a4413871eb6b67ed18ecf, verification-completed-event6b46818225354f33a35e13d2d5d722ab, verification-completed-event60fecebebf6642778046bdbbbc2a2882, verification-completed-event238a025712c44919910eee631cf89d74, verification-completed-eventd901484cda4b486fa4bb23865796afd5, verification-completed-event05c24770c51a4c18922015bb716a9a67, verification-completed-event1989659ead084a9ebd87420a8568aeca, verification-completed-eventc1c90a4163a14c4e8b9860ae3cecc168, verification-completed-event7b5539d33a644c4b9051c2c5e79e37da, verification-completed-eventb0959411adca471f9dd54a6d6f43ae3b, verification-completed-event0cb8b40177da4f65b543d8307a42156b, verification-completed-event56260cef70504748990d0eb0e4b7a754
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s1c`
