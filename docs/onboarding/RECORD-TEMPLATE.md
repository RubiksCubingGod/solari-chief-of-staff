# Onboarding record: <site>

Copy this file to `docs/onboarding/records/<host>.md` and fill every field
while running `docs/onboarding/PROCEDURE.md`. An empty field is an onboarding
that is not finished; a field that does not apply says so and why.

| | |
|---|---|
| Site | |
| URL watched | |
| Date | |
| Person | |
| Candidate line in CANDIDATES.md | |

## Robots and terms

- Verdict (allowed / forbidden by robots / forbidden by terms):
- Robots rule matched (quote, with the path it covers):
- Terms clause on automated access (quote, with link):
- Public page or behind a login:

## Tier justification

- Tier the site needs (`http`, `browser`, `stealth`):
- What each lower tier hit (block signal, status, or "returned the value"):
- Duration and traffic of the manual check at that tier:

## Extractor

```json
{ "version": 1, "strategy": "css", "selector": "", "attribute": null, "parse": "" }
```

- Text of the element matched on the first fetch:
- Same element on the second fetch (yes / no, with the gap between them):

## Allowlist

- Hosts the check needs, one per line, each with why:

## Cost estimate

- Cost per check, with the arithmetic:
- Checks per day (from the schedule):
- Monthly cost:
- Cost target it is against, and where that target is recorded:
- Under target (yes / no; if no, what was changed):

## Check budget

- Schedule (five-field cron, UTC):
- Why this schedule and not a slower one:

## Site connection

- Not applicable (public page), or:
- Host as connected:
- Date connected:
- Has a task signed in with it since (yes / no, task id):

## Anomalies and dispositions

One line each: what happened, then `accepted`, `mitigated` or `dropped`, then
why or what was changed.

-

## Configured watch

- Watch id:
- First observation: value, `tier_used`, `checked_at`:
- Decision (watching / dropped, with the deciding field above):
