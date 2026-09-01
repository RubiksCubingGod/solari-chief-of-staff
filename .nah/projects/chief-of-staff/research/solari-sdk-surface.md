---
schema_version: 1
id: solari-sdk-surface
created_at: 2026-09-01
created_by: RubiksCubingGod
generated_by: claude-fable-5 (dig research agent)
origin:
  summary: Cited Solari browser SDK facts (attach paths, session hygiene, profiles, recording,
    live-view gap, stealth/proxy behavior, limits) needed to implement the SolariProvider in
    the browser-substrate release.
  refs:
    - context/challenge-brief.md
    - context/architecture-direction.md
candidate_sprint: browser-substrate
---

# Research: Solari SDK surface for a `SolariProvider` (BrowserProvider implementation)

**Question:** What is the exact Solari browser SDK surface a `SolariProvider` must call — package/install, attach path, session lifecycle and cleanup, persistent profiles, recording, live view, stealth/proxy, captcha, and operational limits?
**Scope:** In — the Solari **Cloud Browser** product only (`@solarisdk/browser` / `solari-browser`), its HTTP gateway, and the cookbook examples. Out — Sandboxes, Desktops/VMs, and the `@solarisdk/sandbox` / `@solarisdk/desktop` surfaces, except where the cookbook's gotchas conflate them with the browser (called out explicitly, because the brief inherited one such conflation).
**Date of research:** 2026-08-31
**Confidence in coverage:** **High on API shape, low on operational reality.** Every API-shape claim below is triangulated against two or three independent artifacts: the vendor reference docs, the published npm/PyPI package source (which I downloaded and read), and the cookbook's runnable examples. Nothing here is from general knowledge about other cloud-browser vendors. But there is **zero third-party evidence** — no named production user, no independent engineering post, no critical voice, no post-mortem. Everything about reliability, latency, block rates, and captcha success is vendor assertion and is graded accordingly.

---

## Confidence and gaps — read this first

Things I **verified against shipped code** (highest confidence, grade A for "the client does this"):

- The npm package `@solarisdk/browser@0.1.2` exists, and I read its `dist/*.d.ts` and `dist/*.js`. [27][28]
- The PyPI package `solari-browser==0.1.3` exists, and I read `types.py` / `client.py` from the wheel. [31]
- The cookbook fork `RubiksCubingGod/solari-cookbook` is at commit `d304843f5ea0edb5c27829bb2ca30868645bef7a`, **byte-identical to upstream `solari-sdk/solari-cookbook` at the same commit**, single branch `main`, no local commits. There is nothing in the fork that is not upstream. [25][20]

Things that are **vendor-asserted and I could not corroborate** (treat as claims, not facts):

| Claim | Where it comes from | Why I can't verify it |
|---|---|---|
| Stealth "gets past Cloudflare, DataDome, Akamai, PerimeterX" | Vendor docs + changelog [6][32] | No third-party test, no published pass rate, no failure-mode content. Vendor marketing tier. |
| Captcha solve coverage and success rate for reCaptcha/hCaptcha/Turnstile | Vendor docs [8] | No solve-rate number is published anywhere. No latency figure. No behavior on solve failure is documented. |
| "Ready in about a second"; 200–400 ms create+first-page in-region | Vendor docs [34][10] | No independent benchmark exists. |
| Pricing, concurrency caps, retention windows | Vendor pricing page [9] | Single source. Not restated in the API reference or the SDK. Could change without a docs diff. |
| Proxy country pool, tier availability | Vendor docs [7][12] | The docs themselves say `enabled: true` is **not** a per-tier guarantee, and that a mobile ask can silently degrade to residential. |

**Hard gaps — the public record does not answer these:**

1. **There is no documented API that returns a watchable live-session URL for a browser session.** This is the single biggest gap relative to the brief. Details in Q5. Do not assume one exists.
2. **There is no `kill()` on the browser SDK.** The brief's `close()` vs `kill()` framing comes from the cookbook's *VM/sandbox* gotcha, not the browser. Details in Q2.
3. **No request-rate limit is documented anywhere** — only per-plan *concurrency* caps. No `Retry-After`, no `X-RateLimit-*` header is mentioned in the errors page or the API reference. [11][12] I could not find a rate-limit statement to cite; treat "unlimited request rate" as unverified, not as documented.
4. **No `GET /sessions` list endpoint exists.** `GET /sessions/:id` is documented as permanently dead (always 404s). A provider that wants to know its own live-session count must track it itself. [12]
5. **No block/captcha *signal* is delivered to the client.** No event, no field, no error code. Blocks arrive as ordinary page content. Details in Q6.
6. **Two vendor sources contradict each other** on the `proxy: "smart"` escalation order, and the Python SDK reference page is **stale** versus the shipped Python package. Both documented in "Contradictions found" below.
7. **No named production user of Solari exists in the public record.** Web search returned only vendor properties and the vendor's own cookbook (61 stars). No engineering blog, no conference talk, no migration story, no critical voice. [35] For DIG's purposes this is **not yet evidence-grade for production**: bet on it as a young vendor dependency, not a proven substrate.

---

## Landscape summary

Solari's cloud browser is a managed-Chromium-over-the-wire product: the gateway hands you a WebSocket endpoint and you drive it with an ordinary Playwright or CDP client, so the "provider" you write is thin — a session factory plus a lifecycle owner, not a driver. There are exactly four ways to attach, and they differ mainly in who owns the client library and whether the endpoint URL escapes your process: the first-party `launch()` (the SDK bundles a pinned `patchright-core` and hands you a connected `Browser`), a bring-your-own Playwright client connected to `session.wsEndpoint` (needs an exact 1.62.x pin), a bring-your-own CDP client connected to `session.cdpEndpoint` (no pinning, but loses server-side input humanization), and raw HTTP against the gateway (no SDK at all, but you must resolve presigned URLs yourself). Everything else Solari sells — stealth, proxies, captcha, profiles, recording — is a boolean or a small object on the session-create call, resolved server-side, with the consequence that failure is mostly *silent degradation* rather than an error: a proxy that doesn't resolve still returns 201, a `webBotAuth` that isn't provisioned is inert with "no error, no signal," and a mobile tier can quietly serve residential. The dominant axis of differentiation for a provider implementation is therefore not features but **which failures you can detect**, and the answer is: assert on response *fields*, never on status codes.

---

## Approach A — SDK `launch()`: one call, connected Playwright browser

