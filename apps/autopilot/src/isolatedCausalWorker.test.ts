import assert from "node:assert/strict";
import test from "node:test";
import { handleIsolatedCausalVerification, type WorkerEnv } from "./worker";

test("isolated endpoint is disabled unless explicitly configured", async () => {
  let fetchCalls = 0;
  const response = await handleIsolatedCausalVerification(
    new Request("https://worker.example/isolated/causal/verify-and-run", { method: "POST", body: "{}" }),
    {} as WorkerEnv,
    { fetchImpl: async () => { fetchCalls += 1; throw new Error("must not be called while disabled"); } },
  );
  assert.equal(response.status, 404);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await response.json(), {
    accepted: false,
    error: "ISOLATED_CAUSAL_VERIFICATION_DISABLED",
    mutationAllowed: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
});

test("invalid consumer token is rejected before source verification or Durable Object access", async () => {
  let fetchCalls = 0;
  let doCalls = 0;
  const env = {
    NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED: "true",
    NUSA_GITHUB_REPOSITORY: "cinamoncandy/NUSA",
    NUSA_GITHUB_TOKEN: "test-read-only-token",
    NUSA_EXECUTION_COORDINATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { doCalls += 1; return Response.json({}); } }),
    },
  } as unknown as WorkerEnv;
  const response = await handleIsolatedCausalVerification(
    new Request("https://worker.example/isolated/causal/verify-and-run", {
      method: "POST",
      headers: { authorization: "Bearer malformed", "content-type": "application/json" },
      body: JSON.stringify({ sourceRunId: "123", sourceRunAttempt: "1", attestationBundle: {} }),
    }),
    env,
    { fetchImpl: async () => { fetchCalls += 1; return Response.json({ keys: [] }); } },
  );
  assert.equal(response.status, 409);
  assert.equal(fetchCalls, 0, "malformed JWT is rejected before JWKS/source API access");
  assert.equal(doCalls, 0, "no claim is created before consumer OIDC verification");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.accepted, false);
  assert.equal(body.error, "ISOLATED_VERIFICATION_REJECTED");
  assert.equal(body.productionMutationAllowed, false);
  assert.equal(body.aiAuthority, "ZERO_AUTHORITY");
});
