# Onboarding a real site

A person runs this, from one line of `docs/onboarding/CANDIDATES.md` to a
configured watch and a filled-in copy of `docs/onboarding/RECORD-TEMPLATE.md`.
None of it is automated end to end, on purpose: the steps that decide whether
a site may be watched at all and what it will cost are judgments, and the
record is where each judgment is written down so a later reader can disagree
with it. Every section below ends with what goes in the record.

Before starting: `pnpm check` is green on `main`, `pnpm migrate` has run
against the database the watch will live in, and the API is up with
`pnpm start`. `SOLARI_API_KEY` is set in `.env` (never in the example file)
if any step below turns out to need a browser tier.

## Robots and terms

1. Fetch `https://<host>/robots.txt`. Find the longest rule that matches the
   path you mean to watch, under `User-agent: *`. A `Disallow` that covers
   it ends the onboarding: write the verdict and stop.
2. Read the site's terms for clauses on automated access, scraping, crawling
   or "robots". Quote the clause and link it. A clause that forbids automated
   reading ends the onboarding, whatever the robots file says.
3. Note whether the page is public or behind a login. A login is handled under
   Site connection and is a reason to prefer a public page for a first watch.

Record: the verdict, the robots rule matched, the terms clause quoted.

## Fetch tier

The tiers are `http`, `browser` and `stealth`, in cost order; `auto` starts at
`http` and climbs only on a block signal (`packages/core/src/index.ts`,
`packages/core/src/watch/ladder.ts`). The signals are a challenge page, a
block status (401, 403, 429, 503) and an empty shell - a body with next to no
visible text, which is what a client-rendered application looks like without
a browser.

1. Try `http` by hand:

   ```sh
   curl -sS -A "Mozilla/5.0" -o page.html -w "%{http_code}\n" "<url>"
   ```

   Open `page.html` and look for the value you want. If it is there, the site
   works at `http` and the tier question is settled.
2. If the body is a shell or a challenge, the site needs `browser`. If a plain
   browser is blocked too, it needs `stealth`. Find out with one manual check
   at each tier through the API (see Configuring the watch), reading `tier_used` on the
   observation, rather than by guessing.
3. Prefer a page that works at `http`. A site that needs `stealth` for a plain
   read is dropped unless the cost estimate still comes in under target.

Record, as "Tier justification": the first tier that returned the value, and
the block signal each lower tier hit.

## Extractor bootstrap

An extractor is the JSON the watch reads the page with
(`packages/core/src/watch/extractor.ts`):

```json
{ "version": 1, "strategy": "css", "selector": "<css selector>", "attribute": null, "parse": "price" }
```

1. In the fetched HTML, find the element holding the value. Write the most
   specific selector that names the thing rather than its layout: an id, a
   `data-` attribute, a class such as `product-price`, never `div > div:nth-child(3)`.
2. Choose `parse`: `price` for money, `digest` for "tell me when this region
   changes", `slots` for availability.
3. Fetch again a few minutes later and check the selector still matches the
   same element. A selector that drifts between two fetches is an anomaly
   (see Anomalies), not an extractor.

Record: the extractor JSON, and the text of the element it matched.

## Allowlist

A watch fetches one URL and follows no redirect off its host. A playbook -
the action side, if this site will ever have one - fetches within a domain
allowlist the playbook declares. Write down every host the check needs: for
`http`, the page host alone; for a browser tier, also the hosts the page must
load for the value to render, which you read off the browser's network panel
during the manual check. Anything not on the list is not allowed, so a value
that needs a third-party host to render is a reason to look for a different
page.

Record: the hosts, one per line, each with why it is needed.

## Cost estimate

Checks are the recurring cost (`docs/ARCHITECTURE.md`, the cost note under
the watch engine). Per check: `http` is free; `browser` is the session's
minutes at the vendor's rate for the plan; `stealth` adds residential proxy
traffic per megabyte. Take the duration and traffic from the manual check under
Fetch tier, not from a guess.

Monthly cost = cost per check × checks per day (from Check budget) × 30. Compare it with
the cost target a person set in `docs/onboarding/CANDIDATES.md`. Over target,
the choices are a slower schedule, a lower tier, or a different page; the
record says which was taken.

Record: the per-check figure with its arithmetic, the monthly figure, and the
target it is against.

## Check budget

The schedule is a five-field cron expression, evaluated in UTC, with a floor
of one check every five minutes (`packages/core/src/watch/config.ts`). Pick the
slowest schedule that still catches what the person cares about: a price that
moves daily wants `0 */6 * * *`; a slot page wants something like
`*/15 8-20 * * 1-5`, during the hours slots appear and not at night. Count
the checks per day the expression makes and feed the number back into the cost estimate.

Record: the schedule, the checks per day, and the monthly cost it implies
against target.

## Site connection

Only for a page behind a login. Open the dashboard's Sites page (`/connect`),
type the host, and follow the attempt page: the API mints a browser profile,
you log in inside the vendor console's profile editor, and you press confirm
when you are signed in. The routes and their refusals are under "Site
connections" in `docs/API.md`. Never type a password into this repository, a
record, or a chat; the flow has no field for one and neither does the record.

Record: the host as connected, the date, and whether a task has since signed
in with it. Not the profile id - the server keeps that and the record does
not need it.

## Anomalies

Write down everything the procedure did not predict, as it happens: a value
that renders differently on repeat fetches, a consent wall, a geographic
redirect, a rate limit after some number of fetches, a selector that matched
a different element the second time. Each anomaly gets a disposition:

- **accepted** - the watch is configured anyway, and the record says why;
- **mitigated** - something was changed to get round it, and the record says what;
- **dropped** - the site is out, and the record says which anomaly decided it.

Record, as "Anomalies and dispositions": one line per anomaly, with its
disposition.

## Configuring the watch

Create the watch through `POST /watches` (`docs/API.md`), or by asking the bot
in the same words, with the extractor from Extractor bootstrap, the schedule from Check budget,
and `tierPolicy` set to the tier Fetch tier justified, or `auto` if the record
says `http` works. Run the worker with `pnpm worker` and read the first
observation back through `GET /watches/:id/observations`: the value it read
is the one the extractor named, and `tier_used` is the tier the record justified.

Record: the watch id, the first observation's value and tier, and the date.
The record is complete when every field of the template has an entry, even
if the entry is "not applicable, because ...".
