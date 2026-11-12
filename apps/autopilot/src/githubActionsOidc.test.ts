import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CODEX_WIP_AUDIENCE,
  verifyGithubActionsOidcToken,
  verifyGithubCodexWipIdentity,
  verifyGithubCodexWipRun,
  verifyGithubCodingPublisherIdentity,
  verifyGithubCodingPublisherRun,
  verifyGithubCausalProducerEvidence,
  verifyGithubCodingSourceRun,
  verifyGithubEventBridgeOidcToken,
  verifyGithubReleaseControlOidcToken,
} from "./githubActionsOidc";

const repository = "cinamoncandy/NUSA";
const now = 1_788_061_200;
const releaseWorkflowRef = `${repository}/.github/workflows/autopilot-deterministic-audit-release.yml@refs/heads/main`;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodedJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "test-key";
  const header = encodedJson({ alg: "RS256", kid, typ: "JWT" });
  const claims = encodedJson({
    iss: "https://token.actions.githubusercontent.com",
    aud: "nusa-autopilot",
    exp: now + 300,
    nbf: now - 10,
    iat: now - 10,
    repository,
    repository_id: "1296492411",
    ref: "refs/heads/main",
    event_name: "repository_dispatch",
    workflow_ref: `${repository}/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main`,
    ...overrides,
  });
  const signed = new TextEncoder().encode(`${header}.${claims}`);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, signed));
  const token = `${header}.${claims}.${base64Url(signature)}`;
  return {
    token,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }) }),
  };
}

