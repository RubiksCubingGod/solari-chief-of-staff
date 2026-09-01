# Majordomo — sprint graph draft (pre-nah input)

> **Superseded 2026-09-01.** The release graph now lives in
> `.nah/projects/chief-of-staff/project.yaml` (scoped via /nah-scope; s1 split three ways,
> foundation owns thin CRUD, UserIO port instead of the s5→s3 edge). This file is kept as the
> historical input.

Draft only. The real contracts get written collaboratively in `/nah-scope` and
normalized by `/nah-enhance` — this file is the thinking we bring into those
conversations, shaped to nah's model: a **project** (finite goal, MECE release
graph) made of **sprints** (independently landable, verifiable releases — not
timeboxes), each with an outcome, non-goals, and declared proofs.

## Project

- id: `majordomo-v1`
- goal (finite, closable): *A deployed, tested personal chief-of-staff agent —
  watches (price/slot/change), deadline calendar wired to actions, subscription
  cancellation, Telegram interface, dashboard with replays — demoed on real
  sites and published with the Solari challenge launch post.*
- Not the goal (follow-on projects): open-ended booking, purchases, SMS,
  multi-tenant SaaS hardening, sandbox/desktop features.

## Sprint graph

```
s1 foundation ──┬─► s2 watch-engine ──────┬─► s7 calendar-wiring
                ├─► s3 telegram-chat ──┐  ├─► s8 slot-sniping ◄── s5
                ├─► s4 dashboard-read  │  │
                └─────────────────────►s5 action-playbooks ─► s6 agentic-mode
                                          │
s2+s5+s6+s7+s8 ──────────────────────────►s9 real-site-hardening ─► s10 launch
```

Parallelism: after s1 lands, s2/s3/s4 can run as parallel sprints (disjoint
file ownership). s5 needs s3 (the `waiting_user` round-trip talks through the
bot). s6–s8 build on s5/s2. s9 and s10 close the project.

---

### s1 `repo-foundation` (kind: tooling)
**Outcome:** a green-CI monorepo skeleton where every later sprint has a place
to land: pnpm workspace, packages laid out per ARCHITECTURE §11, Postgres
schema + migrations, pg-boss wiring, fixture sites (fakestore, fakegym,
fakedmv, fakenews + hostile modes), `BrowserProvider` interface with
`SolariProvider`/`LocalProvider`, `withBrowser()` hygiene helper, CI with
coverage gates.
**Proofs:** `pnpm check` green in CI; integration test boots fixtures +
Testcontainers Postgres; tagged `@live` smoke opens fakestore through a real
Solari browser and exits cleanly (close/kill hygiene).
**Draft tasks (~10):** workspace+lint+tsconfig · drizzle schema+migrations ·
pg-boss harness · fixture: fakestore · fixture: fakegym · fixture: fakedmv ·
fixture: fakenews+hostile modes · BrowserProvider + Local impl · Solari impl +
withBrowser · CI workflows + coverage gate.

### s2 `watch-engine` (kind: feature) — deps: s1
**Outcome:** price and change watches run on schedule against fixtures with
tiered fetching (HTTP → browser → stealth), deterministic extractors, LLM
extractor creation + self-healing, observations history, trigger → notifier
event.
**Proofs:** fixture price drop produces a trigger event within one tick; tier
escalation test (hostile mode) records tier_used=2; redesign mode heals the
selector; 100% coverage on core comparison/diff logic.
**Draft tasks (~9):** watch model+CRUD · scheduler tick · tier-0 fetcher ·
tier-1/2 browser fetch + block detection · extractor runtime · extractor
creation agent (LLM) · self-healing path · compare/trigger logic ·
observations + retention.

### s3 `telegram-chat` (kind: feature) — deps: s1
**Outcome:** a bound Telegram bot where natural language becomes structured API
calls (create watch, list, add calendar item, answer pending) via one Claude
tool loop; chat transcript persisted; one-time-code account binding.
**Proofs:** mocked-Telegram integration tests: "watch this price" → watch row;
ambiguous request → clarifying question; unbound chat refused.
**Draft tasks (~7):** grammY bot + binding flow · chat agent tool loop · tool
wrappers over API · pending-question routing (`answer_pending`) · transcript
persistence · error/fallback UX · rate limiting.

