"use strict";

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API_VERSION = "2022-11-28";
const RELEASE_NAME = "Oracle PAPER Release";
const RELEASE_PATH = ".github/workflows/oracle-paper-release.yml";
const DIAGNOSE_NAME = "Oracle Host Diagnose";
const DIAGNOSE_PATH = ".github/workflows/oracle-host-diagnose.yml";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 160 * 1024 * 1024;

function normalizePath(value) {
  return typeof value === "string" ? value.replace(/^\//, "") : "";
}

function validSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value.toLowerCase());
}

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function newestFirst(a, b) {
  return (timestamp(b.run_started_at || b.created_at) || 0) -
    (timestamp(a.run_started_at || a.created_at) || 0) ||
    (Number(b.run_attempt) || 0) - (Number(a.run_attempt) || 0) ||
    (Number(b.id) || 0) - (Number(a.id) || 0);
}

function selectLatestRun(runs, { name, workflowPath, expectedSha, after }) {
  const afterMs = after == null ? null : timestamp(after);
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.name === name && normalizePath(run.path) === workflowPath &&
      typeof run.head_sha === "string" && run.head_sha.toLowerCase() === expectedSha.toLowerCase() &&
      run.head_branch === "main" && (afterMs == null || (timestamp(run.run_started_at || run.created_at) || 0) > afterMs))
    .sort(newestFirst)[0] || null;
}

function stripLogPrefix(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "").trim();
}

function cleanLog(raw) {
  return String(raw || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseReleaseObservation(raw, expectedSha) {
  const text = cleanLog(raw);
  const expectedPath = `/opt/nusa/releases/${expectedSha.toLowerCase()}`;
  const currentRelease = [...text.matchAll(/currentRelease=(\/opt\/nusa\/releases\/[0-9a-f]{40})(?=\s|$)/g)]
    .map((match) => match[1].toLowerCase()).at(-1) || null;
  const deployed = /(?:^|\s)deploymentResult=DEPLOYED(?:\s|$)/m.test(text);
  return {
    deployed,
    observedPath: currentRelease,
    matchesExpected: deployed && currentRelease === expectedPath,
  };
}

function parseHostObservation(raw) {
  const lines = cleanLog(raw).split(/\r?\n/);
  let diagnosticAt = null;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (stripLogPrefix(lines[index]) !== "== time") continue;
    const next = lines[index + 1].match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*$/);
    if (next) diagnosticAt = next[1];
    break;
  }

  let healthObservedAt = null;
  let runtimeSourceSha = null;
  for (const line of lines) {
    const jsonStart = line.indexOf('{"ok":');
    if (jsonStart < 0) continue;
    try {
      const health = JSON.parse(line.slice(jsonStart));
      const sourceSha = health?.runtime?.sourceCommitSha;
      if (health?.ok === true && validSha(sourceSha) && timestamp(health.observedAt) !== null) {
        healthObservedAt = health.observedAt;
        runtimeSourceSha = sourceSha.toLowerCase();
      }
    } catch {
      // An incomplete or malformed health line is not runtime SHA evidence.
    }
  }

  const currentRelease = [...cleanLog(raw).matchAll(/(?:^|\n)current_release=([0-9a-f]{40})(?:\n|$)/g)]
    .map((match) => match[1].toLowerCase()).at(-1) || null;
  const resolvedPaths = lines.map(stripLogPrefix).filter((line) => /^\/opt\/nusa\/releases\/[0-9a-f]{40}$/.test(line));
  const resolvedPath = resolvedPaths.at(-1) || null;
  const pathSha = resolvedPath ? resolvedPath.slice("/opt/nusa/releases/".length) : null;
  return {
    observedAt: healthObservedAt,
    diagnosticAt,
    observedSha: currentRelease,
    runtimeSourceSha,
    resolvedPath,
    pathSha,
  };
}

function jobMatchesRun(job, run) {
  return Boolean(job && run && Number.isInteger(Number(job.id)) &&
    Number(job.run_id) === Number(run.id) && Number(job.run_attempt) === Number(run.run_attempt) &&
    typeof job.head_sha === "string" && job.head_sha.toLowerCase() === run.head_sha.toLowerCase() &&
    job.head_branch === "main" && job.status === "completed" && job.conclusion === "success");
}

