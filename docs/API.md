# HTTP API

The surface `packages/api` serves, as a client sees it. The chat tools in
`packages/agent` and the dashboard in `packages/web` are both clients of this
document; neither reaches the database directly. ARCHITECTURE §5 is the data
model behind it.

## Conventions

- Requests and responses are JSON. A row comes back with its column names in
  camelCase (`tierPolicy`, `lastCheckedAt`), timestamps as ISO 8601 instants.
- Every route below acts for the signed-in user, identified by the session
  cookie the magic-link flow issues (`POST /auth/login`, `GET /auth/consume`).
  A request with no session, or a session for a user who no longer exists, is
  refused `401 unauthorized` before anything is read or written.
- Every refusal has one shape, and clients branch on `code`, never on the
  wording:

  ```json
  { "error": { "code": "validation_failed", "message": "...", "details": [ { "path": "/schedule", "message": "..." } ] } }
  ```

  `details` is present on `validation_failed` only. Each entry names the field
  as a JSON Pointer into the request body (or query) and says what was wrong
  with it. Every violation is reported in one response, so a form is fixed in
  one round trip.

  | code | status | meaning |
  |---|---|---|
  | `malformed_json` | 400 | the body was not JSON |
  | `validation_failed` | 400 | the body or query did not match the route, by field |
  | `bad_request` | 400 | a refusal with no single field to name (say, a window that ends before it starts) |
  | `unauthorized` | 401 | no session the server believes |
  | `not_found` | 404 | no such route, or no such row that belongs to you |
  | `method_not_allowed` | 405 | |
  | `payload_too_large` | 413 | |
  | `unsupported_media_type` | 415 | the body was not `application/json` |
  | `internal_error` | 500 | the reason is in the server log, never in the response |

  A row that belongs to somebody else answers exactly as a row that does not
  exist, character for character apart from the id.

## Watches

A watch is a page the engine checks on a schedule and a condition that makes a
check worth telling you about. The fields a client sets are validated at the
door in two layers: JSON Schema for the shape, then the engine's own rules for
the meaning, so that a watch the API accepts is a watch a check can run. A
watch that passed only the first would be stored and never fire.

### The watch row

| field | type | who writes it |
|---|---|---|
| `id` | uuid | the server |
| `userId` | uuid | the server, from the session |
| `kind` | `price` \| `change` \| `slot` | the client, at creation |
| `url` | string | the client, at creation |
| `schedule` | five-field cron expression | the client, at creation |
| `condition` | object, per kind (below) | the client, at creation |
| `extractor` | object | the client at creation, or the engine on the first check |
| `tierPolicy` | `auto` \| `http` \| `browser` \| `stealth` | the client, at creation (default `auto`) |
| `status` | `active` \| `paused` | the client, through `PATCH` |
| `health` | `healthy` \| `needs_extractor` \| `blocked` \| `degraded` | the engine, or a tier reset |
| `tierFloor` | `http` \| `browser` \| `stealth` | the engine, or a tier reset |
| `lastValue` | the value the last successful check read, or null | the engine |
| `lastCheckedAt` | instant or null | the engine |
| `lastError` | why the most recent check failed, or null | the engine |
| `consecutiveFailures` | integer | the engine |

`status` is what you want; `health` is what the engine found. A paused watch is
not checked. A watch whose health is `blocked` was refused at every tier its
policy allows; `degraded` is one whose extractor broke and could not be healed
within budget; `needs_extractor` is one the model could not write an extractor
for. Each comes with `lastError` saying why.

### `POST /watches`

Creates a watch. Responds `201` with the row.

| field | required | rule |
|---|---|---|
| `kind` | yes | `price` or `change`. `slot` is in the vocabulary but refused until slot-sniping teaches the engine to check one. |
| `url` | yes | `http` or `https`, at most 2048 characters, with no credentials in it (a `user:password@` would end up in `lastError` and the logs). |
| `schedule` | yes | A five-field cron expression (an optional sixth field for seconds is accepted). Consecutive runs have to be at least five minutes apart - the shortest gap counts, so `0,3 * * * *` is refused - and the next run has to come within a year. |
| `condition` | yes | Per kind, below. |
| `extractor` | no | Omit it, or send `{}`, and the engine writes one with the model on the first check. Send a full spec (`version: 1`, `strategy: "css"`, `selector`, `attribute` or null, `parse`) to skip that; its `parse` has to be the one this kind reads with (`price` for a price watch, `digest` for a change watch). |
| `tierPolicy` | no | `auto` (default) climbs from plain HTTP to a browser to a stealth browser as the page refuses each; any other value pins that single tier. |

A **price** condition is `{ "drops_below": number }`, `{ "rises_above": number }`
or both, in the page's own units (a threshold of 20 on a page that shows
$19.99 fires; there is no cents convention). Thresholds are numbers of zero or
more, `drops_below` is above zero, and when both are given `drops_below` is
below `rises_above`. No other key is accepted.

A **change** condition is `{}` for the whole page, or `{ "region": "the
headline" }`: where on the page to look, in your own words, at most 200
characters. The region is read once, when the extractor is written; a check
compares what the extractor reads.

Refusals are `400 validation_failed` with one `details` entry per field, for
instance `/condition/drops_below`, `/schedule`, `/extractor/parse`. Nothing is
stored when anything is refused.

```json
{ "kind": "price", "url": "https://shop.example/product/kettle", "schedule": "*/15 * * * *", "condition": { "drops_below": 40 } }
```

### `GET /watches`

Every watch of yours, ordered by id. `200` with an array of rows.

### `PATCH /watches/:id`

Body `{ "status": "paused" }` or `{ "status": "active" }`. Pausing stops the
checks; resuming schedules them again. `200` with the row, `404 not_found` for a
watch that is not yours.

### `POST /watches/:id/tier-reset`

The one way down the tier ladder. The engine records the lowest tier that has
worked for a watch (`tierFloor`) and starts there on every later check, since a
site that refused plain HTTP once will refuse it again. When you have reason to
think otherwise - the site changed, or the watch was pointed somewhere else -
this sets `tierFloor` back to `http` and `health` back to `healthy`, so the next
check starts from the cheapest tier with no verdict hanging over it. What the
last check found (`lastError`, `consecutiveFailures`) is left as it was. No
body. `200` with the row, `404 not_found` for a watch that is not yours.

### `GET /watches/:id/observations`

The check history behind a sparkline: `200` with an array, oldest first, of
`{ id, watchId, checkedAt, tierUsed, value, triggered, error }`. Exactly one of
`value` and `error` is set on each.

| query | rule |
|---|---|
| `from` | an ISO 8601 instant with a zone; the window starts here, inclusive |
| `to` | an ISO 8601 instant with a zone; the window ends here, exclusive |
| `limit` | 1 to 500; default 100. When the series is longer, the newest observations are kept. |

A `to` that is not later than `from` is `400 bad_request`; an unknown query
parameter is `400 validation_failed`. A watch that is not yours is `404
not_found`.
