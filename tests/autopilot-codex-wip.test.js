"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { coordinate, OIDC_AUDIENCE, WORKER_ENDPOINT } = require("../scripts/autopilot-codex-wip.js");

const JWT = `${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}`;
const baseEnv = () => ({
  GITHUB_REPOSITORY: "cinamoncandy/NUSA",
  GITHUB_RUN_ID: "12345",
  GITHUB_RUN_ATTEMPT: "2",
  ISSUE: "903",
  WORKFLOW_SHA: "a".repeat(40),
  TASK_DIGEST: "d".repeat(64),
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/abc/oidc?foo=bar",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-capability",
});

test("Codex claim and release mint the audience-bound token and send only task identity", async () => {
  for (const action of ["claim", "verify", "release"]) {
    const calls = [];
    const outputs = [];
    const fetchImpl = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).startsWith("https://pipelines.actions.githubusercontent.com/")) {
        const url = new URL(String(input));
        assert.equal(url.searchParams.get("audience"), OIDC_AUDIENCE);
        assert.equal(init.headers.authorization, "Bearer request-capability");
        return new Response(JSON.stringify({ value: JWT }), { status: 200 });
      }
      assert.equal(String(input), WORKER_ENDPOINT);
      assert.equal(init.headers.authorization, `Bearer ${JWT}`);
      assert.deepEqual(JSON.parse(init.body), { action, issueNumber: 903, headSha: "a".repeat(40), taskDigest: "d".repeat(64) });
      return new Response(JSON.stringify({ accepted: true }), { status: action === "claim" ? 201 : 200 });
    };
    await coordinate(action, baseEnv(), fetchImpl, (line) => outputs.push(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(outputs, action === "claim" ? ["admitted=true"] : []);
  }
});

test("Codex WIP client fails closed on wrong repo, invalid task, missing OIDC, and coordinator rejection", async () => {
  const fetchImpl = async () => { throw new Error("fetch must not be called"); };
  await assert.rejects(() => coordinate("claim", { ...baseEnv(), GITHUB_REPOSITORY: "attacker/NUSA" }, fetchImpl), /CODEX_WIP_CONTEXT_INVALID/);
  await assert.rejects(() => coordinate("claim", { ...baseEnv(), ISSUE: "0" }, fetchImpl), /CODEX_WIP_CONTEXT_INVALID/);
  await assert.rejects(() => coordinate("claim", { ...baseEnv(), WORKFLOW_SHA: "bad" }, fetchImpl), /CODEX_WIP_CONTEXT_INVALID/);
  await assert.rejects(() => coordinate("claim", { ...baseEnv(), TASK_DIGEST: "bad" }, fetchImpl), /CODEX_WIP_TASK_DIGEST_INVALID/);
  await assert.rejects(() => coordinate("claim", { ...baseEnv(), ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, fetchImpl), /CODEX_WIP_OIDC_CONTEXT_MISSING/);
  await assert.rejects(() => coordinate("delete", baseEnv(), fetchImpl), /CODEX_WIP_ACTION_INVALID/);

  let workerCalled = false;
  const rejectingFetch = async (input) => {
    if (String(input).startsWith("https://pipelines.actions.githubusercontent.com/")) return new Response(JSON.stringify({ value: JWT }), { status: 200 });
    workerCalled = true;
    return new Response(JSON.stringify({ accepted: false, error: "WIP_LIMIT_REACHED" }), { status: 409 });
  };
  await assert.rejects(() => coordinate("claim", baseEnv(), rejectingFetch), /CODEX_WIP_WIP_LIMIT_REACHED/);
  assert.equal(workerCalled, true);
});

test("Codex claim emits no admission when HTTP 200 denies it or coordinator fetch throws", async () => {
  for (const failure of ["denied", "unavailable"]) {
    const outputs = [];
    let workerCalled = false;
    const fetchImpl = async (input) => {
      if (String(input).startsWith("https://pipelines.actions.githubusercontent.com/")) return new Response(JSON.stringify({ value: JWT }), { status: 200 });
      assert.equal(String(input), WORKER_ENDPOINT);
      workerCalled = true;
      if (failure === "unavailable") throw new Error("simulated coordinator fetch failure");
      return new Response(JSON.stringify({ accepted: false }), { status: 200 });
    };
    await assert.rejects(
      () => coordinate("claim", baseEnv(), fetchImpl, (line) => outputs.push(line)),
      failure === "denied" ? /CODEX_WIP_REJECTED/ : /CODEX_WIP_COORDINATOR_UNAVAILABLE/,
    );
    assert.equal(workerCalled, true);
    assert.deepEqual(outputs, []);
  }
});

test("release after a denied or ambiguously acknowledged claim treats an absent claim as an idempotent no-op", async () => {
  const fetchImpl = async (input) => {
    if (String(input).startsWith("https://pipelines.actions.githubusercontent.com/")) return new Response(JSON.stringify({ value: JWT }), { status: 200 });
    return new Response(JSON.stringify({ accepted: false, released: false, reason: "CLAIM_NOT_ACTIVE" }), { status: 409 });
  };
  const result = await coordinate("release", baseEnv(), fetchImpl);
  assert.deepEqual(result, { accepted: true, released: false, reason: "CLAIM_NOT_ACTIVE" });
});
