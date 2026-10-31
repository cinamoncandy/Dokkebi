import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { claimVerifiedCausalDispatch, dispatchWithCausalBinding, prepareCausalDispatch, verifyClaimedCausalDispatch } from "./causalAdmissionAuthorization";
import { acquirePersistentExecution, ExecutionCoordinator, type ExecutionCoordinatorNamespace } from "./executionCoordinator";
import type { SourceExecutionIdentity } from "./githubActionsOidc";
import { handleCausalDispatchClaim, type WorkerEnv } from "./worker";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

const repository = "cinamoncandy/NUSA";
const now = 1_788_061_200_000;
const sha = "a".repeat(40);
const source: SourceExecutionIdentity = { repository, workflowPath: ".github/workflows/ci.yml", sha, runId: "456", runAttempt: "1" };
const sourceRun = { id: 456, run_attempt: 1, repository: { full_name: repository }, path: source.workflowPath, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "failure" };
const publisherRun = { id: 789, run_attempt: 1, repository: { full_name: repository }, path: ".github/workflows/autopilot-execution-consumer.yml", head_sha: sha, head_branch: "main", event: "repository_dispatch" };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function fixture(claimOverrides: Record<string, unknown> = {}) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ alg: "RS256", kid: "fixture" });
  const claims = encode({ iss: "https://token.actions.githubusercontent.com", aud: "nusa-autopilot", exp: now / 1000 + 300, iat: now / 1000, repository, ref: "refs/heads/main", event_name: "repository_dispatch", workflow_ref: `${repository}/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main`, sha, run_id: "789", run_attempt: "1", ...claimOverrides });
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${header}.${claims}`)));
  const token = `${header}.${claims}.${base64Url(signature)}`;
  const coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
  const namespace: ExecutionCoordinatorNamespace = { idFromName: () => ({}), get: () => ({ fetch: (input, init) => coordinator.fetch(new Request(input, init)) }) };
  const dispatched: Array<Record<string, unknown>> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    if (input.endsWith("/.well-known/jwks")) return { ok: true, status: 200, json: async () => ({ keys: [{ ...publicJwk, kid: "fixture", alg: "RS256", use: "sig" }] }) };
    if (input.endsWith("/actions/runs/456/attempts/1")) return { ok: true, status: 200, json: async () => sourceRun };
    if (input.endsWith("/actions/runs/789/attempts/1")) return { ok: true, status: 200, json: async () => publisherRun };
    if (input.endsWith("/actions/runs/456/attempts/1/jobs?per_page=100")) return { ok: true, status: 200, json: async () => ({ total_count: 2, jobs: [
      { id: 1, run_id: 456, run_attempt: 1, head_sha: sha, name: "causal-regression-contract", status: "completed", conclusion: "failure" },
      { id: 2, run_id: 456, run_attempt: 1, head_sha: sha, name: "attest-causal-regression", status: "completed", conclusion: "success" },
    ] }) };
    if (input.endsWith("/actions/runs/456/artifacts?per_page=100")) return { ok: true, status: 200, json: async () => ({ total_count: 1, artifacts: [
      { id: 321, name: "nusa-causal-attestation-1", expired: false, digest: `sha256:${"b".repeat(64)}`, size_in_bytes: 1024, workflow_run: { id: 456, head_sha: sha } },
    ] }) };
    if (input.endsWith("/branches/main")) return { ok: true, status: 200, json: async () => ({ commit: { sha } }) };
    if (input.endsWith("/dispatches")) {
      dispatched.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const context = { coordinator: namespace, allowedRepository: repository, githubToken: "fixture-github-token", dedupeKey: "causal:456", executionId: "exec:456", source, now, fetchImpl };
  await acquirePersistentExecution(namespace, { dedupeKey: context.dedupeKey, executionId: context.executionId, headSha: sha, now, leaseExpiresAt: now + 180_000 });
  return { context, token, dispatched };
}

test("signed canonical publisher and independently verified source bind exactly once", async () => {
  const { context, token } = await fixture();
  const capability = await prepareCausalDispatch(context, now + 120_000);
  assert.ok(capability);
  assert.equal(await verifyClaimedCausalDispatch(context, token, capability), false);
  assert.equal(await claimVerifiedCausalDispatch(context, token, capability), true);
  assert.equal(await claimVerifiedCausalDispatch(context, token, capability), false);
  assert.equal(await verifyClaimedCausalDispatch(context, token, capability), true);
  assert.equal(await verifyClaimedCausalDispatch(context, "static-bearer-token", capability), false);
});

test("static token, source substitution, wrong publisher and unavailable GitHub fail closed", async () => {
  const { context, token } = await fixture();
  const capability = await prepareCausalDispatch(context, now + 120_000);
  assert.ok(capability);
  assert.equal(await claimVerifiedCausalDispatch(context, "static-bearer-token", capability), false);
  assert.equal(await claimVerifiedCausalDispatch({ ...context, source: { ...source, runId: "457" } }, token, capability), false);
  assert.equal(await claimVerifiedCausalDispatch({ ...context, fetchImpl: async () => { throw new Error("offline"); } }, token, capability), false);
  const wrongPublisher = await fixture({ repository: "other/NUSA" });
  assert.equal(await claimVerifiedCausalDispatch(context, wrongPublisher.token, capability), false);
  assert.equal(await claimVerifiedCausalDispatch(context, token, capability), true);
});

test("worker claim route verifies signed publisher and source without granting coding authority", async () => {
  const { context, token } = await fixture();
  const capability = await prepareCausalDispatch(context, now + 120_000);
  assert.ok(capability);
  const env = { NUSA_GITHUB_REPOSITORY: repository, NUSA_GITHUB_TOKEN: context.githubToken, NUSA_EXECUTION_COORDINATOR: context.coordinator } as unknown as WorkerEnv;
  const makeRequest = () => new Request("https://worker.example/coding/causal/claim", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ dedupeKey: context.dedupeKey, executionId: context.executionId, source, capability }) });
  const dependencies = { now: () => now, fetchImpl: context.fetchImpl };
  const response = await handleCausalDispatchClaim(makeRequest(), env, dependencies);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.claimed, true);
  assert.equal(body.causalAttestationVerified, false);
  assert.equal(body.productionMutationAllowed, false);
  assert.equal(body.aiAuthority, "ZERO_AUTHORITY");
  assert.equal("CODE_ACTIONABLE" in body, false);
  assert.equal((await handleCausalDispatchClaim(makeRequest(), env, dependencies)).status, 409);
});

test("worker rejects a cryptographically valid Sigstore bundle from an unauthorized signer", async () => {
  const { context, token } = await fixture();
  const capability = await prepareCausalDispatch(context, now + 120_000);
  assert.ok(capability);
  const fixturePath = join(process.cwd(), "apps/autopilot/src/test-fixtures/sigstore-upstream-valid.json");
  const bundle = (JSON.parse(readFileSync(fixturePath, "utf8")) as { bundle: unknown }).bundle;
  const env = { NUSA_GITHUB_REPOSITORY: repository, NUSA_GITHUB_TOKEN: context.githubToken, NUSA_EXECUTION_COORDINATOR: context.coordinator } as unknown as WorkerEnv;
  const request = new Request("https://worker.example/coding/causal/claim", {
    method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ dedupeKey: context.dedupeKey, executionId: context.executionId, source, capability, attestationBundle: bundle }),
  });
  const response = await handleCausalDispatchClaim(request, env, { now: () => now, fetchImpl: context.fetchImpl });
  assert.equal(response.status, 409);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.claimed, false);
  assert.equal(body.causalAttestationVerified, false);
  assert.equal(body.error, "CAUSAL_ATTESTATION_REJECTED");
  assert.equal("CODE_ACTIONABLE" in body, false);
});

test("server-bound dispatch reaches the signed consumer claim without granting causal authority", async () => {
  const { context, token, dispatched } = await fixture();
  const result = await dispatchWithCausalBinding(context, {
    kind: "REPOSITORY_AUTOPILOT", repository, headSha: sha, workflowRunId: 456,
    executionId: context.executionId, dedupeKey: context.dedupeKey, reason: `gha:456:${sha}:failure`, mutationAllowed: false,
  }, now + 120_000);
  assert.equal(result?.status, "DISPATCHED");
  assert.equal(dispatched.length, 1);
  const payload = dispatched[0]?.client_payload as Record<string, unknown>;
  assert.equal(payload.causal_source_run_attempt, 1);
  assert.match(String(payload.causal_dispatch_capability), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(String(payload.causal_dispatch_capability)), false);
  const env = { NUSA_GITHUB_REPOSITORY: repository, NUSA_GITHUB_TOKEN: context.githubToken, NUSA_EXECUTION_COORDINATOR: context.coordinator } as unknown as WorkerEnv;
  const request = new Request("https://worker.example/coding/causal/claim", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ dedupeKey: context.dedupeKey, executionId: context.executionId, source, capability: payload.causal_dispatch_capability }) });
  const claim = await handleCausalDispatchClaim(request, env, { now: () => now, fetchImpl: context.fetchImpl });
  assert.equal(claim.status, 200);
  const body = await claim.json() as Record<string, unknown>;
  assert.equal(body.claimed, true);
  assert.equal("CODE_ACTIONABLE" in body, false);
});

test("dispatch cannot register a source for a different execution, repository, SHA or run", async () => {
  const { context, dispatched } = await fixture();
  const request = { kind: "REPOSITORY_AUTOPILOT" as const, repository, headSha: sha, workflowRunId: 456, executionId: context.executionId, dedupeKey: context.dedupeKey, reason: `gha:456:${sha}:failure`, mutationAllowed: false as const };
  for (const override of [
    { repository: "other/NUSA" }, { headSha: "b".repeat(40) }, { workflowRunId: 457 },
    { executionId: "exec:other" }, { dedupeKey: "causal:other" },
  ]) assert.equal(await dispatchWithCausalBinding(context, { ...request, ...override }, now + 120_000), null);
  assert.equal(dispatched.length, 0);
  assert.equal((await dispatchWithCausalBinding(context, request, now + 120_000))?.status, "DISPATCHED");
});
