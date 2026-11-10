const fs = require("node:fs");
const path = require("node:path");
const { readBoundedRejectionStage } = require("./isolated-rejection-stage.js");

const REPOSITORY = "cinamoncandy/NUSA";
const OIDC_AUDIENCE = "nusa-isolated-causal-verification-v1";
const WORKER_ENDPOINT = "https://nusa-autopilot.desporin12.workers.dev/isolated/causal/verify-and-run";
let receiptPathForFailure;
let eventForFailure;

function writeFailureReceipt(code, workerRejectionStage) {
  if (!receiptPathForFailure) return;
  const run = eventForFailure?.workflow_run;
  const sourceSha = typeof run?.head_sha === "string" && /^[a-f0-9]{40}$/.test(run.head_sha) ? run.head_sha : null;
  const sourceRunId = Number.isSafeInteger(run?.id) && run.id > 0 ? String(run.id) : null;
  const sourceRunAttempt = Number.isSafeInteger(run?.run_attempt) && run.run_attempt > 0 ? String(run.run_attempt) : null;
  const receipt = Object.freeze({
    schemaVersion: 1,
    receiptType: "NUSA_ISOLATED_CAUSAL_VERIFICATION_RESULT_V1",
    domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1",
    outcome: "FAIL_CLOSED_OR_UNKNOWN",
    failureCode: code,
    ...(typeof workerRejectionStage === "string" && /^[A-Z][A-Z0-9_]{2,95}(?::[A-Za-z0-9_]{1,64}){0,4}$/.test(workerRejectionStage) ? { workerRejectionStage } : {}),
    sourceSha,
    sourceRunId,
    sourceRunAttempt,
    claimOutcome: "UNKNOWN",
    mutationAllowed: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    realOrderAuthority: false,
    realTransferAuthority: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
  try { fs.writeFileSync(receiptPathForFailure, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch { /* Preserve an existing receipt and never mask the primary failure. */ }
}

const fail = (code, workerRejectionStage) => {
  writeFailureReceipt(code, workerRejectionStage);
  console.error(workerRejectionStage ? `${code} ${workerRejectionStage}` : code);
  process.exit(1);
};

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const bundlePath = process.env.NUSA_ATTESTATION_BUNDLE;
  const receiptPath = process.env.NUSA_VERIFICATION_RECEIPT;
  receiptPathForFailure = typeof receiptPath === "string" && receiptPath.length > 0 ? receiptPath : undefined;
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (![eventPath, bundlePath, receiptPath].every((value) => typeof value === "string" && value.length > 0)) {
    fail("ISOLATED_VERIFICATION_INPUT_MISSING");
  }

  let event;
  let bundle;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    eventForFailure = event;
    const resolvedBundlePath = path.resolve(bundlePath);
    const stats = fs.statSync(resolvedBundlePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > 512 * 1024) fail("ISOLATED_ATTESTATION_BUNDLE_SIZE_INVALID");
    bundle = JSON.parse(fs.readFileSync(resolvedBundlePath, "utf8"));
  } catch {
    fail("ISOLATED_VERIFICATION_INPUT_INVALID");
  }

  if (![requestUrl, requestToken].every((value) => typeof value === "string" && value.length > 0)) {
    fail("ISOLATED_VERIFICATION_INPUT_MISSING");
  }

  const run = event?.workflow_run;
  if (event?.repository?.full_name !== REPOSITORY
    || run?.head_repository?.full_name !== REPOSITORY || run?.head_branch !== "main"
    || run?.event !== "workflow_dispatch" || run?.status !== "completed" || run?.conclusion !== "success"
    || !Number.isSafeInteger(run?.id) || run.id <= 0
    || !Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0
    || !/^[a-f0-9]{40}$/.test(run?.head_sha || "")) fail("ISOLATED_WORKFLOW_RUN_EVENT_NOT_ELIGIBLE");

  let oidcUrl;
  try {
    oidcUrl = new URL(requestUrl);
    if (oidcUrl.protocol !== "https:") fail("ISOLATED_OIDC_REQUEST_URL_INVALID");
    oidcUrl.searchParams.set("audience", OIDC_AUDIENCE);
  } catch {
    fail("ISOLATED_OIDC_REQUEST_URL_INVALID");
  }

  let oidcResponse;
  try {
    oidcResponse = await fetch(oidcUrl, { headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" } });
  } catch {
    fail("ISOLATED_OIDC_TOKEN_UNAVAILABLE");
  }
  if (!oidcResponse.ok) fail("ISOLATED_OIDC_TOKEN_UNAVAILABLE");
  let oidcPayload;
  try { oidcPayload = await oidcResponse.json(); } catch { fail("ISOLATED_OIDC_TOKEN_INVALID"); }
  if (typeof oidcPayload?.value !== "string" || oidcPayload.value.length < 32 || oidcPayload.value.length > 16_384) {
    fail("ISOLATED_OIDC_TOKEN_INVALID");
  }

  let response;
  try {
    response = await fetch(WORKER_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${oidcPayload.value}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sourceRunId: String(run.id), sourceRunAttempt: String(run.run_attempt), attestationBundle: bundle }),
      signal: AbortSignal.timeout(12 * 60_000),
    });
  } catch {
    fail("ISOLATED_VERIFICATION_WORKER_UNAVAILABLE");
  }
  if (!response.ok) {
    // Keep only the Worker's fixed stage constant from a bounded error body; never echo anything else.
    const stage = await readBoundedRejectionStage(response);
    fail(`ISOLATED_VERIFICATION_WORKER_REJECTED_${response.status}`, stage);
  }

  let payload;
  try {
    const responseText = await response.text();
    if (responseText.length > 128 * 1024) fail("ISOLATED_VERIFICATION_RECEIPT_INVALID");
    payload = JSON.parse(responseText);
  } catch { fail("ISOLATED_VERIFICATION_RECEIPT_INVALID"); }
  const source = payload?.receipt;
  if (payload?.accepted !== true || source?.domain !== "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1"
    || source?.decision !== "CODE_ACTIONABLE" || source?.classification !== "REPOSITORY_CODE_REGRESSION"
    || source?.sourceRunId !== String(run.id) || source?.sourceRunAttempt !== String(run.run_attempt)
    || source?.sourceSha !== run.head_sha || source?.durableReplayGuard !== "SQLITE_DURABLE_OBJECT_CLAIMED"
    || !/^[a-f0-9]{64}$/.test(source?.sourceIdentityDigest || "")
    || source?.codingRunnerStatus !== "EXECUTION_ACCEPTED" || source?.proposalAdapterCalls !== 1 || source?.sandboxExecutions !== 1
    || source?.dedupe !== "REPLAY_REJECTED_WITHIN_SINGLE_HARNESS"
    || source?.mutationAllowed !== false || source?.liveAuthority !== "NONE"
    || source?.productionMutationAllowed !== false || source?.aiAuthority !== "ZERO_AUTHORITY") {
    fail("ISOLATED_VERIFICATION_RECEIPT_INVALID");
  }

  const sanitized = Object.freeze({
    schemaVersion: 1,
    domain: source.domain,
    decision: source.decision,
    classification: source.classification,
    sourceSha: source.sourceSha,
    sourceRunId: source.sourceRunId,
    sourceRunAttempt: source.sourceRunAttempt,
    durableReplayGuard: source.durableReplayGuard,
    sourceIdentityDigest: source.sourceIdentityDigest,
    codingRunnerStatus: source.codingRunnerStatus,
    proposalAdapterCalls: source.proposalAdapterCalls,
    sandboxExecutions: source.sandboxExecutions,
    dedupe: source.dedupe,
    mutationAllowed: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    realOrderAuthority: false,
    realTransferAuthority: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, [
      "## Isolated causal verification",
      "",
      `- Decision: \`${sanitized.decision}\` / \`${sanitized.classification}\``,
      `- Durable guard: \`${sanitized.durableReplayGuard}\` (digest \`${sanitized.sourceIdentityDigest}\`)`,
      `- Runner: \`${sanitized.codingRunnerStatus}\`; proposal calls ${sanitized.proposalAdapterCalls}; sandbox executions ${sanitized.sandboxExecutions}`,
      `- Source: \`${sanitized.sourceSha}\` / run \`${sanitized.sourceRunId}\` attempt \`${sanitized.sourceRunAttempt}\``,
      "- Authority: PAPER_ONLY; liveAuthority=NONE; productionMutationAllowed=false; realOrderAuthority=false; realTransferAuthority=false; aiAuthority=ZERO_AUTHORITY",
      "",
      "This isolated proof does not authorize production admission, repository publication, deployment, orders, or transfers.",
      "",
    ].join("\n"));
  }
  const output = `${JSON.stringify({ receiptType: "NUSA_ISOLATED_CAUSAL_VERIFICATION_RESULT_V1", outcome: "PASS", ...sanitized }, null, 2)}\n`;
  try { fs.writeFileSync(receiptPath, output, { flag: "wx", mode: 0o600 }); }
  catch { fail("ISOLATED_VERIFICATION_RECEIPT_WRITE_FAILED"); }
  console.log(JSON.stringify({ accepted: true, sourceRunId: sanitized.sourceRunId, decision: sanitized.decision }));
}

main().catch(() => fail("ISOLATED_VERIFICATION_FAILED"));
