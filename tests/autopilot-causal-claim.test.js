const test = require("node:test");
const assert = require("node:assert/strict");
const { claimCausalDispatch } = require("../scripts/autopilot-causal-claim.js");

const capability = "a".repeat(64);
const event = { client_payload: { repository: "cinamoncandy/NUSA", head_sha: "b".repeat(40), workflow_run_id: 456, causal_source_run_attempt: 2, execution_id: "exec:456", dedupe_key: "causal:456", causal_dispatch_capability: capability } };
const environment = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-fixture" };

test("consumer sends the capability only to the fixed claim endpoint with GitHub OIDC", async () => {
  const seen = [];
  await claimCausalDispatch(event, environment, async (url, init) => {
    seen.push({ url, init });
    if (seen.length === 1) return { ok: true, json: async () => ({ value: "signed-oidc" }) };
    return { ok: true, json: async () => ({ claimed: true, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }) };
  });
  assert.match(seen[0].url, /audience=nusa-autopilot/);
  assert.equal(seen[1].url, "https://nusa-autopilot.desporin12.workers.dev/coding/causal/claim");
  assert.equal(seen[1].init.headers.authorization, "Bearer signed-oidc");
  const body = JSON.parse(seen[1].init.body);
  assert.equal(body.capability, capability);
  assert.deepEqual(body.source, { repository: "cinamoncandy/NUSA", workflowPath: ".github/workflows/ci.yml", sha: "b".repeat(40), runId: "456", runAttempt: "2" });
});

test("consumer rejects bad provenance, OIDC source or claim without echoing capability", async () => {
  for (const bad of [{ ...event.client_payload, causal_dispatch_capability: "bad" }, { ...event.client_payload, causal_source_run_attempt: 0 }]) {
    await assert.rejects(() => claimCausalDispatch({ client_payload: bad }, environment, async () => { throw new Error("must-not-fetch"); }), /CAUSAL_DISPATCH_INPUT_INVALID/);
  }
  await assert.rejects(() => claimCausalDispatch(event, { ...environment, ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example/oidc" }), /CAUSAL_DISPATCH_OIDC_URL_INVALID/);
  let calls = 0;
  await assert.rejects(() => claimCausalDispatch(event, environment, async () => (++calls === 1 ? { ok: true, json: async () => ({ value: "signed-oidc" }) } : { ok: false, json: async () => ({}) })), /CAUSAL_DISPATCH_CLAIM_REJECTED/);
});

test("legacy dispatch without a capability does not fetch or expose one", async () => {
  const { causal_dispatch_capability: _capability, ...payload } = event.client_payload;
  assert.equal(await claimCausalDispatch({ client_payload: payload }, {}, async () => { throw new Error("unexpected fetch"); }), false);
});

test("workflow-failure dispatch requires a capability and a same-run signed attestation", async () => {
  const failure = { client_payload: { ...event.client_payload, reason: `gha:456:${"b".repeat(40)}:failure` } };
  const { causal_dispatch_capability: _capability, ...withoutCapability } = failure.client_payload;
  await assert.rejects(() => claimCausalDispatch({ client_payload: withoutCapability }, {}, async () => { throw new Error("must-not-fetch"); }), /CAUSAL_DISPATCH_ATTESTATION_REQUIRED/);
  let calls = 0;
  await assert.rejects(() => claimCausalDispatch(failure, environment, async () => {
    calls += 1;
    if (calls === 1) return { ok: true, json: async () => ({ value: "signed-oidc" }) };
    throw new Error("claim must not run without an attestation bundle");
  }), /CAUSAL_DISPATCH_ATTESTATION_REQUIRED/);
  assert.equal(calls, 1);
});
