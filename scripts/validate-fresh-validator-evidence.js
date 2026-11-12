#!/usr/bin/env node
const fs = require("node:fs");

const SHA40 = /^[0-9a-f]{40}$/;
const WORKFLOW = ".github/workflows/autopilot-execution-consumer.yml";
const exactKeys = (value, keys, code) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) throw new Error(code);
};
const exactKeysWithOptional = (value, required, optional, code) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) throw new Error(code);
};
const positiveInt = (value, code) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
};
const nonnegativeInt = (value, code) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
};
const sha = (value, code) => {
  if (typeof value !== "string" || !SHA40.test(value)) throw new Error(code);
  return value;
};

function validateFreshValidatorEvidence(value, expected) {
  exactKeys(value, [
    "schemaVersion", "kind", "sourceWorkflow", "validatorExecutionRunId", "validatorExecutionAttempt",
    "repository", "prNumber", "reviewedHeadSha", "baseSha", "workflowRunId", "status", "verdict",
    "auditAllowed", "p0", "p1", "p2", "findings", "blockers", "safetyInvariantResult", "evidenceRefs",
    "reviewedAt", "liveAuthority", "productionMutationAllowed", "aiAuthority",
  ], "VALIDATOR_EVIDENCE_KEYS_INVALID");
  if (value.schemaVersion !== 1 || value.kind !== "NUSA_FRESH_VALIDATOR_EVIDENCE" || value.sourceWorkflow !== WORKFLOW) throw new Error("VALIDATOR_EVIDENCE_IDENTITY_INVALID");
  positiveInt(value.validatorExecutionRunId, "VALIDATOR_EXECUTION_RUN_ID_INVALID");
  positiveInt(value.validatorExecutionAttempt, "VALIDATOR_EXECUTION_ATTEMPT_INVALID");
  positiveInt(value.prNumber, "VALIDATOR_PR_NUMBER_INVALID");
  positiveInt(value.workflowRunId, "VALIDATOR_CI_RUN_ID_INVALID");
  nonnegativeInt(value.p0, "VALIDATOR_P0_INVALID");
  nonnegativeInt(value.p1, "VALIDATOR_P1_INVALID");
  nonnegativeInt(value.p2, "VALIDATOR_P2_INVALID");
  nonnegativeInt(value.reviewedAt, "VALIDATOR_REVIEWED_AT_INVALID");
  sha(value.reviewedHeadSha, "VALIDATOR_HEAD_INVALID");
  sha(value.baseSha, "VALIDATOR_BASE_INVALID");
  if (typeof value.repository !== "string" || !value.repository) throw new Error("VALIDATOR_REPOSITORY_INVALID");
  if (value.status !== "VALIDATOR_COMPLETED" || !["PASS", "PASS_WITH_NOTES"].includes(value.verdict) || value.auditAllowed !== true) throw new Error("VALIDATOR_ACCEPTANCE_INVALID");
  if (value.p0 !== 0 || value.p1 !== 0) throw new Error("VALIDATOR_BLOCKING_FINDINGS_PRESENT");
  if (!Array.isArray(value.findings) || !Array.isArray(value.blockers) || !Array.isArray(value.evidenceRefs)) throw new Error("VALIDATOR_COLLECTIONS_INVALID");
  if (value.blockers.length !== 0) throw new Error("VALIDATOR_BLOCKERS_PRESENT");
  if (value.findings.length !== value.p2) throw new Error("VALIDATOR_P2_COUNT_MISMATCH");
  for (const finding of value.findings) {
    exactKeysWithOptional(finding, ["code", "severity", "message", "evidenceRef"], ["evidenceScope"], "VALIDATOR_FINDING_KEYS_INVALID");
    if (typeof finding.code !== "string" || !/^P2_[A-Z0-9_.:-]{1,77}$/.test(finding.code) || finding.severity !== "NOTE") throw new Error("VALIDATOR_FINDING_PRIORITY_INVALID");
    if (typeof finding.message !== "string" || !finding.message.trim()) throw new Error("VALIDATOR_FINDING_MESSAGE_INVALID");
    if (!(finding.evidenceRef === null || typeof finding.evidenceRef === "string")) throw new Error("VALIDATOR_FINDING_EVIDENCE_INVALID");
    if (finding.evidenceRef === null) {
      if (finding.evidenceScope !== undefined) throw new Error("VALIDATOR_FINDING_EVIDENCE_SCOPE_INVALID");
    } else {
      if (finding.evidenceScope !== "SOURCE_CONTENT" && finding.evidenceScope !== "FILE_METADATA") throw new Error("VALIDATOR_FINDING_EVIDENCE_SCOPE_INVALID");
      if (finding.evidenceScope === "FILE_METADATA" && !finding.evidenceRef.endsWith(":@metadata")) throw new Error("VALIDATOR_FINDING_EVIDENCE_SCOPE_INVALID");
      if (finding.evidenceScope === "SOURCE_CONTENT" && finding.evidenceRef.endsWith(":@metadata")) throw new Error("VALIDATOR_FINDING_EVIDENCE_SCOPE_INVALID");
    }
  }
  if (value.verdict === "PASS" && value.findings.length !== 0) throw new Error("VALIDATOR_PASS_FINDINGS_INVALID");
  if (value.verdict === "PASS_WITH_NOTES" && value.findings.length === 0) throw new Error("VALIDATOR_NOTES_REQUIRED");
  if (value.safetyInvariantResult !== "PASS" || value.liveAuthority !== "NONE" || value.productionMutationAllowed !== false || value.aiAuthority !== "ZERO_AUTHORITY") throw new Error("VALIDATOR_SAFETY_INVALID");
  if (!value.evidenceRefs.includes(`github:pull/${value.prNumber}@${value.reviewedHeadSha}`)
      || !value.evidenceRefs.includes(`github:base/${value.baseSha}`)
      || !value.evidenceRefs.includes(`github:actions/runs/${value.workflowRunId}`)
      || !value.evidenceRefs.includes("protocol:docs/GRILL_ME_PROTOCOL.md")) throw new Error("VALIDATOR_PROVENANCE_INVALID");

  if (expected) {
    if (value.repository !== expected.repository) throw new Error("VALIDATOR_EXPECTED_REPOSITORY_MISMATCH");
    if (value.prNumber !== expected.prNumber) throw new Error("VALIDATOR_EXPECTED_PR_MISMATCH");
    if (value.reviewedHeadSha !== expected.headSha) throw new Error("VALIDATOR_EXPECTED_HEAD_MISMATCH");
    if (value.baseSha !== expected.baseSha) throw new Error("VALIDATOR_EXPECTED_BASE_MISMATCH");
    if (value.workflowRunId !== expected.workflowRunId) throw new Error("VALIDATOR_EXPECTED_CI_MISMATCH");
    if (value.validatorExecutionRunId !== expected.validatorExecutionRunId) throw new Error("VALIDATOR_EXPECTED_RUN_MISMATCH");
    if (value.validatorExecutionAttempt !== expected.validatorExecutionAttempt) throw new Error("VALIDATOR_EXPECTED_ATTEMPT_MISMATCH");
  }
  return Object.freeze({ ...value });
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 8) throw new Error("usage: validate-fresh-validator-evidence.js <file> <repository> <pr> <head> <base> <ci-run> <validator-run> <validator-attempt>");
  const [file, repository, pr, head, base, ciRun, validatorRun, validatorAttempt] = argv;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  validateFreshValidatorEvidence(value, {
    repository,
    prNumber: Number(pr),
    headSha: String(head).toLowerCase(),
    baseSha: String(base).toLowerCase(),
    workflowRunId: Number(ciRun),
    validatorExecutionRunId: Number(validatorRun),
    validatorExecutionAttempt: Number(validatorAttempt),
  });
  process.stdout.write(JSON.stringify({ status: "PASS", validatorExecutionRunId: value.validatorExecutionRunId, reviewedHeadSha: value.reviewedHeadSha, p0: value.p0, p1: value.p1, p2: value.p2 }) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "VALIDATOR_EVIDENCE_INVALID"}\n`); process.exitCode = 1; }
}
module.exports = { validateFreshValidatorEvidence };
