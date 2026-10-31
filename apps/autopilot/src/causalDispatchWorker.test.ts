import assert from "node:assert/strict";
import test from "node:test";
import { handleCausalDispatchClaim, type WorkerEnv } from "./worker";

const environment = { NUSA_GITHUB_REPOSITORY: "cinamoncandy/NUSA", NUSA_GITHUB_TOKEN: "github-fixture", NUSA_EXECUTION_COORDINATOR: {} } as unknown as WorkerEnv;
const body = { dedupeKey: "causal:456", executionId: "exec:456", source: { repository: "cinamoncandy/NUSA", workflowPath: ".github/workflows/ci.yml", sha: "a".repeat(40), runId: "456", runAttempt: "1" }, capability: "a".repeat(64) };

test("causal claim denies a legacy static bearer without producing authority", async () => {
  const response = await handleCausalDispatchClaim(new Request("https://worker.example/coding/causal/claim", { method: "POST", headers: { authorization: "Bearer static-token" }, body: JSON.stringify(body) }), environment);
  assert.equal(response.status, 409);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.claimed, false);
  assert.equal(result.productionMutationAllowed, false);
  assert.equal(result.aiAuthority, "ZERO_AUTHORITY");
  assert.equal("CODE_ACTIONABLE" in result, false);
});

test("causal claim rejects missing credentials and malformed or oversized requests", async () => {
  const missing = await handleCausalDispatchClaim(new Request("https://worker.example/coding/causal/claim", { method: "POST", body: "{}" }), environment);
  assert.equal(missing.status, 401);
  for (const raw of ["not-json", JSON.stringify({ ...body, capability: "bad" }), "x".repeat(4097)]) {
    const response = await handleCausalDispatchClaim(new Request("https://worker.example/coding/causal/claim", { method: "POST", headers: { authorization: "Bearer static-token" }, body: raw }), environment);
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes("a".repeat(64)), false);
  }
});

test("causal claim times out an unfinished request body", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
  const request = new Request("https://worker.example/coding/causal/claim", { method: "POST", headers: { authorization: "Bearer static-token" }, body: stream, duplex: "half" } as RequestInit);
  const response = await handleCausalDispatchClaim(request, environment);
  assert.equal(response.status, 400);
  assert.equal(cancelled, true);
});
