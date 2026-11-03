const { createHash } = require("node:crypto");

const ACTUAL_PAPER_WORKFLOW_NAME = "Actual PAPER Public-Market Runtime Evidence";
const ACTUAL_PAPER_WORKFLOW_PATH = ".github/workflows/wo-0059-actual-paper-runtime.yml";
const READINESS_WORKFLOW_PATH = ".github/workflows/exact-head-paper-readiness-convergence.yml";
const GITHUB_ACTIONS_BOT = "github-actions[bot]";

function reject(code) {
  throw new Error(`PAPER_READINESS_SOURCE_REJECTED:${code}`);
}

function positiveInteger(value, code) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) reject(code);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) reject(code);
  return number;
}

function validSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function validateSourceRun(run, expected) {
  if (!run || typeof run !== "object" || Array.isArray(run)) reject("RUN_NOT_OBJECT");
  if (!expected || typeof expected !== "object") reject("EXPECTATION_NOT_OBJECT");

  const expectedRunId = positiveInteger(expected.sourceRunId, "EXPECTED_RUN_ID_INVALID");
  const expectedAttempt = positiveInteger(expected.sourceRunAttempt, "EXPECTED_RUN_ATTEMPT_INVALID");
  const targetSha = String(expected.targetSha ?? "").toLowerCase();
  const currentMainSha = String(expected.currentMainSha ?? "").toLowerCase();
  if (!validSha(targetSha) || !validSha(currentMainSha) || targetSha !== currentMainSha) reject("TARGET_NOT_CURRENT_MAIN");
  if (Number(run.id) !== expectedRunId) reject("RUN_ID_MISMATCH");
  if (Number(run.run_attempt) !== expectedAttempt) reject("RUN_ATTEMPT_MISMATCH");
  if (run.name !== ACTUAL_PAPER_WORKFLOW_NAME) reject("WORKFLOW_NAME_MISMATCH");
  if (run.path !== ACTUAL_PAPER_WORKFLOW_PATH) reject("WORKFLOW_PATH_MISMATCH");
  if (String(run.repository?.full_name ?? "").toLowerCase() !== String(expected.repository ?? "").toLowerCase()) reject("REPOSITORY_MISMATCH");
  if (run.head_branch !== "main") reject("BRANCH_MISMATCH");
  if (String(run.head_sha ?? "").toLowerCase() !== targetSha) reject("HEAD_SHA_MISMATCH");
  if (!(["push", "workflow_dispatch"].includes(run.event))) reject("EVENT_MISMATCH");
  if (run.status !== "completed") reject("RUN_NOT_COMPLETED");
  if (run.conclusion !== "success") reject("RUN_NOT_SUCCESSFUL");

  if (expected.requireTokenDispatch === true) {
    if (run.event !== "workflow_dispatch") reject("TOKEN_DISPATCH_EVENT_MISMATCH");
    if (run.actor?.login !== GITHUB_ACTIONS_BOT) reject("TOKEN_DISPATCH_ACTOR_MISMATCH");
    if (run.triggering_actor?.login !== GITHUB_ACTIONS_BOT) reject("TOKEN_DISPATCH_TRIGGERING_ACTOR_MISMATCH");
  }

  const repositoryId = positiveInteger(run.repository?.id, "RUN_REPOSITORY_ID_INVALID");
  return Object.freeze({
    runId: expectedRunId,
    runAttempt: expectedAttempt,
    headSha: targetSha,
    repository: String(expected.repository),
    repositoryId,
  });
}

function validateSourceArtifact(artifact, expected) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) reject("ARTIFACT_NOT_OBJECT");
  const artifactId = positiveInteger(artifact.id, "ARTIFACT_ID_INVALID");
  const sourceRunId = positiveInteger(expected.sourceRunId, "EXPECTED_RUN_ID_INVALID");
  const repositoryId = positiveInteger(expected.repositoryId, "EXPECTED_REPOSITORY_ID_INVALID");
  const targetSha = String(expected.targetSha ?? "").toLowerCase();
  if (!validSha(targetSha)) reject("TARGET_SHA_INVALID");
  if (artifact.expired !== false) reject("ARTIFACT_EXPIRED_OR_UNKNOWN");
  if (artifact.name !== expected.artifactName) reject("ARTIFACT_NAME_MISMATCH");
  if (String(artifact.digest ?? "") === "" || !/^sha256:[a-f0-9]{64}$/i.test(artifact.digest)) reject("ARTIFACT_DIGEST_INVALID");
  if (Number(artifact.workflow_run?.id) !== sourceRunId) reject("ARTIFACT_RUN_ID_MISMATCH");
  if (String(artifact.workflow_run?.head_sha ?? "").toLowerCase() !== targetSha) reject("ARTIFACT_HEAD_SHA_MISMATCH");
  if (Number(artifact.workflow_run?.repository_id) !== repositoryId) reject("ARTIFACT_REPOSITORY_ID_MISMATCH");
  if (Number(artifact.workflow_run?.head_repository_id) !== repositoryId) reject("ARTIFACT_HEAD_REPOSITORY_ID_MISMATCH");
  return Object.freeze({ artifactId, digest: artifact.digest, name: artifact.name });
}

function validateArtifactArchiveDigest(archiveBytes, expectedDigest) {
  if (!(Buffer.isBuffer(archiveBytes) || archiveBytes instanceof Uint8Array)) reject("ARTIFACT_ARCHIVE_BYTES_INVALID");
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(expectedDigest ?? ""))) reject("ARTIFACT_DIGEST_INVALID");
  const actualDigest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
  if (actualDigest.toLowerCase() !== String(expectedDigest).toLowerCase()) reject("ARTIFACT_ARCHIVE_DIGEST_MISMATCH");
  return actualDigest;
}

function readGitHubWorkflowRunIdentity(environment = process.env) {
  const rawRunId = environment.GITHUB_RUN_ID;
  const rawAttempt = environment.GITHUB_RUN_ATTEMPT;
  if ((rawRunId == null || rawRunId === "") && (rawAttempt == null || rawAttempt === "")) return null;
  return Object.freeze({
    id: positiveInteger(rawRunId, "PRODUCER_RUN_ID_INVALID"),
    attempt: positiveInteger(rawAttempt, "PRODUCER_RUN_ATTEMPT_INVALID"),
  });
}

module.exports = {
  ACTUAL_PAPER_WORKFLOW_NAME,
  ACTUAL_PAPER_WORKFLOW_PATH,
  GITHUB_ACTIONS_BOT,
  READINESS_WORKFLOW_PATH,
  readGitHubWorkflowRunIdentity,
  validateArtifactArchiveDigest,
  validateSourceArtifact,
  validateSourceRun,
};
