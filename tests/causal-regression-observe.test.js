const test = require("node:test");
const assert = require("node:assert/strict");
const { produceReceipt, sourceIdentity } = require("../scripts/causal-regression-observe.js");
const { isRepairableMainWorkflowFailure } = require("../dist/apps/autopilot/src/repairableWorkflowRun.js");

const sha = "a".repeat(40);
const env = { GITHUB_REPOSITORY: "cinamoncandy/NUSA", GITHUB_SHA: sha, GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: "cinamoncandy/NUSA/.github/workflows/ci.yml@refs/heads/main", GITHUB_WORKFLOW_SHA: sha, GITHUB_JOB: "causal-regression-contract" };

test("producer observes the actual predicate and binds fixed contract fingerprints", () => {
  const receipt = produceReceipt(env, sha, isRepairableMainWorkflowFailure);
  assert.equal(receipt.observation.status, "MATCH");
  assert.equal(receipt.source.sha, sha);
  assert.equal(receipt.source.runId, "456");
  assert.equal(receipt.contractId, "REPAIRABLE_WORKFLOW_POLICY_V1");
  for (const value of Object.values(receipt.fingerprints)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal("CODE_ACTIONABLE" in receipt, false);
});

test("unstable or unavailable contract runs cannot produce a mismatch observation", () => {
  let count = 0;
  assert.equal(produceReceipt(env, sha, () => ++count % 2 === 0).observation.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(produceReceipt(env, sha, () => { throw new Error("unavailable"); }).observation.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(produceReceipt(env, sha, () => true).observation.status, "OBSERVED_MISMATCH");
});

test("source identity requires exact checked-out SHA, main push, run and attempt", () => {
  for (const changes of [{ GITHUB_SHA: "b".repeat(40) }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/heads/feature" }, { GITHUB_RUN_ID: "0" }, { GITHUB_RUN_ATTEMPT: "" }, { GITHUB_WORKFLOW_REF: "other/NUSA/.github/workflows/ci.yml@refs/heads/main" }, { GITHUB_WORKFLOW_SHA: "c".repeat(40) }, { GITHUB_JOB: "validation" }]) {
    assert.throws(() => sourceIdentity({ ...env, ...changes }, sha), /CAUSAL_PRODUCER_SOURCE_IDENTITY_INVALID/);
  }
});
