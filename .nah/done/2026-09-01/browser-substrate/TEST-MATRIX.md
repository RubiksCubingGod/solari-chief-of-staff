# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Provider contract suite: acquire → navigate → assert → release on LocalProvider | browser-provider-seam | integration (headless chromium, local static content) | every push |
| SessionMeta echoes not-applied stealth/proxy/captcha and unsupported recording on LocalProvider | browser-provider-seam | integration | every push |
| withBrowser releases on success, on thrown error, and double-release is idempotent | browser-provider-seam | unit | every push |
| create/release ordering; solari.close only at dispose, after releases | solari-session-hygiene | unit (mocked transport) | every push |
| Ledger: add on create, remove on confirmed release, retain on failed release (404 + InvalidSessionId) | solari-session-hygiene | unit (mocked transport) | every push |
| Timeout-after-server-success sends exactly one POST /sessions | solari-session-hygiene | unit (mocked transport) | every push |
| Response omitting proxy → SessionMeta echoes unproxied; tier echoed when present | solari-session-hygiene | unit (mocked transport) | every push |
| 429 → non-retryable capacity error; 502/503/504 → retryable; 402/428 → config errors | solari-session-hygiene | unit (mocked transport) | every push |
| proxy-without-stealth rejected by preflight, no wire call | solari-session-hygiene | unit | every push |
| Contract suite compiles against SolariProvider | solari-session-hygiene | typecheck | every push |
| Recorded session → page assert → replay URL within ~30 s poll → empty ledger → clean exit | live-smoke-path | @live (real vendor, secrets-gated) | nightly + manual dispatch |
| Missing SOLARI_API_KEY → explicit skipped status, never silent green | live-smoke-path | @live workflow | nightly + manual dispatch |

The @live tier starts existing in this sprint: secrets-gated, never on ordinary pushes, cost
per run measured in fractions of a cent. Manual attestations: none — every proof is a command
proof or a linked workflow run.
