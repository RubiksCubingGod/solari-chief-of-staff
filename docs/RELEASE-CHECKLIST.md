# Release checklist

The last gate before the product is run for a real person. Two kinds of
evidence go in here and neither can be produced by this repository on its
own: three consecutive green nights from the live-ops workflow, and five
items a person checks and signs. Attestation is by name and date, in this
file, in a pull request; a line left blank is an item nobody has checked.

The nights come from `.github/workflows/live-ops.yml`, which runs
`scripts/live-ops.mjs` each night and uploads its report. A night is
**green** when every case passed and the cost came in under target,
**failed** when a case failed or the cost ran over, and **errored** when a
case could not run at all. The release wants three consecutive green nights.
One errored night is skipped, neither counting nor breaking the run; two in a
row break it; a failed night always does.

Cost target: $5.00 per night across Solari and Anthropic together, the same
figure the live evals cap themselves at. Change it here and in the workflow's
`LIVE_OPS_COST_TARGET_USD` in the same pull request.

## Nights

Copy each night's line from the report the workflow uploads (`live-ops/night.json`,
rendered as `live-ops/night.md`). Oldest first. Consecutive green is the
count after that night, as the report computes it.

| Date | Verdict | Cost | Target | Consecutive green |
|---|---|---|---|---|
| | | | | |

## Secrets not in the repository

`SOLARI_API_KEY`, `ANTHROPIC_API_KEY` and the Telegram token live in `.env`
locally and in the repository's secrets in CI, nowhere else. Check the
history as well as the tree: `git log -p -S <first eight characters of each key>`
finds a key that was committed and later removed.

- Attested by:

## Session-leak ledger clean

Every browser session the live runs opened was closed by the run that
opened it. Compare the vendor console's session list against the runs of
the last three nights; a session with no run to account for it is a leak,
and the reaper closing it later does not make it not one.

- Attested by:

## Guardrail config armed

In the environment the product will run in: the domain allowlist is set and
not empty, the spend caps are the figures this file names, the schedule floor
is in force, and the site-connection timeout is set. Read them back from the
running process, not from the file they were meant to come from.

- Attested by:

## Replay spot-check

Pick one task run from each of the three green nights and replay it from
its recorded steps. The replay reaches the same outcome the night recorded,
and every step's page is one the allowlist permits.

- Attested by:

## Cost review

The three nights' costs, Solari and Anthropic apart, against the target
above and against what the vendors actually billed for those dates. A
report that sums to less than the bill is a case that is not metering
itself, and that is found here or not at all.

- Attested by:

Each attestation is a name and date, written by the person who did the
check, in the pull request that makes the release.
