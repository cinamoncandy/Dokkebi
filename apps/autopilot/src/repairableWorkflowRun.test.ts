import test from "node:test";
import assert from "node:assert/strict";
import { isRepairableMainWorkflowFailure } from "./repairableWorkflowRun";

const run = (overrides: Record<string, unknown>) => ({ name: "CI", conclusion: "failure", head_branch: "main", event: "push", ...overrides });

test("canonical code checks that failed on main are repair targets", () => {
  assert.equal(isRepairableMainWorkflowFailure(run({})), true);
  assert.equal(isRepairableMainWorkflowFailure(run({ conclusion: "timed_out" })), true);
  assert.equal(isRepairableMainWorkflowFailure(run({ event: "workflow_dispatch" })), true);
  assert.equal(isRepairableMainWorkflowFailure(run({ name: "Autopilot Sandbox New-File Guard" })), true);
});

test("control-plane and runtime evidence workflow failures are never repair targets", () => {
  for (const name of [
    "Autopilot Codex Coding",
    "Autopilot Execution Consumer",
    "Autopilot GitHub Event Bridge",
    "Autopilot Deterministic Audit Release",
    "Actual PAPER Public-Market Runtime Evidence",
    "Android Stable Release Watchdog",
  ]) {
    assert.equal(isRepairableMainWorkflowFailure(run({ name })), false, name);
  }
});

test("only failed runs on main from a push or a manual run qualify", () => {
  assert.equal(isRepairableMainWorkflowFailure(run({ conclusion: "success" })), false);
  assert.equal(isRepairableMainWorkflowFailure(run({ conclusion: "cancelled" })), false);
  assert.equal(isRepairableMainWorkflowFailure(run({ head_branch: "feature" })), false);
  for (const event of ["schedule", "repository_dispatch", "workflow_run", "pull_request", undefined]) {
    assert.equal(isRepairableMainWorkflowFailure(run({ event })), false, String(event));
  }
  assert.equal(isRepairableMainWorkflowFailure(run({ name: undefined })), false);
});
