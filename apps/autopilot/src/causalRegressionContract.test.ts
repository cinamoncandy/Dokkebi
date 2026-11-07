import assert from "node:assert/strict";
import test from "node:test";
import { observeRepairableWorkflowContract, REPAIRABLE_WORKFLOW_CONTRACT } from "./causalRegressionContract";
import { isRepairableMainWorkflowFailure } from "./repairableWorkflowRun";

test("CANARY C': the narrowed repository predicate is a bounded, expected mismatch of the fixed contract (timed_out is no longer repairable)", () => {
  const result = observeRepairableWorkflowContract(isRepairableMainWorkflowFailure);
  assert.equal(result.status, "OBSERVED_MISMATCH");
  assert.deepEqual(result, { contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "OBSERVED_MISMATCH", caseId: "main-ci-timeout", expected: true, observed: false });
  assert.equal("CODE_ACTIONABLE" in result, false);
});

test("a stable incorrect predicate yields only a bounded observation, not coding authority", () => {
  const result = observeRepairableWorkflowContract(() => true);
  assert.deepEqual(result, { contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "OBSERVED_MISMATCH", caseId: "cancelled", expected: false, observed: true });
  assert.equal("CODE_ACTIONABLE" in result, false);
});

test("exceptions, non-boolean outputs and unstable results remain insufficient evidence", () => {
  let calls = 0;
  for (const candidate of [() => { throw new Error("unavailable"); }, () => "true", () => ++calls % 2 === 0]) {
    assert.deepEqual(observeRepairableWorkflowContract(candidate), { contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "INSUFFICIENT_EVIDENCE" });
  }
});
