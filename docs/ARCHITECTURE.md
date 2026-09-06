# Chief of Staff — v1 Architecture

Working name: **Majordomo** (placeholder — rename freely).

An always-on personal agent with a memory and a clock. It holds your watches
(prices, slots, page changes), your deadlines (renewals, cancellation windows),
and takes orders by text. Built on Solari cloud browsers for the Pinetree
Research / Solari hiring challenge.

---

## 1. Scope

### In v1
| # | Feature | What it does |
|---|---------|--------------|
| 1 | Price watching | "Tell me when this drops below $200" — checks on a schedule, alerts |
| 2 | Slot sniping | Watches a booking page; when a slot appears, books it immediately |
| 3 | Page-change watching | Watches any page/element for change; alerts with a diff |
| 4 | Deadline calendar | Subscriptions + deadlines with dates, wired to actions ("cancel before renewal") |
| 5 | Cancellation | "Cancel my gym" — agent drives the cancellation flow, records a replay |
| — | Chat interface | Telegram bot: create watches, order tasks, get alerts, answer 2FA prompts |
| — | Dashboard | Web UI: watches, calendar, task history with session replays |

### Explicitly out of v1
- Open-ended concierge booking ("somewhere Italian on Friday") — least
  differentiated, hardest to test. Booking a *specific known slot* is in (part of #2).
- Autonomous purchases. The agent may fill a cart and ask for one-tap confirm;
  it never submits payment on its own.
- SMS/Twilio (A2P registration friction) — Telegram first, SMS later.
- Multi-tenant SaaS hardening. Schema is multi-user from day one, but v1 ships
  for a handful of invited users, not the open internet.

---

## 2. System overview

```
 Telegram ◄──────────┐                            ┌──────────────► Solari Cloud
                     │                            │                 - browsers (stealth/proxy)
 ┌─────────────┐   ┌─┴────────────┐   ┌───────────┴─┐               - profiles (logins)
 │  Dashboard  │◄──┤  API server  │◄──┤   Workers   │               - session recordings
 │  (Next.js)  │   │  (Fastify)   │   │  (pg-boss)  │
 └─────────────┘   └──────┬───────┘   └───────┬─────┘
                          │                   │
                          ▼                   ▼
                   ┌────────────────────────────────┐
                   │            Postgres            │
                   │ users · watches · observations │
                   │ tasks · calendar · messages    │
                   └────────────────────────────────┘
```

One deployable unit (single Docker image) running three processes:
**API server**, **worker pool**, **Telegram bot** — all TypeScript, sharing one
Postgres. No Redis, no microservices. Boring on purpose: the interesting part
is the agent, not the infra.

### Language: TypeScript everywhere
- Solari's browser SDK is Playwright-compatible and TS-first; the cookbook's
  richest examples are TS.
- One language across bot, API, workers, dashboard, and tests.
- Anthropic SDK (`@anthropic-ai/sdk`) has the beta tool runner + Zod tools,
  which is exactly the shape of our agent loop.

### Core stack
| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 + TypeScript | `await using` disposal works with Solari's close() gotcha |
| API | Fastify | Small, fast, first-class TS + JSON-schema validation |
| Jobs/scheduling | pg-boss | Cron + queues + retries on plain Postgres; no Redis to run |
| DB | Postgres + Drizzle ORM | Typed schema, easy test containers |
| Dashboard | Next.js (App Router) | Fast to build; deploys with the same image |
| Bot | grammY (Telegram) | Clean TS Telegram framework |
| Browser automation | `@solarisdk/browser` + Playwright API | The point of the exercise |
| LLM | Claude API, `claude-opus-5` | See §7 |
| Tests | Vitest + Playwright + Testcontainers | See §9 |

---

## 3. The three engines

Features 1–5 collapse into three pieces of machinery. Everything else is UI.

### 3.1 Watch engine (features 1, 2, 3)

A **watch** = `{ url, extractor, condition, schedule, on_trigger }`.

Execution of one check:
1. **Fetch tier** — try cheap first, escalate only when needed:
   - Tier 0: plain HTTP fetch + parse (no browser, near-free) — used when the
     page is static and not bot-hostile.
   - Tier 1: Solari browser, default settings.
   - Tier 2: Solari browser with stealth + residential proxy — entered
     automatically when tier 0/1 hits a block signal (captcha page, 403,
     empty shell). The escalation decision is recorded on the observation.
2. **Extract** — run the watch's extractor against the page (see below).
3. **Compare** — against the last observation: numeric threshold (price),
   presence/absence (slot), text diff (change).
4. **Act** — on trigger: notify via Telegram, and/or enqueue an action task
   (slot sniping enqueues "book this slot" with the found slot's details).

**Extractors** are created once, at watch-creation time, by the LLM:
user sends a URL + "watch the price" → agent opens the page, proposes an
extractor spec `{ selector, attribute, parse: "price" }`, verifies it returns a
sane value, stores it. At check time extraction is **deterministic** (CSS
selector + parse rule — no LLM call, no per-check token cost).
**Self-healing:** if the selector stops matching, the check falls back to LLM
extraction (page text → value), flags the watch, and proposes an updated
selector. One LLM call per breakage, not per check.

**Cost note:** checks are the recurring cost driver. Tier 0 checks are free;
tier 1 ≈ browser-minutes; the target is < $0.01/check at tier 1 and LLM spend
only at creation/breakage/trigger time.

### 3.2 Action engine (features 2's booking half, 5)

A **task** = one browser mission: "cancel subscription X", "book slot Y".

State machine (persisted; every transition is an event row):

```
queued → running → waiting_user → running → succeeded
                 ↘ failed (with reason + replay link)
```

`waiting_user` is the 2FA/confirmation gate: the agent hits an OTP prompt or an
irreversible step, pauses the browser session (kept alive), texts the user
("Enter the code Chase sent you" / "Confirm: cancel Planet Fitness \$24.99/mo?"),
and resumes with the reply. Timeout → task fails gracefully with a replay.

Two execution modes, tried in order:

1. **Playbooks** — deterministic scripted flows (plain Playwright) for known
   sites. Fast, cheap, fully unit-testable. v1 ships with playbooks for the
   demo targets; the registry is just a directory of TS modules implementing
   `Playbook { match(task), run(page, task, io) }`.
2. **Agentic mode** — for everything else. Claude drives the browser through a
   tool loop (SDK beta tool runner, Zod tools):
   - `navigate(url)`, `read_page()` (accessibility-tree text, not raw HTML),
     `click(ref)`, `type(ref, text)`, `select(ref, value)`, `screenshot()`
   - `ask_user(question)` → the `waiting_user` gate
   - `done(summary)` / `give_up(reason)`
   - Budgets: max 40 steps, 10 min wall clock, per-task token cap.

Hard guardrails, enforced in code (not prompt):
- **Domain allowlist per task** — the browser refuses navigation off the
  task's declared domains.
- **No payment submission** — payment-shaped forms trigger `ask_user`, always.
- **Recording always on** — every task creates a Solari session with
  `recording: true`; the replay URL is stored on the task and shown in the
  dashboard. The replay *is* the audit trail and the demo.

### 3.3 Calendar (feature 4)

Plain data + the two engines above:
- `calendar_items`: subscriptions (name, cost, renewal date, cancel-by date,
  cancellation URL) and one-off deadlines.
- pg-boss cron scans daily: upcoming item → reminder message; item with a
  wired action ("auto-cancel before renewal") → enqueue the action task with a
  confirm-by-text step.
- Created via chat ("I pay \$24.99 for Planet Fitness, renews the 12th") — LLM
  parses to a structured item — or via dashboard form.

---

## 4. Logins: Solari profiles, 2FA, and what we never store

- **We never store passwords.** To connect a site, the user gets a live,
  watchable Solari browser session (VNC/live-view link from the dashboard),
  logs in themselves, and we save the **Solari profile id**. Cookies/session
  state live in Solari's profile store; our DB maps `user × site → profile_id`.
- Watches and tasks on that site launch browsers with that profile — already
  logged in.
- When a session expires or 2FA fires mid-task: `waiting_user` gate
  (agent relays the OTP prompt to Telegram). If a site forces full re-login,
  the task fails with a "reconnect this site" link rather than asking for
  credentials in chat.

This is both the security story ("your passwords never touch our servers") and
a Solari feature showcase (profiles are the product's answer to exactly this).

---

## 5. Data model (Postgres, Drizzle)

```
users            id, telegram_chat_id, email, tz, created_at
site_connections id, user_id, site_domain, solari_profile_id, status, last_used_at
watches          id, user_id, kind(price|slot|change), url, extractor jsonb,
                 condition jsonb, schedule (cron), tier_policy, status,
                 last_value jsonb, last_checked_at, consecutive_failures
observations     id, watch_id, checked_at, tier_used, value jsonb, triggered bool,
                 error text?          -- history feeds dashboard sparklines
tasks            id, user_id, kind(cancel|book_slot|custom), input jsonb,
                 status, mode(playbook|agentic), playbook_id?,
                 solari_session_id?, recording_url?, result jsonb,
                 created_at, finished_at
task_events      id, task_id, ts, type(step|ask_user|user_reply|transition),
                 payload jsonb        -- full step log; renders as a timeline
calendar_items   id, user_id, kind(subscription|deadline), name, amount_cents?,
                 renew_on?, cancel_by?, action jsonb?, status
messages         id, user_id, direction, channel(telegram), text, task_id?,
                 watch_id?, ts       -- chat transcript, links replies to waits
```

State lives in Postgres, not in process memory: a worker crash mid-task leaves
a resumable/failable row, and `waiting_user` survives restarts because the
pending question is a `task_events` row and the Telegram reply is matched back
by `task_id`.

---

## 6. Chat layer (how a text becomes a row)

The Telegram bot pipes every message through one Claude call (tool runner) with
tools that are just thin wrappers over the API server's own endpoints:

- `create_watch`, `list_watches`, `pause_watch`
- `create_task` (cancel / book)
- `add_calendar_item`, `list_calendar`
- `answer_pending` (routes a reply to a `waiting_user` task)
- `connect_site` (returns the live-login link)

So chat and dashboard hit the same API; the LLM's only chat-layer job is
natural language → structured call → confirmation message. Multi-turn intent
("cancel my gym" → "which one, you have two?") falls out of the tool loop.

---

## 7. LLM layer

- Model: **`claude-opus-5`** everywhere (agent loop, extractor creation, chat
  parsing) with adaptive thinking (default on). Rationale: the agent loop is
  the product's reliability core; per-task token volume is small (dozens of
  short tool turns), so the premium over a smaller model is noise next to
  correctness. Revisit only with eval data in hand ($5/$25 per MTok input/output;
  a typical cancel task should be well under $0.25).
- SDK: `@anthropic-ai/sdk`, beta tool runner + `betaZodTool` for the loops;
  structured outputs (`output_config.format`) for extractor specs and calendar
  parsing.
- Refusal fallbacks: enable server-side `fallbacks: "default"`
  (beta `server-side-fallback-2026-07-01`) on Opus 5 calls per current API
  guidance.
- Prompt caching: stable system prompt + tool defs first, page content last;
  `cache_control` breakpoint after the static prefix (agent loop turns re-send
  history, so cache hits matter).
- Every LLM call logs tokens in/out to `task_events` — cost per task is a
  first-class metric on the dashboard (also good challenge-post material).

---

## 8. Solari usage map (challenge showcase)

| Solari feature | Where we use it |
|---|---|
| Cloud browser (Playwright) | every tier-1+ check, every task |
| Stealth + residential proxy | tier-2 escalation on block signals |
| Persistent profiles | site logins (§4) |
| Session recording | every action task → replay in dashboard |
| Live view | user watches their own login session; peek at running tasks |
| Captcha solving | implicit via stealth tier |
| `solari.close()` / `kill()` hygiene | wrapped in one `withBrowser()` helper so the cookbook gotchas live in exactly one place |

Sandbox/desktop are not used in v1 — honest scoping beats shoehorning.
(v2 candidates: sandbox for user-defined watch scripts; desktop for
computer-use fallback when a site defeats DOM automation.)

---

## 9. Testing strategy

The quality bar (full suite, coverage, manual checks) is part of the pitch.
The trick that makes agent testing deterministic: **fixture sites**.

### 9.1 Fixture sites (`fixtures/`)
Tiny self-contained Express apps we control, started by the test harness:
- **fakestore** — product page with a settable price (test endpoint mutates it)
- **fakegym** — login, member area, deliberately annoying multi-step
  cancellation flow (retention offer, "are you sure" ×2), state queryable via
  a test endpoint (`GET /__test/member/1` → `{ cancelled: true }`)
- **fakedmv** — appointment calendar where slots appear via test endpoint
- **fakenews** — page whose content changes on command (change-watch diffing)
- Hostile variants: `?mode=blocked` serves a captcha shell (tier escalation
  tests), `?mode=redesign` renames CSS classes (self-healing tests)

Assertions are exact: after the cancel task, the fixture's own DB says
`cancelled: true`. No screenshots-look-right hand-waving.

### 9.2 Test pyramid
| Layer | Tooling | Runs | Covers |
|---|---|---|---|
| Unit | Vitest | every push, seconds | condition eval, diffing, extractor parsing, state machines, schedule math, guardrail logic — 100% line coverage enforced on `core/` |
| Integration | Vitest + Testcontainers (Postgres) + fixture sites, **local Playwright browser** | every push, ~minutes | watch engine end-to-end, playbooks, API routes, bot handlers (Telegram API mocked), `waiting_user` round-trip |
| Agent evals | same harness, **real Claude API**, local browser | nightly + pre-release | agentic mode vs fixture sites: N scenarios × pass/fail by fixture state; regression-gated (pass rate must not drop) |
| Live smoke | real Solari API, tagged `@live` | nightly + pre-release, budgeted | one real browser launch, profile reuse, recording retrieval, tier-2 stealth fetch of a known bot-hostile page |
| Manual checklist | `docs/RELEASE_CHECKLIST.md` | pre-release | real-site demo runs, replay playback, Telegram UX pass |

Key design decision enabling this: the engines depend on a `BrowserProvider`
interface with two implementations — `SolariProvider` and `LocalProvider`
(plain Playwright). CI runs everything except live smoke on `LocalProvider`:
free, fast, no credits burned, and it proves the engines don't secretly depend
on Solari specifics. The `SolariProvider`-specific behavior (profiles,
recording, stealth, close/kill hygiene) gets its own contract tests in the
live-smoke tier.

### 9.3 CI (GitHub Actions)
- `push`: lint (eslint + tsc), unit + integration, coverage gate (100% on
  `core/`, ≥90% overall), build.
- `nightly`: agent evals + live smoke (secrets-gated), cost report artifact.
- `live-ops` (nightly, secrets-gated): the release gate's night. `scripts/live-ops.mjs`
  runs one case per class - session lifecycle, real-site watch checks, one
  fixture mission, the live evals - and reports each as passed, failed or
  errored, never merged; sums Solari and Anthropic cost against
  `LIVE_OPS_COST_TARGET_USD`; judges the night (`packages/watch/src/live-ops/`);
  and sends a night that is not green to `OPS_USER_ID` through `sendToUser`.
  The release wants three consecutive green nights; one errored night is
  skipped, two in a row break the run. The record is an artifact a person
  copies into `docs/RELEASE-CHECKLIST.md`, never a file the job commits.
- PR template carries the manual-checklist stub.

---

## 10. Security & guardrails (summary)

- No credentials in our DB — Solari profiles only (§4).
- No autonomous payments; irreversible steps gate on `ask_user`.
- Per-task domain allowlist enforced below the LLM.
- Telegram chat binding via one-time code from the dashboard (no open bot).
- Secrets via env only; `.env.example` documented; API keys never logged.
- Task replays are private to the user; dashboard behind auth (simple email
  magic-link for v1).
- Watch frequency floor (≥ 5 min default, per-site politeness) — both cost
  control and don't-hammer-sites etiquette.

---

## 11. Repo layout

```
majordomo/
  packages/
    core/          # engines, state machines, pure logic (100% cov)
    db/            # drizzle schema + migrations
    solari/        # BrowserProvider iface, Solari + Local impls, withBrowser()
    agent/         # Claude tool loops: action agent, extractor agent, chat agent
    playbooks/     # per-site scripted flows
    api/           # fastify server
    bot/           # grammY telegram bot
    web/           # next.js dashboard
  fixtures/        # fakestore, fakegym, fakedmv, fakenews
  docs/            # this file, RELEASE_CHECKLIST.md, demo script
  .github/workflows/
```

pnpm workspace, single Dockerfile, docker-compose for local dev
(Postgres + fixtures).

## 12. Build order

1. **Skeleton** — workspace, CI, schema/migrations, fixture sites, Telegram
   echo bot, `withBrowser()` + both providers. *Exit: green CI, bot echoes,
   a Solari browser opens fakestore in live smoke.*
2. **Watch engine** — price + change watches vs fixtures, tiering, notifier.
   *Exit: fakestore price drop → Telegram alert, full test coverage.*
3. **Dashboard (read)** — watches, observations sparkline, calendar list.
4. **Action engine** — playbook mode + fakegym cancel + `waiting_user`
   round-trip + recordings. *Exit: "cancel my gym" in Telegram cancels
   fakegym, replay link works.*
5. **Agentic mode** — tool loop, guardrails, evals harness vs fixtures.
6. **Calendar wiring** — reminders, auto-cancel with confirm.
7. **Slot sniping** — watch→task pipeline vs fakedmv.
8. **Real-site demos + polish** — pick 2–3 real showcase sites, record demo,
   README, architecture writeup, launch post.

Each milestone = 1 PR-sized chunk with its tests; ship order front-loads the
always-on differentiator (watches) before the flashy part (agentic mode).

---

## 13. Open decisions (defaults chosen, flag to change)

1. **Hosting**: Railway (simplest Docker + Postgres + cron story). Fly.io
   equally fine. Decide at milestone 3.
2. **Working name**: "Majordomo" placeholder. Decide before the public repo.
3. **Real demo sites** for milestone 8 — needs a deliberate pick (ToS-friendly,
   visually clear, reliably demoable). Decide during milestone 4.
4. **Auth for dashboard**: magic link (chosen) vs Telegram-login widget.
5. **Anthropic spend**: nightly evals burn real tokens — set a monthly cap in
   the console before milestone 5.