### s4 `dashboard-read` (kind: feature) — deps: s1
**Outcome:** authenticated (magic-link) Next.js dashboard showing watches with
observation sparklines, calendar list, task history shell.
**Proofs:** Playwright UI tests against seeded DB; auth denies anonymous.
**Draft tasks (~6):** magic-link auth · watches page + sparkline · calendar
page · task list shell · layout/theme · seed script.

### s5 `action-playbooks` (kind: feature) — deps: s1, s3
**Outcome:** the action engine in playbook mode: task state machine
(queued→running→waiting_user→…), fakegym cancellation playbook end-to-end
through Telegram including a 2FA `waiting_user` round-trip, Solari session
recording stored and shown on the task.
**Proofs:** "cancel my gym" in (mocked) chat flips fakegym's member record to
cancelled and stores a replay reference; waiting_user survives a worker
restart; guardrail test: off-domain navigation refused, payment form always
gates.
**Draft tasks (~8):** task model + state machine · worker execution loop ·
playbook registry + fakegym playbook · waiting_user gate + chat round-trip ·
recording capture + storage · guardrails (domain allowlist, payment gate) ·
task timeline events · dashboard task detail + replay embed.

### s6 `agentic-mode` (kind: feature) — deps: s5
**Outcome:** LLM-driven browser missions for sites without a playbook: tool
loop (navigate/read_page/click/type/ask_user/done), budgets, code-enforced
guardrails, eval harness with regression-gated pass rate against fixture
scenarios.
**Proofs:** agentic cancel succeeds on fakegym *without* its playbook; eval
suite (N scenarios incl. hostile variants) meets baseline pass rate; budget
exhaustion fails gracefully with replay.
**Draft tasks (~7):** page-to-text (a11y tree) · browser tools + Zod schemas ·
mission loop + budgets · guardrail enforcement layer · eval harness + fixtures
scenarios · cost logging per task · failure UX (replay + reason).

### s7 `calendar-wiring` (kind: feature) — deps: s2, s5
**Outcome:** calendar items (subscriptions/deadlines) created via chat or
dashboard; daily cron produces reminders; "auto-cancel before renewal" enqueues
a confirm-gated cancellation task.
**Proofs:** time-travel test: item with cancel_by tomorrow → reminder today,
confirm → task enqueued, decline → nothing; LLM parse test corpus for
"I pay $X for Y, renews the 12th".
**Draft tasks (~5):** calendar model+CRUD · chat/LLM parsing to items · daily
scan cron · reminder messages · auto-action wiring + confirm gate.

### s8 `slot-sniping` (kind: feature) — deps: s2, s5
**Outcome:** slot watches that, on trigger, immediately enqueue and run a
book-this-slot task (fakedmv), with race-safety (slot gone by booking time →
graceful re-arm).
**Proofs:** fixture slot appears → booked within one cycle, fixture DB shows
the booking; slot-stolen race test re-arms the watch.
**Draft tasks (~4):** slot extractor/compare kind · trigger→task pipeline ·
fakedmv booking playbook · race handling + re-arm.

### s9 `real-site-hardening` (kind: reliability) — deps: s2, s5, s6, s7, s8
**Outcome:** the system proven against 2–3 chosen real sites (decision:
which — ToS-friendly, reliably demoable): real playbooks/watches, live smoke
suite green nightly, cost telemetry reviewed, RELEASE_CHECKLIST manual pass
recorded as attestations.
**Proofs:** nightly live workflow green 3 consecutive runs; per-task cost under
target; human attestations for the manual checklist (screenshots/replays).
**Draft tasks (~6):** pick+approve demo sites (human decision) · real
watches/playbooks ×2–3 · live smoke suite · cost report · checklist run ·
bugfix buffer.

### s10 `launch` (kind: operations) — deps: s9
**Outcome:** deployed (Railway), public repo on RubiksCubingGod with README +
architecture writeup + demo video/gifs, Solari fork linkage, launch post
drafted and published tagging @harrychow_ and @getsolari.
**Proofs:** production URL serves dashboard; fresh-clone setup instructions
verified; post live (human attestation).
**Draft tasks (~6):** deploy + env/secrets · production Telegram bot · README +
docs pass · demo recording · launch post draft · publish + tag (human).

---

## Open decisions to raise in /nah-scope
1. s3/s5 seam: does `waiting_user` need the real bot, or land s5 against a
   notifier interface so s3/s5 fully parallelize?
2. Real demo sites for s9 (human decision, needed by end of s5).
3. Whether s1 is too big for one sprint — nah sizing audit may want fixtures
   split out (`test-harness` sprint).
4. Working name / repo name before s10.
