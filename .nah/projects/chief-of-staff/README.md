# Chief-of-Staff

An always-on personal agent with a memory and a clock, built on Solari cloud browsers for the
Pinetree Research / Solari hiring challenge. It holds watches (prices, slots, page changes),
deadlines (renewals, cancellation windows), and takes orders by text.

## Mission

The project closes when a deployed, tested personal chief-of-staff agent — watches
(price/slot/change), a deadline calendar wired to actions, subscription cancellation, a Telegram
interface, and a dashboard with session replays — has been demoed on real sites and published
with the Solari challenge launch post.

## Boundaries (not this project)

- Open-ended concierge booking ("somewhere Italian on Friday"). Booking a specific known slot is
  in scope.
- Autonomous purchases. The agent may fill a cart and ask for one-tap confirm; it never submits
  payment on its own.
- SMS/Twilio. Telegram first.
- Multi-tenant SaaS hardening. Schema is multi-user from day one; v1 ships to invited users.
- Solari sandbox/desktop features (follow-on candidates).

## Release graph

```
repo-foundation ──┬─► fixture-harness ───────┬─► watch-engine ──┬─► calendar-wiring ◄─┐
                  ├─► browser-substrate ─────┤                  ├─► slot-sniping ◄──┐ │
                  ├─► telegram-chat ─────────│──────────────────│───────────────────│─┘
                  └─► dashboard-read ──┐     └─► action-playbooks ◄─────────────────┘
                                       └─────────► │        │
                                                   │        └─► agentic-mode
                                                   ▼
   watch-engine + action-playbooks + agentic-mode + calendar-wiring + slot-sniping
                                                   │
                                                   ▼
                                        real-site-hardening ─► launch
```

After `repo-foundation` lands, four streams can run concurrently: `fixture-harness`,
`browser-substrate`, `telegram-chat`, `dashboard-read`. The action engine
(`action-playbooks`) is the critical path to `agentic-mode`, `slot-sniping`, and hardening.

Key seams (decided 2026-09-01, see `context/architecture-direction.md`):

- The original repo-foundation sprint was split three ways (workspace spine, fixtures, browser
  substrate) so the fixture and browser work parallelize and the Solari/live-smoke risk is
  isolated.
- The foundation owns a thin engine-free CRUD API, so chat, dashboard, and watch engine stay
  parallel.
- The action engine talks to a `UserIO` port, not the Telegram bot directly; the real
  bot round-trip is proven in `calendar-wiring`.

## Sources

- `context/challenge-brief.md` — the hiring-challenge direction this project answers.
- `context/architecture-direction.md` — binding design decisions; full design in
  `docs/ARCHITECTURE.md` at the repo root.
- `research/solari-sdk-surface.md` — cited Solari SDK facts (attach paths, session hygiene,
  proxy/stealth behavior, live-view gap) that the browser substrate builds on.