function hasHostLabels(job) {
  const labels = Array.isArray(job?.labels) ? job.labels.map((label) => String(label).toLowerCase()) : [];
  return labels.includes("self-hosted") && labels.includes("linux") && labels.includes("nusa-paper-host");
}

function nonemptyIdentity(job) {
  return Number.isInteger(Number(job?.runner_id)) && Number(job.runner_id) > 0 &&
    typeof job.runner_name === "string" && job.runner_name.trim().length > 0;
}

function artifactForRelease(artifacts, run, buildJob) {
  if (!Array.isArray(artifacts) || !run || !buildJob) return null;
  const buildStarted = timestamp(buildJob.started_at);
  const buildCompleted = timestamp(buildJob.completed_at);
  return artifacts
    .filter((artifact) => artifact?.name === "nusa-paper-release" &&
      Number(artifact.workflow_run?.id) === Number(run.id) &&
      typeof artifact.workflow_run?.head_sha === "string" && artifact.workflow_run.head_sha.toLowerCase() === run.head_sha.toLowerCase() &&
      ARTIFACT_DIGEST_PATTERN.test(String(artifact.digest || "")) &&
      Number.isInteger(Number(artifact.id)) && buildStarted !== null && buildCompleted !== null &&
      artifact.expired === false && Number.isSafeInteger(Number(artifact.size_in_bytes)) &&
      Number(artifact.size_in_bytes) > 0 && Number(artifact.size_in_bytes) <= MAX_ARTIFACT_BYTES &&
      timestamp(artifact.created_at) !== null && timestamp(artifact.created_at) >= buildStarted && timestamp(artifact.created_at) <= buildCompleted)
    .sort((a, b) => (timestamp(b.created_at) || 0) - (timestamp(a.created_at) || 0))[0] || null;
}

function artifactDigestMatches(artifact, downloadedDigest) {
  return Boolean(artifact && artifact.expired === false &&
    ARTIFACT_DIGEST_PATTERN.test(String(artifact.digest || "")) &&
    artifact.digest === downloadedDigest);
}

