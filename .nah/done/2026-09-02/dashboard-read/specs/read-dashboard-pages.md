---
schema_version: 1
id: read-dashboard-pages
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: An authenticated user opening the watches, calendar, or task history page
  terminal: Pages rendering exactly the seeded rows the read API serves (sparklines included),
    with honest empty states, and pause/resume round-tripping through the CRUD route
origin:
  summary: The read surface - watches with observation sparklines, calendar list, task history
    shell - rendered from the API against seeded data, plus the engine-free read routes
    (observation series, task reads) the pages consume.
  refs: [.nah/active/dashboard-read/README.md]
---

# Read dashboard pages

## Outcome

Three authenticated pages in `packages/web`: **watches** — each watch with status, last
observation, an observation-series sparkline, and a working pause/resume control; **calendar**
— upcoming items ordered by date with kind badges (deadline/renewal); **task history** — a
list shell of task rows (id, kind, status, timestamps) that s5 will extend with the detail
page. Backing them, engine-free API additions: `GET /watches/:id/observations` (series for
sparklines) and task list/detail reads, thin Drizzle queries with the same validation posture
as s1 crud-routes.

## Path

Seeded database (users, watches, observations across time, calendar items, tasks) → login →
each page renders exactly the seeded facts (asserted against the seed, not screenshots) →
pause on the watches page flips the watch via the CRUD route and re-renders. Empty seeds →
every page renders its designed empty state, no errors. A user sees only their own rows —
cross-user seeds never leak.

## Failure behavior

API errors render a visible error state, not a blank page. The observations route refuses
requests for another user's watch with typed 404 (not 403 — no existence leak). Pages never
query the database directly — the API is the only door, asserted by module boundaries.

## Proof

Playwright e2e against the dev server with seeded Testcontainers: populated and empty states
for all three pages; sparkline series matches seeded observations; pause round-trip; cross-user
isolation; API-error state. Integration tests for the new read routes: accepted, refused
(other user's watch → 404), and validation cases.
