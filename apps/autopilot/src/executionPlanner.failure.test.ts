import assert from "node:assert/strict";
import test from "node:test";
import { planAutopilotExecution } from "./executionPlanner";

test("PR_CI_SUCCEEDED becomes a bounded exact-head audit request", () => {
  const headSha = "2777b2d4f7cf9fa4402d8b8b00c51175195e8568";
  const workflowRunId = 33298118860;
  const result = planAutopilotExecution({
    kind: "PR_CI_SUCCEEDED",
    repository: "cinamoncandy/NUSA",
    headSha,
    prNumber: 42,
    workflowRunId,
    reason: "pull-request-ci-success",
    mutationAllowed: false,
  });

  assert.equal(result.kind, "AUDIT_REQUEST");
  assert.equal(result.repository, "cinamoncandy/NUSA");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, headSha);
  assert.equal(result.workflowRunId, workflowRunId);
  assert.equal(result.executionId, `audit:42:${workflowRunId}`);
  assert.equal(result.dedupeKey, `audit:42:${workflowRunId}:${headSha}`);
  assert.equal(result.mutationAllowed, false);
});

test("PR_CI_SUCCEEDED without exact bounded identity fails closed", () => {
  const result = planAutopilotExecution({
    kind: "PR_CI_SUCCEEDED",
    repository: "cinamoncandy/NUSA",
    headSha: "3".repeat(40),
    prNumber: null,
    workflowRunId: 33298118860,
    reason: "pull-request-ci-success",
    mutationAllowed: false,
  });

  assert.equal(result.kind, "NOOP");
  assert.equal(result.reason, "pr-ci-success-missing-bounded-identity");
  assert.equal(result.mutationAllowed, false);
});

test("CI_FAILED becomes bounded repository autopilot repair evidence", () => {
  const headSha = "1777b2d4f7cf9fa4402d8b8b00c51175195e8568";
  const workflowRunId = 33298118859;
  const result = planAutopilotExecution({
    kind: "CI_FAILED",
    repository: "cinamoncandy/NUSA",
    headSha,
    prNumber: null,
    workflowRunId,
    reason: "workflow-run:failure",
    mutationAllowed: false,
  });

  assert.equal(result.kind, "REPOSITORY_AUTOPILOT");
  assert.equal(result.repository, "cinamoncandy/NUSA");
  assert.equal(result.headSha, headSha);
  assert.equal(result.workflowRunId, workflowRunId);
  assert.equal(result.reason, `gha:${workflowRunId}:${headSha}:failure`);
  assert.equal(result.executionId, `ci-failure:${workflowRunId}`);
  assert.equal(result.dedupeKey, `ci-failure:${workflowRunId}:${headSha}`);
  assert.equal(result.mutationAllowed, false);
});

test("CI_FAILED without exact bounded identity fails closed", () => {
  const result = planAutopilotExecution({
    kind: "CI_FAILED",
    repository: "cinamoncandy/NUSA",
    headSha: null,
    prNumber: null,
    workflowRunId: 33298118859,
    reason: "workflow-run:failure",
    mutationAllowed: false,
  });

  assert.equal(result.kind, "NOOP");
  assert.equal(result.reason, "ci-failure-missing-bounded-identity");
  assert.equal(result.mutationAllowed, false);
});

test("events that carry no evidence of anything to fix plan no coding request (the evidence-free continue lane is closed)", () => {
  for (const kind of ["MAIN_PUSH", "CI_SUCCEEDED", "PR_CHANGED"] as const) {
    const result = planAutopilotExecution({
      kind,
      repository: "cinamoncandy/NUSA",
      headSha: "a".repeat(40),
      prNumber: kind === "PR_CHANGED" ? 7 : null,
      workflowRunId: kind === "CI_SUCCEEDED" ? 99 : null,
      workflowRunAttempt: null,
      reason: "x",
      mutationAllowed: false,
    });
    assert.equal(result.kind, "NOOP", kind);
    assert.equal(result.reason, "evidence-free-continue-disabled", kind);
    assert.equal(result.mutationAllowed, false, kind);
    assert.equal("executionId" in result, false, kind);
  }
});

test("a failed CI run still plans an evidence-bound request that names the failed run", () => {
  const headSha = "b".repeat(40);
  const result = planAutopilotExecution({
    kind: "CI_FAILED",
    repository: "cinamoncandy/NUSA",
    headSha,
    prNumber: null,
    workflowRunId: 123,
    workflowRunAttempt: 1,
    reason: "workflow-run:failure",
    mutationAllowed: false,
  });
  assert.equal(result.kind, "REPOSITORY_AUTOPILOT");
  assert.equal(result.reason, `gha:123:${headSha}:failure`);
});