function evaluateOracleEvidence(input) {
  const expectedSha = typeof input?.expectedSha === "string" ? input.expectedSha.toLowerCase() : "";
  const releaseRun = input?.releaseRun || null;
  const hostRun = input?.hostRun || null;
  const releaseJob = input?.releaseJobs?.find((job) => job?.name === "Release exact-main Cloud PAPER runtime") || null;
  const backupJob = input?.releaseJobs?.find((job) => job?.name === "Back up exact-main Cloud PAPER state") || null;
  const buildJob = input?.releaseJobs?.find((job) => job?.name === "Build exact-main Cloud PAPER release") || null;
  const hostJob = input?.hostJobs?.find((job) => job?.name === "Read-only PAPER host diagnosis") || null;
  const releaseObservation = parseReleaseObservation(input?.releaseLog, expectedSha);
  const hostObservation = parseHostObservation(input?.hostLog);
  const artifact = artifactForRelease(input?.artifacts, releaseRun, buildJob);

  const result = {
    oracle_convergence_status: "INCOMPLETE",
    oracle_convergence_reason: "UNKNOWN",
    oracle_release_run_id: Number.isInteger(Number(releaseRun?.id)) ? Number(releaseRun.id) : null,
    oracle_release_run_attempt: Number.isInteger(Number(releaseRun?.run_attempt)) ? Number(releaseRun.run_attempt) : null,
    oracle_release_head_sha: validSha(releaseRun?.head_sha) ? releaseRun.head_sha.toLowerCase() : null,
    oracle_release_conclusion: typeof releaseRun?.conclusion === "string" ? releaseRun.conclusion : "UNKNOWN",
    oracle_release_artifact_id: artifact ? Number(artifact.id) : null,
    oracle_release_artifact_name: artifact?.name || null,
    oracle_release_artifact_digest: artifact?.digest || null,
    oracle_release_artifact_expired: typeof artifact?.expired === "boolean" ? artifact.expired : null,
    oracle_release_artifact_digest_verified: input?.artifactDigestVerified === true,
    oracle_release_job_id: Number.isInteger(Number(releaseJob?.id)) ? Number(releaseJob.id) : null,
    oracle_release_log_sha256: typeof input?.releaseLogSha256 === "string" && ARTIFACT_DIGEST_PATTERN.test(input.releaseLogSha256) ? input.releaseLogSha256 : null,
    oracle_host_observed_sha: hostObservation.observedSha,
    oracle_host_observed_at: hostObservation.observedAt,
    oracle_host_runtime_source_sha: hostObservation.runtimeSourceSha,
    oracle_host_diagnose_observed_at: hostObservation.diagnosticAt,
    oracle_host_diagnose_run_id: Number.isInteger(Number(hostRun?.id)) ? Number(hostRun.id) : null,
    oracle_host_diagnose_attempt: Number.isInteger(Number(hostRun?.run_attempt)) ? Number(hostRun.run_attempt) : null,
    oracle_host_diagnose_job_id: Number.isInteger(Number(hostJob?.id)) ? Number(hostJob.id) : null,
    oracle_host_diagnose_log_sha256: typeof input?.hostLogSha256 === "string" && ARTIFACT_DIGEST_PATTERN.test(input.hostLogSha256) ? input.hostLogSha256 : null,
    oracle_host_identity: nonemptyIdentity(hostJob) ? {
      runner_id: Number(hostJob.runner_id),
      runner_name: hostJob.runner_name,
      runner_group_id: Number.isInteger(Number(hostJob.runner_group_id)) ? Number(hostJob.runner_group_id) : null,
      runner_group_name: typeof hostJob.runner_group_name === "string" ? hostJob.runner_group_name : null,
    } : null,
  };

  const finish = (reason) => ({ ...result, oracle_convergence_reason: reason });
  if (!validSha(expectedSha)) return finish("EXPECTED_SHA_INVALID");
  if (typeof input?.workflowSha !== "string" || input.workflowSha.toLowerCase() !== expectedSha) {
    return finish("RECEIPT_WORKFLOW_SHA_MISMATCH");
  }
  if (input?.mainBefore !== expectedSha || input?.mainAfter !== expectedSha) return finish("PROTECTED_MAIN_NOT_STABLE");
  if (!releaseRun) return finish("EXACT_MAIN_RELEASE_RUN_MISSING");
  if (releaseRun.name !== RELEASE_NAME || normalizePath(releaseRun.path) !== RELEASE_PATH ||
      releaseRun.head_branch !== "main" || releaseRun.head_sha?.toLowerCase() !== expectedSha || releaseRun.event !== "workflow_dispatch") {
    return finish("RELEASE_IDENTITY_MISMATCH");
  }
  if (!Number.isInteger(Number(releaseRun.run_attempt)) || Number(releaseRun.run_attempt) < 1 ||
      releaseRun.status !== "completed" || releaseRun.conclusion !== "success") {
    return finish("RELEASE_NOT_COMPLETED_SUCCESSFULLY");
  }
  if (!jobMatchesRun(releaseJob, releaseRun) || !hasHostLabels(releaseJob) || !nonemptyIdentity(releaseJob)) {
    return finish("RELEASE_HOST_JOB_UNVERIFIED");
  }
  if (!jobMatchesRun(backupJob, releaseRun)) return finish("RELEASE_BACKUP_JOB_UNVERIFIED");
  if (!jobMatchesRun(buildJob, releaseRun)) return finish("RELEASE_BUILD_JOB_UNVERIFIED");
  if (!artifact) return finish("RELEASE_ARTIFACT_UNVERIFIED");
  if (!artifactDigestMatches(artifact, input?.downloadedArtifactDigest) || input?.artifactDigestVerified !== true) {
    return finish("RELEASE_ARTIFACT_DIGEST_UNVERIFIED");
  }
  if (!ARTIFACT_DIGEST_PATTERN.test(String(input?.releaseLogSha256 || ""))) return finish("RELEASE_LOG_PROVENANCE_UNVERIFIED");
  if (!releaseObservation.matchesExpected) return finish("RELEASE_HOST_READBACK_MISMATCH");
  if (!hostRun) return finish("POST_RELEASE_HOST_DIAGNOSE_MISSING");
  if (hostRun.name !== DIAGNOSE_NAME || normalizePath(hostRun.path) !== DIAGNOSE_PATH ||
      hostRun.head_branch !== "main" || hostRun.head_sha?.toLowerCase() !== expectedSha ||
      hostRun.event !== "workflow_dispatch") {
    return finish("HOST_DIAGNOSE_IDENTITY_MISMATCH");
  }
  if (!Number.isInteger(Number(hostRun.run_attempt)) || Number(hostRun.run_attempt) < 1 ||
      hostRun.status !== "completed" || hostRun.conclusion !== "success") {
    return finish("HOST_DIAGNOSE_NOT_SUCCESSFUL");
  }
  const releaseCompleted = timestamp(releaseRun.updated_at);
  const diagnoseStarted = timestamp(hostRun.run_started_at || hostRun.created_at);
  if (releaseCompleted === null || diagnoseStarted === null || diagnoseStarted <= releaseCompleted) {
    return finish("HOST_DIAGNOSE_NOT_AFTER_RELEASE");
  }
  if (!jobMatchesRun(hostJob, hostRun) || !hasHostLabels(hostJob) || !nonemptyIdentity(hostJob)) {
    return finish("HOST_DIAGNOSE_JOB_UNVERIFIED");
  }
  if (!ARTIFACT_DIGEST_PATTERN.test(String(input?.hostLogSha256 || ""))) return finish("HOST_DIAGNOSE_LOG_PROVENANCE_UNVERIFIED");
  if (Number(hostJob.runner_id) !== Number(releaseJob.runner_id) || hostJob.runner_name !== releaseJob.runner_name ||
      Number(hostJob.runner_group_id) !== Number(releaseJob.runner_group_id)) {
    return finish("HOST_IDENTITY_MISMATCH");
  }
  const observedAt = timestamp(hostObservation.observedAt);
  const hostJobStarted = timestamp(hostJob.started_at);
  const hostJobCompleted = timestamp(hostJob.completed_at);
  if (!hostObservation.observedSha || !validSha(hostObservation.observedSha) || !hostObservation.runtimeSourceSha ||
      !validSha(hostObservation.runtimeSourceSha) || !hostObservation.resolvedPath ||
      hostObservation.pathSha !== hostObservation.observedSha) {
    return finish("HOST_SHA_UNOBSERVED_OR_INCONSISTENT");
  }
  if (observedAt === null || hostJobStarted === null || hostJobCompleted === null ||
      observedAt < releaseCompleted || observedAt < hostJobStarted - 300_000 || observedAt > hostJobCompleted + 300_000) {
    return finish("HOST_OBSERVATION_TIME_UNVERIFIED");
  }
  if (hostObservation.observedSha !== expectedSha || hostObservation.pathSha !== expectedSha) {
    return finish("HOST_SHA_MISMATCH");
  }
  if (hostObservation.runtimeSourceSha !== expectedSha) return finish("HOST_RUNTIME_SHA_MISMATCH");

  result.oracle_convergence_status = "CONVERGED";
  result.oracle_convergence_reason = "EXACT_MAIN_RELEASE_AND_POST_RELEASE_HOST_READBACK";
  return result;
}

