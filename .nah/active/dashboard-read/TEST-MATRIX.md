# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Web app builds in pnpm check; smoke page renders; DB-import lint boundary fails synthetic violation | read-dashboard-pages | build + lint | every push |
| Observation series + task reads: accepted, other-user 404, malformed 4xx | read-dashboard-pages | integration (Testcontainers) | every push |
| Magic-link accepted flow: request → captured link → session → guarded page | magic-link-auth | Playwright e2e | every push |
| Expired/reused/tampered tokens refused; single-use atomic under race | magic-link-auth | integration | every push |
| Enumeration-safe responses; unauthenticated redirect; logout | magic-link-auth | integration + e2e | every push |
| Watches page: rows + sparkline match seed; pause round-trips; empty state; cross-user isolation | read-dashboard-pages | Playwright e2e (seeded) | every push |
| Calendar + task shell pages: seeded rows, empty states, API-error state | read-dashboard-pages | Playwright e2e (seeded) | every push |

No @live tier: everything renders seeded local data. Production email delivery is deliberately
out (MailerPort dev implementation captures links); a real mail vendor arrives with the hosting
decision at challenge-launch.
