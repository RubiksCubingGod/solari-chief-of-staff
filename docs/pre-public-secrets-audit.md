# Pre-public secrets audit

Recorded before flipping the repository public, per `challenge-launch`
(s10) `repo-public-polish` and `specs/public-launch-package.md`
("a recorded full-history secrets audit ... a found leak means
rotate-then-rewrite before the flip"). A hit is not a leak until reviewed;
this record shows the scan, the manual review of every flag, and the
disposition.

- **Date:** 2026-09-04
- **Scope:** all history reachable from every ref (`git rev-list --all`),
  234 commits, HEAD `859af50`.
- **Method:** git-native scan (`git log --all -S/-G` pickaxe, `git grep`,
  `git check-ignore`), reproducible from `scripts/secrets-audit.sh`.
  No third-party scanner (gitleaks/trufflehog) was installed on this
  machine; the git-native pickaxe over the four named secrets plus token
  and DB-URL shapes is the tooling-assisted pass.
- **Verdict: CLEAN. No real secret found in any commit. No
  rotate-then-rewrite required.**

## What was scanned

The four production secrets named in the deploy spec
(`SOLARI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`,
`MAGIC_LINK_SECRET`/`SESSION_SECRET`), plus:

- Anthropic key prefix `sk-ant-`.
- Telegram bot-token shape `NNNNNNNN:xxxxx`.
- Postgres URLs carrying an inline password.
- Whether a real `.env` (not `.env.example`) was ever tracked.

## Flags and dispositions

| Flag | Commits | Manual review | Disposition |
|---|---|---|---|
| `sk-ant-` | 3 | Only the fake literals `sk-ant-test-key…`, `sk-ant-not-a-real…`, `sk-ant-something…` in `*.test.ts` | Not a secret — test fixtures |
| `SOLARI_API_KEY=` / `ANTHROPIC_API_KEY=` / `TELEGRAM_BOT_TOKEN=` | 1–2 each | At HEAD: `.env.example` placeholders (`…`), CI `${{ secrets.* }}` references, `process.env` passthroughs, empty strings, and fake `123…` test tokens. No commit ever assigned a real (long, high-entropy) value | Not a secret |
| `MAGIC_LINK_SECRET=` | 0 | — | Absent |
| Telegram-token shape | 0 | — | Absent |
| Postgres URL w/ password | 15 | All localhost/fixture authorities: `postgres:…@127.0.0.1:55432`/`55433` (throwaway test servers), `chief_of_staff:…@127.0.0.1:5432` (local dev), `user:…@db` (compose service) | Not a production credential |
| Real `.env` tracked? | 0 | `git log --all --full-history` on `.env` paths is empty; `.env` and `packages/api/.env` are gitignored | Never tracked |

## Advisories for the owner (not blockers)

1. **Local-dev DB passwords are committed** in compose/test config, bound
   to `127.0.0.1`. These are dev-only, not production secrets, and are not
   a leak. Confirm they are throwaway values and not reused anywhere real.
2. **This audit covers history reachable from `859af50`** (the s9 branch).
   Before the flip, confirm the exact commit made public is this commit or
   an ancestor of it (i.e. no unaudited history is introduced by the
   PR #2 reconciliation), or re-run `scripts/secrets-audit.sh` against
   the final commit.
3. Production secrets go to the host/CI secret store, never into the repo
   — the discipline the scan confirms has held so far.