describe("GitHub Actions OIDC", () => {
  it("checks the distinct source run without treating its failure as causal proof", async () => {
    const source = { repository, workflowPath: ".github/workflows/ci.yml", sha: "a".repeat(40), runId: "456", runAttempt: "1" };
    const run = { id: 456, run_attempt: 1, repository: { full_name: repository }, path: source.workflowPath, head_sha: source.sha, head_branch: "main", event: "push", status: "completed", conclusion: "failure" };
    const response = (data: unknown) => async () => ({ ok: true, status: 200, json: async () => data });
    await verifyGithubCodingSourceRun(source, repository, "fixture-token", response(run));
    for (const changed of [{ id: 457 }, { run_attempt: 2 }, { repository: { full_name: "other/NUSA" } }, { path: ".github/workflows/other.yml" }, { head_sha: "b".repeat(40) }, { head_branch: "other" }, { event: "repository_dispatch" }, { status: "in_progress" }, { conclusion: "success" }]) {
      await assert.rejects(() => verifyGithubCodingSourceRun(source, repository, "fixture-token", response({ ...run, ...changed })), /CODING_SOURCE_RUN_MISMATCH/);
    }
    await assert.rejects(() => verifyGithubCodingSourceRun({ ...source, repository: "other/NUSA" }, repository, "fixture-token", response(run)), /CODING_SOURCE_IDENTITY_INVALID/);
    await assert.rejects(() => verifyGithubCodingSourceRun(source, repository, "fixture-token", async () => { throw new Error("offline"); }), /CODING_SOURCE_RUN_UNAVAILABLE/);
  });
  it("requires exact protected producer jobs and one fresh same-run attestation artifact", async () => {
    const source = { repository, workflowPath: ".github/workflows/ci.yml", sha: "a".repeat(40), runId: "456", runAttempt: "1" };
    const fingerprintPaths = [
      ".github/workflows/ci.yml",
      "scripts/causal-regression-observe.js",
      "apps/autopilot/src/causalRegressionContract.ts",
      "pnpm-lock.yaml",
      "apps/autopilot/src/repairableWorkflowRun.ts",
    ];
    const fingerprintBytes = new TextEncoder().encode("fixture source fingerprint\n");
    const fingerprintBase64 = btoa(Array.from(fingerprintBytes, (byte) => String.fromCharCode(byte)).join(""));
    const job = (name: string, conclusion: string, overrides: Record<string, unknown> = {}) => ({
      id: name === "causal-regression-contract" ? 1 : 2, run_id: 456, run_attempt: 1, head_sha: source.sha,
      name, status: "completed", conclusion, ...overrides,
    });
    const artifact = (overrides: Record<string, unknown> = {}) => ({
      id: 123, name: "nusa-causal-attestation-1", expired: false, digest: `sha256:${"b".repeat(64)}`, size_in_bytes: 1024,
      workflow_run: { id: 456, head_sha: source.sha }, ...overrides,
    });
    const evidenceFetch = (jobs: readonly unknown[], artifacts: readonly unknown[]) => async (input: string) => {
      const sourceRunPath = `/actions/runs/${source.runId}/attempts/${source.runAttempt}`;
      if (input.split("?")[0]?.endsWith(sourceRunPath)) return {
        ok: true, status: 200, json: async () => ({
          id: Number(source.runId), run_attempt: Number(source.runAttempt), repository: { full_name: source.repository },
          path: source.workflowPath, head_sha: source.sha, head_branch: "main", event: "push", status: "completed", conclusion: "failure",
        }),
      };
      if (input.includes("/jobs?")) return { ok: true, status: 200, json: async () => ({ total_count: jobs.length, jobs }) };
      if (input.includes("/artifacts?")) return { ok: true, status: 200, json: async () => ({ total_count: artifacts.length, artifacts }) };
      if (input.includes("/contents/")) {
        const path = decodeURIComponent(new URL(input).pathname.split("/contents/")[1] ?? "");
        if (fingerprintPaths.includes(path)) return { ok: true, status: 200, json: async () => ({
          type: "file", path, encoding: "base64", size: fingerprintBytes.byteLength, content: fingerprintBase64,
        }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const validJobs = [job("causal-regression-contract", "failure"), job("attest-causal-regression", "success")];
    const validArtifacts = [artifact()];
    await verifyGithubCausalProducerEvidence(source, repository, "fixture-token", evidenceFetch(validJobs, validArtifacts));
    for (const [jobs, artifacts] of [
      [[job("causal-regression-contract", "failure"), job("attest-causal-regression", "failure")], validArtifacts],
      [[job("causal-regression-contract", "failure", { head_sha: "c".repeat(40) }), validJobs[1]], validArtifacts],
      [validJobs, [artifact({ expired: true })]],
      [validJobs, [artifact({ workflow_run: { id: 457, head_sha: source.sha } })]],
      [validJobs, [artifact({ digest: "unknown" })]],
      [validJobs, [artifact(), artifact({ id: 124 })]],
    ] as const) {
      await assert.rejects(() => verifyGithubCausalProducerEvidence(source, repository, "fixture-token", evidenceFetch(jobs, artifacts)), /CODING_CAUSAL_PRODUCER_(JOBS|ARTIFACT)_MISMATCH/);
    }
    await assert.rejects(() => verifyGithubCausalProducerEvidence(source, repository, "fixture-token", async () => { throw new Error("offline"); }), /CODING_CAUSAL_PRODUCER_JOBS_UNAVAILABLE/);
  });
  it("cross-checks publisher run identity and fails closed on mismatches", async () => {
    const signed = await fixture({ sha: "a".repeat(40), run_id: "12345", run_attempt: "2" });
    const identity = await verifyGithubCodingPublisherIdentity(signed.token, repository, signed.fetch, now);
    const run = { id: 12345, run_attempt: 2, repository: { full_name: repository }, path: ".github/workflows/autopilot-execution-consumer.yml", head_sha: "a".repeat(40), head_branch: "main", event: "repository_dispatch" };
    const response = (data: unknown) => async () => ({ ok: true, status: 200, json: async () => data });
    await verifyGithubCodingPublisherRun(identity, "fixture-token", response(run));
    for (const changed of [
      { id: 12346 }, { run_attempt: 1 }, { repository: { full_name: "other/NUSA" } },
      { path: ".github/workflows/ci.yml" }, { head_sha: "b".repeat(40) },
      { head_branch: "feature" }, { event: "push" },
    ]) {
      await assert.rejects(() => verifyGithubCodingPublisherRun(identity, "fixture-token", response({ ...run, ...changed })), /CODING_PUBLISHER_RUN_MISMATCH/);
    }
    await assert.rejects(() => verifyGithubCodingPublisherRun(identity, "fixture-token", async () => { throw new Error("offline"); }), /CODING_PUBLISHER_RUN_UNAVAILABLE/);
  });
  it("returns publisher identity only from a signed canonical workflow token", async () => {
    const valid = await fixture({ sha: "A".repeat(40), run_id: "12345", run_attempt: "2" });
    const identity = await verifyGithubCodingPublisherIdentity(valid.token, repository, valid.fetch, now);
    assert.deepEqual(identity, { repository, workflowRef: `${repository}/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main`, ref: "refs/heads/main", sha: "a".repeat(40), runId: "12345", runAttempt: "2", event: "repository_dispatch" });
    assert.equal(Object.isFrozen(identity), true);
    for (const [overrides, expected] of [
      [{ run_id: "12345", run_attempt: "1" }, /SHA_INVALID/],
      [{ sha: "a".repeat(40), run_attempt: "1" }, /RUN_ID_INVALID/],
      [{ sha: "a".repeat(40), run_id: "12345" }, /RUN_ATTEMPT_INVALID/],
      [{ sha: "a".repeat(40), run_id: "12345", run_attempt: "1", repository: "other/NUSA" }, /REPOSITORY_INVALID/],
      [{ sha: "a".repeat(40), run_id: "12345", run_attempt: "1", workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main` }, /WORKFLOW_INVALID/],
      [{ sha: "a".repeat(40), run_id: "12345", run_attempt: "1", aud: "wrong" }, /AUDIENCE_INVALID/],
      [{ sha: "a".repeat(40), run_id: "12345", run_attempt: "1", iss: "https://wrong.invalid" }, /ISSUER_INVALID/],
    ] as const) {
      const invalid = await fixture(overrides);
      await assert.rejects(() => verifyGithubCodingPublisherIdentity(invalid.token, repository, invalid.fetch, now), expected);
    }
  });
  it("accepts the trusted execution consumer workflow", async () => {
    const valid = await fixture();
    await verifyGithubActionsOidcToken(valid.token, repository, valid.fetch, now);
  });

  it("binds Codex WIP coordination to its exact signed workflow and live run attempt", async () => {
    const workflowPath = ".github/workflows/autopilot-codex-coding.yml";
    const workflowRef = `${repository}/${workflowPath}@refs/heads/main`;
    const signed = await fixture({
      aud: CODEX_WIP_AUDIENCE,
      workflow_ref: workflowRef,
      event_name: "workflow_dispatch",
      sha: "A".repeat(40),
      run_id: "12345",
      run_attempt: "2",
    });
    const identity = await verifyGithubCodexWipIdentity(signed.token, repository, signed.fetch, now);
    assert.deepEqual(identity, {
      repository,
      workflowRef,
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      runId: "12345",
      runAttempt: "2",
      event: "workflow_dispatch",
    });
    const run = {
      id: 12345,
      run_attempt: 2,
      repository: { full_name: repository },
      path: workflowPath,
      head_sha: "a".repeat(40),
      head_branch: "main",
      event: "workflow_dispatch",
      status: "in_progress",
    };
    const response = (data: unknown) => async () => ({ ok: true, status: 200, json: async () => data });
    await verifyGithubCodexWipRun(identity, "fixture-token", response(run));
    for (const changed of [
      { id: 12346 }, { run_attempt: 1 }, { repository: { full_name: "other/NUSA" } },
      { path: ".github/workflows/ci.yml" }, { head_sha: "b".repeat(40) },
      { head_branch: "feature" }, { event: "schedule" }, { status: "completed" },
    ]) {
      await assert.rejects(() => verifyGithubCodexWipRun(identity, "fixture-token", response({ ...run, ...changed })), /CODEX_WIP_RUN_MISMATCH/);
    }
    await assert.rejects(() => verifyGithubCodexWipRun(identity, "fixture-token", async () => { throw new Error("offline"); }), /CODEX_WIP_RUN_UNAVAILABLE/);
  });

  it("rejects Codex WIP OIDC claims outside the allowlisted identity", async () => {
    for (const [overrides, expected] of [
      [{ workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`, aud: CODEX_WIP_AUDIENCE, run_id: "1", run_attempt: "1" }, /CODEX_WIP_OIDC_WORKFLOW_INVALID/],
      [{ aud: "nusa-autopilot", run_id: "1", run_attempt: "1" }, /CODEX_WIP_OIDC_AUDIENCE_INVALID/],
      [{ aud: CODEX_WIP_AUDIENCE, ref: "refs/heads/feature", run_id: "1", run_attempt: "1" }, /CODEX_WIP_OIDC_REF_INVALID/],
      [{ aud: CODEX_WIP_AUDIENCE, event_name: "push", run_id: "1", run_attempt: "1" }, /CODEX_WIP_OIDC_EVENT_INVALID/],
      [{ aud: CODEX_WIP_AUDIENCE, repository: "other/NUSA", run_id: "1", run_attempt: "1" }, /CODEX_WIP_OIDC_REPOSITORY_INVALID/],
      [{ aud: CODEX_WIP_AUDIENCE, sha: "bad", run_id: "1", run_attempt: "1" }, /CODEX_WIP_OIDC_SHA_INVALID/],
      [{ aud: CODEX_WIP_AUDIENCE, sha: "a".repeat(40), run_attempt: "1" }, /CODEX_WIP_OIDC_RUN_ID_INVALID/],
      [{ aud: CODEX_WIP_AUDIENCE, sha: "a".repeat(40), run_id: "1" }, /CODEX_WIP_OIDC_RUN_ATTEMPT_INVALID/],
    ] as const) {
      const invalid = await fixture(Object.assign({
        aud: CODEX_WIP_AUDIENCE,
        workflow_ref: `${repository}/.github/workflows/autopilot-codex-coding.yml@refs/heads/main`,
        event_name: "workflow_dispatch",
      }, overrides));
      await assert.rejects(() => verifyGithubCodexWipIdentity(invalid.token, repository, invalid.fetch, now), expected);
    }
    const wrongRepositoryPolicy = await fixture({ aud: CODEX_WIP_AUDIENCE });
    await assert.rejects(() => verifyGithubCodexWipIdentity(wrongRepositoryPolicy.token, "other/NUSA", wrongRepositoryPolicy.fetch, now), /CODEX_WIP_OIDC_REPOSITORY_POLICY_INVALID/);

    const expired = await fixture({
      aud: CODEX_WIP_AUDIENCE,
      workflow_ref: `${repository}/.github/workflows/autopilot-codex-coding.yml@refs/heads/main`,
      event_name: "workflow_dispatch",
      sha: "a".repeat(40),
      run_id: "12345",
      run_attempt: "2",
      exp: now - 120,
    });
    await assert.rejects(() => verifyGithubCodexWipIdentity(expired.token, repository, expired.fetch, now), /CODEX_WIP_OIDC_EXPIRED/);

    const wrongIssuer = await fixture({
      aud: CODEX_WIP_AUDIENCE,
      workflow_ref: `${repository}/.github/workflows/autopilot-codex-coding.yml@refs/heads/main`,
      event_name: "workflow_dispatch",
      sha: "a".repeat(40),
      run_id: "12345",
      run_attempt: "2",
      iss: "https://issuer.invalid",
    });
    await assert.rejects(() => verifyGithubCodexWipIdentity(wrongIssuer.token, repository, wrongIssuer.fetch, now), /CODEX_WIP_OIDC_ISSUER_INVALID/);
  });

  it("rejects a token from another coding workflow or branch", async () => {
    const wrongWorkflow = await fixture({ workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main` });
    await assert.rejects(() => verifyGithubActionsOidcToken(wrongWorkflow.token, repository, wrongWorkflow.fetch, now), /CODING_RUNNER_OIDC_WORKFLOW_INVALID/);

    const obsoleteBridge = await fixture({ workflow_ref: `${repository}/.github/workflows/autopilot-worker-dispatch-bridge.yml@refs/heads/main` });
    await assert.rejects(() => verifyGithubActionsOidcToken(obsoleteBridge.token, repository, obsoleteBridge.fetch, now), /CODING_RUNNER_OIDC_WORKFLOW_INVALID/);

    const wrongRef = await fixture({ ref: "refs/heads/feature" });
    await assert.rejects(() => verifyGithubActionsOidcToken(wrongRef.token, repository, wrongRef.fetch, now), /CODING_RUNNER_OIDC_REF_INVALID/);
  });

  it("accepts only the trusted event bridge workflow and bounded event surface", async () => {
    const valid = await fixture({
      workflow_ref: `${repository}/.github/workflows/autopilot-github-event-bridge.yml@refs/heads/main`,
      event_name: "workflow_run",
      ref: "refs/heads/feature-pr-head",
    });
    await verifyGithubEventBridgeOidcToken(valid.token, repository, valid.fetch, now);

    const wrongWorkflow = await fixture({
      workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      event_name: "workflow_run",
    });
    await assert.rejects(() => verifyGithubEventBridgeOidcToken(wrongWorkflow.token, repository, wrongWorkflow.fetch, now), /EVENT_BRIDGE_OIDC_WORKFLOW_INVALID/);

    const wrongEvent = await fixture({
      workflow_ref: `${repository}/.github/workflows/autopilot-github-event-bridge.yml@refs/heads/main`,
      event_name: "issues",
    });
    await assert.rejects(() => verifyGithubEventBridgeOidcToken(wrongEvent.token, repository, wrongEvent.fetch, now), /EVENT_BRIDGE_OIDC_EVENT_INVALID/);
  });

  it("accepts only the canonical Release control workflow identity", async () => {
    const valid = await fixture({ workflow_ref: releaseWorkflowRef });
    await verifyGithubReleaseControlOidcToken(valid.token, repository, valid.fetch, now);

    const wrongWorkflow = await fixture({ workflow_ref: `${repository}/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main` });
    await assert.rejects(() => verifyGithubReleaseControlOidcToken(wrongWorkflow.token, repository, wrongWorkflow.fetch, now), /RELEASE_CONTROL_OIDC_WORKFLOW_INVALID/);

    const wrongRepository = await fixture({ repository: "other/NUSA", workflow_ref: releaseWorkflowRef });
    await assert.rejects(() => verifyGithubReleaseControlOidcToken(wrongRepository.token, repository, wrongRepository.fetch, now), /RELEASE_CONTROL_OIDC_REPOSITORY_INVALID/);

    const wrongAudience = await fixture({ aud: "other-service", workflow_ref: releaseWorkflowRef });
    await assert.rejects(() => verifyGithubReleaseControlOidcToken(wrongAudience.token, repository, wrongAudience.fetch, now), /RELEASE_CONTROL_OIDC_AUDIENCE_INVALID/);

    const wrongRef = await fixture({ ref: "refs/heads/feature", workflow_ref: releaseWorkflowRef });
    await assert.rejects(() => verifyGithubReleaseControlOidcToken(wrongRef.token, repository, wrongRef.fetch, now), /RELEASE_CONTROL_OIDC_REF_INVALID/);

    const wrongEvent = await fixture({ event_name: "workflow_run", workflow_ref: releaseWorkflowRef });
    await assert.rejects(() => verifyGithubReleaseControlOidcToken(wrongEvent.token, repository, wrongEvent.fetch, now), /RELEASE_CONTROL_OIDC_EVENT_INVALID/);

    const expired = await fixture({ exp: now - 120, workflow_ref: releaseWorkflowRef });
    await assert.rejects(() => verifyGithubReleaseControlOidcToken(expired.token, repository, expired.fetch, now), /RELEASE_CONTROL_OIDC_EXPIRED/);

    const badSignature = await fixture({ workflow_ref: releaseWorkflowRef });
    const [header, claims] = badSignature.token.split(".");
    const forged = `${header}.${claims}.${base64Url(new Uint8Array(256))}`;
    await assert.rejects(() => verifyGithubReleaseControlOidcToken(forged, repository, badSignature.fetch, now), /RELEASE_CONTROL_OIDC_SIGNATURE_INVALID/);
  });

  it("rejects wrong audience and expired coding tokens", async () => {
    const wrongAudience = await fixture({ aud: "other-service" });
    await assert.rejects(() => verifyGithubActionsOidcToken(wrongAudience.token, repository, wrongAudience.fetch, now), /CODING_RUNNER_OIDC_AUDIENCE_INVALID/);

    const expired = await fixture({ exp: now - 120 });
    await assert.rejects(() => verifyGithubActionsOidcToken(expired.token, repository, expired.fetch, now), /CODING_RUNNER_OIDC_EXPIRED/);
  });
});
