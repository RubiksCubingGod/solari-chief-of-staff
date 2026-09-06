# Onboarding record: NWS forecast (Charlottesville, VA)

The first site that clears the whole procedure and is **watched**, not dropped.
The National Weather Service forecast point page is public-domain government
content: robots imposes nothing, the terms permit free use with no clause
against automated reading, the value is server-rendered so the check runs at
the free `http` tier, and the wiring was proven end to end against it live.

| | |
|---|---|
| Site | forecast.weather.gov |
| URL watched | `https://forecast.weather.gov/MapClick.php?lat=38.0293&lon=-78.4767` (NWS point forecast for Charlottesville, VA) |
| Date | 2026-09-03 |
| Person | Aarav (RubiksCubingGod), with a Claude Code session running the fetches |
| Candidate line in CANDIDATES.md | "A National Weather Service point-forecast page", added with this record |

## Robots and terms

- Verdict (allowed / forbidden by robots / forbidden by terms): **allowed**.
- Robots rule matched (quote, with the path it covers): none. `https://forecast.weather.gov/robots.txt`
  returned `404 Not Found` (fetched 2026-09-03), so no rule forbids any path;
  `/MapClick.php` is open.
- Terms clause on automated access (quote, with link): none forbids it. The NWS
  disclaimer (`https://www.weather.gov/disclaimer/`) states the information "is
  in the public domain ... and may be used freely by the public" and "may be
  distributed or copied," with the only limits being that content not be
  "modified in content and then presented as official government material," and
  the security rule against "unauthorized attempts to upload information or
  change information." A read-only watch does neither. There is no anti-scraping
  or anti-monitoring clause.
- Public page or behind a login: public, no login.

## Tier justification

- Tier the site needs (`http`, `browser`, `stealth`): **http** (measured). The
  current conditions and forecast are server-rendered in the HTML; a plain GET
  returns the value.
- What each lower tier hit: none. `http` returned the value on the first fetch;
  the ladder never climbed.
- Duration and traffic of the manual check at that tier: one HTTP GET, ~52 KB,
  sub-second, **$0** (no browser session, no residential proxy).

## Extractor

Two extractors were verified against the live page; the watch below uses the
`change` one, because a change watch fires on every conditions update and so
exercises the notification path reliably. A `price` watch on the temperature is
also valid and is noted for a threshold alert.

Change (the configured one):

```json
{ "version": 1, "strategy": "css", "selector": "#current_conditions-summary", "attribute": null, "parse": "digest" }
```

Price (available, for a "temp drops below N" alert):

```json
{ "version": 1, "strategy": "css", "selector": ".myforecast-current-lrg", "attribute": null, "parse": "price" }
```

- Text of the element matched on the first fetch: the change selector read the
  current-conditions summary, digested from "Fair 87°F 31°C"; the price selector
  read `.myforecast-current-lrg` = "87°F", parsed to `{ amount: 87, currency: null }`.
- Same element on the second fetch: yes; both selectors matched the same
  elements. (The `.myforecast-current-lrg` block is the NWS large current-temp
  element, stable across the site's point pages.)

## Allowlist

- `forecast.weather.gov` — the page host, and the only host needed: the value is
  server-rendered, so nothing third-party has to load for it to appear.

## Cost estimate

- Cost per check, with the arithmetic: **$0**. `http` tier is free — no browser
  minutes, no proxy megabytes.
- Checks per day (from the schedule): 24 (hourly).
- Monthly cost: $0 × 24 × 30 = **$0**.
- Cost target it is against, and where that target is recorded: the target is
  still unset in `docs/onboarding/CANDIDATES.md` (open decision 2). $0 is under
  any non-negative target.
- Under target: yes (trivially).

## Check budget

- Schedule (five-field cron, UTC): `0 * * * *` (hourly).
- Why this schedule and not a slower one: NWS refreshes point observations about
  once an hour, so hourly catches every update without paying for checks that
  would read the same value. The check is free, but a slower cadence would miss
  intra-day swings; a faster one would only re-read the same hourly observation.

## Site connection

- Not applicable (public page, no login).

## Anomalies and dispositions

- `robots.txt` is a 404 on the forecast subdomain: **accepted** — a missing
  robots file forbids nothing, and the terms independently permit the read.

## Configured watch

- Watch id: to be assigned when the standing watch is created in the production
  database via `POST /watches` under `pnpm start` + `pnpm worker` (the durable
  DB and the multi-day run are the operator's). The exact create body:

  ```json
  {
    "kind": "change",
    "url": "https://forecast.weather.gov/MapClick.php?lat=38.0293&lon=-78.4767",
    "schedule": "0 * * * *",
    "condition": { "region": "current conditions" },
    "extractor": { "version": 1, "strategy": "css", "selector": "#current_conditions-summary", "attribute": null, "parse": "digest" },
    "tierPolicy": "http"
  }
  ```

- First observation: an onboarding check was run live through the product's own
  pipeline (fetch ladder → extractor → comparator → store → notifier) on
  2026-09-03: `tier_used = http`, value = the current-conditions digest of
  "Fair 87°F 31°C" (and, on the price extractor, `87`), the observation
  persisted to Postgres and the watch row updated. The change path was verified
  to fire the notifier on a differing value.
- Decision (watching / dropped, with the deciding field above): **watching**,
  by the allowed robots-and-terms verdict. This is the sprint's first real
  watch target; the standing watch, its three-day observation series, and the
  delivered notification are the operator-run evidence the `real-watches` task
  attests.
