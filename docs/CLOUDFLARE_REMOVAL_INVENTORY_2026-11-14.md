# Cloudflare removal, step S0: inventory (2026-11-14)

Status: READ-ONLY INVENTORY. Phase S0 of `docs/PROPOSAL_SIMPLIFICATION_2026-11-14.md`. It changes no code, workflow, secret or Cloudflare
setting. Owner decision 2026-11-14: Cloudflare is not needed; remove the connection in stages. Safety stays: PAPER_ONLY,
`liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`, Release=HOLD.

Read on `main` after #3113 (`86eff57ce`) and later merges. "Fail closed" below is what the code does when the Worker is unreachable.
Items marked CONFIRM are not yet read in detail and must be checked in S1 before S2 starts.

## 1. What the Worker exposes (`apps/autopilot/src/worker.ts`)

| Route | Who calls it | What it does | State it keeps |
| --- | --- | --- | --- |
| `POST /control-plane/release-check` | `autopilot-deterministic-audit-release.yml` (step "Verify durable control-plane Release clearance") | Checks GitHub OIDC (audience `nusa-autopilot`), that the Coordinator exists, the global release freeze variable, and the durable control-plane HOLD. Answers `RELEASE_CONTROL_CLEAR` only when all pass. The workflow fails unless the answer is exactly CLEAR with `liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY` | the HOLD record in the Coordinator (Durable Object) and `NUSA_GLOBAL_RELEASE_FREEZE` in `wrangler.jsonc` |
| `POST /audit/execute`, `POST /coding/execute` | `autopilot-execution-consumer.yml`; `/coding/execute` also `scripts/autopilot-dispatch-retry.js` | Run or hand off an audit or coding step for a queued execution | Coordinator records (Claim, Dispatch, Lease) CONFIRM |
| `POST /coding/propose`, `/coding/wip-release`, `/coding/publish`, `/coding/sandbox/validate` | the coding workflows (`autopilot-codex-coding.yml` and related) | coding proposal, WIP release, publish, sandbox check | Coordinator WIP slots CONFIRM |
| `POST /coding/causal/claim` | `scripts/autopilot-causal-claim.js` | claim for the causal-verification flow | Coordinator CONFIRM |
| `POST /isolated/causal/verify-and-run` | `scripts/submit-isolated-causal-verification.js` | isolated causal verification run (FORGE L1 window, closed after attempt 9 PASS) | none beyond the flow CONFIRM |
| `POST /github/webhook` | `autopilot-github-event-bridge.yml` via `scripts/dispatch-github-event-to-autopilot.mjs` | forwards GitHub events so the Worker can queue work | event inbox CONFIRM |
| `GET /operator/coordinator/status` | none yet (added by #3113, route closed with 503 until four `NUSA_ACCESS_*` variables exist) | read-only Coordinator view | none |
| `GET /health` | `autopilot-cloudflare-runtime-proof.yml` (hourly) and the deploy workflow | liveness and last scheduled receipt | none |
| scheduled (`*/5 * * * *`) | Cloudflare cron | background reconciliation CONFIRM | Coordinator |

## 2. Cloudflare-only workflows

| Workflow | Purpose | Removal note |
| --- | --- | --- |
| `autopilot-cloudflare-deploy.yml` | deploys the Worker on every push to `main` touching `apps/autopilot/**`, and on `workflow_run` of CI | last to disable; keep until the Worker is no longer called |
| `autopilot-cloudflare-promote.yml` | promotes a revision to the `cloudflare-production` branch | remove with the deploy |
| `autopilot-cloudflare-credential-preflight.yml` | checks the Cloudflare token and account | remove with the deploy |
| `autopilot-cloudflare-runtime-proof.yml` | hourly proof that the deployed Worker has a fresh scheduled receipt | remove only after the proof is no longer a required signal |
| `cloudflare-deployment-readiness.yml` | readiness check for the deploy | remove with the deploy |
| `deployment-convergence-*`, `autopilot-reconverge.yml`, `autopilot-already-merged-audit-convergence.yml` | convergence of merged heads with the deployed Worker | CONFIRM how much they depend on the Worker |

## 3. The one control that must not be lost

`/control-plane/release-check` is the durable **Release HOLD and global freeze** that the auto-merge path asks before it
may merge. It fails closed: if the Worker is down, merging stops. Removing Cloudflare therefore also removes the place where
the HOLD is stored. S3 must supply an equivalent that keeps these properties:

1. The HOLD and the global freeze live in one durable place that an agent session cannot change by itself.
2. Reading it is part of the same required check that gates merging, and an unreadable HOLD blocks the merge (fail closed).
3. The merge path still returns the same three safety facts (`liveAuthority=NONE`, `productionMutationAllowed=false`,
   `aiAuthority=ZERO_AUTHORITY`) and a test fails if any is missing.
4. Setting or clearing the HOLD stays an owner action recorded in git or in a protected GitHub setting.

Candidate homes for the HOLD (to be chosen in S1 with a review): a protected file on `main` changed only through the owner's
PR, or a protected repository environment with required reviewers. A plain repository variable is NOT enough if an agent
token can edit it. Until the choice is made and tested in shadow, the Worker check stays.

## 4. What the Coordinator protects (for the WIP replacement)

Policy cap: at most 2 active WIP (`MAX_ACTIVE_WIP` 8 in storage, callers pass 2), claims expire after 3,600,000 ms, a
duplicate Claim for the same key is refused, and a Lease that expired is not reusable. These are the cases the equivalence
tests in S2 must reproduce (see `docs/PROPOSAL_SIMPLIFICATION_2026-11-14.md`, "Conditions that gate S3").

## 5. Order of removal that this inventory supports

1. S1 (read-only): finish the CONFIRM items above; choose the HOLD home; decide for each route whether it is replaced,
   becomes a GitHub job, or is deleted because nothing needs it.
2. S2: shadow-run the replacements; the Worker stays authoritative.
3. S3: switch one call at a time, `release-check` last (it is the safety control).
4. S4: remove the deploy, promote, preflight, proof and readiness workflows, then `apps/autopilot`, then the owner deletes the
   Worker in the Cloudflare account (after the redeploy rehearsal in the proposal).
5. Never: loosen the HOLD, the freeze, the WIP cap, Audit or Release; remove the Worker before a full release has run without
   any `workers.dev` call.

## 6. Not done here

No workflow, code, secret, Cloudflare or host change. Today the Worker is deployed from `main` automatically; that continues until S4.
