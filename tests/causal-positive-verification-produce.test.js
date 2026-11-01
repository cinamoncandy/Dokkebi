const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { produceVerificationManifest, writeIsolatedManifest, PREDICATE, DOMAIN, FIXTURE } = require("../scripts/causal-positive-verification-produce.js");
const { verifyProducerExecution } = require("../scripts/causal-positive-verification-verify.js");

const sha = "a".repeat(40);
const env = {
  GITHUB_REPOSITORY: "cinamoncandy/NUSA",
  GITHUB_SHA: sha,
  GITHUB_RUN_ID: "456",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: "cinamoncandy/NUSA/.github/workflows/ci.yml@refs/heads/main",
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_JOB: "causal-positive-verification",
};

test("isolated fault fixture deterministically emits only a verification-domain mismatch", () => {
  const result = produceVerificationManifest(env, sha);
  assert.equal(result.predicateType, PREDICATE);
  assert.equal(result.predicate.domain, DOMAIN);
  assert.equal(result.predicate.fixtureId, FIXTURE);
  assert.equal(result.predicate.result, "OBSERVED_MISMATCH");
  assert.equal(result.predicate.observation.caseId, "main-ci-failure");
  assert.equal(result.predicate.producer.sha, sha);
  assert.equal(result.predicate.producer.runId, "456");
  assert.equal("CODE_ACTIONABLE" in result.predicate, false);
  assert.equal("causalReceipt" in result.predicate, false);
});

test("verification manifest refuses non-main, non-dispatch, wrong-workflow, and identity-mismatched contexts", () => {
  for (const change of [
    { GITHUB_REPOSITORY: "other/NUSA" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_WORKFLOW_REF: "other/NUSA/.github/workflows/ci.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_JOB: "validation" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ATTEMPT: "" },
  ]) assert.throws(() => produceVerificationManifest({ ...env, ...change }, sha), /CAUSAL_VERIFICATION_PRODUCER_IDENTITY_INVALID/);
});

test("manifest is written as a private isolated file and never issues admission authority", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-causal-harness-test-"));
  try {
    const result = writeIsolatedManifest(env, directory);
    const stat = fs.statSync(result.output);
    assert.equal(stat.mode & 0o077, 0);
    const body = JSON.parse(fs.readFileSync(result.output, "utf8"));
    assert.equal(body.domain, DOMAIN);
    assert.equal(body.result, "OBSERVED_MISMATCH");
    assert.equal("CODE_ACTIONABLE" in body, false);
    assert.equal("token" in body, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow producer writes under RUNNER_TEMP using the path consumed by the workflow", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-causal-runner-temp-test-"));
  try {
    const result = writeIsolatedManifest({ ...env, RUNNER_TEMP: directory });
    assert.equal(result.output, path.join(directory, "nusa-causal-verification-456-1", "verification.json"));
    assert.equal(fs.existsSync(result.output), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("consumer cross-checks exact run, producer/attestor jobs, and attestation artifact", async () => {
  const environment = { ...env, GITHUB_TOKEN: "read-only-test-token" };
  const responses = new Map([
    [`/actions/runs/456/attempts/1`, { id: 456, run_attempt: 1, path: ".github/workflows/ci.yml", event: "workflow_dispatch", head_branch: "main", head_sha: sha, status: "in_progress", conclusion: null }],
    [`/actions/runs/456/attempts/1/jobs?per_page=100`, { jobs: [
      { id: 11, run_id: 456, run_attempt: 1, head_sha: sha, name: "causal-positive-verification", status: "completed", conclusion: "success" },
      { id: 12, run_id: 456, run_attempt: 1, head_sha: sha, name: "attest-causal-positive-verification", status: "completed", conclusion: "success" },
    ] }],
    [`/actions/runs/456/artifacts?per_page=100`, { artifacts: [
      { id: 99, name: "nusa-causal-verification-attestation-1", expired: false, digest: `sha256:${"b".repeat(64)}`, workflow_run: { id: 456, head_sha: sha } },
    ] }],
  ]);
  const result = await verifyProducerExecution(environment, async (url, init) => {
    assert.equal(init.headers.authorization, "Bearer read-only-test-token");
    const pathname = new URL(url).pathname.replace("/repos/cinamoncandy/NUSA", "") + new URL(url).search;
    const body = responses.get(pathname);
    return body ? { ok: true, json: async () => body } : { ok: false, status: 404 };
  });
  assert.deepEqual(result, { runId: "456", attempt: "1", artifactId: 99, artifactDigest: `sha256:${"b".repeat(64)}` });
});

test("consumer fails closed on unavailable GitHub identity evidence", async () => {
  await assert.rejects(verifyProducerExecution({ ...env, GITHUB_TOKEN: "token" }, async () => ({ ok: false, status: 503 })), /ISOLATED_CAUSAL_VERIFICATION_GITHUB_LOOKUP_FAILED/);
});
