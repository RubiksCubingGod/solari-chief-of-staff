---
schema_version: 1
id: site-connect-path
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: An authenticated user on the dashboard (or in chat) choosing to connect a real site
    account
  terminal: >-
    A site_connections row holding the Solari profile id with its status visible on the
    dashboard, and a subsequent mission on that site launching already logged in - or an
    observable failed/expired state offering reconnect, with no password ever stored
origin:
  summary: The security story made real - the user logs in themselves inside a watchable Solari
    cloud browser, we keep only the profile id, and expiry degrades to a reconnect link instead
    of a credential prompt.
  refs: [.nah/active/real-site-hardening/README.md,
    .nah/active/browser-substrate/specs/browser-provider-seam.md,
    docs/ARCHITECTURE.md]
---

# Site connect path

## Outcome

The connect flow from architecture §4: a "connect site" page in `packages/web` starts a Solari
session for the chosen site, shows the live-view link so the user watches and drives their own
login, and on confirmation stores the Solari profile id on a `site_connections` row (user ×
site domain → profile id, status connected). Watches and missions on that site launch with the
saved profile and are already authenticated. A `connect_site` chat tool returns the same
connect link in Telegram. We never see or store the password - the credential story the launch
post gets to tell.

## Path

Dashboard → connect site → live-view session → user logs in → confirm → row saved, status
connected → an s5/s6 mission on that site runs authenticated without a login step. Chat
variant: "connect my gym" → connect_site tool → link in Telegram → same flow. Expiry: a
mission hitting a logged-out state fails with reconnect-required, the connection row flips to
expired, and the dashboard/chat surface a reconnect link - never a password prompt in chat.

## Failure behavior

Abandoned connect sessions (user never confirms) time out and close per browser-substrate
hygiene, leaving no half-connected row. A connection whose profile id the provider no longer
honors lands expired, observably. Fixture-tier proofs cannot exercise real profiles
(LocalProvider echoes profiles as not-applied), so CI proves the flow's bookkeeping with a
scripted provider; the live proof is part of this sprint's evidence.

## Proof

Integration tests with a scripted provider: connect-flow state transitions (started, confirmed,
abandoned-timeout, expired-on-failure), row bookkeeping, and the chat tool returning the link.
The live evidence: one real site connected through the flow (recorded), the real-action mission
running authenticated via the saved profile, and an expiry-or-forced-reconnect episode with the
reconnect path exercised.