function parseLinkNext(link) {
  const match = String(link || "").match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] || null;
}

async function apiJson(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!response.ok) throw new Error(`GITHUB_API_${response.status}`);
  return { body: await response.json(), next: parseLinkNext(response.headers.get("link")) };
}

async function listRuns(repo, sha, token, fetchImpl = fetch) {
  const encodedSha = encodeURIComponent(sha);
  let url = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${encodedSha}&per_page=100`;
  const runs = [];
  for (let page = 0; url && page < 10; page += 1) {
    const response = await apiJson(url, token, fetchImpl);
    if (!Array.isArray(response.body.workflow_runs)) throw new Error("GITHUB_RUNS_MALFORMED");
    runs.push(...response.body.workflow_runs);
    url = response.next;
  }
  if (url) throw new Error("GITHUB_RUNS_PAGINATION_LIMIT");
  return runs;
}

async function downloadJobLog(repo, jobId, token, fetchImpl = fetch) {
  const url = `https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`GITHUB_LOG_${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  if (zip.length === 0 || zip.length > MAX_LOG_BYTES) throw new Error("GITHUB_LOG_SIZE_INVALID");
  const sha256 = `sha256:${createHash("sha256").update(zip).digest("hex")}`;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-convergence-log-"));
  const archive = path.join(directory, "job.zip");
  try {
    fs.writeFileSync(archive, zip, { mode: 0o600 });
    const listing = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8", maxBuffer: MAX_LOG_BYTES });
    if (listing.status !== 0) throw new Error("GITHUB_LOG_ARCHIVE_INVALID");
    const names = listing.stdout.split(/\r?\n/).filter((name) => name && !name.startsWith("__MACOSX/"));
    const pieces = [];
    let totalBytes = 0;
    for (const name of names) {
      const output = spawnSync("unzip", ["-p", archive, name], { encoding: "utf8", maxBuffer: MAX_LOG_BYTES });
      if (output.status !== 0 || output.error) throw new Error("GITHUB_LOG_ENTRY_INVALID");
      totalBytes += Buffer.byteLength(output.stdout);
      if (totalBytes > MAX_LOG_BYTES) throw new Error("GITHUB_LOG_SIZE_INVALID");
      pieces.push(output.stdout);
    }
    return { text: pieces.join("\n"), sha256 };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function downloadArtifactDigest(repo, artifact, token, fetchImpl = fetch) {
  if (!artifact || !Number.isInteger(Number(artifact.id)) || artifact.expired !== false ||
      !ARTIFACT_DIGEST_PATTERN.test(String(artifact.digest || ""))) {
    throw new Error("GITHUB_ARTIFACT_IDENTITY_INVALID");
  }
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`GITHUB_ARTIFACT_${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) throw new Error("GITHUB_ARTIFACT_SIZE_INVALID");
  if (!response.body) throw new Error("GITHUB_ARTIFACT_BODY_MISSING");
  const hash = createHash("sha256");
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_ARTIFACT_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error("GITHUB_ARTIFACT_SIZE_INVALID");
    }
    hash.update(chunk);
  }
  if (totalBytes === 0) throw new Error("GITHUB_ARTIFACT_EMPTY");
  return `sha256:${hash.digest("hex")}`;
}

