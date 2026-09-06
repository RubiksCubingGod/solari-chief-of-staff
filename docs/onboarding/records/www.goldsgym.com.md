# Onboarding record: Gold's Gym Willow Lawn class availability

The onboarding evaluated a class-availability watch on the Willow Lawn club
page. The robots file allows the path, but the site's Terms & Conditions
forbid automated monitoring (quoted below), and step 2 of
`docs/onboarding/PROCEDURE.md` ends the onboarding on a terms clause whatever
robots says. So the verdict is **dropped by terms**.

Separately, and worth keeping: the watch-engine wiring was verified live
against this page as a one-off engineering smoke (not a standing watch). It
fetched at the free `http` tier, the extractor read the real availability
element, an observation persisted to Postgres, and a change fired the
notifier. That proves the machinery end to end; it does not make the site
watchable, because the terms forbid a scheduled watch. The smoke's rows were
deleted afterward; no watch is configured.

| | |
|---|---|
| Site | www.goldsgym.com |
| URL evaluated | `https://www.goldsgym.com/locations/va/richmondwillowlawn/` (Gold's Gym Willow Lawn, Richmond VA; class schedule with live spot counts) |
| Date | 2026-09-03 |
| Person | Aarav (RubiksCubingGod), with a Claude Code session running the fetches |
| Candidate line in CANDIDATES.md | "A gym club page with a live class schedule", added with this record |

## Robots and terms

- Verdict (allowed / forbidden by robots / forbidden by terms): **forbidden by terms**.
- Robots rule matched (quote, with the path it covers): none covers the path.
  `https://www.goldsgym.com/robots.txt` (fetched 2026-09-03, status 200) under
  `User-agent: *` disallows `/wp-admin/`, `/locations/*?*` (only location URLs
  that carry a query string), `/*/success/`, `/feed`, `/*/feed/`, `/blog/?`
  and `/wp-json`. The watched path `/locations/va/richmondwillowlawn/` has no
  query string, so **robots allows it**.
- Terms clause on automated access (quote, with link): forbidden. From
  `https://www.goldsgym.com/terms-and-conditions/` (fetched 2026-09-03):
  "You may not use any deep-link, page-scrape, spider, robot, crawl, index,
  Internet agent, or other automatic device, program, algorithm or technology
  which does the same things, to use, access, copy, acquire information,
  generate impressions, input information, store information, search, generate
  searches, or monitor any portion of the Gold's Gym Digital Properties." A
  scheduled watch monitors a portion of the site, which this forbids. The same
  terms also ban "harvest or collect information about Digital Properties
  users." The terms verdict ends the onboarding.
- Public page or behind a login: public (a club page), no login.

## Tier justification

- Tier the site needs (`http`, `browser`, `stealth`): **http** (measured, not
  guessed). The class schedule and its spot counts are server-rendered in the
  raw HTML, so a plain HTTP GET returns the value.
- What each lower tier hit: none. `http` returned the value on the first
  fetch; the ladder never had to climb.
- Duration and traffic of the manual check at that tier: one HTTP GET, ~900 KB,
  sub-second, **$0** (no Solari browser session, no residential proxy). Measured
  by a one-off engineering smoke, not a standing watch.

## Extractor

```json
{ "version": 1, "strategy": "css", "selector": ".schedule__week-item-spots", "attribute": null, "parse": "digest" }
```

- Text of the element matched on the first fetch: `46 spots left` (the first
  class slot's availability). A `slots` parser on the same selector would read
  the same element as an availability count for a slot watch.
- Same element on the second fetch: yes; the selector matched the same
  `schedule__week-item-spots` element (the live series read
  "46 spots left 30 spots left 46 spots left ...").

## Allowlist

- `www.goldsgym.com` — the page host, and the only host needed: the value is
  server-rendered, so no third-party host has to load for it to appear.

## Cost estimate

- Cost per check, with the arithmetic: **$0** — `http` tier is free; no browser
  minutes and no proxy traffic.
- Checks per day (from the schedule): not applicable (dropped by terms).
- Monthly cost: $0 in principle, but not applicable, because the site is
  dropped.
- Cost target it is against, and where that target is recorded: still unset in
  `docs/onboarding/CANDIDATES.md` (open decision 2, proposed $0.01 per check).
  Nothing was compared against it, since the site is out.
- Under target: not applicable.

## Check budget

- Schedule (five-field cron, UTC): not applicable (dropped by terms).
- Why this schedule and not a slower one: not applicable.

## Site connection

- Not applicable (public page).

## Anomalies and dispositions

- Robots allows the path but the Terms & Conditions forbid automated
  monitoring: **dropped**. This is the deciding field.

## Configured watch

- Watch id: none. No standing watch was configured, because the terms forbid a
  scheduled monitor.
- First observation: one was captured as an engineering smoke — a digest of the
  live availability region ("46 spots left 30 spots left ..."), read at the
  `http` tier on 2026-09-03 and persisted to Postgres, then deleted with the
  rest of the smoke's rows. Not a production observation.
- Decision (watching / dropped, with the deciding field above): **dropped**, by
  the terms verdict. What stands: the watch-engine wiring is proven end to end
  against a real site at $0, so a site whose robots **and** terms both permit a
  watch is a short onboarding away. That terms-clean site is what the
  real-watches evidence still needs.
