# Candidate sites

A shortlist for the first real watches. It is an input to a decision, not a
record of one: nothing here has been onboarded, and every line goes through
`docs/onboarding/PROCEDURE.md` before it is. The choice of which lines to run,
and the cost target they are held to, are a person's to make.

## Open decisions

1. **Which candidates to onboard first.** Open decision. Two is the proposed
   number for the first round: one public price page and one public
   availability page, so the `price` and `slots` parsers each get a real site
   before anything behind a login is tried.
2. **The cost target.** Open decision. The architecture's figure is under one
   cent per check at the browser tier; the proposed target for this round is
   **$0.01 per check and $3 per watch per month**, which is the browser tier
   at a six-hourly schedule with room to spare. A person sets the number in
   this file before the first record is written, and every record's cost
   estimate is compared with it.

## Shortlist

Each line is a kind of page and the reasons it is a good or bad first site.
The host is left to the person choosing: step 1 of the procedure is where a
specific site's robots file and terms are read, and no site is named here as
if that had been done.

| Kind of page | Parser | Likely tier | For | Against |
|---|---|---|---|---|
| A supermarket's product page for one staple item | `price` | `http` or `browser` | prices move often enough to prove a drop notification within a week; the value is one element | large grocers render prices client-side and some rate-limit plain fetches |
| A public transport or venue page listing seat or slot availability | `slots` | `browser` | proves the slot parser on a real page; availability changes on a schedule a person can predict | slot pages are the most likely to sit behind a challenge page |
| A public library, clinic or municipal booking page | `slots` | `http` | usually plain server-rendered HTML with permissive robots; the kind of page the product exists for | slots may be rare, so a green run can take days to see a trigger |
| A software vendor's pricing page | `digest` | `http` | static, cheap, changes rarely; proves the change watch and costs nothing | a change may never come during the trial window |
| A second-hand marketplace search for one item | `price` | `browser` or `stealth` | the most useful watch to a real person | the terms of most marketplaces forbid automated reading; expected to fail step 1 |
| An online travel agency's flight search results page | `price` | `browser` or `stealth` | a fare the person is actually waiting on; a real drop is worth a notification | **failed step 1 on 2026-09-03**: www.expedia.com's robots file disallows `/Flights-Search` under `User-agent: *` (`records/www.expedia.com.md`); orbitz.com and travelocity.com carry the same rule, and the legal pages answer 429 to a plain fetch |
| A gym club page with a live class schedule | `slots` or `digest` | `http` | server-rendered spot counts that move through the day; free tier | **failed step 1 on 2026-09-03**: robots allows the path but www.goldsgym.com's Terms & Conditions forbid automated monitoring (`records/www.goldsgym.com.md`) |
| A National Weather Service point-forecast page | `price` or `digest` | `http` | **onboarded and watching on 2026-09-03** (`records/forecast.weather.gov.md`): public-domain, robots-clean, terms-clean, server-rendered, $0 at the free tier; both a numeric temperature threshold and a conditions-change digest verified live | the value moves on the weather's schedule, so a threshold trigger can take days to fire |

## How to use this file

Pick lines, set the cost target above, then run the procedure once per line
and put the record beside this file under `records/`. A line that fails step
1 stays in the table with a note saying so, so the next person does not try
it again; the table is the memory of what was tried.
