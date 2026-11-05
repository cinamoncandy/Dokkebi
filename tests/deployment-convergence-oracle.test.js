"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  evaluateOracleEvidence,
  parseHostObservation,
  parseReleaseObservation,
  selectLatestRun,
} = require("../scripts/deployment-convergence-oracle");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RELEASE_UPDATED = "2026-11-05T04:35:56Z";
const HOST_STARTED = "2026-11-05T04:39:31Z";
const HOST_OBSERVED = "2026-11-05T04:39:33Z";
const HOST_COMPLETED = "2026-11-05T04:39:43Z";

function fixture(overrides = {}) {
  const releaseRun = {
    id: 123,
    run_attempt: 1,
    name: "Oracle PAPER Release",
    path: ".github/workflows/oracle-paper-release.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    updated_at: RELEASE_UPDATED,
  };
  const hostRun = {
    id: 456,
    run_attempt: 1,
    name: "Oracle Host Diagnose",
    path: ".github/workflows/oracle-host-diagnose.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    run_started_at: HOST_STARTED,
  };
  const commonJob = (id, run, name) => ({
    id,
    name,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: run.head_sha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  });
  const runner = {
    labels: ["self-hosted", "Linux", "nusa-paper-host"],
    runner_id: 24,
    runner_name: "nusa-paper-host-datascale",
    runner_group_id: 1,
    runner_group_name: "Default",
  };
  const releaseJobs = [
    { ...commonJob(10, releaseRun, "Build exact-main Cloud PAPER release"), started_at: "2026-11-05T04:13:21Z", completed_at: "2026-11-05T04:14:07Z" },
    { ...commonJob(11, releaseRun, "Back up exact-main Cloud PAPER state") },
    { ...commonJob(12, releaseRun, "Release exact-main Cloud PAPER runtime"), ...runner },
  ];
  const hostJob = {
    ...commonJob(20, hostRun, "Read-only PAPER host diagnosis"),
    ...runner,
    started_at: HOST_STARTED,
    completed_at: HOST_COMPLETED,
  };
  const artifacts = [{
    id: 789,
    name: "nusa-paper-release",
    digest: `sha256:${"c".repeat(64)}`,
    created_at: "2026-11-05T04:14:04Z",
    expired: false,
    workflow_run: { id: releaseRun.id, head_sha: SHA },
  }];
  const releaseLog = `2026-11-05T04:35:50.3824023Z currentRelease=/opt/nusa/releases/${SHA}\n2026-11-05T04:35:50.3839321Z deploymentResult=DEPLOYED`;
  const hostLog = [
    `2026-11-05T04:39:33.6854029Z == time`,
    `2026-11-05T04:39:33.6854029Z ${HOST_OBSERVED}`,
    `2026-11-05T04:39:33.6873436Z /opt/nusa/releases/${SHA}`,
    `current_release=${SHA}`,
  ].join("\n");

  return {
    expectedSha: SHA,
    workflowSha: SHA,
    mainBefore: SHA,
    mainAfter: SHA,
    releaseRun,
    releaseJobs,
    artifacts,
    releaseLog,
    hostRun,
    hostJobs: [hostJob],
    hostLog,
    ...overrides,
  };
}

test("Oracle convergence passes only with current successful release and post-release host read-back", () => {
  const result = evaluateOracleEvidence(fixture());
  assert.equal(result.oracle_convergence_status, "CONVERGED");
  assert.equal(result.oracle_convergence_reason, "EXACT_MAIN_RELEASE_AND_POST_RELEASE_HOST_READBACK");
  assert.equal(result.oracle_release_run_id, 123);
  assert.equal(result.oracle_release_run_attempt, 1);
  assert.equal(result.oracle_release_head_sha, SHA);
  assert.equal(result.oracle_release_conclusion, "success");
  assert.equal(result.oracle_release_artifact_id, 789);
  assert.match(result.oracle_release_artifact_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.oracle_host_observed_sha, SHA);
  assert.equal(result.oracle_host_observed_at, HOST_OBSERVED);
  assert.equal(result.oracle_host_diagnose_run_id, 456);
  assert.equal(result.oracle_host_diagnose_attempt, 1);
  assert.deepEqual(result.oracle_host_identity, {
    runner_id: 24,
    runner_name: "nusa-paper-host-datascale",
    runner_group_id: 1,
    runner_group_name: "Default",
  });
});

