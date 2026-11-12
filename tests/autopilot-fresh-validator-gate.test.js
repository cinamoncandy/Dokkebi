import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const consumer = fs.readFileSync(".github/workflows/autopilot-execution-consumer.yml", "utf8");
const release = fs.readFileSync(".github/workflows/autopilot-deterministic-audit-release.yml", "utf8");
const runner = fs.readFileSync("apps/autopilot/src/auditRunner.ts", "utf8");
const worker = fs.readFileSync("apps/autopilot/src/worker.ts", "utf8");
const githubExecutor = fs.readFileSync("apps/autopilot/src/githubExecutor.ts", "utf8");

test("fresh pre-Audit VALIDATOR is a stateless trusted workflow stage, not PR-comment authority", () => {
  assert.match(consumer, /kind:\s*['"]VALIDATOR_REQUEST['"]/);
  assert.match(consumer, /VALIDATOR_COMPLETED/);
  assert.match(consumer, /fresh non-author VALIDATOR/i);
  assert.match(consumer, /trusted-validator-evidence\.json/);
  assert.match(consumer, /contents\/scripts\/validate-fresh-validator-evidence\.js\?ref=\$base_sha/);
  assert.doesNotMatch(consumer.slice(consumer.indexOf("  audit-request:"), consumer.indexOf("  release-handoff:")), /uses: actions\/checkout/);
  assert.match(consumer, /validatorExecutionRunId/);
  assert.match(consumer, /p0[^\n]*===?[^\n]*0|p0[^\n]*!==?[^\n]*0/);
  assert.match(consumer, /p1[^\n]*===?[^\n]*0|p1[^\n]*!==?[^\n]*0/);
  assert.match(consumer, /auditAllowed/);
  assert.doesNotMatch(consumer, /nusa-validator-verdict[^\n]*comment/i);
});

test("review runner distinguishes VALIDATOR from Audit and binds P0\/P1 blockers to current diff", () => {
  assert.match(runner, /ValidatorRunnerRequest/);
  assert.match(runner, /VALIDATOR_REQUEST/);
  assert.match(runner, /VALIDATOR_COMPLETED/);
  assert.match(runner, /P0_/);
  assert.match(runner, /P1_/);
  assert.match(runner, /P2_/);
  assert.match(runner, /docs\/GRILL_ME_PROTOCOL\.md/);
  assert.match(runner, /TRUSTED PROTECTED-BASE GRILL_ME_PROTOCOL/);
  assert.match(runner, /VALIDATOR_PROTOCOL_HTTP_/);
  assert.match(worker, /validateValidatorRunnerRequest/);
  assert.match(worker, /executeIndependentValidator/);
});

test("deterministic Audit and Release re-read exact trusted validator artifact before authority or merge", () => {
  assert.match(release, /VALIDATOR_EXECUTION_RUN_ID/);
  assert.match(release, /actions\/runs\/\$VALIDATOR_EXECUTION_RUN_ID\/artifacts/);
  assert.match(release, /validate-completed-audit-consumer-run\.js/);
  assert.match(release, /validate-fresh-validator-evidence\.js/);
  assert.match(release, /\"\$VALIDATOR_EXECUTION_RUN_ID\" \"\$current_main\"/);
  const auditPass = release.indexOf("authority=DETERMINISTIC_AUDIT_PASS");
  const validatorCheck = release.indexOf("validate-fresh-validator-evidence.js");
  assert.ok(validatorCheck >= 0 && auditPass > validatorCheck, "validator evidence must gate deterministic Audit PASS");
  const authorize = release.indexOf("Publish exact-head release authorization");
  const lastValidatorCheck = release.lastIndexOf("validate-fresh-validator-evidence.js", authorize);
  assert.ok(authorize > 0 && lastValidatorCheck >= 0 && lastValidatorCheck < authorize, "Release must re-check validator evidence before authorization");
});

test("AUDIT_REQUEST enters the canonical execution consumer before deterministic Release", () => {
  assert.match(consumer, /run-name:.*dedupe_key/);
  assert.match(githubExecutor, /autopilot-execution-consumer\.yml\/runs\?event=repository_dispatch/);
  assert.match(githubExecutor, /event_type: "nusa_autopilot_execution"/);
  assert.doesNotMatch(githubExecutor, /event_type: request\.kind === "AUDIT_REQUEST" \? "nusa_autopilot_audit"/);
});
