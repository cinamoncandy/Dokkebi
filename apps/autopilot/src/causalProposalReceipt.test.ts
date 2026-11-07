import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCausalProposalReceipt, verifyCausalProposalReceipt } from "./causalProposalReceipt";
import type { CodingRunnerRequest } from "./codingRunner";
import type { SourceExecutionIdentity, VerifiedCodingPublisherIdentity } from "./githubActionsOidc";

const HEAD = "a".repeat(40);
const request: CodingRunnerRequest = Object.freeze({
  kind: "REPOSITORY_AUTOPILOT",
  repository: "cinamoncandy/NUSA",
  headSha: HEAD,
  workflowRunId: 123456,
  workflowRunAttempt: 2,
  reason: "gha:123456:" + HEAD + ":failure",
  executionId: "autopilot:" + HEAD + ":123456",
  dedupeKey: "autopilot:" + HEAD + ":123456",
  mutationAllowed: false,
  liveAuthority: "NONE",
  productionMutationAllowed: false,
  aiAuthority: "ZERO_AUTHORITY",
});
const source: SourceExecutionIdentity = Object.freeze({
  repository: request.repository,
  workflowPath: ".github/workflows/ci.yml",
  sha: HEAD,
  runId: String(request.workflowRunId),
  runAttempt: String(request.workflowRunAttempt),
});
const publisher: VerifiedCodingPublisherIdentity = Object.freeze({
  repository: request.repository,
  workflowRef: request.repository + "/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main",
  ref: "refs/heads/main",
  sha: HEAD,
  runId: "987654",
  runAttempt: "1",
  event: "repository_dispatch",
});
const admission = Object.freeze({ source, publisher, capabilityDigest: "b".repeat(64) });
const patch = [
  "diff --git a/apps/autopilot/src/repairableWorkflowRun.ts b/apps/autopilot/src/repairableWorkflowRun.ts",
  "--- a/apps/autopilot/src/repairableWorkflowRun.ts",
  "+++ b/apps/autopilot/src/repairableWorkflowRun.ts",
  "@@ -1,1 +1,1 @@",
  "-export const enabled = true;",
  "+export const enabled = false;",
].join("\n");

describe("causal proposal receipt", () => {
  it("binds the exact source, publisher, capability, request, and proposal patch", async () => {
    const now = 1_800_000_000_000;
    const receipt = await createCausalProposalReceipt(request, admission, patch, "github-token-fixture", now);
    assert.equal(await verifyCausalProposalReceipt(receipt, request, admission, patch, "github-token-fixture", now + 1), true);
    assert.equal(await verifyCausalProposalReceipt(receipt, request, admission, patch + "\n", "github-token-fixture", now + 1), false);
    assert.equal(await verifyCausalProposalReceipt(receipt, { ...request, workflowRunAttempt: 1 }, admission, patch, "github-token-fixture", now + 1), false);
    assert.equal(await verifyCausalProposalReceipt(receipt, request, { ...admission, capabilityDigest: "c".repeat(64) }, patch, "github-token-fixture", now + 1), false);
    assert.equal(await verifyCausalProposalReceipt(receipt, request, admission, patch, "another-github-token-fixture", now + 1), false);
    assert.equal(await verifyCausalProposalReceipt(receipt, request, admission, patch, "github-token-fixture", now + 30 * 60 * 1000), false);
  });

  it("rejects malformed or non-causal receipt inputs", async () => {
    await assert.rejects(
      () => createCausalProposalReceipt({ ...request, reason: "evolve:issue-1" }, admission, patch, "github-token-fixture", 1_800_000_000_000),
      /CAUSAL_PROPOSAL_RECEIPT_INPUT_INVALID/,
    );
    assert.equal(await verifyCausalProposalReceipt("forged.receipt", request, admission, patch, "github-token-fixture"), false);
  });
});
