# Onboarding record: Expedia flight search

The onboarding ended at step 1 of `docs/onboarding/PROCEDURE.md`: the robots
file forbids the path. Every later section is not applicable for that reason,
and says so. The page was never fetched.

| | |
|---|---|
| Site | www.expedia.com |
| URL watched | `https://www.expedia.com/Flights-Search?...&leg1=from:...(CHO-Charlottesville-Albemarle),to:...(LAS-All Airports),departure:9/17/2026...&leg2=...departure:9/24/2026...&options=cabinclass:economy&passengers=adults:1` (round trip CHO to LAS, 17 to 24 September 2026, one adult, economy; the person's price target was 675 dollars) |
| Date | 2026-09-03 |
| Person | Aarav (RubiksCubingGod), with a Claude Code session running the fetches |
| Candidate line in CANDIDATES.md | "An online travel agency's flight search results page", added with this record |

## Robots and terms

- Verdict (allowed / forbidden by robots / forbidden by terms): **forbidden by robots**.
- Robots rule matched (quote, with the path it covers): under `User-agent: *`
  in `https://www.expedia.com/robots.txt` (fetched 2026-09-03, status 200):
  `Disallow: /Flights-Search`. It covers the whole path the watch would read,
  `/Flights-Search?...`. The same block also disallows `/Flight-SearchResults`,
  `/Flight-Information`, `/Flights-BagFees`, `/FlightCheckout` and
  `/Confirmation-Flight`, so no flight page of the site is open to a watch.
- Terms clause on automated access (quote, with link): not retrieved. Both
  `https://www.expedia.com/lp/lg-legal` and `https://www.expedia.com/terms`
  answered `429 Too Many Requests` to a plain fetch from this machine, the
  legal page itself sitting behind the site's bot protection, and no browser
  session was connected to read it. The robots verdict ends the onboarding on
  its own; whoever next has the terms open can paste the clause here.
- Public page or behind a login: public (a search results page), no login.

## Tier justification

- Tier the site needs (`http`, `browser`, `stealth`): not applicable, because
  the onboarding ended at step 1 and the disallowed page was not fetched.
- What each lower tier hit: not applicable. One incidental signal: the legal
  pages answered 429 at `http`, so the site would not have worked at `http`.
- Duration and traffic of the manual check at that tier: not applicable.

## Extractor

```json
{ "version": 1, "strategy": "css", "selector": "", "attribute": null, "parse": "" }
```

- Text of the element matched on the first fetch: not applicable, because no fetch was made.
- Same element on the second fetch: not applicable.

## Allowlist

- Hosts the check needs, one per line, each with why: not applicable, because
  the site is out at step 1.

## Cost estimate

- Cost per check, with the arithmetic: not applicable.
- Checks per day (from the schedule): not applicable.
- Monthly cost: not applicable.
- Cost target it is against, and where that target is recorded: the target is
  not yet set in `docs/onboarding/CANDIDATES.md` (open decision 2, proposed
  $0.01 per check and $3 per watch per month); nothing here was compared with it.
- Under target: not applicable.

## Check budget

- Schedule (five-field cron, UTC): not applicable.
- Why this schedule and not a slower one: not applicable.

## Site connection

- Not applicable (public page).

## Anomalies and dispositions

- The site's legal pages answer 429 to a plain fetch with a browser user
  agent, before any disallowed path was touched: `dropped`, though the robots
  rule had already decided it.

## Configured watch

- Watch id: none.
- First observation: none.
- Decision (watching / dropped, with the deciding field above): **dropped**,
  by the robots verdict. The person's watch intent (a CHO to LAS round trip
  under 675 dollars for 17 to 24 September 2026) stands and needs a site whose
  robots file and terms allow a watch; flight search pages on the other
  agencies of the same group (orbitz.com, travelocity.com) carry the same
  `Disallow: /Flights-Search`.
