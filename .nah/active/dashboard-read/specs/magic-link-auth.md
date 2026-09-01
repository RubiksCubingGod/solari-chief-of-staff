---
schema_version: 1
id: magic-link-auth
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A seeded user requesting a login link for their email address
  terminal: An authenticated session cookie rendering guarded pages, or a refused state
    (invalid, expired, or reused token; unauthenticated access redirected)
origin:
  summary: Magic-link authentication - request, deliver through the MailerPort, consume,
    session - the authorization root for every dashboard page.
  refs: [.nah/active/dashboard-read/README.md]
---

# Magic-link auth

## Outcome

`POST /auth/request-link` issues a signed single-use token for a seeded user's email and hands
it to the MailerPort (dev/CI implementation records the link instead of sending). Visiting the
link sets a session cookie and lands on the dashboard. Middleware guards every dashboard page;
unauthenticated requests redirect to the request-link page. Tokens expire and are single-use.

## Path

Accepted: request link → MailerPort captures it → visit → session cookie → guarded page
renders. Refused, each observable and side-effect-free: unknown email (identical "link sent"
response — no account enumeration), expired token, reused token, tampered token,
unauthenticated page access redirecting. Logout clears the session.

## Failure behavior

Token consumption is atomic — a race of two visits with the same token authenticates at most
one. Session cookies are httpOnly and signed; a garbage cookie is treated as unauthenticated,
never an error page.

## Proof

Integration + Playwright e2e against the dev server with Testcontainers: the accepted flow end
to end; every refused state; token single-use race; enumeration-safe response equality; logout.
