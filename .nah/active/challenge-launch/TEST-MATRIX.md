# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Production spine smoke: magic-link login, observation written, Telegram delivered, fixture mission + replay | production-deploy | recorded live smoke | at deploy |
| Rollback-and-redeploy procedure exercised | production-deploy | recorded exercise | at deploy |
| Fresh clone on a clean machine → green local tests via README alone | production-deploy | recorded verification | pre-flip |
| No secrets in repo history, logs, or build output | public-launch-package | audit record (scan + manual) | pre-flip |
| Public repo renders correctly, no broken links, logged-out | public-launch-package | manual check, recorded | at flip |
| Demo: full consequence spine on production, under three minutes, no failure-masking edits | public-launch-package | recorded artifact | pre-post |
| Posts live with verified tags; demo and repo resolve from each post logged-out | public-launch-package | recorded URLs + manual check | at launch |

This sprint's proofs are almost entirely recorded evidence: the claim is "a stranger can find
it, watch it, clone it, run it", and each row is one link of that chain checked as the
stranger would experience it. Preconditions: s9's three-night record and attested checklist.
