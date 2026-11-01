const fs = require("node:fs");
const { verifyIsolatedCausalVerificationAttestation } = require("../dist/apps/autopilot/src/sigstoreCausalAttestation.js");

async function verifyProducerExecution(environment, fetchImpl = fetch) {
  const repository = environment.GITHUB_REPOSITORY;
  const runId = environment.GITHUB_RUN_ID;
  const attempt = environment.GITHUB_RUN_ATTEMPT;
  const token = environment.GITHUB_TOKEN;
  if (repository !== "cinamoncandy/NUSA" || !/^[1-9][0-9]{0,19}$/.test(runId || "")
    || !/^[1-9][0-9]{0,9}$/.test(attempt || "") || typeof token !== "string" || !token) {
    throw new Error("ISOLATED_CAUSAL_VERIFICATION_GITHUB_IDENTITY_REQUIRED");
  }
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
  const base = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  const request = async (url) => {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error("ISOLATED_CAUSAL_VERIFICATION_GITHUB_LOOKUP_FAILED");
    return response.json();
  };
  const [run, jobs, artifacts] = await Promise.all([
    request(`${base}/attempts/${attempt}`),
    request(`${base}/attempts/${attempt}/jobs?per_page=100`),
    request(`${base}/artifacts?per_page=100`),
  ]);
  if (run.id !== Number(runId) || Number(run.run_attempt) !== Number(attempt)
    || run.path !== ".github/workflows/ci.yml" || run.event !== "workflow_dispatch"
    || run.head_branch !== "main" || run.head_sha !== environment.GITHUB_SHA
    || run.status !== "in_progress" || run.conclusion != null) {
    throw new Error("ISOLATED_CAUSAL_VERIFICATION_RUN_MISMATCH");
  }
  const exactJobs = (jobs.jobs || []).filter((job) => job.run_id === Number(runId) && Number(job.run_attempt) === Number(attempt)
    && job.head_sha === environment.GITHUB_SHA);
  for (const name of ["causal-positive-verification", "attest-causal-positive-verification"]) {
    const matches = exactJobs.filter((job) => job.name === name && job.status === "completed" && job.conclusion === "success");
    if (matches.length !== 1) throw new Error("ISOLATED_CAUSAL_VERIFICATION_JOB_MISMATCH");
  }
  const artifactName = `nusa-causal-verification-attestation-${attempt}`;
  const matches = (artifacts.artifacts || []).filter((artifact) => artifact.name === artifactName && artifact.expired === false
    && artifact.workflow_run?.id === Number(runId) && artifact.workflow_run?.head_sha === environment.GITHUB_SHA);
  if (matches.length !== 1 || (matches[0].digest != null && !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest))) {
    throw new Error("ISOLATED_CAUSAL_VERIFICATION_ARTIFACT_MISMATCH");
  }
  return Object.freeze({ runId, attempt, artifactId: matches[0].id, artifactDigest: matches[0].digest || null });
}

async function verifyBundleFile(file, environment = process.env, fetchImpl = fetch) {
  const execution = await verifyProducerExecution(environment, fetchImpl);
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  const verified = await verifyIsolatedCausalVerificationAttestation(bundle, {
    repository: environment.GITHUB_REPOSITORY,
    sha: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  });
  if (verified.domain !== "NUSA_CAUSAL_VERIFICATION_ONLY_V1"
    || verified.fixtureId !== "repairable-workflow-known-mismatch-v1"
    || verified.producer.repository !== environment.GITHUB_REPOSITORY
    || verified.producer.sha !== environment.GITHUB_SHA
    || verified.producer.runId !== environment.GITHUB_RUN_ID
    || verified.producer.runAttempt !== environment.GITHUB_RUN_ATTEMPT) {
    throw new Error("ISOLATED_CAUSAL_VERIFICATION_IDENTITY_MISMATCH");
  }
  return Object.freeze({ ...verified, execution });
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("ISOLATED_CAUSAL_VERIFICATION_BUNDLE_REQUIRED");
    process.exitCode = 2;
  } else {
    verifyBundleFile(file).then((verified) => {
      console.log(`ISOLATED_ATTESTATION_VERIFY=PASS`);
      console.log(`DOMAIN=${verified.domain}`);
      console.log(`FIXTURE=${verified.fixtureId}`);
      console.log(`STATEMENT_DIGEST=${verified.statementDigest}`);
      console.log("CODE_ACTIONABLE=NOT_ISSUED");
    }).catch(() => {
      console.error("ISOLATED_ATTESTATION_VERIFY=REJECT");
      process.exitCode = 1;
    });
  }
}

module.exports = { verifyBundleFile, verifyProducerExecution };
