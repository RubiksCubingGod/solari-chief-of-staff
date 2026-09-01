# challenge-launch (s10)

## Outcome

Deployed to production with a public repo, verified fresh-clone setup, README and architecture
writeup, demo recording, and the Solari challenge launch post published tagging the challenge
hosts.

## Why this boundary

The challenge is judged on a public, working, well-told product - so shipping the deploy, the
repo going public, and the launch story are one release with one closing state: a stranger can
find the post, watch the demo, clone the repo, and run the product. It ships only on s9's
gate: three green nights and the attested checklist are this sprint's preconditions, cited by
the deploy task.

## Design decisions

- **Open decisions (owner: Aarav, needed at implementation start)**: the product's public
  name ("Majordomo" is the working name) and the hosting target for the production deploy
  (candidates: Railway/Fly/Render-class host for API+workers+Postgres, Vercel for
  packages/web). Scope is host-agnostic; the deploy spec binds to "the chosen host".
- **Going public is a security event**: the repo history is audited for secrets before the
  flip (the .env key discipline held, but the audit is recorded, not assumed);
  SOLARI_API_KEY, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN move to host/CI secret stores; the
  fresh-clone setup is verified on a machine without them.
- **The demo shows consequence, not features**: recording follows the product's spine - a
  watch fires on a real change, a Telegram confirm, a cancellation mission with the rrweb
  replay - under three minutes, embedded in the post and linked in the README.
- **Launch post is the deliverable the judges see first**: LinkedIn + X, tagging @harrychow_
  and @getsolari per the challenge brief, telling the build-in-public story with the repo
  link, demo, and architecture writeup. Post copy is drafted for Aarav's approval - the
  account and the final send are his.

## Specifications

- `specs/production-deploy.md` (vertical) - the system live on the chosen host, migrations
  run, crons firing, secrets in stores, fresh-clone setup verified.
- `specs/public-launch-package.md` (vertical) - repo public after audit, README/architecture
  writeup, demo recording, launch post published with tags.

## Non-goals

- No multi-user hardening, billing, or signup funnel - the deployed instance is Aarav's.
  No new product features; a demo-blocking gap goes back to its owning sprint. No paid
  promotion - the post stands on the work.

## Task waves

[production-deploy, repo-public-polish] → [demo-recording] → [launch-post]