async function runJobs(repo, run, token, fetchImpl = fetch) {
  if (!run || !Number.isInteger(Number(run.id)) || !Number.isInteger(Number(run.run_attempt))) return [];
  const url = `https://api.github.com/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
  const response = await apiJson(url, token, fetchImpl);
  if (!Array.isArray(response.body.jobs)) throw new Error("GITHUB_JOBS_MALFORMED");
  return response.body.jobs;
}

async function runArtifacts(repo, run, token, fetchImpl = fetch) {
  if (!run || !Number.isInteger(Number(run.id))) return [];
  const response = await apiJson(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, token, fetchImpl);
  if (!Array.isArray(response.body.artifacts)) throw new Error("GITHUB_ARTIFACTS_MALFORMED");
  return response.body.artifacts;
}

function firstOrNull(jobs, name) {
  return Array.isArray(jobs) ? jobs.find((job) => job?.name === name) || null : null;
}

async function collectOracleEvidence({ repo, expectedSha, workflowSha, token, fetchImpl = fetch }) {
  let mainBefore = null;
  let mainAfter = null;
  let runs = [];
  let releaseRun = null;
  let releaseJobs = [];
  let artifacts = [];
  let releaseLog = "";
  let releaseLogSha256 = "";
  let downloadedArtifactDigest = "";
  let artifactDigestVerified = false;
  let hostRun = null;
  let hostJobs = [];
  let hostLog = "";
  let hostLogSha256 = "";
  let collectionError = null;

  try {
    const branch = await apiJson(`https://api.github.com/repos/${repo}/branches/main`, token, fetchImpl);
    mainBefore = branch.body?.commit?.sha?.toLowerCase() || null;
    runs = await listRuns(repo, expectedSha, token, fetchImpl);
    releaseRun = selectLatestRun(runs, { name: RELEASE_NAME, workflowPath: RELEASE_PATH, expectedSha });
    if (releaseRun?.status === "completed" && releaseRun?.conclusion === "success") {
      [releaseJobs, artifacts] = await Promise.all([
        runJobs(repo, releaseRun, token, fetchImpl),
        runArtifacts(repo, releaseRun, token, fetchImpl),
      ]);
      const releaseJob = firstOrNull(releaseJobs, "Release exact-main Cloud PAPER runtime");
      if (releaseJob?.id) {
        const evidence = await downloadJobLog(repo, Number(releaseJob.id), token, fetchImpl);
        releaseLog = evidence.text;
        releaseLogSha256 = evidence.sha256;
      }
      const buildJob = firstOrNull(releaseJobs, "Build exact-main Cloud PAPER release");
      const releaseArtifact = artifactForRelease(artifacts, releaseRun, buildJob);
      if (releaseArtifact) {
        downloadedArtifactDigest = await downloadArtifactDigest(repo, releaseArtifact, token, fetchImpl);
        artifactDigestVerified = artifactDigestMatches(releaseArtifact, downloadedArtifactDigest);
      }
      hostRun = selectLatestRun(runs, {
        name: DIAGNOSE_NAME,
        workflowPath: DIAGNOSE_PATH,
        expectedSha,
        after: releaseRun.updated_at,
      });
      if (hostRun?.status === "completed" && hostRun?.conclusion === "success") {
        hostJobs = await runJobs(repo, hostRun, token, fetchImpl);
        const hostJob = firstOrNull(hostJobs, "Read-only PAPER host diagnosis");
        if (hostJob?.id) {
          const evidence = await downloadJobLog(repo, Number(hostJob.id), token, fetchImpl);
          hostLog = evidence.text;
          hostLogSha256 = evidence.sha256;
        }
      }
    }
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.match(/^[A-Z0-9_]+$/)?.[0] : null;
    collectionError = errorCode || "GITHUB_API_UNAVAILABLE";
  } finally {
    try {
      const branch = await apiJson(`https://api.github.com/repos/${repo}/branches/main`, token, fetchImpl);
      mainAfter = branch.body?.commit?.sha?.toLowerCase() || null;
    } catch {
      mainAfter = null;
      collectionError ||= "GITHUB_MAIN_RECHECK_UNAVAILABLE";
    }
  }

  const evaluation = evaluateOracleEvidence({
    expectedSha,
    workflowSha,
    mainBefore,
    mainAfter,
    releaseRun,
    releaseJobs,
    artifacts,
    releaseLog,
    releaseLogSha256,
    downloadedArtifactDigest,
    artifactDigestVerified,
    hostRun,
    hostJobs,
    hostLog,
    hostLogSha256,
  });
  if (collectionError && evaluation.oracle_convergence_status !== "CONVERGED") {
    evaluation.oracle_convergence_reason = "EVIDENCE_COLLECTION_UNAVAILABLE";
    evaluation.oracle_evidence_collection_error = collectionError;
  }
  return evaluation;
}

