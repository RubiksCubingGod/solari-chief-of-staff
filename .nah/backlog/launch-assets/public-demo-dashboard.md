---
schema_version: 1
id: public-demo-dashboard
created_at: 2026-09-02
created_by: RubiksCubingGod
origin:
  summary: "Launch-planning discussion: reviewers need a zero-setup way to experience the product; strongest competing challenge entries all offer one-click evidence."
candidate_sprint: challenge-launch
---

# public-demo-dashboard

One-line: a zero-setup, free, read-only demo of the product for challenge
reviewers, hosted as a static site (GitHub Pages) with seeded data.

## Why

Reviewers click the repo link and decide in under a minute. They will not
clone, configure Telegram, or provision keys. A hosted read-only dashboard
plus a short demo video is the only way they experience the product in one
click. The Solari fact sheet says proving that people can see/use the build
is how entries stand out.

## Rough shape (to be scoped properly)

- Static export of the dashboard (read-only mode): watches with observation
  history, calendar, 2-3 finished tasks.
- Replays included as downloaded recording files (video) rather than live
  Solari embeds, so hosting stays free and keyless.
- Seeded/example data baked at build time; no backend, no auth, no cost.
- Publish via GitHub Pages from the public repo.

## Constraints

- Must be free to host (GitHub Pages or equivalent static host).
- Must not expose real user data or any API key.
- Changes what challenge-launch (s10) promises, so it enters via /nah-scope
  on challenge-launch (or a small dedicated sprint if scoping prefers), not
  via the iterate lane.

## Status

Filed 2026-09-02 from launch planning discussion. Decision owner: aarav
(RubiksCubingGod). Pending scope-in when s6/s7/s8 land.
