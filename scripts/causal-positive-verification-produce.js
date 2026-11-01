const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPOSITORY = "cinamoncandy/NUSA";
const WORKFLOW = ".github/workflows/ci.yml";
const PREDICATE = "https://github.com/cinamoncandy/NUSA/attestations/causal-regression-verification/v1";
const DOMAIN = "NUSA_CAUSAL_VERIFICATION_ONLY_V1";
const FIXTURE = "repairable-workflow-known-mismatch-v1";
const CONTRACT = "apps/autopilot/src/causalRegressionContract.ts";
const IMPLEMENTATION = "apps/autopilot/src/repairableWorkflowRun.ts";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function produceVerificationManifest(environment = process.env, actualHead = undefined) {
  const head = actualHead || environment.GITHUB_SHA;
  if (environment.GITHUB_REPOSITORY !== REPOSITORY || environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@refs/heads/main`
    || environment.GITHUB_WORKFLOW_SHA !== head || !/^[a-f0-9]{40}$/.test(head || "")
    || environment.GITHUB_SHA !== head || !/^[1-9][0-9]{0,19}$/.test(environment.GITHUB_RUN_ID || "")
    || !/^[1-9][0-9]{0,9}$/.test(environment.GITHUB_RUN_ATTEMPT || "")
    || environment.GITHUB_JOB !== "causal-positive-verification") {
    throw new Error("CAUSAL_VERIFICATION_PRODUCER_IDENTITY_INVALID");
  }

  const { observeRepairableWorkflowContract } = require("../dist/apps/autopilot/src/causalRegressionContract.js");
  // This deliberately faulty predicate is confined to the verification harness.
  // It exercises a known mismatch without modifying checked-out repository code.
  const isolatedFault = (run) => run.conclusion === "failure" ? false : run.conclusion === "timed_out";
  const observation = observeRepairableWorkflowContract(isolatedFault);
  if (observation.status !== "OBSERVED_MISMATCH" || observation.caseId !== "main-ci-failure") {
    throw new Error("CAUSAL_VERIFICATION_FIXTURE_NOT_REPRODUCED");
  }

  const predicate = {
    schemaVersion: 1,
    domain: DOMAIN,
    fixtureId: FIXTURE,
    result: "OBSERVED_MISMATCH",
    producer: {
      repository: REPOSITORY,
      workflowPath: WORKFLOW,
      workflowRef: environment.GITHUB_WORKFLOW_REF,
      workflowSha: head,
      ref: environment.GITHUB_REF,
      event: environment.GITHUB_EVENT_NAME,
      job: environment.GITHUB_JOB,
      sha: head,
      runId: environment.GITHUB_RUN_ID,
      runAttempt: environment.GITHUB_RUN_ATTEMPT,
    },
    observation,
    failureFingerprint: sha256Text(JSON.stringify(observation)),
    contractFingerprint: sha256(CONTRACT),
    implementationFingerprint: sha256(IMPLEMENTATION),
  };
  return { predicateType: PREDICATE, predicate };
}

function writeIsolatedManifest(environment = process.env, outputDirectory = path.join(
  environment.RUNNER_TEMP || os.tmpdir(),
  `nusa-causal-verification-${environment.GITHUB_RUN_ID || "local"}-${environment.GITHUB_RUN_ATTEMPT || "1"}`,
)) {
  const manifest = produceVerificationManifest(environment);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const output = path.join(outputDirectory, "verification.json");
  fs.writeFileSync(output, `${JSON.stringify(manifest.predicate)}\n`, { mode: 0o600, flag: "wx" });
  if (environment.GITHUB_OUTPUT) fs.appendFileSync(environment.GITHUB_OUTPUT, "verification_status=OBSERVED_MISMATCH\n");
  return { output, ...manifest };
}

if (require.main === module) {
  try {
    const result = writeIsolatedManifest(process.env);
    console.log(`ISOLATED_VERIFICATION_MANIFEST=${result.output}`);
    console.log(`ISOLATED_VERIFICATION_DOMAIN=${result.predicate.domain}`);
    console.log(`ISOLATED_VERIFICATION_RESULT=${result.predicate.result}`);
  } catch {
    console.error("ISOLATED_CAUSAL_VERIFICATION_INSUFFICIENT_EVIDENCE");
    process.exitCode = 2;
  }
}

module.exports = { produceVerificationManifest, writeIsolatedManifest, PREDICATE, DOMAIN, FIXTURE };
