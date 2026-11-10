import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyGithubIsolatedConsumerIdentity,
  verifyGithubIsolatedConsumerRun,
  verifyGithubIsolatedSourceRun,
} from "./githubActionsOidc";

const repository = "cinamoncandy/NUSA";
const repoId = "1296492411";
const now = 1_798_000_000;
const sha = "a".repeat(40);
const consumerPath = ".github/workflows/causal-verification-consumer.yml";
const sourcePath = ".github/workflows/causal-verification.yml";

function b64(value: Uint8Array): string {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signedToken(overrides: Record<string, unknown> = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "isolated-test-key";
  const head = b64(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
  const claims = b64(new TextEncoder().encode(JSON.stringify({
    iss: "https://token.actions.githubusercontent.com",
    aud: "nusa-isolated-causal-verification-v1",
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    repository,
    repository_id: repoId,
    ref: "refs/heads/main",
    event_name: "workflow_run",
    workflow_ref: `${repository}/${consumerPath}@refs/heads/main`,
    sha,
    workflow_sha: sha,
    sub: `repo:${repository}:ref:refs/heads/main`,
    run_id: "987654321",
    run_attempt: "1",
    ...overrides,
  })));
  const signingInput = `${head}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput)));
  return {
    token: `${signingInput}.${b64(signature)}`,
    jwksFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }),
    }),
  };
}

test("isolated consumer identity pins OIDC, audience, repository, workflow/ref, and same workflow SHA", async () => {
  const fixture = await signedToken();
  const identity = await verifyGithubIsolatedConsumerIdentity(fixture.token, repository, fixture.jwksFetch, now);
  assert.deepEqual(identity, {
    repository,
    repositoryId: repoId,
    workflowRef: `${repository}/${consumerPath}@refs/heads/main`,
    ref: "refs/heads/main",
    event: "workflow_run",
    sha,
    runId: "987654321",
    runAttempt: "1",
  });

  for (const [override, expectedError] of [
    [{ aud: "wrong-audience" }, /ISOLATED_CONSUMER_OIDC_AUDIENCE_INVALID/],
    [{ event_name: "push" }, /ISOLATED_CONSUMER_OIDC_EVENT_INVALID/],
    [{ workflow_ref: `${repository}/.github/workflows/other.yml@refs/heads/main` }, /ISOLATED_CONSUMER_OIDC_WORKFLOW_INVALID/],
    [{ repository_id: "1" }, /ISOLATED_CONSUMER_OIDC_REPOSITORY_ID_INVALID/],
    [{ workflow_sha: "b".repeat(40) }, /ISOLATED_CONSUMER_OIDC_WORKFLOW_SHA_INVALID/],
    [{ sub: `repo:${repository}:ref:refs/heads/feature` }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ sub: `repo:${repository}:pull_request` }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ sub: `repo:${repository}:environment:prod` }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ sub: "" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ sub: 42 }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:FORMAT:NOT_STRING/],
    [{ sub: `repo:${repository}:ref:refs/heads/main:ref:refs/heads/feature` }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ sub: `repo:${repository}:ref:refs/heads/main:ref:refs/heads/main` }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ sub: `repo:${repository}:ref` }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ sub: "repo:cinamoncandy/nusa:ref:refs/heads/feature" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:REF:repo:ref$/],
    [{ sub: "repo:cinamoncandy/nusa:pull_request" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:KIND:repo:pull_request$/],
    [{ sub: "repo:cinamoncandy/nusa-fork:ref:refs/heads/main" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:REPOSITORY:cinamoncandy_nusa_fork:repo:ref$/],
    [{ sub: "repo:cinamoncandy/nusa:ref:refs/heads/main", repository: "cinamoncandy/nusa" }, /ISOLATED_CONSUMER_OIDC_REPOSITORY_INVALID/],
    [{ sub: "ARBITRARY_SUBJECT" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:REPOSITORY:NO_REPO_SEGMENT:NO_KEYS/],
    [{ sub: "repo:other/NUSA:ref:refs/heads/main" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:REPOSITORY:other_NUSA:repo:ref$/],
    [{ sub: "repo:x/y-z.w:ref:refs/heads/main" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:REPOSITORY:x_y_z_w:repo:ref$/],
    [{ sub: "repository_owner_id:1:repository_id:2:ref:refs/heads/main" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID:REPOSITORY:NO_REPO_SEGMENT:repository_owner_id:repository_id$/],
    [{ sub: "repo:cinamoncandy/NUSA-fork:ref:refs/heads/main" }, /ISOLATED_CONSUMER_OIDC_SUBJECT_INVALID/],
    [{ exp: now - 100 }, /ISOLATED_CONSUMER_OIDC_EXPIRED/],
  ] as const) {
    const invalid = await signedToken(override);
    await assert.rejects(() => verifyGithubIsolatedConsumerIdentity(invalid.token, repository, invalid.jwksFetch, now), expectedError);
  }
});

test("consumer OIDC run is independently checked against its in-progress GitHub run", async () => {
  const fixture = await signedToken();
  const identity = await verifyGithubIsolatedConsumerIdentity(fixture.token, repository, fixture.jwksFetch, now);
  const apiFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: Number(identity.runId), run_attempt: Number(identity.runAttempt),
      repository: { id: Number(repoId), full_name: repository },
      path: consumerPath, head_sha: sha, head_branch: "main", event: "workflow_run", status: "in_progress",
    }),
  });
  await verifyGithubIsolatedConsumerRun(identity, "read-only-token", apiFetch);
  await assert.rejects(() => verifyGithubIsolatedConsumerRun(identity, "read-only-token", async () => ({
    ok: true, status: 200, json: async () => ({
      id: Number(identity.runId), run_attempt: Number(identity.runAttempt),
      repository: { id: Number(repoId), full_name: repository },
      path: consumerPath, head_sha: sha, head_branch: "main", event: "workflow_run", status: "completed",
    }),
  })), /ISOLATED_CONSUMER_RUN_MISMATCH/);
});

test("source workflow, attempt, repository and successful producer job are independently resolved", async () => {
  const runId = "123456789";
  const attempt = "3";
  const base = `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const run = {
    id: Number(runId), run_attempt: Number(attempt), repository: { id: Number(repoId), full_name: repository },
    path: sourcePath, name: "NUSA Isolated Causal Verification", head_sha: sha, head_branch: "main",
    event: "workflow_dispatch", status: "completed", conclusion: "success",
  };
  const job = { id: 765, run_id: Number(runId), run_attempt: Number(attempt), head_sha: sha,
    name: "verify-causal-positive", status: "completed", conclusion: "success" };
  const fetchApi = async (url: string) => {
    if (url === base) return { ok: true, status: 200, json: async () => run };
    if (url === `${base}/jobs?per_page=100`) return { ok: true, status: 200, json: async () => ({ total_count: 1, jobs: [job] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.deepEqual(await verifyGithubIsolatedSourceRun(runId, attempt, "read-only-token", fetchApi), {
    repository, workflowPath: sourcePath, sha, runId, runAttempt: attempt, status: "completed",
    conclusion: "success", event: "workflow_dispatch", branch: "main", jobId: 765,
  });
  await assert.rejects(() => verifyGithubIsolatedSourceRun(runId, attempt, "read-only-token", async (url) => {
    if (url === base) return { ok: true, status: 200, json: async () => run };
    return { ok: true, status: 200, json: async () => ({ total_count: 2, jobs: [job, { ...job, id: 766 }] }) };
  }), /ISOLATED_SOURCE_JOB_MISMATCH/);
});

test("consumer OIDC accepts a customized subject template while the signed claims stay pinned", async () => {
  for (const sub of [
    `repo:${repository}:ref:refs/heads/main`,
    "repo:cinamoncandy/nusa:ref:refs/heads/main",
    "repo:CINAMONCANDY/nusa:ref:refs/heads/main",
    `repo:${repository}:workflow:NUSA Isolated Causal Verification Consumer:ref:refs/heads/main`,
    `repository_owner_id:1:repository_id:1296492411:ref:refs/heads/main`,
    `repo:${repository}:job_workflow_ref:${repository}/.github/workflows/causal-verification-consumer.yml@refs/heads/main`,
  ]) {
    const fixture = await signedToken({ sub });
    const identity = await verifyGithubIsolatedConsumerIdentity(fixture.token, repository, fixture.jwksFetch, now);
    assert.equal(identity.ref, "refs/heads/main", sub);
  }
  const wrongWorkflow = await signedToken({ sub: `repo:${repository}:ref:refs/heads/main`, workflow_ref: `${repository}/.github/workflows/other.yml@refs/heads/main` });
  await assert.rejects(() => verifyGithubIsolatedConsumerIdentity(wrongWorkflow.token, repository, wrongWorkflow.jwksFetch, now), /ISOLATED_CONSUMER_OIDC_WORKFLOW_INVALID/);
  const wrongRepository = await signedToken({ sub: `repo:${repository}:ref:refs/heads/main`, repository: "other/NUSA" });
  await assert.rejects(() => verifyGithubIsolatedConsumerIdentity(wrongRepository.token, repository, wrongRepository.jwksFetch, now), /ISOLATED_CONSUMER_OIDC_REPOSITORY_INVALID/);
  const wrongRef = await signedToken({ sub: `repo:${repository}:ref:refs/heads/main`, ref: "refs/heads/feature" });
  await assert.rejects(() => verifyGithubIsolatedConsumerIdentity(wrongRef.token, repository, wrongRef.jwksFetch, now), /ISOLATED_CONSUMER_OIDC_REF_INVALID/);
});
