import assert from "node:assert/strict";
import test from "node:test";
import { observeRepairableWorkflowContract, REPAIRABLE_WORKFLOW_CONTRACT } from "./causalRegressionContract";
import { isRepairableMainWorkflowFailure } from "./repairableWorkflowRun";

test("the current repository predicate satisfies the fixed observation contract", () => {
  assert.deepEqual(observeRepairableWorkflowContract(isRepairableMainWorkflowFailure), { contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "MATCH" });
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