test("missing, queued, in-progress, or failed Release remains incomplete", () => {
  assert.equal(evaluateOracleEvidence(fixture({ releaseRun: null })).oracle_convergence_reason, "EXACT_MAIN_RELEASE_RUN_MISSING");
  for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "failure"], ["completed", "cancelled"]]) {
    const result = evaluateOracleEvidence(fixture({ releaseRun: { ...fixture().releaseRun, status, conclusion } }));
    assert.equal(result.oracle_convergence_status, "INCOMPLETE");
    assert.equal(result.oracle_convergence_reason, "RELEASE_NOT_COMPLETED_SUCCESSFULLY");
  }
});

test("stale or missing host observation cannot be replaced by the Release input SHA", () => {
  const missing = evaluateOracleEvidence(fixture({ hostLog: "diagnose succeeded but current path was not emitted" }));
  assert.equal(missing.oracle_convergence_status, "INCOMPLETE");
  assert.equal(missing.oracle_host_observed_sha, null);
  assert.equal(missing.oracle_convergence_reason, "HOST_SHA_UNOBSERVED_OR_INCONSISTENT");

  const mismatch = fixture({
    hostLog: `2026-11-05T04:39:33.6854029Z == time\n2026-11-05T04:39:33.6854029Z ${HOST_OBSERVED}\n2026-11-05T04:39:33.6873436Z /opt/nusa/releases/${OTHER_SHA}\ncurrent_release=${OTHER_SHA}`,
  });
  const result = evaluateOracleEvidence(mismatch);
  assert.equal(result.oracle_host_observed_sha, OTHER_SHA);
  assert.equal(result.oracle_convergence_reason, "HOST_SHA_MISMATCH");
});

test("pre-release diagnose, wrong host, wrong attempt, wrong artifact, and main movement fail closed", () => {
  const preRelease = fixture({ hostRun: { ...fixture().hostRun, run_started_at: "2026-11-05T04:35:00Z" } });
  assert.equal(evaluateOracleEvidence(preRelease).oracle_convergence_reason, "HOST_DIAGNOSE_NOT_AFTER_RELEASE");

  const wrongHost = fixture({ hostJobs: [{ ...fixture().hostJobs[0], runner_id: 25 }] });
  assert.equal(evaluateOracleEvidence(wrongHost).oracle_convergence_reason, "HOST_IDENTITY_MISMATCH");

  const wrongAttempt = fixture({ hostJobs: [{ ...fixture().hostJobs[0], run_attempt: 2 }] });
  assert.equal(evaluateOracleEvidence(wrongAttempt).oracle_convergence_reason, "HOST_DIAGNOSE_JOB_UNVERIFIED");

  const wrongArtifact = fixture({ artifacts: [{ ...fixture().artifacts[0], workflow_run: { id: 999, head_sha: SHA } }] });
  assert.equal(evaluateOracleEvidence(wrongArtifact).oracle_convergence_reason, "RELEASE_ARTIFACT_UNVERIFIED");

  const movedMain = fixture({ mainAfter: OTHER_SHA });
  assert.equal(evaluateOracleEvidence(movedMain).oracle_convergence_reason, "PROTECTED_MAIN_NOT_STABLE");
});

