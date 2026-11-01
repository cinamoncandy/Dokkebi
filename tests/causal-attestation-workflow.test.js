const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
function jobBlock(job, nextJob) {
  const start = workflow.indexOf(`  ${job}:\n`);
  const end = workflow.indexOf(`\n  ${nextJob}:\n`, start + 1);
  assert.notEqual(start, -1, `${job} job exists`);
  assert.notEqual(end, -1, `${nextJob} boundary exists`);
  return workflow.slice(start, end);
}

test("only the isolated attestation job receives artifact signing permissions", () => {
  const observer = jobBlock("causal-regression-contract", "attest-causal-regression");
  const attestor = jobBlock("attest-causal-regression", "causal-positive-verification");
  assert.doesNotMatch(observer, /id-token:\s*write|attestations:\s*write|artifact-metadata:\s*write/);
  assert.match(attestor, /id-token:\s*write/);
  assert.match(attestor, /attestations:\s*write/);
  assert.match(attestor, /artifact-metadata:\s*write/);
  assert.doesNotMatch(attestor, /actions\/checkout@/);
});

test("attestation is gated to an exact main-push mismatch and same-run artifact", () => {
  const attestor = jobBlock("attest-causal-regression", "test");
  assert.match(attestor, /github\.event_name == 'push'/);
  assert.match(attestor, /github\.ref == 'refs\/heads\/main'/);
  assert.match(attestor, /observation_status == 'OBSERVED_MISMATCH'/);
  assert.match(attestor, /name: nusa-causal-repairable-v1-\$\{\{ github\.run_attempt \}\}/);
  assert.match(attestor, /GH_RUN_ID:\s*\$\{\{ github\.run_id \}\}/);
  assert.match(attestor, /GH_RUN_ATTEMPT:\s*\$\{\{ github\.run_attempt \}\}/);
  assert.match(attestor, /source\.sha !== process\.env\.GH_SHA/);
  assert.match(attestor, /source\.workflowSha !== process\.env\.GH_SHA/);
  assert.match(attestor, /source\.runId\).*process\.env\.GH_RUN_ID/);
});

test("attestation action is immutable-pinned and emits a separately retained bundle", () => {
  const attestor = jobBlock("attest-causal-regression", "test");
  assert.match(attestor, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/);
  assert.match(attestor, /predicate-type: https:\/\/github\.com\/cinamoncandy\/NUSA\/attestations\/causal-regression\/v1/);
  assert.match(attestor, /predicate-path: causal-input\/receipt\.json/);
  assert.match(attestor, /bundle-path: artifacts\/causal-regression\/attestation\.json/);
  assert.match(attestor, /name: nusa-causal-attestation-\$\{\{ github\.run_attempt \}\}/);
});

test("consumer reads the same source-run attestation artifact and requires server verification when supplied", () => {
  const consumer = fs.readFileSync(".github/workflows/autopilot-execution-consumer.yml", "utf8");
  assert.match(consumer, /actions:\s*read/);
  assert.match(consumer, /gh run download \"\$SOURCE_RUN_ID\"/);
  assert.match(consumer, /nusa-causal-attestation-\$\{SOURCE_RUN_ATTEMPT\}/);
  const claim = fs.readFileSync("scripts/autopilot-causal-claim.js", "utf8");
  assert.match(claim, /attestationBundle/);
  assert.match(claim, /causalAttestationVerified !== true/);
});

test("positive verification attestation is manual, main-only, and domain-separated from production causal evidence", () => {
  const producer = jobBlock("causal-positive-verification", "attest-causal-positive-verification");
  const attestor = jobBlock("attest-causal-positive-verification", "verify-causal-positive-verification");
  const consumer = jobBlock("verify-causal-positive-verification", "test");
  assert.match(producer, /github\.event_name == 'workflow_dispatch'/);
  assert.match(producer, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(producer, /id-token:\s*write|attestations:\s*write|artifact-metadata:\s*write/);
  assert.match(attestor, /id-token:\s*write/);
  assert.match(attestor, /attestations:\s*write/);
  assert.match(attestor, /artifact-metadata:\s*write/);
  assert.match(attestor, /NUSA_CAUSAL_VERIFICATION_ONLY_V1/);
  assert.match(attestor, /causal-regression-verification\/v1/);
  assert.doesNotMatch(attestor, /CODE_ACTIONABLE/);
  assert.match(consumer, /causal-positive-verification-verify\.js/);
  assert.match(consumer, /actions:\s*read/);
  const worker = fs.readFileSync("apps/autopilot/src/worker.ts", "utf8");
  const verifier = fs.readFileSync("apps/autopilot/src/sigstoreCausalAttestation.ts", "utf8");
  assert.doesNotMatch(worker, /verifyIsolatedCausalVerificationAttestation/);
  assert.match(verifier, /const PREDICATE_TYPE = "https:\/\/github\.com\/cinamoncandy\/NUSA\/attestations\/causal-regression\/v1"/);
  assert.match(verifier, /const VERIFICATION_PREDICATE_TYPE = "https:\/\/github\.com\/cinamoncandy\/NUSA\/attestations\/causal-regression-verification\/v1"/);
});
