import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateTrustedAuditAuthority } = require("../scripts/validate-trusted-audit-authority.js");
const { validateCompletedAuditConsumerRun } = require("../scripts/validate-completed-audit-consumer-run.js");
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const expected = { repository: "cinamoncandy/NUSA", prNumber: 2872, headSha: HEAD, baseSha: BASE, ciRunId: 901, consumerRunId: 902, consumerAttempt: 2 };
const authority = (overrides = {}) => ({
  schemaVersion: 1, status: "AUDIT_COMPLETED", repository: expected.repository, prNumber: expected.prNumber,
  reviewedHeadSha: HEAD, baseSha: BASE, workflowRunId: expected.ciRunId, verdict: "PASS", mergeAllowed: true,
  safetyInvariantResult: "PASS", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY",
  auditExecutionRunId: expected.consumerRunId, auditExecutionAttempt: expected.consumerAttempt,
  validatorStatus: "VALIDATOR_COMPLETED", validatorExecutionRunId: expected.consumerRunId,
  validatorExecutionAttempt: expected.consumerAttempt, validatorAuditAllowed: true, validatorP0: 0, validatorP1: 0, validatorP2: 2,
  ...overrides,
});

test("accepts same-run exact-head trusted independent Audit authority", () => {
  assert.equal(validateTrustedAuditAuthority(authority(), expected).verdict, "PASS");
  assert.equal(validateTrustedAuditAuthority(authority({ verdict: "PASS_WITH_NOTES" }), expected).mergeAllowed, true);
});

test("completed consumer success and independent Audit authority form one exact same-attempt chain", () => {
  const run = {
    id: expected.consumerRunId,
    name: "Autopilot Execution Consumer",
    path: ".github/workflows/autopilot-execution-consumer.yml",
    event: "repository_dispatch",
    repository: { full_name: expected.repository },
    head_sha: expected.baseSha,
    status: "completed",
    conclusion: "success",
    run_attempt: expected.consumerAttempt,
  };
  const completed = validateCompletedAuditConsumerRun(run, {
    repository: expected.repository,
    runId: expected.consumerRunId,
    mainSha: expected.baseSha,
  });
  assert.equal(validateTrustedAuditAuthority(authority(), { ...expected, consumerAttempt: completed.runAttempt }).verdict, "PASS");
});

test("fails closed when consumer Audit authority is absent, mismatched, or unsafe", () => {
  for (const [patch, code] of [
    [{ reviewedHeadSha: "c".repeat(40) }, /IDENTITY_MISMATCH/],
    [{ auditExecutionAttempt: 1 }, /EXECUTION_MISMATCH/],
    [{ validatorExecutionRunId: 903 }, /EXECUTION_MISMATCH/],
    [{ verdict: "FAIL", mergeAllowed: false }, /VERDICT_INVALID/],
    [{ mergeAllowed: false }, /AUDIT_NOT_ALLOWED/],
    [{ productionMutationAllowed: true }, /SAFETY_INVALID/],
    [{ validatorP1: 1 }, /VALIDATOR_BLOCKED/],
    [{ status: "AUDIT_RUNNING" }, /STATUS_INVALID/],
    [{ unexpected: true }, /KEYS_INVALID/],
  ]) assert.throws(() => validateTrustedAuditAuthority(authority(patch), expected), code);
});
