"use strict";

const OIDC_AUDIENCE = "nusa-codex-wip-v1";
const WORKER_ENDPOINT = "https://nusa-autopilot.desporin12.workers.dev/coding/codex-wip";
const REPOSITORY = "cinamoncandy/NUSA";

function readIdentity(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY
    || !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID || "")
    || !/^[1-9][0-9]{0,9}$/.test(env.GITHUB_RUN_ATTEMPT || "")
    || !/^[1-9][0-9]{0,6}$/.test(env.ISSUE || "")
    || !/^[a-f0-9]{40}$/i.test(env.WORKFLOW_SHA || "")) {
    throw new Error("CODEX_WIP_CONTEXT_INVALID");
  }
  return Object.freeze({ issueNumber: Number(env.ISSUE), headSha: env.WORKFLOW_SHA.toLowerCase() });
}

async function requestOidcToken(env, fetchImpl) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("CODEX_WIP_OIDC_CONTEXT_MISSING");
  }
  let url;
  try {
    url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch {
    throw new Error("CODEX_WIP_OIDC_CONTEXT_INVALID");
  }
  if (url.protocol !== "https:" || url.hostname !== "pipelines.actions.githubusercontent.com") {
    throw new Error("CODEX_WIP_OIDC_CONTEXT_INVALID");
  }
  url.searchParams.set("audience", OIDC_AUDIENCE);
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, accept: "application/json" } });
  } catch {
    throw new Error("CODEX_WIP_OIDC_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("CODEX_WIP_OIDC_UNAVAILABLE");
  let body;
  try { body = await response.json(); } catch { throw new Error("CODEX_WIP_OIDC_RESPONSE_INVALID"); }
  if (!body || typeof body.value !== "string" || body.value.length < 64 || body.value.length > 16_384) {
    throw new Error("CODEX_WIP_OIDC_RESPONSE_INVALID");
  }
  return body.value;
}

async function coordinate(action, env = process.env, fetchImpl = fetch, writeOutput = (value) => {
  if (env.GITHUB_OUTPUT) require("node:fs").appendFileSync(env.GITHUB_OUTPUT, `${value}\n`);
}) {
  if (action !== "claim" && action !== "release") throw new Error("CODEX_WIP_ACTION_INVALID");
  const { issueNumber, headSha } = readIdentity(env);
  const taskDigest = env.TASK_DIGEST;
  if (action === "claim" && !/^[a-f0-9]{64}$/i.test(taskDigest || "")) throw new Error("CODEX_WIP_TASK_DIGEST_INVALID");
  const token = await requestOidcToken(env, fetchImpl);
  let response;
  try {
    response = await fetchImpl(WORKER_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ action, issueNumber, headSha, ...(taskDigest ? { taskDigest: taskDigest.toLowerCase() } : {}) }),
    });
  } catch {
    throw new Error("CODEX_WIP_COORDINATOR_UNAVAILABLE");
  }
  let result;
  try { result = await response.json(); } catch { throw new Error("CODEX_WIP_COORDINATOR_RESPONSE_INVALID"); }
  if (action === "release" && response.status === 409 && result?.reason === "CLAIM_NOT_ACTIVE") {
    return { accepted: true, released: false, reason: "CLAIM_NOT_ACTIVE" };
  }
  if (!response.ok || result?.accepted !== true) {
    const reason = typeof result?.error === "string" && /^[A-Z0-9_]{1,80}$/.test(result.error) ? result.error : "REJECTED";
    throw new Error(`CODEX_WIP_${reason}`);
  }
  if (action === "claim") writeOutput("admitted=true");
  return result;
}

if (require.main === module) {
  coordinate(process.argv[2]).then(() => {
    console.log(`Codex WIP ${process.argv[2]} accepted`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "CODEX_WIP_FAILED");
    process.exitCode = 1;
  });
}

module.exports = { OIDC_AUDIENCE, WORKER_ENDPOINT, coordinate };
