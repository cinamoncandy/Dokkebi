import assert from "node:assert/strict";
import test from "node:test";
import { validateAuditModelVerdict } from "./auditRunner";

test("normalizes semantic audit safety enum casing without weakening fail-closed values", () => {
  const pass = validateAuditModelVerdict({
    verdict: "PASS",
    findings: [],
    blockers: [],
    safetyInvariantResult: " pass ",
    mergeAllowed: true,
  });
  assert.equal(pass.safetyInvariantResult, "PASS");

  const fail = validateAuditModelVerdict({
    verdict: "FAIL",
    findings: [{
      code: "SAFETY_REGRESSION",
      severity: "BLOCKER",
      message: "safety invariant regressed",
      evidenceRef: "a.ts:+1",
      evidenceScope: "SOURCE_CONTENT",
    }],
    blockers: ["safety invariant regressed"],
    safetyInvariantResult: " fail ",
    mergeAllowed: false,
  });
  assert.equal(fail.safetyInvariantResult, "FAIL");
  assert.equal(fail.verdict, "FAIL");

  assert.throws(() => validateAuditModelVerdict({
    verdict: "PASS",
    findings: [],
    blockers: [],
    safetyInvariantResult: "UNKNOWN",
    mergeAllowed: true,
  }), /AUDIT_VERDICT_SAFETY_INVALID/);

  assert.throws(() => validateAuditModelVerdict({
    verdict: "PASS",
    findings: [],
    blockers: [],
    safetyInvariantResult: true,
    mergeAllowed: true,
  }), /AUDIT_VERDICT_SAFETY_INVALID/);
});
