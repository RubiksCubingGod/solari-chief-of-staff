# Architecture direction (binding decisions)

Full design: `docs/ARCHITECTURE.md` at the repo root. This file records the binding decisions
and their status, plus corrections discovered after that document was written. Where the two
disagree, this file wins.

## Standing decisions (from ARCHITECTURE.md, confirmed)

- TypeScript everywhere; Node 22; pnpm workspace; single Docker deployable running API server
  (Fastify), worker pool (pg-boss), and Telegram bot (grammY); Postgres + Drizzle; Next.js
  dashboard; Vitest + Playwright + Testcontainers.
- LLM: claude-opus-5 everywhere via @anthropic-ai/sdk (beta tool runner + Zod tools); revisit
  only with eval data.
- Engines depend on a `BrowserProvider` interface with `SolariProvider` and `LocalProvider`
  implementations; CI runs on LocalProvider, Solari-specific behavior is proven in a budgeted
  @live smoke tier.
- Security posture: no passwords in our DB (Solari profiles only), no autonomous payments,
  per-task domain allowlist enforced below the LLM, recordings always on for action tasks.
- Dashboard auth: magic link (decided).

## Seam decisions (2026-09-01, /nah-scope with Aarav)

1. **repo-foundation split three ways** — workspace spine (`repo-foundation`), fixture sites
   (`fixture-harness`), browser substrate (`browser-substrate`). Why: the bundle was ~34
   wall-hours with three separable release claims and proof regimes; split, ~60% of it
   parallelizes and chat/dashboard unblock at ~13h instead of ~34h. Solari-credential risk is
   isolated in `browser-substrate`.
2. **Foundation owns thin CRUD** — Fastify skeleton plus engine-free CRUD routes (watches,
   calendar items, task reads) land in `repo-foundation`. Why: telegram-chat's own proof and
   dashboard-read's pages need CRUD; leaving it in watch-engine created hidden edges that
   serialized chat and dashboard behind the watch engine.
3. **UserIO port** — the action engine asks the user through an `ask(question) -> reply`
   interface; proofs use scripted IO. The real Telegram waiting_user round-trip is proven in
   `calendar-wiring` (which therefore depends on `telegram-chat`). Why: keeps the action
   engine — the critical path — parallel with chat, and the draft's proofs already mocked chat.

## Corrections to ARCHITECTURE.md (from research/solari-sdk-surface.md, 2026-09-01)

- **There is no `kill()` in the browser SDK** — that is the sandbox/VM API. Real session
  hygiene: `browser.close()` releases the session (closing the browser alone holds the slot
  until expiry); `solari.close()` is required in Node or the process hangs, and it does NOT
  release sessions; `GET /sessions/:id` is dead, so we track our own sessions. `withBrowser()`
  must encode exactly this.
- **No block/captcha signal reaches the client.** Tier escalation (ARCHITECTURE §3.1) must
  detect blocks from page content ourselves (captcha markup, empty shell, 403 body); Solari
  gives no event or field. Proxy resolution degrades silently — assert on response fields
  (e.g. the `proxy` field), never on status codes.
- **No documented API mints a watchable live-view URL.** The §4 login story ("user watches
  their own login session via a live-view link") has no supported programmatic path today; the
  vendor's human-in-the-loop path is the console's Profiles → Open editor. Open decision on the
  project: ask the vendor, or design connect-site around the console editor.
- **The TS SDK rewrites session endpoints to a loopback proxy** — a browser session is only
  reachable from the process that created it and dies with that client. A `waiting_user` pause
  can survive a worker restart as DB state, but the live browser session cannot be re-attached
  from a new process; on restart the task must resume by re-running, not re-attaching.
- Version pins matter: `chromium.connect` requires Playwright 1.62.x; `connectOverCDP` loses
  server-side input humanization. Free-plan concurrency cap is 3 sessions; a client-side retry
  bug can double-create sessions on timeout (needs a deliberate test in browser-substrate).
