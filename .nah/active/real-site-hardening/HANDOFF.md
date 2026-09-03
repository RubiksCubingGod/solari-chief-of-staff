# Handoff

No execution handoff yet.

<!-- nah-checkpoint:49db810134ff7730 -->
## 2026-09-03T07:21:27.435Z · claude-code · fd0bcdfa-83d9-4ad3-9677-379590e3415c

- Stage: implementation
- Ready: site-onboarding, site-connect-flow
- In progress: none
- Root blockers: none
- Done: 0/6
- Receipts: none
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s9`

<!-- nah-checkpoint:4e82c50eb2cfd1ca -->
## 2026-09-03T07:39:59.852Z · claude-code · fd0bcdfa-83d9-4ad3-9677-379590e3415c

- Stage: implementation
- Ready: live-suite-code, release-checklist
- In progress: onboarding-procedure, site-connect-flow
- Root blockers: none
- Done: 0/9
- Receipts: verification-completed-event27c0cf47759a458ebfb975ab08e0c76c, verification-completed-event5d0d019a19954279aaa9988d588e3adc, verification-completed-event78e8829d84644624b0c32a042919e278, verification-completed-eventbd5683f3a7df4ff4a70cf8edc95795eb, verification-completed-event5e945236de4645448b1b98086fbd27c3, verification-completed-event134afa29f12947b5b6c2b7c95d496264
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s9`

<!-- nah-checkpoint:37df6164728b4b15 -->
## 2026-09-03T07:59:33.689Z · claude-code · fd0bcdfa-83d9-4ad3-9677-379590e3415c

- Stage: implementation
- Ready: none
- In progress: onboarding-procedure, site-connect-flow, live-suite-code, release-checklist
- Root blockers: none
- Done: 0/9
- Receipts: verification-completed-event27c0cf47759a458ebfb975ab08e0c76c, verification-completed-event5d0d019a19954279aaa9988d588e3adc, verification-completed-event78e8829d84644624b0c32a042919e278, verification-completed-eventbd5683f3a7df4ff4a70cf8edc95795eb, verification-completed-event5e945236de4645448b1b98086fbd27c3, verification-completed-event134afa29f12947b5b6c2b7c95d496264
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s9`

## 2026-09-03T08:25:00Z · replan record · fd0bcdfa-83d9-4ad3-9677-379590e3415c

### Commander's intent
Prove the product against real sites and real vendors without fabricating evidence: a person can connect a site without ever giving the product a password, the nightly gate counts green/failed/errored nights honestly and holds cost to a target, and the release rests on three consecutive green nights plus five attested checklist items.

### Current plan
Four build tasks are green locally with red and green receipts recorded: site-connect-flow, onboarding-procedure, live-suite-code, release-checklist. The five evidence tasks (site-onboarding, real-watches, real-action, live-suite-expansion, cost-and-checklist) need a person: onboarding records, three real nights, attestations by name and date. They become ready after the four finishes and go into a typed wait.

### What changed
- Site connection was redesigned around the vendor console editor: the API mints a profile, the person logs in at console.getsolari.com/profiles, and confirms; no password ever reaches the product (task-architecture change, recorded 07:39Z checkpoint).
- The live-ops gate is one script (`scripts/live-ops.mjs`) running four case classes as child processes; the arithmetic lives in `packages/watch/src/live-ops/` (verdict, report) and the notice in `packages/bot/src/ops-notification.ts`.
- The watch case runs `LIVE_OPS_WATCH_SUITE` and is reported errored, never skipped, until a site is onboarded. Solari cost is not metered per case yet; the checklist's cost review compares the report to the bill.
- The record of nights is an artifact a person copies into `docs/RELEASE-CHECKLIST.md`; the job never commits it.

### What breaks
Nothing in the ordinary gate. The nightly cannot be green until a real-site watch suite exists (watch case errored), and two errored nights in a row break the record, so the three-night count starts only after site-onboarding.

### Proposed solution
Finish the four tasks in one coverage window (after 6c's series and b9's re-earns), then block the five evidence tasks with typed reasons naming who acts (Aarav attests; nightly runs need the repository secrets and `LIVE_OPS_WATCH_SUITE`).

### Patterns used
Live workflow pattern (schedule + dispatch only, guard job on secrets, no-cancel concurrency, artifact upload always); scripted-store fixtures per test; red-before-green with ledger signatures matched to actual output; keep the shared tree lint- and typecheck-clean between red and green.

### Graph and proof delta
- live-ops-green argv gained `packages/watch/src/live-ops/report.test.ts`.
- site-connect-unit-green covers and runs `packages/solari/src/index.test.ts` (export surface grew by four names) and covers `packages/solari/src/solari.ts`.
- site-connect-integration-green covers `packages/api/src/index.ts`.
- Receipts recorded this window: verdict-red, checklist-red, live-ops-green, checklist-green.

<!-- nah-checkpoint:8333487acdbea311 -->
## 2026-09-03T08:40:54.784Z · claude-code · fd0bcdfa-83d9-4ad3-9677-379590e3415c

- Stage: implementation
- Ready: none
- In progress: onboarding-procedure, site-connect-flow, live-suite-code, release-checklist
- Root blockers: none
- Done: 0/9
- Receipts: verification-completed-event27c0cf47759a458ebfb975ab08e0c76c, verification-completed-event5d0d019a19954279aaa9988d588e3adc, verification-completed-event78e8829d84644624b0c32a042919e278, verification-completed-eventbd5683f3a7df4ff4a70cf8edc95795eb, verification-completed-event5e945236de4645448b1b98086fbd27c3, verification-completed-event134afa29f12947b5b6c2b7c95d496264, verification-completed-event0ea549392c6a44cc9e74b63d936138b3, verification-completed-event920c32fa9ed441a4aaee9334d8d28a2e, verification-completed-event425cb7707b6d41e4ad1543fb29411d00, verification-completed-eventc7643f3a47d54494bca984644fc6bead, verification-completed-event819249cadbac41609c145cade99c8de9, verification-completed-event98c31b008373480498e6b47bf6c47029, verification-completed-eventa0549c25289b4c6e81c4b7a86e5c1b95
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s9`

