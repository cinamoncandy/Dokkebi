#!/usr/bin/env node
const fs = require("node:fs");

const SHA40 = /^[0-9a-f]{40}$/;
const KEYS = [
  "schemaVersion", "status", "repository", "prNumber", "reviewedHeadSha", "baseSha", "workflowRunId",
  "verdict", "mergeAllowed", "safetyInvariantResult", "liveAuthority", "productionMutationAllowed", "aiAuthority",
  "auditExecutionRunId", "auditExecutionAttempt", "validatorStatus", "validatorExecutionRunId",
  "validatorExecutionAttempt", "validatorAuditAllowed", "validatorP0", "validatorP1", "validatorP2",
];

function exactKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TRUSTED_AUDIT_AUTHORITY_INVALID");
  if (Object.keys(value).sort().join(",") !== [...KEYS].sort().join(",")) throw new Error("TRUSTED_AUDIT_AUTHORITY_KEYS_INVALID");
}

function positive(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

function nonnegative(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function validateTrustedAuditAuthority(value, expected) {
  exactKeys(value);
  if (value.schemaVersion !== 1 || value.status !== "AUDIT_COMPLETED") throw new Error("TRUSTED_AUDIT_AUTHORITY_STATUS_INVALID");
  if (value.repository !== expected.repository || value.prNumber !== expected.prNumber || value.reviewedHeadSha !== expected.headSha || value.baseSha !== expected.baseSha || value.workflowRunId !== expected.ciRunId) throw new Error("TRUSTED_AUDIT_AUTHORITY_IDENTITY_MISMATCH");
  if (!SHA40.test(value.reviewedHeadSha) || !SHA40.test(value.baseSha)) throw new Error("TRUSTED_AUDIT_AUTHORITY_SHA_INVALID");
  if (value.verdict !== "PASS" && value.verdict !== "PASS_WITH_NOTES") throw new Error("TRUSTED_AUDIT_AUTHORITY_VERDICT_INVALID");
  if (value.mergeAllowed !== true || value.safetyInvariantResult !== "PASS") throw new Error("TRUSTED_AUDIT_AUTHORITY_AUDIT_NOT_ALLOWED");
  if (value.liveAuthority !== "NONE" || value.productionMutationAllowed !== false || value.aiAuthority !== "ZERO_AUTHORITY") throw new Error("TRUSTED_AUDIT_AUTHORITY_SAFETY_INVALID");
  positive(value.auditExecutionRunId, "TRUSTED_AUDIT_AUTHORITY_AUDIT_RUN_INVALID");
  positive(value.auditExecutionAttempt, "TRUSTED_AUDIT_AUTHORITY_AUDIT_ATTEMPT_INVALID");
  positive(value.validatorExecutionRunId, "TRUSTED_AUDIT_AUTHORITY_VALIDATOR_RUN_INVALID");
  positive(value.validatorExecutionAttempt, "TRUSTED_AUDIT_AUTHORITY_VALIDATOR_ATTEMPT_INVALID");
  if (value.auditExecutionRunId !== expected.consumerRunId || value.auditExecutionAttempt !== expected.consumerAttempt || value.validatorExecutionRunId !== expected.consumerRunId || value.validatorExecutionAttempt !== expected.consumerAttempt) throw new Error("TRUSTED_AUDIT_AUTHORITY_EXECUTION_MISMATCH");
  if (value.validatorStatus !== "VALIDATOR_COMPLETED" || value.validatorAuditAllowed !== true) throw new Error("TRUSTED_AUDIT_AUTHORITY_VALIDATOR_NOT_ALLOWED");
  nonnegative(value.validatorP0, "TRUSTED_AUDIT_AUTHORITY_P0_INVALID");
  nonnegative(value.validatorP1, "TRUSTED_AUDIT_AUTHORITY_P1_INVALID");
  nonnegative(value.validatorP2, "TRUSTED_AUDIT_AUTHORITY_P2_INVALID");
  if (value.validatorP0 !== 0 || value.validatorP1 !== 0) throw new Error("TRUSTED_AUDIT_AUTHORITY_VALIDATOR_BLOCKED");
  return Object.freeze({ ...value });
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 8) throw new Error("usage: validate-trusted-audit-authority.js <file> <repository> <pr> <head> <base> <ci-run> <consumer-run> <consumer-attempt>");
  const [file, repository, pr, head, base, ciRun, consumerRun, consumerAttempt] = argv;
  validateTrustedAuditAuthority(JSON.parse(fs.readFileSync(file, "utf8")), {
    repository, prNumber: Number(pr), headSha: String(head).toLowerCase(), baseSha: String(base).toLowerCase(),
    ciRunId: Number(ciRun), consumerRunId: Number(consumerRun), consumerAttempt: Number(consumerAttempt),
  });
  process.stdout.write(JSON.stringify({ status: "PASS", consumerRunId: Number(consumerRun), headSha: String(head).toLowerCase() }) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "TRUSTED_AUDIT_AUTHORITY_INVALID"}\n`); process.exitCode = 1; }
}
module.exports = { validateTrustedAuditAuthority };
