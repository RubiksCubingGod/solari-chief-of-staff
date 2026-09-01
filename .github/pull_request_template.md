## What this changes

<!-- The outcome, not the diff. Which sprint task or spec does this close? -->

## Proof

<!-- The proofs that ran, and anything a reviewer should re-run by hand. -->

## Manual checks

`pnpm check` covers lint, types, unit and integration tests, the coverage gate,
and the build. It cannot see any of the following, so tick what applies and
strike out what does not.

- [ ] Ran against a real site or a real Solari session, not only fixtures
- [ ] Telegram conversation reads the way a person would expect
- [ ] Dashboard renders correctly at a phone width
- [ ] Recording or replay artifacts play back
- [ ] Nothing new is written to the logs that should not be there
- [ ] `.env.example` still documents every variable this needs
