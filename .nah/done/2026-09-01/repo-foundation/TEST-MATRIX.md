# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Fresh clone + documented setup + `pnpm check` green | workspace-ci-gate | toolchain | local + CI on the sprint PR |
| Coverage gate fails on synthetic uncovered branch in `core/` | workspace-ci-gate | unit (gate config) | CI |
| Lint/type error fails the workflow | workspace-ci-gate | toolchain | CI (by construction) |
| Migration set applies to fresh Postgres; re-apply is a no-op | watch-crud-path | integration (Testcontainers) | every push |
| Watch create/list/pause: accepted + refused (typed 4xx, nothing persisted) | watch-crud-path | integration | every push |
| Calendar item create/list: accepted + refused | watch-crud-path | integration | every push |
| Task list read returns seeded rows | watch-crud-path | integration | every push |
| Cron schedule fires handler; queued job round-trips | job-scheduling-harness | integration | every push |
| Failing handler retries then lands observable failed state | job-scheduling-harness | integration | every push |
| Enqueue → worker restart → job still executes | job-scheduling-harness | integration | every push |

No @live tier in this sprint: nothing here touches Solari (that proof regime starts in
browser-substrate). No manual attestations: every proof is a command proof.
