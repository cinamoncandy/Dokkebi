const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const CONTRACT_ID = "REPAIRABLE_WORKFLOW_POLICY_V1";
const WORKFLOW = ".github/workflows/ci.yml";
const PRODUCER = "scripts/causal-regression-observe.js";
const CONTRACT = "apps/autopilot/src/causalRegressionContract.ts";
const IMPLEMENTATION = "apps/autopilot/src/repairableWorkflowRun.ts";
const LOCK = "pnpm-lock.yaml";
const OUTPUT = "artifacts/causal-regression/receipt.json";

function sha256(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function sourceIdentity(environment, observedHead) {
  const repository = environment.GITHUB_REPOSITORY;
  const sha = environment.GITHUB_SHA;
  const runId = environment.GITHUB_RUN_ID;
  const runAttempt = environment.GITHUB_RUN_ATTEMPT;
  const workflowRef = environment.GITHUB_WORKFLOW_REF;
  const workflowSha = environment.GITHUB_WORKFLOW_SHA;
  const job = environment.GITHUB_JOB;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha) || sha !== observedHead
    || typeof runId !== "string" || !/^[1-9][0-9]{0,19}$/.test(runId)
    || typeof runAttempt !== "string" || !/^[1-9][0-9]{0,9}$/.test(runAttempt)
    || environment.GITHUB_EVENT_NAME !== "push" || environment.GITHUB_REF !== "refs/heads/main"
    || workflowRef !== `${repository}/${WORKFLOW}@refs/heads/main` || workflowSha !== sha
    || job !== "causal-regression-contract") {
    throw new Error("CAUSAL_PRODUCER_SOURCE_IDENTITY_INVALID");
  }
  return { repository, workflowPath: WORKFLOW, workflowRef, workflowSha, ref: environment.GITHUB_REF,
    event: environment.GITHUB_EVENT_NAME, job, sha, runId, runAttempt };
}

function produceReceipt(environment, observedHead, candidate) {
  const source = sourceIdentity(environment, observedHead);
  const { observeRepairableWorkflowContract } = require("../dist/apps/autopilot/src/causalRegressionContract.js");
  const observation = observeRepairableWorkflowContract(candidate);
  return {
    schemaVersion: 1,
    contractId: CONTRACT_ID,
    source,
    fingerprints: { workflow: sha256(WORKFLOW), producer: sha256(PRODUCER), contract: sha256(CONTRACT), lockfile: sha256(LOCK), implementation: sha256(IMPLEMENTATION) },
    observation,
  };
}

if (require.main === module) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
    const { isRepairableMainWorkflowFailure } = require("../dist/apps/autopilot/src/repairableWorkflowRun.js");
    const receipt = produceReceipt(process.env, head, isRepairableMainWorkflowFailure);
    fs.mkdirSync("artifacts/causal-regression", { recursive: true, mode: 0o700 });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    if (typeof process.env.GITHUB_OUTPUT === "string" && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `observation_status=${receipt.observation.status}\n`);
    }
    if (receipt.observation.status === "OBSERVED_MISMATCH") process.exitCode = 1;
    if (receipt.observation.status === "INSUFFICIENT_EVIDENCE") process.exitCode = 2;
  } catch {
    console.error("CAUSAL_PRODUCER_INSUFFICIENT_EVIDENCE");
    process.exitCode = 2;
  }
}

module.exports = { produceReceipt, sourceIdentity };
