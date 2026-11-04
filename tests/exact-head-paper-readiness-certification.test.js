const test = require("node:test");
const assert = require("node:assert/strict");
const { canonical, sha256 } = require("../scripts/actual-paper-runtime-e2e.js");
const { certifyExactHeadPaperReadiness } = require("../scripts/certify-exact-head-paper-readiness.js");

const SHA = "3821b9d97aa9b80c3c983c171b7f8bade29f5681";
const COMPLETE = "COMPLETE_AUTONOMOUS_EXECUTION_OBSERVED";

function withHash(evidence) {
  const { artifact_hash: _ignored, ...withoutHash } = evidence;
  return {
    ...withoutHash,
    artifact_hash: { algorithm: "sha256", value: sha256(canonical(withoutHash)) },
  };
}

function completeEvidence(overrides = {}) {
  return withHash({
    schema_version: 1,
    evidence_type: "nusa.actual-paper-runtime-e2e",
    result: "PASS",
    source_commit: SHA,
    workflow_run: { id: 34069372617, attempt: 1 },
    authority: {
      mode: "PAPER_ONLY",
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    },
    market_data: {
      provider: "UPBIT",
      channel: "PUBLIC_TICKER",
      market: "KRW-TEST",
      private_credentials_used: false,
    },
    prohibited_capabilities: {
      upbit_private_credentials: false,
      live_order_endpoint: false,
      withdrawal_transfer: false,
      real_money_mutation: false,
    },
    runtime_safety_smoke: {
      status: "PASS",
      public_market_runtime_observed: true,
      restart_recovery_observed: true,
      live_authority: "NONE",
      production_mutation_allowed: false,
    },
    autonomous_trading_certification: {
      status: COMPLETE,
      automatic_order_observed: true,
      automatic_fill_observed: true,
      account_or_pnl_change_observed: true,
    },
    production_readiness: {
      status: COMPLETE,
      runtime_safety_smoke_passed: true,
      automatic_order_observed: true,
      automatic_fill_observed: true,
      account_or_pnl_change_observed: true,
      live_mutation_observed: false,
      completion_claim_allowed: true,
    },
    ...overrides,
  });
}

function context(overrides = {}) {
  return {
    targetSha: SHA,
    sourceRunId: "34069372617",
    sourceRunAttempt: "1",
    sourceRunHeadSha: SHA,
    artifactId: "9999970869",
    artifactName: `wo-0059-actual-paper-runtime-evidence-${SHA}-attempt-1`,
    artifactDigest: "sha256:918f7e4e307a78e8a998663485d1d5c319834886292c1696a4725d33d4ce527e",
    certifiedAt: "2026-09-07T00:20:00.000Z",
    ...overrides,
  };
}

test("same-head complete PAPER evidence produces a non-LIVE readiness receipt", () => {
  const receipt = certifyExactHeadPaperReadiness(completeEvidence(), context());
  assert.equal(receipt.status, "CERTIFIED");
  assert.equal(receipt.target_sha, SHA);
  assert.equal(receipt.semantic_proof.automatic_order_observed, true);
  assert.equal(receipt.semantic_proof.automatic_fill_observed, true);
  assert.equal(receipt.semantic_proof.account_or_pnl_change_observed, true);
  assert.equal(receipt.authority.liveAuthority, "NONE");
  assert.equal(receipt.authority.productionMutationAllowed, false);
  assert.equal(receipt.authority.liveTradingAuthorityGranted, false);
  assert.equal(receipt.authority.restrictedLiveActivationAuthorized, false);
});

test("stale-head PAPER evidence cannot certify the current target SHA", () => {
  const stale = "1111111111111111111111111111111111111111";
  assert.throws(
    () => certifyExactHeadPaperReadiness(completeEvidence({ source_commit: stale }), context()),
    /EVIDENCE_SOURCE_COMMIT_MISMATCH/,
  );
  assert.throws(
    () => certifyExactHeadPaperReadiness(completeEvidence(), context({ sourceRunHeadSha: stale })),
    /SOURCE_RUN_HEAD_MISMATCH/,
  );
});

test("workflow success with incomplete order-fill-PnL semantics is rejected", () => {
  const evidence = completeEvidence({
    autonomous_trading_certification: {
      status: "INCOMPLETE_NO_AUTONOMOUS_ORDER_FILL_PNL",
      automatic_order_observed: false,
      automatic_fill_observed: false,
      account_or_pnl_change_observed: false,
    },
    production_readiness: {
      status: "INCOMPLETE_NO_AUTONOMOUS_ORDER_FILL_PNL",
      runtime_safety_smoke_passed: true,
      automatic_order_observed: false,
      automatic_fill_observed: false,
      account_or_pnl_change_observed: false,
      live_mutation_observed: false,
      completion_claim_allowed: false,
    },
  });
  assert.throws(
    () => certifyExactHeadPaperReadiness(evidence, context()),
    /AUTONOMOUS_EXECUTION_INCOMPLETE/,
  );
});

test("any LIVE mutation or authority escalation is rejected", () => {
  const mutation = completeEvidence({
    prohibited_capabilities: {
      upbit_private_credentials: false,
      live_order_endpoint: false,
      withdrawal_transfer: false,
      real_money_mutation: true,
    },
  });
  assert.throws(
    () => certifyExactHeadPaperReadiness(mutation, context()),
    /REAL_MONEY_MUTATION_OBSERVED/,
  );

  const authority = completeEvidence({
    authority: {
      mode: "PAPER_ONLY",
      liveAuthority: "SOME",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    },
  });
  assert.throws(
    () => certifyExactHeadPaperReadiness(authority, context()),
    /LIVE_AUTHORITY_NOT_NONE/,
  );
});

test("artifact identity is exact-head bound", () => {
  assert.throws(
    () => certifyExactHeadPaperReadiness(completeEvidence(), context({ artifactName: "wo-0059-actual-paper-runtime-evidence-stale" })),
    /ARTIFACT_NAME_MISMATCH/,
  );
  assert.throws(
    () => certifyExactHeadPaperReadiness(completeEvidence(), context({ artifactName: `wo-0059-actual-paper-runtime-evidence-${SHA}-attempt-2` })),
    /ARTIFACT_NAME_MISMATCH/,
  );
});

test("producer evidence and readiness receipt bind the exact workflow run attempt", () => {
  const receipt = certifyExactHeadPaperReadiness(completeEvidence(), context());
  assert.equal(receipt.source.run_id, 34069372617);
  assert.equal(receipt.source.run_attempt, 1);

  assert.throws(
    () => certifyExactHeadPaperReadiness(completeEvidence(), context({
      sourceRunAttempt: "2",
      artifactName: `wo-0059-actual-paper-runtime-evidence-${SHA}-attempt-2`,
    })),
    /EVIDENCE_SOURCE_RUN_ATTEMPT_MISMATCH/,
  );
  assert.throws(
    () => certifyExactHeadPaperReadiness(completeEvidence(), context({ sourceRunId: "34069372618" })),
    /EVIDENCE_SOURCE_RUN_ID_MISMATCH/,
  );
  assert.throws(
    () => certifyExactHeadPaperReadiness(completeEvidence({ workflow_run: null }), context()),
    /EVIDENCE_SOURCE_RUN_ID_MISMATCH/,
  );
});
