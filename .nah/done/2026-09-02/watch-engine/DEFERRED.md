# Deferred

Nothing deferred during bootstrap.

## From hardening (2026-09-02)

Observations below medium, or outside the accepted outcome, recorded so the
next sprint that touches the surface finds them. None is a defect in what the
sprint promised.

- **Inverted two-sided condition.** The condition parser accepts
  `drops_below` above `rises_above` (say 20 and 15). Every price between the
  two is then past both bounds at once: it triggers once, worded as the floor
  crossing, and reads "still drops below" after. Rejecting the pair is an
  acceptance change on the config surface (a new typed 4xx), so it is not
  made here.
- **Private-address URLs.** A watch URL only has to be http or https; the
  worker will fetch `http://127.0.0.1:…` or a LAN address like any other.
  Fine for the single-operator deployment this sprint serves; a shared
  deployment needs an address policy in `checkWatchConfig` before the URL is
  accepted.
- **Ticks that outlive their interval.** A tick is bounded by the fetch
  timeouts (15 s http, 30 s browser, 30 s stealth) and the harness's retry
  policy (three retries, 5 s apart), so a site that times out on every tier
  on every attempt can hold one cron firing for a little over five minutes,
  the schedule floor. The next firing then overlaps: two observations for one
  interval, and if both reach the extract step with no extractor yet, two
  creation calls. Needs a site that stalls on all tiers four times in a row
  and then serves. pg-boss debounces cron sends per key within one minute
  only; a per-watch singleton on the check queue would close it.
- **Content-only dedup keys.** A trigger key is (watch, condition, value) and
  a block key is (watch, tiers tried, signal). A change watch that goes
  A→B→A, or a watch blocked again after recovering, repeats a key; the
  delivery channel (s7) needs a time window on its dedup rather than a set.
