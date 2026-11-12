import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateCompletedAuditConsumerRun } = require("../scripts/validate-completed-audit-consumer-run.js");
const mainSha = "a".repeat(40);
const repository = "cinamoncandy/NUSA";
const expected = { repository, runId: 902, mainSha };
const run = (overrides = {}) => ({
  id: expected.runId,
  name: "Autopilot Execution Consumer",
  path: ".github/workflows/autopilot-execution-consumer.yml",
  event: "repository_dispatch",
  repository: { full_name: repository },
  head_sha: mainSha,
  status: "completed",
  conclusion: "success",
  run_attempt: 2,
  ...overrides,
});

test("accepts only a completed-success canonical consumer run bound to current main", () => {
  assert.deepEqual(validateCompletedAuditConsumerRun(run(), expected), {
    runId: 902,
    runAttempt: 2,
    headSha: mainSha,
  });
});

test("rejects in-progress consumer even if validator artifacts may already exist", () => {
  assert.throws(() => validateCompletedAuditConsumerRun(run({ status: "in_progress" }), expected), /NOT_COMPLETED_SUCCESSFULLY/);
});

test("rejects consumer failure after an earlier validator artifact was uploaded", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", null]) {
    assert.throws(() => validateCompletedAuditConsumerRun(run({ conclusion }), expected), /NOT_COMPLETED_SUCCESSFULLY/);
  }
});

test("rejects wrong run, workflow, event, repository, base SHA, or attempt", () => {
  for (const patch of [
    { id: 903 },
    { name: "Other workflow" },
    { path: ".github/workflows/other.yml" },
    { event: "workflow_dispatch" },
    { repository: { full_name: "other/repo" } },
    { head_sha: "b".repeat(40) },
    { run_attempt: 0 },
  ]) assert.throws(() => validateCompletedAuditConsumerRun(run(patch), expected));
});