async function main() {
  const result = await collectOracleEvidence({
    repo: process.env.GITHUB_REPOSITORY || "",
    expectedSha: process.env.EXPECTED_SHA || "",
    workflowSha: process.env.WORKFLOW_SHA || "",
    token: process.env.GH_TOKEN || "",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      oracle_convergence_status: "INCOMPLETE",
      oracle_convergence_reason: "EVIDENCE_COLLECTION_UNAVAILABLE",
      oracle_evidence_collection_error: "UNEXPECTED_COLLECTION_FAILURE",
      oracle_release_run_id: null,
      oracle_release_run_attempt: null,
      oracle_release_head_sha: null,
      oracle_release_conclusion: "UNKNOWN",
      oracle_release_artifact_id: null,
      oracle_release_artifact_name: null,
      oracle_release_artifact_digest: null,
      oracle_release_artifact_expired: null,
      oracle_release_artifact_digest_verified: false,
      oracle_release_job_id: null,
      oracle_release_log_sha256: null,
      oracle_host_observed_sha: null,
      oracle_host_observed_at: null,
      oracle_host_runtime_source_sha: null,
      oracle_host_diagnose_observed_at: null,
      oracle_host_diagnose_run_id: null,
      oracle_host_diagnose_attempt: null,
      oracle_host_diagnose_job_id: null,
      oracle_host_diagnose_log_sha256: null,
      oracle_host_identity: null,
    })}\n`);
  });
}

module.exports = {
  artifactForRelease,
  artifactDigestMatches,
  collectOracleEvidence,
  evaluateOracleEvidence,
  parseHostObservation,
  parseReleaseObservation,
  selectLatestRun,
};