test("run selection binds exact workflow path, main SHA, and post-release attempt", () => {
  const stale = { id: 1, name: "Oracle PAPER Release", path: ".github/workflows/old.yml", head_branch: "main", head_sha: SHA, created_at: "2026-11-05T04:10:00Z" };
  const current = { id: 2, name: "Oracle PAPER Release", path: ".github/workflows/oracle-paper-release.yml", head_branch: "main", head_sha: SHA, created_at: "2026-11-05T04:11:00Z" };
  assert.equal(selectLatestRun([stale, current], { name: "Oracle PAPER Release", workflowPath: ".github/workflows/oracle-paper-release.yml", expectedSha: SHA }).id, 2);
  assert.equal(selectLatestRun([current], { name: "Oracle PAPER Release", workflowPath: ".github/workflows/oracle-paper-release.yml", expectedSha: OTHER_SHA }), null);
  assert.equal(selectLatestRun([current], { name: "Oracle PAPER Release", workflowPath: ".github/workflows/oracle-paper-release.yml", expectedSha: SHA, after: "2026-11-05T04:12:00Z" }), null);
});

test("receipt workflow source itself must be the same protected-main SHA", () => {
  const result = evaluateOracleEvidence(fixture({ workflowSha: OTHER_SHA }));
  assert.equal(result.oracle_convergence_status, "INCOMPLETE");
  assert.equal(result.oracle_convergence_reason, "RECEIPT_WORKFLOW_SHA_MISMATCH");
});

test("log parsers require the host read-link path and preserve the host observation timestamp", () => {
  const host = parseHostObservation(fixture().hostLog);
  assert.equal(host.observedSha, SHA);
  assert.equal(host.pathSha, SHA);
  assert.equal(host.observedAt, HOST_OBSERVED);
  assert.equal(parseReleaseObservation(fixture().releaseLog, SHA).matchesExpected, true);
  assert.equal(parseReleaseObservation(fixture().releaseLog, OTHER_SHA).matchesExpected, false);
});

test("watchdog gates receipt dispatch on exact-main Release and later read-only Diagnose without dispatching Release", () => {
  const watchdog = read(".github/workflows/deployment-convergence-watchdog.yml");
  assert.match(watchdog, /\.github\/workflows\/oracle-paper-release\.yml/);
  assert.match(watchdog, /oracle_release_success/);
  assert.match(watchdog, /oracle_host_diagnose_success/);
  assert.match(watchdog, /Host Diagnose remains read-only and manual/);
  assert.doesNotMatch(watchdog, /actions\/workflows\/oracle-paper-release\.yml\/dispatches/);
  const releaseGate = watchdog.indexOf("if ! oracle_release_success; then", watchdog.indexOf("# A single machine-readable convergence receipt"));
  const receiptDispatch = watchdog.indexOf('"Deployment Receipt"', releaseGate);
  assert.ok(releaseGate >= 0 && receiptDispatch > releaseGate);
});

test("receipt consumes server-read Release and Host Diagnose evidence, not a client-asserted host SHA", () => {
  const receipt = read(".github/workflows/deployment-convergence-receipt.yml");
  assert.match(receipt, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(receipt, /WORKFLOW_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(receipt, /FINAL_MAIN=.*branches\/main/);
  assert.match(receipt, /\[ "\$CURRENT_MAIN" = "\$EXPECTED_SHA" \] && \[ "\$FINAL_MAIN" = "\$EXPECTED_SHA" \]/);
  assert.match(receipt, /node scripts\/deployment-convergence-oracle\.js/);
  assert.doesNotMatch(receipt, /oracle_observed_sha:/);
  for (const field of [
    "expected_main_sha",
    "oracle_convergence_status",
    "oracle_release_run_id",
    "oracle_release_run_attempt",
    "oracle_release_head_sha",
    "oracle_release_conclusion",
    "oracle_host_observed_sha",
    "oracle_host_observed_at",
    "oracle_host_diagnose_run_id",
    "oracle_host_diagnose_attempt",
    "oracle_host_identity",
  ]) assert.match(receipt, new RegExp(field));
  assert.match(receipt, /RELEASE_STATUS=RELEASE_PROVENANCE_UNKNOWN/);
  assert.doesNotMatch(receipt, /RELEASE_STATUS=RELEASE_COMPLETE/);
});
