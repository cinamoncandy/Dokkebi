"use strict";
// Read-only evaluator for the canary pre-start recheck (docs/FORGE_CANARY_PREPARATION_20261104.md).
// It takes facts that a person or session already read from GitHub and the host and returns PASS or FAIL per check.
// It reads no network, writes nothing and changes nothing. Missing or malformed facts FAIL (fail-closed).
const EXPECTED_TARGET_BLOB = "865c7fb4f3a3669511acae08135853337545d70f";

function check(id, ok, detail) {
  return { id, status: ok === true ? "PASS" : "FAIL", detail };
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function evaluatePreflight(facts) {
  const f = isObj(facts) ? facts : {};
  const checks = [
    check("TARGET_BLOB_UNCHANGED", f.targetBlob === EXPECTED_TARGET_BLOB, `repairableWorkflowRun.ts blob ${String(f.targetBlob)}`),
    check("CODEX_CODING_DISABLED", f.autopilotCodexCodingState === "disabled_manually", `Autopilot Codex Coding state ${String(f.autopilotCodexCodingState)}`),
    check("MAIN_CI_NOT_ALREADY_RED", isObj(f.mainCi) && f.mainCi.conclusion === "success", `latest main CI ${isObj(f.mainCi) ? String(f.mainCi.conclusion) : "unknown"}`),
    check("NO_OTHER_PR_IN_AUDIT_OR_MERGE", Array.isArray(f.otherPrsInAuditOrMerge) && f.otherPrsInAuditOrMerge.length === 0, `other PRs in Audit or merge: ${Array.isArray(f.otherPrsInAuditOrMerge) ? f.otherPrsInAuditOrMerge.length : "unknown"}`),
    check("SERVER_HEALTHY", isObj(f.server) && f.server.restarts === 0 && f.server.newAlarms === 0, `server restarts ${isObj(f.server) ? String(f.server.restarts) : "unknown"}, new alarms ${isObj(f.server) ? String(f.server.newAlarms) : "unknown"}`),
    check("NO_OPEN_P0", Number.isInteger(f.openP0) && f.openP0 === 0, `open P0 ${String(f.openP0)}`),
    check("CANARY_PR_STILL_DRAFT", f.canaryPrDraft === true && f.canaryPrMerged === false, `canary PR draft ${String(f.canaryPrDraft)}, merged ${String(f.canaryPrMerged)}`),
  ];
  const failed = checks.filter((c) => c.status !== "PASS").map((c) => c.id);
  return { verdict: failed.length === 0 ? "PASS" : "FAIL", failed, checks };
}

module.exports = { evaluatePreflight, EXPECTED_TARGET_BLOB };

if (require.main === module) {
  const fs = require("node:fs");
  let facts;
  try { facts = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch { facts = undefined; }
  const result = evaluatePreflight(facts);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.verdict === "PASS" ? 0 : 1);
}
