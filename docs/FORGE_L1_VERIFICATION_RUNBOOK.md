# FORGE L1 isolated verification runbook (one switch-on, one run, switch-off)

Status: proposal. Nothing in this document is enabled by merging it. Owner approval is required for step 1.

## What this proves, and what it does not

FORGE L1 (Issue #1851, owner checkpoint `6545892314`, `WO-AUTOPILOT-20261030-1851-CAUSAL-ADMISSION`) needs one genuine,
end-to-end positive receipt: a repository-issued attestation of a deterministic code regression, verified in a domain
separated from production, classified `REPOSITORY_CODE_REGRESSION` -> `CODE_ACTIONABLE`, claimed once with replay
protection, and accepted by the existing CodingRunner. All of that code is on main. It has never run:
`causal-verification.yml` and `causal-verification-consumer.yml` have 0 runs (checked 2026-11-10).

One run of the isolated lane proves exactly that chain. It does **not** enable autonomous coding:

| Piece | In the isolated run |
|---|---|
| Defect | An ephemeral fixture built inside the runner by `scripts/create-isolated-causal-fixture.js`; nothing is committed |
| Attestation | `actions/attest` with the distinct predicate `isolated-causal-verification/v1`, bound to the exact main run |
| Verification | Worker route `/isolated/causal/verify-and-run`, GitHub OIDC consumer identity, source-run read-back |
| Claim | One `NUSA_ISOLATED_CAUSAL_ATTEMPT_CLAIM_V1` record in the `NUSA_EXECUTION_COORDINATOR` Durable Object |
| CodingRunner | Real `CodingRunner`, with a deterministic proposal adapter (no Workers AI call) and a no-op sandbox |
| Output | A sanitized receipt artifact. No branch, no PR, no commit, no repository write |

`NUSA_AUTOPILOT_CODING_ENABLED` (the production coding switch) stays off throughout.

## The one real side effect

Step 3 writes one claim record into the production `NUSA_EXECUTION_COORDINATOR` Durable Object, in its own
`NUSA_ISOLATED_CAUSAL_ATTEMPT_CLAIM_V1` domain. The record makes the same source run unreplayable. It does not
dispatch, approve or merge anything. Earlier records treat this write as an owner decision; approving step 1 is that decision.

## Steps

1. **Switch on (owner approves).** A PR adds `"NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED": "true"` to the `vars` of
   `apps/autopilot/wrangler.jsonc`. It merges through the release path; Autopilot Cloudflare Deploy ships it.
2. **Confirm the deploy.** Autopilot Cloudflare Runtime Proof on the new main reports `exactHeadVerified=true` with
   `deploymentRevision` equal to that main commit.
3. **One run.** Dispatch `NUSA Isolated Causal Verification` (`causal-verification.yml`) once on `main`.
   Its consumer starts automatically on success.
4. **Read the receipt.** Download `nusa-isolated-causal-verification-result-1` from the consumer run. Accept only if:
   `domain=NUSA_ISOLATED_CAUSAL_VERIFICATION_V1`, `decision=CODE_ACTIONABLE`,
   `classification=REPOSITORY_CODE_REGRESSION`, `sourceSha` = the dispatched main commit, `sourceRunId` = the source run,
   `durableReplayGuard=SQLITE_DURABLE_OBJECT_CLAIMED`, `codingRunnerStatus=EXECUTION_ACCEPTED`,
   `proposalAdapterCalls=1`, `sandboxExecutions=1`, `dedupe=REPLAY_REJECTED_WITHIN_SINGLE_HARNESS`,
   `mutationAllowed=false`, `liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`.
   Any other value, a non-success run, or a missing artifact is a failure; record it and do not retry blindly.
5. **Switch off.** A PR sets the var to `"false"` (or removes it). Confirm with the next runtime proof.
6. **Record.** One comment on #1851 and an update to the work order with the run IDs and receipt fields.
   Independent non-author review of that evidence is still required before L1 is called accepted.

If anything in steps 2-4 fails: switch off first (step 5), then diagnose. Never re-dispatch with a changed fixture.

## Safety

PAPER_ONLY; liveAuthority=NONE; productionMutationAllowed=false; aiAuthority=ZERO_AUTHORITY. No trading, risk, limit,
capital or credential change. The production coding switch is not touched.
