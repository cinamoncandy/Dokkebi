const fs = require("node:fs");
const path = require("node:path");

const CLAIM_URL = "https://nusa-autopilot.desporin12.workers.dev/coding/causal/claim";
const CAUSAL_ATTESTATION_PATH = path.join("artifacts", "autopilot-execution", "causal-attestation", "attestation.json");

/** One-shot provenance claim; it does not decide whether a failure is code-actionable. */
async function claimCausalDispatch(event, environment = process.env, fetchImpl = fetch) {
  const payload = event && typeof event === "object" && !Array.isArray(event) ? event.client_payload : null;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && !Object.hasOwn(payload, "causal_dispatch_capability")) {
    if (typeof payload.reason === "string" && payload.reason.startsWith("gha:")) throw new Error("CAUSAL_DISPATCH_ATTESTATION_REQUIRED");
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || typeof payload.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repository)
    || typeof payload.head_sha !== "string" || !/^[a-f0-9]{40}$/.test(payload.head_sha)
    || !Number.isSafeInteger(payload.workflow_run_id) || payload.workflow_run_id <= 0
    || !Number.isSafeInteger(payload.causal_source_run_attempt) || payload.causal_source_run_attempt <= 0 || payload.causal_source_run_attempt > 9_999_999_999
    || typeof payload.execution_id !== "string" || !/^[A-Za-z0-9_.:|-]{1,512}$/.test(payload.execution_id)
    || typeof payload.dedupe_key !== "string" || !/^[A-Za-z0-9_.:|-]{1,512}$/.test(payload.dedupe_key)
    || typeof payload.causal_dispatch_capability !== "string" || !/^[a-f0-9]{64}$/.test(payload.causal_dispatch_capability)) {
    throw new Error("CAUSAL_DISPATCH_INPUT_INVALID");
  }
  const oidcUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcRequestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!oidcUrl || !oidcRequestToken) throw new Error("CAUSAL_DISPATCH_OIDC_UNAVAILABLE");
  let tokenUrl;
  try {
    tokenUrl = new URL(oidcUrl);
    if (tokenUrl.protocol !== "https:" || !tokenUrl.hostname.endsWith(".actions.githubusercontent.com")) throw new Error("invalid");
    tokenUrl.searchParams.set("audience", "nusa-autopilot");
  } catch { throw new Error("CAUSAL_DISPATCH_OIDC_URL_INVALID"); }
  let token;
  try {
    const response = await fetchImpl(tokenUrl.toString(), { headers: { authorization: `Bearer ${oidcRequestToken}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    const json = response.ok ? await response.json() : null;
    if (typeof json?.value !== "string" || !json.value) throw new Error("invalid");
    token = json.value;
  } catch { throw new Error("CAUSAL_DISPATCH_OIDC_UNAVAILABLE"); }
  let attestationBundle;
  try {
    if (fs.existsSync(CAUSAL_ATTESTATION_PATH)) {
      const rawBundle = fs.readFileSync(CAUSAL_ATTESTATION_PATH);
      if (rawBundle.byteLength > 512 * 1024) throw new Error("oversized");
      attestationBundle = JSON.parse(rawBundle.toString("utf8"));
      if (!attestationBundle || typeof attestationBundle !== "object" || Array.isArray(attestationBundle)) throw new Error("invalid");
    }
  } catch { throw new Error("CAUSAL_DISPATCH_ATTESTATION_INVALID"); }
  if (typeof payload.reason === "string" && payload.reason.startsWith("gha:") && !attestationBundle) {
    throw new Error("CAUSAL_DISPATCH_ATTESTATION_REQUIRED");
  }
  try {
    const response = await fetchImpl(CLAIM_URL, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        dedupeKey: payload.dedupe_key, executionId: payload.execution_id, capability: payload.causal_dispatch_capability,
        source: { repository: payload.repository, workflowPath: ".github/workflows/ci.yml", sha: payload.head_sha, runId: String(payload.workflow_run_id), runAttempt: String(payload.causal_source_run_attempt) },
        ...(attestationBundle ? { attestationBundle } : {}),
      }),
    });
    const result = response.ok ? await response.json() : null;
    if (!response.ok || result?.claimed !== true || (attestationBundle && result.causalAttestationVerified !== true)
      || result.liveAuthority !== "NONE" || result.productionMutationAllowed !== false || result.aiAuthority !== "ZERO_AUTHORITY") throw new Error("rejected");
  } catch { throw new Error("CAUSAL_DISPATCH_CLAIM_REJECTED"); }
  return true;
}

if (require.main === module) {
  Promise.resolve().then(() => JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")))
    .then((event) => claimCausalDispatch(event))
    .catch(() => { console.error("CAUSAL_DISPATCH_CLAIM_FAILED"); process.exitCode = 1; });
}

module.exports = { claimCausalDispatch };