## 2026-09-03T05:50:00Z · checkpoint: the four build tasks are finished

- Commits: site-connect-flow 78fc132 (its first finish, 616040a, was recorded with findings because the launcher's TEST_DATABASE_URL for 55432 lacked the password the server has always required, so the integration proof failed at connect with the SCRAM error; the proof was re-recorded green on the private 55434 server with `nah verify --retry` and the task finished again bare), onboarding-procedure 1269a30, release-checklist c1eceab, live-suite-code e7b9123.
- Before the finishes, coverage proofs were added for the branches the first measurement left bare: a malformed-record table and an over-target render in packages/watch/src/live-ops/report.test.ts; a non-Error vendor rejection in packages/solari/src/profiles.test.ts; packages/web/src/connect/client.test.ts (every shape of refusal body); no-cookie confirm and cancel in start-route.test.ts; packages/api/src/connect-attempts.test.ts (cancel of an unknown attempt, a vendor that keeps the profile with no warn configured); DELETE of an unknown attempt and a non-Error vendor refusal in the API integration suite. packages/solari/src/profiles.ts now hands its options to the vendor client factory as they are (ProfileStoreOptions extends SolariClientOptions), which removed two conditional spreads. My files measure 94-100% branches; the only bare branches left are unreachable (a JSON.parse that throws a non-Error, a timer disarmed while undefined, a row deleted between read and update).
- `nah task finish` did not run scripts/check.mjs for this sprint (each finish took under 30 seconds and ran only the declared proofs). The gate was run by hand after the last finish; its result is in the next entry.
- Shared-checkout state: b9 runs six bare re-earns after my message; the 55432 server (C:/tmp/cos-testpg) wants postgres://postgres:nahtest@127.0.0.1:55432/postgres; this session's gates used its private trust-only server on 55434 (C:/tmp/cos-testpg-s9, PID 6356), stopped at 06:12 local once b9 said they did not need it (restart with `pg_ctl -D C:/tmp/cos-testpg-s9 -o "-p 55434 -h 127.0.0.1" start`).
- Next: the five evidence tasks (site-onboarding, real-watches, real-action, live-suite-expansion, cost-and-checklist) are now unblocked in the graph; each needs a human or repository secrets, so each goes into a typed wait with the reason recorded, and this session suspends.

## 2026-09-03T06:02:00Z · gate result after the finishes

- `node scripts/check.mjs` on HEAD e7b9123 (TEST_DATABASE_URL on 55434): the first run failed only on two browser tests in packages/web/src/task-detail-page.integration.test.ts (the rr-player did not appear within 60 seconds; a recording fetch answered 404), which pass alone and belong to action-playbooks; the second run passed every step: lint, typecheck, typecheck:tests, test (1722 passed, 17 skipped), build, build:web. Treat those two tests as load-flaky under the gate's parallelism, not as a break.
- The tree was released to b9 at 06:02 for their six bare re-earns.

## 2026-09-03T06:08:00Z · typed suspension: the frontier is a human decision

- NAH frontier: ready none, in progress none; site-onboarding is attestation-ready behind an external gate of kind decision (authority RubiksCubingGod): which 2-3 sites are onboarded and the cost target are Aarav's to decide, and each onboarding runs with the account holder through docs/onboarding/PROCEDURE.md, recorded on docs/onboarding/RECORD-TEMPLATE.md, then attested with `nah attest`. real-watches, real-action, live-suite-expansion and cost-and-checklist are gated behind it (calendar time on real sites, repository secrets and vars LIVE_OPS_WATCH_SUITE and OPS_USER_ID, three green nights, checklist attestations).
- Nothing in this sprint can be built or proved without those inputs, so this session suspends here. Resume by re-running `nah implement real-site-hardening` once the first onboarding record is attested; the live-ops workflow needs SOLARI_API_KEY and ANTHROPIC_API_KEY as repository secrets before a night can run.

<!-- nah-checkpoint:cd55de3f2b0fc438 -->
## 2026-09-03T10:04:51.253Z · claude-code · fd0bcdfa-83d9-4ad3-9677-379590e3415c

- Stage: implementation
- Ready: none
- In progress: none
- Root blockers: none
- Done: 4/9
- Receipts: verification-completed-event27c0cf47759a458ebfb975ab08e0c76c, verification-completed-event5d0d019a19954279aaa9988d588e3adc, verification-completed-event78e8829d84644624b0c32a042919e278, verification-completed-eventbd5683f3a7df4ff4a70cf8edc95795eb, verification-completed-event5e945236de4645448b1b98086fbd27c3, verification-completed-event134afa29f12947b5b6c2b7c95d496264, verification-completed-event0ea549392c6a44cc9e74b63d936138b3, verification-completed-event920c32fa9ed441a4aaee9334d8d28a2e, verification-completed-event425cb7707b6d41e4ad1543fb29411d00, verification-completed-eventc7643f3a47d54494bca984644fc6bead, verification-completed-event819249cadbac41609c145cade99c8de9, verification-completed-event98c31b008373480498e6b47bf6c47029, verification-completed-eventa0549c25289b4c6e81c4b7a86e5c1b95, verification-completed-eventbf6324a8bf4f4aaea860042caf7c13c3, verification-completed-eventd094302240af45c49a28a8852f13d0bf, verification-completed-event8a38b70b423645f2857ccc7ef7615918, verification-completed-eventebab3e8599894a39b90d24597fd69cbb, verification-completed-eventb011c448d2c24c83a24af4aa09617675, verification-completed-event0ed145469d0341368f08f6f4a92fde09, verification-completed-event1ec23877065f4ec9bbfacb2af03965ef
- Findings: none
- Assurance request: none
- Knowledge revisions: none
- Resume: `nah implement s9`
