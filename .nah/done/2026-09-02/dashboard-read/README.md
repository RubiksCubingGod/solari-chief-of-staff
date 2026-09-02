# dashboard-read (s4)

## Outcome

An authenticated magic-link Next.js dashboard rendering watches with observation sparklines,
the calendar list, and a task history shell from the read API against a seeded database.

## Why this boundary

The read-only dashboard is deliberately engine-free: every page renders data the s1 CRUD/read
API serves, proven against seeded rows, so it lands in parallel with the engines and needs only
repo-foundation. It establishes the web shell, auth, and page conventions that action-playbooks
extends with the task detail + replay embed (the s4 → s5 edge artifact).

## Design decisions

- Next.js app in `packages/web`, talking to the Fastify API over HTTP (no direct DB access from
  web code — the API is the only door).
- Magic-link auth: request a link by email → signed one-time token → session cookie. Email
  delivery goes through a MailerPort; the dev/CI implementation logs the link (no email vendor
  until the hosting decision lands — open decision, owner Aarav, due by this sprint's close for
  production email only, not for this sprint's proofs).
- This sprint adds the missing engine-free read routes the pages need (observations series for
  sparklines, task list/detail reads) — thin Drizzle-backed queries in the API, same posture as
  s1 crud-routes.
- Pages ship with both empty and populated states; e2e proofs run Playwright against a dev
  server with a seeded Testcontainers database.
- Watch pause/resume from the list page reuses the existing CRUD route — the one write this
  read dashboard performs.

## Specifications

- `specs/magic-link-auth.md` (vertical) — email in → link → session cookie → guarded page;
  refused states (bad/expired/reused token, unauthenticated access).
- `specs/read-dashboard-pages.md` (vertical) — authenticated user → watches with sparklines,
  calendar list, task history shell, all from the read API against seeded data; includes the
  engine-free read-route additions the pages consume.

## Non-goals

- No task detail page or replay embed (s5 extends the shell).
- No engine data generation — seeds simulate observations/tasks; live data arrives when engines
  land.
- No account management, no signup flow (users are seeded/invited in v1), no email vendor.
- No production deployment (challenge-launch).

## Task waves

[next-shell, observation-read-routes] → [magic-link-auth] → [watches-page,
calendar-tasks-pages]
