# FORGE L1 attempt 9: evidence for independent review

Review target: Issue #1851, `docs/FORGE_L1_VERIFICATION_RUNBOOK.md` step 4. Read the runs yourself; this file only lists them.

| Item | Value |
|---|---|
| Deploy proof before dispatch | Autopilot Cloudflare Runtime Proof run `42923865408`, `exactHeadVerified=true`, `deploymentRevision=4b66244310d6fad9abf37b38e8c1b0b030bfb47d` |
| Source run | `causal-verification.yml` run `42923997847` (workflow_dispatch on main `4b662443`) |
| Consumer run | `causal-verification-consumer.yml` run `42924120287`; artifact `nusa-isolated-causal-verification-result-1` |
| Route | Opened by #3067, closed by #3069 |
| Fixes that enabled the pass | #3062 (`apps/autopilot/src/githubActionsOidc.ts`), #3066 (`apps/autopilot/src/sigstoreCausalAttestation.ts`) |

Receipt (as downloaded):

```json
{"outcome":"PASS","domain":"NUSA_ISOLATED_CAUSAL_VERIFICATION_V1","decision":"CODE_ACTIONABLE","classification":"REPOSITORY_CODE_REGRESSION","sourceSha":"4b66244310d6fad9abf37b38e8c1b0b030bfb47d","sourceRunId":"42923997847","sourceRunAttempt":"1","durableReplayGuard":"SQLITE_DURABLE_OBJECT_CLAIMED","sourceIdentityDigest":"3d1e541d718ccac28c5ff5d31afccb9c107b264d306343c5e780c832207e3929","codingRunnerStatus":"EXECUTION_ACCEPTED","proposalAdapterCalls":1,"sandboxExecutions":1,"dedupe":"REPLAY_REJECTED_WITHIN_SINGLE_HARNESS","mutationAllowed":false,"liveAuthority":"NONE","productionMutationAllowed":false,"realOrderAuthority":false,"realTransferAuthority":false,"aiAuthority":"ZERO_AUTHORITY"}
```

Questions for the reviewer:
1. Does every receipt field match runbook step 4?
2. Do #3062 and #3066 keep identity and signature checks at least as strict (ids pinned, digest only defaulted for P-256/P-384 when absent)?
3. Is there any path by which this lane writes to the repository or enables `NUSA_AUTOPILOT_CODING_ENABLED`?

PAPER_ONLY; liveAuthority=NONE; productionMutationAllowed=false; aiAuthority=ZERO_AUTHORITY.
