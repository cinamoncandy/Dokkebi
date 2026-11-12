import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const consumerWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/autopilot-execution-consumer.yml"), "utf8");
const releaseWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/autopilot-deterministic-audit-release.yml"), "utf8");

function jobSlice(workflow: string, name: string, nextName?: string): string {
  const startToken = `\n  ${name}:`;
  const start = workflow.indexOf(startToken);
  assert.notEqual(start, -1, `missing ${name} job`);
  if (!nextName) return workflow.slice(start);
  const end = workflow.indexOf(`\n  ${nextName}:`, start + startToken.length);
  assert.notEqual(end, -1, `missing ${nextName} job`);
  return workflow.slice(start, end);
}

test("PR comments cannot skip independent Audit execution", () => {
  const audit = jobSlice(consumerWorkflow, "audit-request", "audit-recovery");
  assert.doesNotMatch(audit, /Detect existing exact-head Audit verdict/);
  assert.doesNotMatch(audit, /steps\.existing-audit/);
  assert.match(audit, /Execute independent read-only Audit with GitHub OIDC/);
  assert.match(audit, /Bind trusted same-workflow Audit authority/);
  assert.match(audit, /auditExecutionRunId/);
  assert.match(audit, /auditExecutionAttempt/);
});

test("Release authority comes only from deterministic Audit, never PR comment JSON", () => {
  const release = jobSlice(releaseWorkflow, "release");
  assert.match(releaseWorkflow, /needs\.audit\.outputs\.authority == 'DETERMINISTIC_AUDIT_PASS'/);
  assert.match(release, /environment: nusa-release-authority/);
  assert.match(release, /Mint dedicated release authority token/);
  assert.match(release, /steps\.release_authority_token\.outputs\.token/);
  assert.doesNotMatch(release, /nusa-audit-verdict/);
  assert.doesNotMatch(release, /Audit verdict JSON missing/);
  assert.doesNotMatch(release, /auditComments/);
});

test("deterministic Audit requires successful same-consumer trusted Audit artifact as well as Validator evidence", () => {
  const audit = jobSlice(releaseWorkflow, "audit", "release");
  assert.match(audit, /trusted-audit-authority\.json/);
  assert.match(audit, /validate-trusted-audit-authority\.js/);
  assert.match(audit, /actions\/runs\/\$VALIDATOR_EXECUTION_RUN_ID\/artifacts/);
  assert.match(audit, /validator_attempt/);
  assert.match(consumerWorkflow, /Bind trusted same-workflow Audit authority/);
  assert.match(consumerWorkflow, /name: autopilot-audit-request-\$\{\{ github\.run_id \}\}/);
});

test("execution consumer cannot perform repository-native Release", () => {
  assert.doesNotMatch(consumerWorkflow, /\n  release:/);
  assert.doesNotMatch(consumerWorkflow, /\n  release-recovery:/);
  assert.doesNotMatch(consumerWorkflow, /pulls\/[^\s"']+\/merge/);

  const release = jobSlice(releaseWorkflow, "release");
  assert.match(release, /concurrency:\r?\n\s+group: deterministic-release-main/);
  assert.match(release, /Canonical expected-head merge/);
  assert.match(release, /-f sha="\$EXPECTED_HEAD"/);
  assert.match(release, /AUDITED_BASE/);
});

test("canonical merge is bound to the dedicated GitHub App token", () => {
  const release = jobSlice(releaseWorkflow, "release");
  assert.match(release, /app-id: \$\{\{ secrets\.NUSA_RELEASE_AUTH_APP_ID \}\}/);
  assert.match(release, /private-key: \$\{\{ secrets\.NUSA_RELEASE_AUTH_APP_PRIVATE_KEY \}\}/);
  const mergeStart = release.indexOf("      - name: Canonical expected-head merge");
  const mergeEnd = release.indexOf("\n      - name:", mergeStart + 1);
  assert.notEqual(mergeStart, -1, "missing canonical merge step");
  const merge = release.slice(mergeStart, mergeEnd === -1 ? undefined : mergeEnd);
  assert.match(merge, /GH_TOKEN: \$\{\{ steps\.release_authority_token\.outputs\.token \}\}/);
  assert.doesNotMatch(merge, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test("Release waits a bounded interval for GitHub branch protection to observe its exact App status", () => {
  const release = jobSlice(releaseWorkflow, "release");
  const waitStart = release.indexOf("      - name: Wait for protected-branch authorization propagation");
  const mergeStart = release.indexOf("      - name: Canonical expected-head merge");
  assert.ok(waitStart >= 0 && waitStart < mergeStart, "authorization propagation wait must precede canonical merge");
  const wait = release.slice(waitStart, mergeStart);
  assert.match(wait, /seq 1 10/);
  assert.match(wait, /head\.sha/);
  assert.match(wait, /base\.sha/);
  assert.match(wait, /nusa\/release-authorized/);
  assert.match(wait, /sleep 3/);
});

test("Audit and Release keep zero-authority fail-closed safety invariants", () => {
  const audit = jobSlice(consumerWorkflow, "audit-request", "audit-recovery");
  const deterministicAudit = jobSlice(releaseWorkflow, "audit", "release");
  const release = jobSlice(releaseWorkflow, "release");
  for (const source of [audit, deterministicAudit, release]) {
    assert.match(source, /liveAuthority|live_authority/);
    assert.match(source, /productionMutationAllowed|production_mutation_allowed/);
    assert.match(source, /aiAuthority|ai_authority/);
    assert.match(source, /ZERO_AUTHORITY/);
  }
});