**Class:** Composition (the SDK composes session-create + a bundled Playwright client + a loopback proxy)
**Evidence grade:** **A** for "the client behaves as described" (I read the shipped source); **C** for operational maturity (0.1.2, no third-party users, no published incident/failure content)

**Core technical mechanism**
`solari.launch(opts)` calls `POST /sessions`, receives `{sessionId, wsEndpoint, cdpEndpoint, expiresAt, storageStateUrl?, proxy?}`, then registers both upstream URLs in an **in-process `LocalProxy`** — a Node `http.Server` bound to `127.0.0.1:0` that accepts a WebSocket upgrade and pipes raw TCP (with TLS for `wss:`) to the upstream, retrying the upstream connect up to 3 times at 50 ms backoff with a 2 s connect timeout. It then calls `chromium.connect(localWsEndpoint)` from the bundled `patchright-core@1.62.2` — the Playwright *wire protocol*, not CDP. Optionally it runs a health probe (`newContext` → `newPage` → `page.evaluate("1")`) capped at `probeTimeoutMs`. [27][28]

**What it gives you**
- One call from nothing to a `Page`; no Playwright install or version management on your side (`npm install @solarisdk/browser` is the entire dependency list — it depends on `patchright-core: "1.62.2"`, exact-pinned, not a range). [26][27]
- `BrowserSession` exposes `id`, `expiresAt`, `proxy`, `wsEndpoint`, `cdpEndpoint`, `raw` (the underlying `Browser`), `isConnected()`, `version()`, `contexts()`, `newContext()`, `newPage()`, `close()`, `[Symbol.asyncDispose]()`. [27]
- `close()` is the *only* correct teardown: it closes the browser **and** calls `releaseAndWait(id)`, is idempotent, and on double failure rethrows the browser error in preference to the release error. [28]
- `await using browser = await solari.launch(...)` works on Node 22+ via `Symbol.asyncDispose`. [27][2]
- `launch({retries: n})` re-runs the whole create+connect, sleeping `100 ms × attempt`, **only** for a `BrowserUnhealthy` probe failure or a message matching `/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|WebSocket|connect|handshake|Browser closed|Target page, context or browser has been closed/i`. Anything else throws on the first attempt. [27][14]

**What it costs / where it breaks**
- **The endpoints are loopback URLs and die with the client.** `wsEndpoint`/`cdpEndpoint` on the TS SDK are `ws://127.0.0.1:<port>/ws/<id>`. They are unreachable from another process or machine and stop resolving after `solari.close()`. If your provider's contract is "hand a CDP URL to a subprocess or another service," the TypeScript SDK cannot do it via `launch()` or via `sessions.create()` — both wrap. Python deliberately does not wrap and returns the real upstream URL. [27][28][15][31]
- **Node process hang if you skip `solari.close()`.** The `LocalProxy` server handle keeps the event loop alive. The cookbook flags this as its first gotcha and every TS example ends with it. Grade A — it's a direct consequence of `http.Server.listen` in the shipped code. [20][21][28]
- **`request()` retries non-idempotent POSTs on any transport error.** `isRetryableError()` in the shipped source is `return true` unconditionally, and the retry loop wraps `POST /sessions`. A create that succeeds server-side but times out client-side (90 s default, per attempt) will be re-sent, producing a second billable session whose id you never see and whose concurrency slot is held until the ~3.5-minute orphan-grace reaper. This is my reading of the code, not a documented behavior — **assertion, verify by test.** [27][12]
- Wall-clock ceiling on any SDK HTTP call is roughly `maxAttempts × timeoutMs + backoff` ≈ **180.5 s** at defaults, not the 90 s you configured. The errors page says this explicitly. [11]
- Node ≥ 20 required (`engines`), and Node 22+ for `await using`. [26]

**Who uses it (named, with detail)**
- **None found.** No org, no subsystem, no published outcome. The only public consumers are the vendor's own cookbook (61 stars) and the vendor's MCP server. [33][35] Flagging per DIG rules: **not yet evidence-grade for production**.

**Current references**
- `@solarisdk/browser@0.1.2`, published (registry `modified` 2026-09-01), Apache-2.0, `dist/index.js` 435 lines. [26][27]
- Cookbook `browser-quickstart-ts/index.ts` — the canonical minimal path, with the `solari.close()` warning in-line. [21]

**Open questions**
- Does the duplicate-create-on-retry path actually leak a slot in practice, or does the gateway dedupe? No `Idempotency-Key` is documented for the *browser* gateway (only the VM one). [11]
- What happens to an in-flight `LocalProxy` pipe when `solari.close()` is called with a live session? `stop()` clears the session map and closes the server, but existing piped sockets are not explicitly destroyed. [28]

---

## Approach B — `sessions.create()` + your own Playwright over `wsEndpoint`

