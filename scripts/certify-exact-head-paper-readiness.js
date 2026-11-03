const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { canonical, sha256 } = require("./actual-paper-runtime-e2e.js");

const COMPLETE = "COMPLETE_AUTONOMOUS_EXECUTION_OBSERVED";
const RECEIPT_TYPE = "nusa.exact-head-paper-readiness";

function requireCondition(condition, message) {
  if (!condition) throw new Error(`EXACT_HEAD_PAPER_READINESS_REJECTED:${message}`);
}

function verifyEvidenceHash(evidence) {
  const hash = evidence?.artifact_hash;
  requireCondition(hash?.algorithm === "sha256", "EVIDENCE_HASH_ALGORITHM");
  requireCondition(typeof hash?.value === "string" && /^[a-f0-9]{64}$/i.test(hash.value), "EVIDENCE_HASH_MISSING");
  const { artifact_hash: _ignored, ...withoutHash } = evidence;
  requireCondition(sha256(canonical(withoutHash)) === hash.value, "EVIDENCE_HASH_MISMATCH");
}

function certifyExactHeadPaperReadiness(evidence, context) {
  requireCondition(evidence && typeof evidence === "object", "EVIDENCE_NOT_OBJECT");
  requireCondition(context && typeof context === "object", "CONTEXT_NOT_OBJECT");

  const targetSha = String(context.targetSha || "").toLowerCase();
  requireCondition(/^[a-f0-9]{40}$/.test(targetSha), "TARGET_SHA_INVALID");
  requireCondition(String(context.sourceRunHeadSha || "").toLowerCase() === targetSha, "SOURCE_RUN_HEAD_MISMATCH");
  requireCondition(String(evidence.source_commit || "").toLowerCase() === targetSha, "EVIDENCE_SOURCE_COMMIT_MISMATCH");
  requireCondition(evidence.evidence_type === "nusa.actual-paper-runtime-e2e", "EVIDENCE_TYPE_MISMATCH");
  requireCondition(evidence.result === "PASS", "EVIDENCE_RESULT_NOT_PASS");

  requireCondition(Number.isSafeInteger(Number(context.sourceRunId)) && Number(context.sourceRunId) > 0, "SOURCE_RUN_ID_INVALID");
  requireCondition(Number.isSafeInteger(Number(context.sourceRunAttempt)) && Number(context.sourceRunAttempt) > 0, "SOURCE_RUN_ATTEMPT_INVALID");
  const expectedArtifactName = `wo-0059-actual-paper-runtime-evidence-${targetSha}-attempt-${Number(context.sourceRunAttempt)}`;
  requireCondition(context.artifactName === expectedArtifactName, "ARTIFACT_NAME_MISMATCH");
  requireCondition(Number.isSafeInteger(Number(context.artifactId)) && Number(context.artifactId) > 0, "ARTIFACT_ID_INVALID");
  requireCondition(/^sha256:[a-f0-9]{64}$/i.test(String(context.artifactDigest || "")), "ARTIFACT_DIGEST_INVALID");
  requireCondition(Number(evidence?.workflow_run?.id) === Number(context.sourceRunId), "EVIDENCE_SOURCE_RUN_ID_MISMATCH");
  requireCondition(Number(evidence?.workflow_run?.attempt) === Number(context.sourceRunAttempt), "EVIDENCE_SOURCE_RUN_ATTEMPT_MISMATCH");

  verifyEvidenceHash(evidence);

  requireCondition(evidence?.authority?.mode === "PAPER_ONLY", "MODE_NOT_PAPER_ONLY");
  requireCondition(evidence?.authority?.liveAuthority === "NONE", "LIVE_AUTHORITY_NOT_NONE");
  requireCondition(evidence?.authority?.productionMutationAllowed === false, "PRODUCTION_MUTATION_ALLOWED");
  requireCondition(evidence?.authority?.aiAuthority === "ZERO_AUTHORITY", "AI_AUTHORITY_NOT_ZERO");

  requireCondition(evidence?.market_data?.provider === "UPBIT", "PUBLIC_MARKET_PROVIDER_MISMATCH");
  requireCondition(evidence?.market_data?.channel === "PUBLIC_TICKER", "PUBLIC_MARKET_CHANNEL_MISMATCH");
  requireCondition(evidence?.market_data?.private_credentials_used === false, "PRIVATE_CREDENTIALS_USED");

  requireCondition(evidence?.prohibited_capabilities?.upbit_private_credentials === false, "PRIVATE_EXCHANGE_CAPABILITY_PRESENT");
  requireCondition(evidence?.prohibited_capabilities?.live_order_endpoint === false, "LIVE_ORDER_ENDPOINT_PRESENT");
  requireCondition(evidence?.prohibited_capabilities?.withdrawal_transfer === false, "WITHDRAWAL_TRANSFER_PRESENT");
  requireCondition(evidence?.prohibited_capabilities?.real_money_mutation === false, "REAL_MONEY_MUTATION_OBSERVED");

  requireCondition(evidence?.runtime_safety_smoke?.status === "PASS", "RUNTIME_SAFETY_SMOKE_NOT_PASS");
  requireCondition(evidence?.runtime_safety_smoke?.public_market_runtime_observed === true, "PUBLIC_MARKET_RUNTIME_NOT_OBSERVED");
  requireCondition(evidence?.runtime_safety_smoke?.live_authority === "NONE", "SMOKE_LIVE_AUTHORITY_NOT_NONE");
  requireCondition(evidence?.runtime_safety_smoke?.production_mutation_allowed === false, "SMOKE_PRODUCTION_MUTATION_ALLOWED");

  requireCondition(evidence?.autonomous_trading_certification?.status === COMPLETE, "AUTONOMOUS_EXECUTION_INCOMPLETE");
  requireCondition(evidence?.autonomous_trading_certification?.automatic_order_observed === true, "AUTOMATIC_ORDER_NOT_OBSERVED");
  requireCondition(evidence?.autonomous_trading_certification?.automatic_fill_observed === true, "AUTOMATIC_FILL_NOT_OBSERVED");
  requireCondition(evidence?.autonomous_trading_certification?.account_or_pnl_change_observed === true, "ACCOUNT_PNL_CHANGE_NOT_OBSERVED");

  requireCondition(evidence?.production_readiness?.status === COMPLETE, "PRODUCTION_READINESS_INCOMPLETE");
  requireCondition(evidence?.production_readiness?.runtime_safety_smoke_passed === true, "PRODUCTION_SAFETY_SMOKE_NOT_PASS");
  requireCondition(evidence?.production_readiness?.automatic_order_observed === true, "READINESS_ORDER_NOT_OBSERVED");
  requireCondition(evidence?.production_readiness?.automatic_fill_observed === true, "READINESS_FILL_NOT_OBSERVED");
  requireCondition(evidence?.production_readiness?.account_or_pnl_change_observed === true, "READINESS_ACCOUNT_PNL_NOT_OBSERVED");
  requireCondition(evidence?.production_readiness?.live_mutation_observed === false, "READINESS_LIVE_MUTATION_OBSERVED");
  requireCondition(evidence?.production_readiness?.completion_claim_allowed === true, "COMPLETION_CLAIM_NOT_ALLOWED");

  return {
    schema_version: 1,
    receipt_type: RECEIPT_TYPE,
    status: "CERTIFIED",
    target_sha: targetSha,
    source: {
      workflow: "Actual PAPER Public-Market Runtime Evidence",
      workflow_path: ".github/workflows/wo-0059-actual-paper-runtime.yml",
      run_id: Number(context.sourceRunId),
      run_attempt: Number(context.sourceRunAttempt),
      run_head_sha: targetSha,
      artifact_id: Number(context.artifactId),
      artifact_name: context.artifactName,
      artifact_digest: context.artifactDigest,
      evidence_hash: evidence.artifact_hash,
    },
    semantic_proof: {
      public_market_runtime_observed: true,
      automatic_order_observed: true,
      automatic_fill_observed: true,
      account_or_pnl_change_observed: true,
      live_mutation_observed: false,
      completion_claim_allowed: true,
    },
    authority: {
      mode: "PAPER_ONLY",
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
      restrictedLiveActivationAuthorized: false,
      liveTradingAuthorityGranted: false,
    },
    certified_at: context.certifiedAt || new Date().toISOString(),
  };
}

function main(argv = process.argv.slice(2)) {
  const [evidencePath, targetSha, sourceRunId, sourceRunAttempt, sourceRunHeadSha, artifactId, artifactName, artifactDigest, outputPath] = argv;
  if (!outputPath) {
    throw new Error("usage: node scripts/certify-exact-head-paper-readiness.js <evidence.json> <target-sha> <source-run-id> <source-run-attempt> <source-run-head-sha> <artifact-id> <artifact-name> <artifact-digest> <receipt.json>");
  }
  const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"));
  const receipt = certifyExactHeadPaperReadiness(evidence, {
    targetSha,
    sourceRunId,
    sourceRunAttempt,
    sourceRunHeadSha,
    artifactId,
    artifactName,
    artifactDigest,
  });
  writeFileSync(resolve(outputPath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: receipt.status, target_sha: receipt.target_sha, liveAuthority: receipt.authority.liveAuthority, productionMutationAllowed: receipt.authority.productionMutationAllowed, liveTradingAuthorityGranted: receipt.authority.liveTradingAuthorityGranted })}\n`);
}

if (require.main === module) main();

module.exports = { COMPLETE, RECEIPT_TYPE, certifyExactHeadPaperReadiness, verifyEvidenceHash };