**Class:** Composition
**Evidence grade:** **B** (documented in three places and exercised in the docs' own snippets, but no cookbook example uses it end-to-end)

**Core technical mechanism**
`sessions.create(opts)` returns a `Session` without connecting. You call `chromium.connect(session.wsEndpoint)` with your own client, then `client.sessions.releaseAndWait(session.id)` when done. The gateway's `/ws/:sessionId` upgrade pipes TCP to the owning pool. The pool matches client version on **major.minor**, so any Playwright/patchright `1.62.x` connects and any other minor gets **HTTP 428**. [1][3][12]

**What it gives you**
- Your own client version and your own instrumentation; the docs claim this path is "a bit faster per action" than CDP. [1]
- Server-side **mouse/keyboard humanization**: the pool patches Playwright's `Mouse` inside the slot, and this **only fires on the `/ws/` path**. [12][15]

**What it costs / where it breaks**
- Requires pinning `patchright-core@1.62.2` exactly (docs say "pin 1.62.2"; the shipped SDK pins the same version). Version drift is an HTTP 428 forwarded verbatim from the pool, relabelled `application/json` even when it is plain text. [1][3][12]
- On the TS SDK, `sessions.create()` **still** wraps the endpoints in the LocalProxy — you do not escape the loopback constraint by avoiding `launch()`. [27]
- You now own release. `release(id)` is fire-and-forget and logs rather than throws; `releaseAndWait(id)` is the one that confirms.

**Open questions**
- Is 1.62.2 a floor or a hard pin? Docs say "the pool matches on major.minor, so any Playwright / patchright 1.62.x client connects," but the pin instruction says 1.62.2 specifically. [3]

---

## Approach C — `sessions.create()` + any CDP client over `cdpEndpoint`

**Class:** Enabler (this is what makes non-Playwright agent stacks — Puppeteer, browser-use — usable)
**Evidence grade:** **B**

**Core technical mechanism**
`chromium.connectOverCDP(session.cdpEndpoint)`, `puppeteer.connect({browserWSEndpoint: session.cdpEndpoint})`, or `BrowserSession(cdp_url=...)` in browser-use. The gateway's `/cdp/:sessionId` upgrade proxies to the pool's CDP proxy. No version pinning. [1][3]

**What it gives you**
- Any recent CDP-compatible client works. This is the path the vendor's own MCP server uses ("A Solari cloud browser session, driven over CDP"). [17]

**What it costs / where it breaks**
- **Loses input humanization.** Both SDK references say raw-CDP clients bypass the pool's Playwright-path mouse/keyboard humanization "unless the gateway-side CDP input humanizer is enabled," and the API reference states flatly: "Behavioral parity between the two paths is not guaranteed." If stealth matters, this is a real cost. [12][15]
- **A 201 does not guarantee `cdpEndpoint` connects.** `cdpEndpoint` is always emitted on create, but the pool-side CDP proxy 404s if the slot's `/json/version` lookup failed. [12]
- Fallback helper exists in Python (`derive_cdp_from_ws()`) and inline in TS (`deriveCdpFromWs`) mapping `/ws/<id>` → `/cdp/<id>` for older gateways. [15][27]

---

## Approach D — raw HTTP against `api.getsolari.com`

**Class:** Substrate (this is the actual contract; the SDKs are one consumer of it)
**Evidence grade:** **B** — the API reference is unusually candid (it documents its own dead endpoint and its own silent-degradation traps), which raises my confidence that it reflects the implementation.

**Core technical mechanism**
`POST /sessions` with `Authorization: Bearer slr_live_<id>_<secret>`, then connect to the returned `wsEndpoint`/`cdpEndpoint` directly (no auth header — **the signed URL is the credential**). [12][13]

**What it gives you**
- Real, remote, reusable endpoint URLs — no loopback wrapper. If your provider must hand a browser to another process, this (or the Python SDK) is the only documented way.
- `GET /proxy/countries` — **no SDK method exposes this route**; it is curl-only, and it's the documented way to guard "should I even send `proxy:`?". [12]
- `GET /health` — unauthenticated, returns `{ok, idle, busy, recycling, pools, saturated, fast:{...}, stealth:{...}}`. [12]

**What it costs / where it breaks**
- **`storageState` does not exist on the wire.** `POST /sessions` returns `storageStateUrl: {url, expiresInSeconds}` (a ~60 s presigned S3 GET). The SDK's `Session.storageState` is client-side synthesis — the SDK fetches that URL itself (8 s timeout) and inlines the JSON. A raw-HTTP caller must follow it in a second request. A `null` url means "profile exists but was never saved." [12][27]
- WebSocket URLs **expire 90 minutes after minting** and are checked for age on `/ws/`, `/cdp/`, and `/ws/observe/`. `DELETE /sessions/:id` is **not** age-checked, so a session stays releasable for its whole `expiresAt` lifetime. [12]
- The session id is a signed composite: `<poolId>:<realSessionId>:<orgId>:<iatMs>.<sigBase64Url>`. It is a capability, not an opaque handle — anyone with it can drive the browser. [12]

---

## Capability surface, by the brief's questions

### Q1 — Package, install, Playwright compatibility, minimal path

| | TypeScript | Python |
|---|---|---|
| Package | `@solarisdk/browser` | `solari-browser` |
| Install | `npm install @solarisdk/browser` | `pip install solari-browser` |
| Latest verified | **0.1.2** (npm dist-tags) [26] | **0.1.3** (PyPI) [30] |
| Bundled driver | `patchright-core` **exactly 1.62.2** [26][27] | `patchright>=1.62,<1.63` [30] |
| Runtime floor | Node **>=20** (`engines`) [26] | Python **>=3.9** [30] |
| Class names | `Solari`, `BrowserSession`, `SolariError` [27] | `Solari`, `BrowserSession`, `SolariError` [31] |
| Endpoints returned | **loopback** `ws://127.0.0.1:…` [27] | **upstream** `wss://api.getsolari.com/…` [31] |
| License | Apache-2.0 [27] | (not checked) |

**Playwright compatibility: yes, and via three distinct doors.** The SDK ships its own Playwright client (a patched fork, `patchright`), so `launch()` returns a `Browser` whose surface is Playwright's. The docs state it plainly: "Anything that works in Playwright works on a Solari browser… If a Playwright snippet works locally, it works against a Solari session unchanged." [3] Attach options: (a) `launch()`; (b) `chromium.connect(wsEndpoint)` — Playwright wire protocol, 1.62.x pin; (c) `chromium.connectOverCDP(cdpEndpoint)` / Puppeteer / browser-use — raw CDP, no pin. [1][3]

**Minimal launch-to-page (TypeScript), exactly as the cookbook writes it** [21]:

```ts
import { Solari } from "@solarisdk/browser"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

const browser = await solari.launch()
try {
  const page = await browser.newPage()
  await page.goto("https://example.com")
  console.log(await page.title())
} finally {
  await browser.close()   // closes browser AND releases the session
  await solari.close()    // REQUIRED in Node, or the process never exits
}
```

`baseUrl` is optional (defaults to the `us-west` region URL `https://api.getsolari.com`); the docs' snippets pass it explicitly, the cookbook's do not. Both work. [10][27]

**Constructor options (TS `SolariOptions`), verified in the shipped `.d.ts`** [27]: `apiKey` (required, throws `SolariError` if empty), `region?: "us-west"` (the only value; unknown region throws), `baseUrl?` (overrides region), `maxAttempts?` (default **2** = one retry), `backoffMs?` (default **500**, fixed, no jitter), `timeoutMs?` (default **90_000**, per attempt).

### Q2 — Session lifecycle, and the real `close()` / `kill()` story

**Correcting the brief's premise: the browser SDK has no `kill()`.** `kill()` belongs to the **sandbox/VM** SDK (`sbx.kill()`), a different package. The cookbook lists its gotchas in one undifferentiated bullet list, and two of the five bullets are VM-only. Mapping them: [20][16][18]

| Cookbook gotcha | Applies to browser? | What it actually means |
|---|---|---|
| "TypeScript: call `await solari.close()`" | **Yes** | The `LocalProxy` `http.Server` keeps the Node event loop alive. Verified in shipped source. [28] |
| "Recording is per session, not per account… poll for ~30s" | **Yes** | See Q4. |
| "Sandbox commands are not shell-interpreted" | No — sandbox only | Irrelevant to a `SolariProvider`. |
| "**`kill()`, not `close()`, ends a VM**" | **No — VM only** | There is no `kill()` in `@solarisdk/browser`. Do not look for one. [27] |
| "`timeoutMs` is a rolling idle window, not a hard deadline" | **No — VM/sandbox only** | On sandboxes, `timeoutMs` + `lifecycle.onTimeout` is an idle-pause window [18]. On the **browser** client, `timeoutMs` is the **per-attempt HTTP timeout** (90 s default). Confusing these will cost you an afternoon in the opposite direction. [27][14] |

**The browser lifecycle, precisely:**

- **Create:** `launch(opts)` (create + connect) or `sessions.create(opts)` (create only). Both hit `POST /sessions`, which counts against concurrency **until released**. [12]
- **Deadline:** `expiresAt` is stamped at `now + plan.maxSessionMinutes` and the session **auto-releases** then. There is no idle timeout and no way to extend it. Plan caps: Free 1 h, Starter 5 h, Professional 24 h, Enterprise unlimited. [9][12]
- **Teardown, three variants:**
  - `browser.close()` — closes the browser **and** `releaseAndWait`s the session. Idempotent. **This is the one to use.** [27][28]
  - `sessions.release(id)` — fire-and-forget, returns `void` immediately, logs failures via `console.warn`, never throws. [27]
  - `sessions.releaseAndWait(id)` — awaits the server ack. **Use this before `getReplayUrl()`.** [1][14]
  - `solari.close()` — **stops the client's local proxy only. It does NOT release live sessions.** Both SDK references say this in the same words. Order matters: release the session first, then close the client. [14][15]

**The cleanup gotchas, in order of how much they will cost you:**

1. **`solari.close()` or your Node process hangs forever.** Not optional, not a nicety. The Python quickstart does *not* need it (no local proxy); the TS one does. [20][21]
2. **Closing the browser without releasing leaks the slot until `expiresAt`.** The cookbook's in-line comment: "`browser.close()` also RELEASES the session. Closing the browser alone would leave the slot held until the plan deadline." On Free (3 concurrent, 1 h max) that is a self-inflicted outage. [21]
3. **`204` means *accepted*, not *released*.** `DELETE /sessions/:id` acks 204 immediately and forwards to the pool in the background (30 s budget, **no retry**). Downstream failures never surface. A lost DELETE is a slower release, never a leaked slot — the pool's orphan-grace cleaner reaps at **~3.5 min**. [12]
4. **A 404 on release is NOT success — but only in TypeScript.** The TS SDK's `releaseRejection()` treats a 404 carrying `code: "InvalidSessionId"` as a *failure* (nothing was released; the slot stays held) and a bare 404 with no code as tolerable legacy behavior. The comment in the shipped source says: *"Treating that as success is what made expired-session-id releases leak slots silently."* [27] **The Python SDK does not do this.** `solari_browser` 0.1.3 `release_and_wait` is `if res.status_code >= 400 and res.status_code != 404: raise` — i.e. **every** 404, including `InvalidSessionId`, is swallowed as success. [31] If the provider is Python, you must classify the 404 yourself.
5. **`GET /sessions/:id` is permanently dead.** It always 404s, and its body is the plain-text string `404 Not Found` served under `application/json` — it will not `JSON.parse()`. There is no replacement. **Track sessions yourself from the create response.** The Python SDK still exposes `sessions.get()` for it, documented as having "no working server behind it." [12][11][15]
6. **`launch()` failure path releases for you** — on a connect/probe failure it closes the browser and calls the fire-and-forget `sessions.release(session.id)` before retrying or throwing. So a thrown `launch()` does not leak, assuming that DELETE lands. [27]
7. **A revoked API key keeps working for up to 60 s** (the browser gateway caches verified bearers). Relevant to key-rotation runbooks. [11][13]

### Q3 — Persistent profiles

**Model:** a profile is a server-side, org-scoped store of a **Playwright `storageState`** — `{cookies: [...], origins: [{origin, localStorage: [...]}]}`, the exact JSON `context.storageState({path})` writes. Nothing more; it is not a full Chrome user-data-dir. [4][12]

**The identifier you must store:** `profile.id`, of the form `prof_abc123` / `prof_01HZY3`. That is the only thing a `SolariProvider` needs to persist per logical account. Only `id` and `name` are contractually guaranteed on the wire — the gateway forwards the control plane's rows verbatim and explicitly declines to promise any other field ("Do not treat the absence of a field as a contract"). The TS `Profile` type is `{id, name, [k: string]: unknown}`; the Python `Profile` carries a `raw: dict` of the full wire object for forward compatibility. [12][27][31]

**API surface (TS / Python):**

| Operation | TypeScript | Python | HTTP |
|---|---|---|---|
| Create | `profiles.create({name})` → `Profile` | `profiles.create(name)` | `POST /profiles` (201) |
| List | `profiles.list()` → `Profile[]` | `profiles.list()` | `GET /profiles` (200, array) |
| Save state | `profiles.save(id, storageState)` → `{version, sizeBytes}` | `profiles.save(profile_id, storage_state)` → `SaveResult` | `POST /profiles/:id/save` (200) |
| Delete | `profiles.delete(id)` (404 swallowed as success) | `profiles.delete(profile_id)` | `DELETE /profiles/:id` (204) |
| Attach | `launch({profileId})` / `sessions.create({profileId})` | `launch(profile_id=…)` | `POST /sessions {"profileId": …}` |

**How state actually persists — the load-bearing gotcha:**

> **Attaching a profile does not auto-save it.** You must call `profiles.save()` explicitly, or the session's accumulated state is discarded on release.

The cookbook says it twice (README of the example and an in-line comment: *"Without this the session's state is discarded on release — attaching a profile does not auto-save it"*). The canonical loop is: [22]

```ts
const state = await page.context().storageState()
const { version, sizeBytes } = await solari.profiles.save(profile.id, state)
```

Other profile facts a provider needs:

- **Reuse across sessions** is just passing the same `profileId` to every create. The docs' idempotent create pattern is `list()` → find by name → create only if absent. [22]
- **Save is a pure control-plane operation.** `POST /profiles/:id/save` "touches no pool and no session," so save-without-a-session is a valid flow — you can migrate a local Playwright `storageState.json` straight in. [12][4]
- **Versioning:** every save bumps an integer `version` and returns `storageStateS3Key` + `sizeBytes` over raw HTTP (the TS SDK returns only `version` and `sizeBytes`). [12][14]
- **Body cap on save is 1 MB** — an exception to the 16 KB cap on every other route, "sized for cookie-heavy sites." Exceeding it is a 413 whose `limit` field echoes the cap in bytes. [12]
- **On attach, the session response carries the seed.** `session.storageState` is **tri-state**: `undefined` = no profile attached; `null` = profile exists but is empty; object = the profile's state. Python encodes the first as a falsy `UNSET` sentinel — test with `is UNSET` / `is None`, **never truthiness**. Over raw HTTP this is `storageStateUrl.url === null` for the empty case. [27][31][12]
- **Concurrency conflicts:** a profile with the console editor open returns **409** on delete and on save; 409 on save also covers an optimistic-concurrency version clash, and the status does not distinguish the two. [12]
- **Plan caps on profile count** (3 / 20 / 500 / unlimited) surface as **403 `PlanLimitExceeded`** on create — the only route in the gateway that can emit that code. [9][12]
- **Security posture, verbatim from the docs:** *"Treat profiles like passwords… Anyone with your API key can attach it to a session and act as that account."* Profiles are org-scoped and cross-tenant reads are impossible, but every org member and every org API key can read every profile. [4][19]

**User-driven login into a profile** is the console flow: **Profiles → Open editor** drives a live browser in a browser tab; you log in, clear 2FA/captcha, hit Save. The docs call this "the easy way to handle sites with 2FA or captchas." It is a **manual, console-only** flow — no API is documented for minting an editor link. [4]

### Q4 — Session recording

**Enable:** `recording: true` at **create time only**. There is no account-level switch and no way to turn it on mid-session. `launch({recording: true})` or `sessions.create({recording: true})` or `POST /sessions {"recording": true}`. [5][12]

**Format:** **rrweb NDJSON, gzipped** — a DOM-level event log, not a video. Stored as `<sessionId>.ndjson.gz`. [12][24]

**Retrieve:**
- `sessions.getReplayUrl(id)` → `{url, expiresInSeconds, contentEncoding}` — a presigned S3 GET (`expiresInSeconds: 900` in the documented example). **Fetch it with no auth header.** [12][14]
- `sessions.downloadReplay(id)` → bytes in one call. [14][15]
- HTTP: `GET /sessions/:id/replay-url`. Notably this route **does not HMAC-validate the session id** — it forwards to the control plane with your authenticated org, which enforces tenancy. Consequence: **it is not subject to the 90-minute id expiry**, so replays of long-lived sessions stay fetchable. [12]

**Gotchas:**

1. **Without `recording: true`, the replay endpoint 404s forever.** [20][24]
2. **Release first, then poll through the 404.** The recording-finalized webhook lands asynchronously *after* release. Docs say the URL is "typically available 1 to 3 s after the session is released" and "poll with backoff"; the cookbook is more conservative — *"poll for ~30 s before giving up"* — and its Python example does 10 attempts × 3 s sleep. Use `releaseAndWait` (not `release`) before the first poll. [12][14][20][24]
3. **A 404 here is expected, not an alarm.** It means one of: recording off, another org's session, or the webhook hasn't landed. [12]
4. **Give rrweb a moment to flush** — the cookbook sleeps 2 s before closing so batched events are emitted. [24]
5. **Decompression is ambiguous and you must test it.** Both SDK references say `downloadReplay` returns "gzipped NDJSON," but the cookbook's Python example explicitly warns the opposite: *"The object is stored gzipped, but the HTTP client honours `Content-Encoding` and hands back decompressed bytes — so this is already plain NDJSON. Don't `gzip.decompress()` it."* I confirmed Python returns `httpx` `res.content` (httpx auto-decodes `Content-Encoding`) [31]; the TS path is `fetch(url).arrayBuffer()` and I did **not** verify whether undici decompresses here. **Open question — test before writing the parser.** [14][15][24][27]
6. **Recording captures input values by default**, including passwords and payment fields. The docs put the compliance burden on you. Retention is plan-bound: 1 / 7 / 30 / 90 days. [5][9]
7. The MCP server exposes the same thing as `solari_browser_replay_url`. [17]

### Q5 — Live view: the documented answer is "no public API"

**This is the brief's weakest-supported item, and the gap is real, not a search failure.** I read every page in the docs sitemap that could plausibly carry it (`sessions`, `browser-api`, `recording`, `api-reference/browser`, `mcp`, `pricing`, `regions`) and grepped the whole corpus for *live view / observe / watch / share / VNC / stream*. Here is everything that exists:

1. **`WS /ws/observe/:sessionId`** — the only programmatic surface. Documented as a *"read-only observer stream for a live session, **used by the console's live view**."* Critically: **"The frame schema is owned by the observer implementation and the pool; it is not asserted by this contract."** Unlike `/ws/` and `/cdp/`, the signed URL alone is **not** sufficient — it additionally requires `Authorization: Bearer` **or** a `?token=` short-lived JWT, and the resolved org must match the org in the composite id. **No documented way to mint that JWT exists** — the console does it internally. Subject to the same 90-minute id expiry. **No SDK in any language wraps this route.** [12]
2. **The console** — the changelog lists "Console: Machines created from the SDK show up in the console and can be viewed live" as **GA**. That is an authenticated, human, in-console view. No shareable URL is documented. [32]
3. **Profiles → Open editor** — a live browser in a console tab, explicitly positioned as the way to handle 2FA and captchas by hand. Also console-only, also no API. [4]
4. **Desktops (a different product) do have a watchable URL** — `solari_desktop_create` "returns a `streamUrl` you can watch over noVNC," and VMs bill $0.02/hour for the live screen. **This does not apply to browser sessions.** [17][9]

**Consequences for a `SolariProvider` that wants user-driven logins:**

- There is **no documented `liveViewUrl`**, no `debuggerUrl`, no `shareUrl`, and no session-token-minting endpoint for browsers. Anything you build on `/ws/observe/` is against an explicitly unasserted frame schema and an unminted credential — that is an undocumented-API bet, not an integration.
- The observer is **read-only**. Even if you solved the token, a user could *watch* but not *type a password*. The interactive human-in-the-loop surface Solari documents is the **console profile editor**, used out-of-band, with the resulting login persisted as a profile that your provider then attaches by `profileId`. That is the shape the vendor designed for.
- **Decision-relevant open question for the vendor:** "Is there a supported way to mint a live-view or profile-editor URL for a session/profile from the API?" I would ask this before designing any user-facing login handoff.

### Q6 — Stealth and residential proxies, and how blocks surface

**Stealth.** A boolean, off by default: `stealth: true` on create/launch. Mechanically it is a **pool switch plus a runtime shim** — it "routes to the stealth pool (**full Chromium under Xvfb**) instead of the fast pool (**chromium-headless-shell**), and injects the runtime stealth shim." The cookbook adds "a headful browser on real GPU." **Pool kind is decided solely by `stealth` and is never substituted.** [12][6][23]

Trade-offs the vendor states: slightly slower to start and load; higher per-second rate; and it is a **hard prerequisite** for both proxy and captcha. Default mode has proxies and captcha "Not available." [6]

**Proxies.** `proxy` accepts `"off"` | `"smart"` | a lowercase country code (`"us"`) | a `ProxyRequest` object. Fields, verified in the shipped `.d.ts` [27] and the API reference [12]:

| Field | Values | Notes |
|---|---|---|
| `country` | `au br ca de es fr gb in it jp kr mx nl sg us` (15) | Anything else → **400**. Default `"us"`. |
| `tier` | `"residential"` (default, rotating) \| `"static"` \| `"mobile"` | `"isp"` is a deprecated alias for `static`, "reachable only over raw HTTP." |
| `static` | `true` | Deprecated; `tier` wins when both present. |
| `session` | alnum + dash, ≤32 chars | **Sticky IP label.** Same label across sessions ⇒ same exit IP. Not the SDK `Session` object. |
| `sessionDuration` | 1–30 minutes, default 10 | Only with `session`. Out-of-range is **rejected 400, not clamped**. |
| `asn` | e.g. `"20057"` | Pin egress ASN. |
| `state` / `city` | `"california"` / `"los_angeles"` | **US only.** |

- **Cross-field rules, enforced in this order:** proxy (anything but `"off"`) requires `stealth: true` else 400 → each of stealth/proxy/captcha requires the plan's feature flag else **402 `FeatureRequiresPlan`** → captcha requires `stealth: true` else 400. [12]
- **The proxy is applied server-side; you never dial it.** `ResolvedProxyConfig` is confirmation only: `{timezoneId, country, tier?}`. The shipped TS source states why: *"Earlier builds returned the upstream `server`/`username`/`password` here; that was a disclosure of our proxy vendor's account and has been removed."* [27]
- **Pass `timezoneId` to `newContext({timezoneId})`** if you build your own context, so `Intl`/`Date` match the egress country. [12][27]
- **Proxy traffic bills per GB** — $1.00/GB Starter, $0.10/GB Professional+. Not included in the hourly browser rate. [9]

**How blocks and degradation surface — this is the part that matters:**

- **Proxy failure is silent by design.** Verbatim: *"Proxy resolution never errors. If the requested tier is unavailable, the session is created unproxied and the response omits `proxy`. If you require proxy egress, assert on the presence of the `proxy` field, not on the 201."* And: a `tier: "mobile"` ask can **degrade to residential** — `resolved.tier` echoes what actually served, "so you can confirm a mobile ask did not quietly degrade." A `SolariProvider` must check `session.proxy` and `session.proxy.tier` after every create, or it will silently run unproxied. [12][7][27]
- **`webBotAuth` is silently inert** if not provisioned: *"no error, no signal."* [12][27]
- **`GET /proxy/countries`** returns `{enabled, countries[]}` and is the documented guard — but the docs immediately warn that `enabled: true` is **not** a per-tier guarantee. **No SDK exposes this route**; a provider that wants the guard must use `solari.request("GET", "/proxy/countries")` (the documented escape hatch) or raw HTTP. [12][14]
- **There is no block signal, event, field, or error code delivered to the client.** Nothing in the SDK types, the error-code table (14 codes across both gateways, all plan/capacity/state — none about blocking), or the session response reports "you were blocked," "you hit a captcha," or "you got a 403." A block arrives as **ordinary page content** — an HTTP status on `page.goto()`, a challenge page, a `403` body — and detecting it is entirely your code's job. The stealth page's own advice is behavioral, not programmatic: *"start with the default and switch to stealth the moment you see blocks or challenge pages."* [11][6][27]
- **The one server-side block reaction is `proxy: "smart"`**, described as an escalation ladder that swaps egress **in-place, mid-session, on block detection, with no client-side retry required**. This means the gateway *does* have a block detector — but it is not exposed to you, and there is no callback or field telling you it fired. **This is the single most important thing I could not verify:** you cannot observe smart-ladder escalations from the client.

### Q7 — Captcha solving

**Automatic, and configurable only as a boolean.** `captcha: true` on create/launch; **requires `stealth: true`** (else 400) and the plan's captcha feature (else 402). "The captcha is already solved by the time you submit the form. You don't write any solving code yourself." There is no solver-selection knob, no timeout knob, no per-site override, and no callback. [8][12][27]

**Coverage:** documented as reCaptcha v2 (normal and invisible), reCaptcha v3, hCaptcha, Cloudflare Turnstile. "DataDome, PerimeterX, GeeTest, and image-text captchas" are covered **"on a site-by-site basis"** — i.e. by arrangement with the vendor (`hello@getsolari.com`), not by a flag. [8]

**Billing:** per solve — $0.01 (Starter), $0.005 (Professional/Enterprise). **Not available on Free.** [9]

**What is not documented, and matters:** what happens when a solve *fails*. No error code, no event, no field. Presumably the challenge page simply stays up and your locator times out — **assertion, not documented**. Also undocumented: solve latency, solve success rate, and whether a failed solve is still billed. Worth asking the vendor.

### Q8 — Operational limits: concurrency, rate limits, credits

**Concurrency is the real limit, and it is the one that will bite an agent.** Per-plan caps [9]:

| | Free | Starter | Professional | Enterprise |
|---|---|---|---|---|
| Monthly fee / credits | $0 / $3 | $20 / $20 | $200 / $200 | Custom |
| Browser rate | $0.15/hr | $0.10/hr | $0.07/hr | $0.05/hr |
| **Concurrent browsers** | **3** | **20** | **150** | 150+ |
| **Max session time** | **1 h** | **5 h** | **24 h** | Unlimited |
| Profiles | 3 | 20 | 500 | Unlimited |
| Replay retention | 1 day | 7 days | 30 days | 90 days |
| Stealth | **No** | Included | Included | Included |
| Captcha | **No** | $0.01/solve | $0.005/solve | $0.005/solve |
| Proxies | **No** | $1.00/GB | $0.10/GB | $0.10/GB |

Behavior at the cap and around it:

- **429 `ConcurrencyLimitExceeded`, and it is explicitly not retryable.** The errors page: *"Retrying cannot help: a slot only frees when you pause or kill a session. Neither the browser client nor the VM client retries a 429… A tight retry loop here burns quota against a wall."* The body carries `plan` and `cap`. [11][12]
- **The cap is org-wide and cross-region.** "10 at once means 10 total, not 10 per region." API keys are org-scoped and shared across every member. [10][19]
- **A slot is held from `POST /sessions` until release** — or until `expiresAt`, or until the ~3.5-min orphan-grace reaper. This is why the release discipline in Q2 is a capacity concern, not a hygiene concern. On Free (3 concurrent), one leaked session is a third of your capacity for up to an hour. [12]
- **503 on capacity, and the request blocks first.** If no pool of the requested kind has idle capacity, `POST /sessions` **blocks for up to the acquire timeout** before returning 503 — "patient queueing," not fail-fast. Retryable. `ConcurrencyCheckUnavailable` (503) means the concurrency store is wedged and the gateway **fails closed**. [12][11]
- **Retryable set is exactly 502/503/504 + transport errors** for the browser client. 500 and 501 surface immediately. [11][27]
- **No request-rate limit is documented.** No `Retry-After`, no `X-RateLimit-*`, no requests-per-second figure appears in the errors page, the API reference, or the SDK. **This is an absence of evidence, not evidence of absence** — do not design assuming unlimited create QPS.
- **Credits:** one balance across browsers, sandboxes, VMs, proxies, and captcha solves. Monthly credits refill and **do not roll over**; self-topped-up credit does not expire and is spent after the month's included credits. At zero balance "new sandboxes and desktops stop launching" — note the pricing page says *sandboxes and desktops*, and does not explicitly say browsers stop. **Ambiguity worth resolving with the vendor.** No overage billing on any plan. [9]
- **Region:** `us-west` only today (`REGION_URLS` in both shipped SDKs has exactly one entry). Sessions, replays, and profiles are colocated in-region; API keys and billing are global. [10][27][31]

---

## Contradictions found between vendor sources

Flagging these because a provider written against the wrong one will be subtly wrong. All three are vendor-vs-vendor, which is why I read the shipped packages.

1. **`proxy: "smart"` escalation order.** API reference: *"direct → mobile → residential."* [12] The npm package's own README: *"rotating residential → direct → mobile → fresh residential → residential GB."* [29] Different first hop, different length. Unresolvable from outside; the package README is newer-shipped, the API reference claims to be the contract.
2. **Python `ResolvedProxyConfig` — the docs page is stale.** `docs/sdk/python/browser` lists `server`, `username`, `password` and calls the field "resolved proxy credentials." The **shipped** `solari_browser` 0.1.3 `types.py` has only `timezone_id`, `country`, `tier`, with the docstring *"Carries NO credentials by design."* The shipped package is right; the docs page describes a removed build. [15][31] (The TS `BrowserSession.proxy` getter JSDoc says "Resolved proxy credentials" too — same stale wording, correct type. [27])
3. **404-on-release handling diverges between SDKs.** TS distinguishes `InvalidSessionId` (throw, slot leaked) from a bare 404 (tolerate). Python treats *all* 404s as success. Verified in both shipped sources. [27][31] A `SolariProvider` in Python must re-implement the TS classification or it will silently leak slots.
4. **Replay decompression.** SDK references say "gzipped NDJSON"; the cookbook's Python example says the client already decompressed it. [14][15][24] Verified for Python (httpx); unverified for TS.
5. **Cookbook README bundles VM gotchas with browser gotchas** without labeling which is which — the source of the brief's `close()` vs `kill()` framing. [20]

---

## Comparison table

| Approach | Class | Evidence | Core mechanism (one line) | Best fit | Worst fit | Notable user |
|---|---|---|---|---|---|---|
| **A. SDK `launch()`** | Composition | A (shipped code) / C (ops maturity) | `POST /sessions` → register upstream in in-process `LocalProxy` → `chromium.connect()` with bundled patchright 1.62.2 | A single-process provider that owns the whole session lifetime | Handing an endpoint to another process; endpoints are loopback-only and die with the client | None public |
| **B. `sessions.create()` + own Playwright (`wsEndpoint`)** | Composition | B | Playwright wire protocol over `/ws/:id`; pool matches client on major.minor | You already run Playwright/patchright and want your own version + instrumentation | Any stack that can't pin 1.62.x — HTTP 428 | None public |
| **C. `sessions.create()` + CDP (`cdpEndpoint`)** | Enabler | B | Raw CDP over `/cdp/:id`; any recent CDP client, no pinning | Puppeteer, browser-use, non-Playwright agent loops (the vendor's own MCP server uses this) | Stealth-critical work — bypasses server-side input humanization; parity "not guaranteed" | Solari's own MCP server [17] |
| **D. Raw HTTP gateway** | Substrate | B | `POST /sessions` + signed-composite-ID WebSocket URLs as capabilities | Cross-process/cross-machine handoff; `/proxy/countries`; not-yet-wrapped routes | You now own presigned `storageStateUrl` resolution, 90-min URL expiry, and 404 classification | None public |

---

## What a `SolariProvider` must persist or carry (facts, not a design)

Collected here because they are scattered across seven doc pages:

- **`profile.id`** (`prof_…`) — per logical account. The only durable profile identifier. [4][12]
- **`session.id`** — the signed composite `<poolId>:<realSessionId>:<orgId>:<iatMs>.<sig>`. Needed for release and for `replay-url`. **Treat as a secret** (it is the WebSocket capability). Usable for `DELETE` for the session's whole life; usable for `replay-url` indefinitely; usable for `/ws/`,`/cdp/`,`/ws/observe/` for **90 minutes only**. [12]
- **`session.expiresAt`** — hard auto-release deadline, `now + plan.maxSessionMinutes`. There is no extend and no idle window. [12][9]
- **Your own live-session count** — no `GET /sessions` list exists, and `GET /sessions/:id` is dead. [12]
- **`session.proxy` presence and `session.proxy.tier`** — the only way to detect silent proxy degradation. [12][7]
- **`session.proxy.timezoneId`** — must be passed to `newContext({timezoneId})` if you build your own context. [12]
- **`storageState` tri-state** (`undefined`/`UNSET` vs `null` vs object) — distinguishes "no profile" from "empty profile." [27][31]

---

## References

[1] Solari. "Sessions." docs.getsolari.com. 2026. https://docs.getsolari.com/sessions. [Tier 7 vendor docs; treated as Tier 3-equivalent for API-shape claims, corroborated by [27]]
[2] Solari. "Quickstart." https://docs.getsolari.com/quickstart. [Tier 7]
[3] Solari. "Driving the browser." https://docs.getsolari.com/browser-api. [Tier 7]
[4] Solari. "Profiles." https://docs.getsolari.com/profiles. [Tier 7]
[5] Solari. "Session recording." https://docs.getsolari.com/recording. [Tier 7]
[6] Solari. "Stealth." https://docs.getsolari.com/stealth. [Tier 7]
[7] Solari. "Proxies." https://docs.getsolari.com/proxies. [Tier 7]
[8] Solari. "Captcha solving." https://docs.getsolari.com/captcha. [Tier 7]
[9] Solari. "Plans & pricing." https://docs.getsolari.com/pricing. [Tier 7 — single source, no corroboration]
[10] Solari. "Regions." https://docs.getsolari.com/regions. [Tier 7]
[11] Solari. "Errors." https://docs.getsolari.com/errors. [Tier 7; unusually specific, corroborated by [27]]
[12] Solari. "Browser API." https://docs.getsolari.com/api-reference/browser. [Tier 7; the most load-bearing single page in this report]
[13] Solari. "API reference (overview)." https://docs.getsolari.com/api-reference. [Tier 7]
[14] Solari. "TypeScript SDK: Browsers." https://docs.getsolari.com/sdk/typescript/browser. [Tier 7]
[15] Solari. "Python SDK: Browsers." https://docs.getsolari.com/sdk/python/browser. [Tier 7 — **contains at least one stale section**, see Contradictions #2]
[16] Solari. "SDKs & Languages." https://docs.getsolari.com/languages. [Tier 7]
[17] Solari. "MCP Server." https://docs.getsolari.com/mcp. [Tier 7]
[18] Solari. "Sandboxes." https://docs.getsolari.com/sandboxes. [Tier 7 — cited only to scope the `timeoutMs` gotcha out of the browser]
[19] Solari. "Organizations." https://docs.getsolari.com/organizations. [Tier 7]
[20] solari-sdk. "Solari Cookbook — README (Gotchas the examples encode)." GitHub, commit `d304843`. https://github.com/solari-sdk/solari-cookbook. [Tier 3 — open-source artifact]
[21] solari-sdk. `examples/browser-quickstart-ts/index.ts`, commit `d304843`. [Tier 3]
[22] solari-sdk. `examples/browser-profiles-ts/index.ts`, commit `d304843`. [Tier 3]
[23] solari-sdk. `examples/browser-stealth-proxy-ts/index.ts`, commit `d304843`. [Tier 3]
[24] solari-sdk. `examples/browser-session-recording-py/main.py`, commit `d304843`. [Tier 3]
[25] RubiksCubingGod. "solari-cookbook" (fork), branch `main` @ `d304843f5ea0edb5c27829bb2ca30868645bef7a`. https://github.com/RubiksCubingGod/solari-cookbook. Verified byte-identical to [20]; `diff -rq` clean outside `.git`, single remote branch. [Tier 3]
[26] npm registry. `@solarisdk/browser` package metadata (dist-tags `latest: 0.1.2`; versions 0.1.0/0.1.1/0.1.2; `dependencies: {"patchright-core": "1.62.2"}`; `engines.node >=20`). https://registry.npmjs.org/@solarisdk%2Fbrowser. [Tier 3]
[27] `@solarisdk/browser@0.1.2` shipped source: `dist/index.d.ts`, `dist/index.js` (435 lines). Downloaded from the registry tarball and read directly. [Tier 3 — **highest-fidelity source in this report**]
[28] `@solarisdk/browser@0.1.2` shipped source: `dist/browser-session.js`, `dist/local-proxy.js`. [Tier 3]
[29] `@solarisdk/browser@0.1.2` package `README.md` (the `proxy: "smart"` ladder description). [Tier 3]
[30] PyPI. `solari-browser` metadata (version 0.1.3; `requires_dist: httpx>=0.24, patchright>=1.62,<1.63`; `requires_python >=3.9`). https://pypi.org/pypi/solari-browser/json. [Tier 3]
[31] `solari_browser==0.1.3` shipped source: `types.py`, `client.py`, `__init__.py`, extracted from the wheel. [Tier 3]
[32] Solari. "Changelog" (Jul 28 2026 single API endpoint; Jul 27 2026 one API key + Go/Rust/C++ SDKs; Jul 21 2026 sandboxes & desktops GA; "Earlier" cloud browser GA; capability/GA-Beta matrix). https://changelog.getsolari.com. [Tier 7]
[33] GitHub. `solari-sdk` org repository list via API — 7 repos, `solari-cookbook` at 61 stars (pushed 2026-08-18), all six language SDK repos at 0 stars (pushed 2026-07-30). [Tier 3]
[34] Solari. "Overview." https://docs.getsolari.com. [Tier 7]
[35] Web search for third-party/production evidence — returned only vendor properties (getsolari.com, docs, the cookbook) and unrelated homonyms (Solar2D, Solara, Solari Enterprises). **No independent engineering content, no named production user, no critical voice found.** [Tier 6 — pointer-quality, cited as an absence]

---

## Methodology note

I pulled `docs.getsolari.com/sitemap.xml` (44 URLs; `llms.txt` returns a 404 page) and fetched and de-HTML'd all 19 browser-relevant pages so I could quote the reference verbatim rather than through a summarizer. I then cloned both cookbook repos and `diff -rq`'d them, and — because vendor docs are Tier 7 and this brief needs an *exact* surface — I downloaded and read the actual published artifacts: the `@solarisdk/browser@0.1.2` npm tarball (`.d.ts` + `.js`) and the `solari_browser-0.1.3` wheel. That is what let me catch the three vendor-vs-vendor contradictions above. What I could not find: any third-party engineering content, any named production user, any block-rate or captcha-solve-rate number, any live-view API for browsers, and any documented request-rate limit. I did not exercise the API against a live key — every runtime claim here is read from source or from the vendor's reference, never observed.

## Sign-off

With another hour I would spend it on a live key rather than more reading: create one session per attach path, confirm whether a `patchright-core` minor other than 1.62.x really 428s, confirm whether `downloadReplay` in Node returns gzipped or plain bytes, and — most valuable — deliberately time out a `POST /sessions` to see whether the SDK's unconditional transport retry creates a duplicate billable session. The single question I would put to Solari before designing anything user-facing: **"Is there a supported API for minting a live-view (or profile-editor) URL for a browser session, and if not, what is the intended pattern for a human-in-the-loop login?"** Everything else in this report has a documented answer; that one has only a console screenshot.
