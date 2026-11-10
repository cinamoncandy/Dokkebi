const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-autopilot-cloudflare-runtime.mjs"), "utf8");
const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "autopilot-cloudflare-runtime-proof.yml"), "utf8");

test("runtime proof runs hourly away from the scheduler burst and uploads bounded evidence", () => {
  assert.equal(workflow.includes("cron: '37 * * * *'"), true);
  assert.equal(workflow.includes("workflow_run:"), true);
  assert.equal(workflow.includes("workflows: [Autopilot Cloudflare Deploy]"), true);
  assert.equal(workflow.includes("branches: [main]"), true);
  assert.equal(workflow.includes("github.event.workflow_run.head_sha"), true);
  assert.equal(workflow.includes("NUSA_RUNTIME_PROOF_OUTPUT"), true);
  assert.equal(workflow.includes("NUSA_RUNTIME_PROOF_EVENT"), true);
  assert.equal(workflow.includes("NUSA_RUNTIME_PROOF_RUN_ID"), true);
  assert.equal(workflow.includes("NUSA_RUNTIME_PROOF_SOURCE_SHA"), true);
  assert.equal(workflow.includes("name: Upload runtime proof evidence"), true);
  assert.equal(workflow.includes("if: always()"), true);
  assert.equal(workflow.includes("retention-days: 7"), true);
});

test("only exact-current runtime proof directly dispatches Credential Preflight", () => {
  // #1860: the workflow default is read-only; only the dispatch job, which checks out
  // nothing and runs no repository code, holds Actions write authority.
  assert.match(workflow, /\npermissions:\s*\n  contents: read\s*\n\S/);
  const proofJob = workflow.slice(workflow.indexOf("\n  runtime-proof:"), workflow.indexOf("\n  dispatch-preflight:"));
  const dispatchJob = workflow.slice(workflow.indexOf("\n  dispatch-preflight:"));
  assert.equal(proofJob.includes("actions: write"), false);
  assert.equal(proofJob.includes("/dispatches"), false);
  assert.match(dispatchJob, /needs: runtime-proof/);
  assert.match(dispatchJob, /permissions:\s*\n\s*actions: write/);
  assert.equal(dispatchJob.includes("contents:"), false);
  assert.equal(dispatchJob.includes("actions/checkout"), false);
  assert.equal(dispatchJob.includes("node "), false);
  assert.match(dispatchJob, /if: \$\{\{ always\(\) && github\.event_name != 'pull_request' && needs\.runtime-proof\.outputs\.preflight_eligible == 'true' \}\}/);
  assert.equal(workflow.includes("Dispatch Credential Preflight directly for fresh safety-gate re-verification"), true);
  assert.equal(workflow.includes("single canonical post-runtime ingress"), true);
  assert.equal(workflow.includes("actions/workflows/autopilot-cloudflare-credential-preflight.yml/dispatches"), true);
  const dispatchIndex = workflow.indexOf("Dispatch Credential Preflight directly");
  assert.ok(dispatchIndex > 0);
  assert.equal(workflow.includes("proof.exactHeadVerified === true"), true);
  assert.equal(workflow.includes("revision === sourceSha"), true);
  assert.equal(workflow.includes("preflight_eligible="), true);
  assert.match(proofJob, /preflight_eligible: \$\{\{ steps\.freshness\.outputs\.current == 'true' && steps\.proof\.outputs\.preflight_eligible == 'true' \}\}/);
});

test("runtime proof distinguishes scheduler, receipt, and worker failures without exposing credentials", () => {
  for (const classification of ["proof_not_scheduled", "proof_scheduled_late", "worker_receipt_stale", "worker_unreachable", "proof_invalid"]) {
    assert.equal(script.includes('"' + classification + '"'), true, classification);
  }
  assert.equal(script.includes("schemaVersion: 2"), true);
  assert.equal(script.includes('liveAuthority: "NONE"'), true);
  assert.equal(script.includes("productionMutationAllowed: false"), true);
  assert.equal(script.includes('aiAuthority: "ZERO_AUTHORITY"'), true);
  for (const marker of ["proofId", "workerReceiptIdentity", "evidenceFingerprint", "HEAD_MISMATCH_FAILED_CLOSED", "auth_failed_closed", "MAX_TRANSIENT_ATTEMPTS"]) {
    assert.equal(script.includes(marker), true, marker);
  }
  assert.doesNotMatch(script, /Authorization|Bearer|cookie|secret/i);
});

function healthBody() {
  return {
    service: "nusa-autopilot",
    status: "WEBHOOK_READY",
    deploymentRevision: "revision-test",
    persistentExecutionCoordination: "CONFIGURED",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  };
}

function scheduledBody(headSha, workflowRunId = 999) {
  const now = 1_700_000_000_000;
  return {
    status: "OBSERVED",
    receipt: {
      scheduledTime: now - 1_000,
      observedAt: now,
      status: "DUPLICATE_EXECUTION_SUPPRESSED",
      reason: "scheduled-state-unchanged",
      headSha,
      workflowRunId,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    },
    history: [],
    summary: null,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  };
}

async function loadVerifier() {
  return import(pathToFileURL(path.join(__dirname, "..", "scripts", "verify-autopilot-cloudflare-runtime.mjs")).href);
}

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fetchSequence({ headSha, transientScheduledFailures = 0, healthStatus = 200, scheduledPayload }) {
  let healthCalls = 0;
  let scheduledCalls = 0;
  return {
    get calls() { return { healthCalls, scheduledCalls }; },
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) {
        healthCalls += 1;
        return response(healthStatus, healthBody());
      }
      scheduledCalls += 1;
      if (scheduledCalls <= transientScheduledFailures) return response(503, { error: "temporary" });
      return response(200, scheduledPayload ?? scheduledBody(headSha));
    },
  };
}

test("scheduled proof binds the actual workflow run and exact source head", async () => {
  const sourceSha = "a".repeat(40);
  const sequence = fetchSequence({ headSha: sourceSha });
  const verifier = await loadVerifier();
  const proof = await verifier.collectRuntimeProof({
    fetchImpl: sequence.fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowName: "Autopilot Cloudflare Runtime Proof", workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha },
    now: 1_700_000_000_500,
  });
  assert.equal(proof.proofStatus, "PROOF_FRESH");
  assert.equal(proof.workflowRunId, 12345);
  assert.equal(proof.workerReceiptWorkflowRunId, 999);
  assert.equal(proof.sourceSha, sourceSha);
  assert.equal(proof.expectedMainSha, sourceSha);
  assert.equal(proof.exactHeadVerified, true);
  assert.equal(typeof proof.proofId, "string");
  assert.equal(proof.proofId, proof.evidenceFingerprint);
  assert.deepEqual(sequence.calls, { healthCalls: 1, scheduledCalls: 1 });
});

test("runtime context preserves the workflow start timestamp when supplied as ISO evidence", async () => {
  const sourceSha = "a".repeat(40);
  const verifier = await loadVerifier();
  const previous = process.env.NUSA_RUNTIME_PROOF_STARTED_AT;
  process.env.NUSA_RUNTIME_PROOF_STARTED_AT = "2026-08-31T02:00:00.000Z";
  try {
    const proof = await verifier.collectRuntimeProof({
      fetchImpl: fetchSequence({ headSha: sourceSha }).fetchImpl,
      requestBaseUrl: "https://example.test",
      contextOverride: {
        workflowRunId: 12345,
        workflowRunAttempt: 1,
        triggerType: "schedule",
        sourceBranch: "main",
        sourceSha,
      },
      now: 1_700_000_000_500,
    });
    assert.equal(proof.actualStartTimestamp, Date.parse("2026-08-31T02:00:00.000Z"));
  } finally {
    if (previous === undefined) delete process.env.NUSA_RUNTIME_PROOF_STARTED_AT;
    else process.env.NUSA_RUNTIME_PROOF_STARTED_AT = previous;
  }
});

test("transient runtime failures retry only within the bounded budget", async () => {
  const sourceSha = "a".repeat(40);
  const sequence = fetchSequence({ headSha: sourceSha, transientScheduledFailures: 1 });
  const verifier = await loadVerifier();
  const proof = await verifier.collectRuntimeProof({
    fetchImpl: sequence.fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha },
    now: 1_700_000_000_500,
  });
  assert.equal(proof.proofStatus, "PROOF_FRESH");
  assert.deepEqual(sequence.calls, { healthCalls: 1, scheduledCalls: 2 });
});

test("a scheduled receipt from another head fails closed", async () => {
  const verifier = await loadVerifier();
  await assert.rejects(() => verifier.collectRuntimeProof({
    fetchImpl: fetchSequence({ headSha: "b".repeat(40) }).fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha: "a".repeat(40) },
    now: 1_700_000_000_500,
  }), (error) => error?.classification === "head_mismatch_failed_closed" && error?.reasonCode === "HEAD_MISMATCH_FAILED_CLOSED");
});

test("push verification cannot be counted as a scheduled proof", async () => {
  const sourceSha = "a".repeat(40);
  const verifier = await loadVerifier();
  const proof = await verifier.collectRuntimeProof({
    fetchImpl: fetchSequence({ headSha: sourceSha }).fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "push", sourceBranch: "main", sourceSha },
    now: 1_700_000_000_500,
  });
  assert.equal(proof.proofStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(proof.exactHeadVerified, true);
});

test("successful canonical main workflow_run is an event-driven proof", async () => {
  const sourceSha = "a".repeat(40);
  const verifier = await loadVerifier();
  const proof = await verifier.collectRuntimeProof({
    fetchImpl: fetchSequence({ headSha: sourceSha }).fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "workflow_run", sourceBranch: "main", sourceSha },
    now: 1_700_000_000_500,
  });
  assert.equal(proof.proofStatus, "PROOF_FRESH");
  assert.equal(proof.expectedMainSha, sourceSha);
  assert.equal(proof.exactHeadVerified, true);
});

test("event-driven proof from another head fails closed", async () => {
  const verifier = await loadVerifier();
  await assert.rejects(() => verifier.collectRuntimeProof({
    fetchImpl: fetchSequence({ headSha: "b".repeat(40) }).fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "workflow_run", sourceBranch: "main", sourceSha: "a".repeat(40) },
    now: 1_700_000_000_500,
  }), (error) => error?.classification === "head_mismatch_failed_closed" && error?.reasonCode === "HEAD_MISMATCH_FAILED_CLOSED");
});

test("missing scheduled evidence is classified as proof_not_scheduled", async () => {
  const sourceSha = "a".repeat(40);
  const sequence = fetchSequence({
    headSha: sourceSha,
    scheduledPayload: {
      status: "AWAITING_FIRST_SCHEDULED_EVENT",
      receipt: null,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    },
  });
  const verifier = await loadVerifier();
  await assert.rejects(() => verifier.collectRuntimeProof({
    fetchImpl: sequence.fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha },
    now: 1_700_000_000_500,
  }), (error) => error?.classification === "proof_not_scheduled" && error?.reasonCode === "PROOF_NOT_SCHEDULED");
  assert.deepEqual(sequence.calls, { healthCalls: 1, scheduledCalls: 1 });
});

test("a scheduled receipt observed after its allowed schedule window is classified as proof_scheduled_late", async () => {
  const sourceSha = "a".repeat(40);
  const observedAt = 1_700_000_000_000;
  const sequence = fetchSequence({
    headSha: sourceSha,
    scheduledPayload: {
      status: "OBSERVED",
      receipt: {
        scheduledTime: observedAt - 180_001,
        observedAt,
        status: "DUPLICATE_EXECUTION_SUPPRESSED",
        reason: "scheduled-state-unchanged",
        headSha: sourceSha,
        workflowRunId: 999,
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      },
      history: [],
      summary: null,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    },
  });
  const verifier = await loadVerifier();
  await assert.rejects(() => verifier.collectRuntimeProof({
    fetchImpl: sequence.fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha },
    now: observedAt + 500,
  }), (error) => error?.classification === "proof_scheduled_late" && error?.reasonCode === "PROOF_SCHEDULED_LATE");
  assert.deepEqual(sequence.calls, { healthCalls: 1, scheduledCalls: 1 });
});

test("authentication failures fail closed without retry", async () => {
  const verifier = await loadVerifier();
  const sequence = fetchSequence({ headSha: "a".repeat(40), healthStatus: 401 });
  await assert.rejects(() => verifier.collectRuntimeProof({
    fetchImpl: sequence.fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha: "a".repeat(40) },
    now: 1_700_000_000_500,
  }), (error) => error?.classification === "auth_failed_closed");
  assert.deepEqual(sequence.calls, { healthCalls: 1, scheduledCalls: 0 });
});

test("retry exhaustion remains bounded and stale receipts never pass", async () => {
  const verifier = await loadVerifier();
  const sequence = fetchSequence({ headSha: "a".repeat(40), transientScheduledFailures: 2 });
  await assert.rejects(() => verifier.collectRuntimeProof({
    fetchImpl: sequence.fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha: "a".repeat(40) },
    now: 1_700_000_000_500,
  }), (error) => error?.classification === "worker_unreachable" && error?.retryCount === 1);
  assert.deepEqual(sequence.calls, { healthCalls: 1, scheduledCalls: 2 });

  const staleSequence = fetchSequence({ headSha: "a".repeat(40) });
  await assert.rejects(() => verifier.collectRuntimeProof({
    fetchImpl: staleSequence.fetchImpl,
    requestBaseUrl: "https://example.test",
    contextOverride: { workflowRunId: 12345, workflowRunAttempt: 1, triggerType: "schedule", sourceBranch: "main", sourceSha: "a".repeat(40) },
    now: 1_700_000_200_000,
  }), (error) => error?.classification === "worker_receipt_stale");
});


test("runtime proof self-heal controller classifies only bounded recoverable failures", () => {
  const healer = fs.readFileSync(path.join(__dirname, "..", "scripts", "autopilot-runtime-proof-self-heal.mjs"), "utf8");
  for (const marker of ["worker_unreachable", "worker_receipt_stale", "proof_not_scheduled", "proof_scheduled_late", "head_mismatch_failed_closed", "SCHEDULED_RECEIPT_HEAD_INVALID"]) assert.equal(healer.includes(marker), true, marker);
  assert.equal(healer.includes("auth_failed_closed"), false);
  assert.match(healer, /maxAttempts\s*>\s*20/);
});

test("runtime proof never treats an un-deployed pull request as Worker acceptance", () => {
  assert.equal(workflow.includes("github.event_name != 'pull_request'"), true);
});

test("runtime proof self-heal retries a recoverable deployed receipt exactly once before success", async () => {
  const healer = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "autopilot-runtime-proof-self-heal.mjs")).href);
  const evidence = [
    { classification: "proof_invalid", reasonCode: "SCHEDULED_RECEIPT_HEAD_INVALID" },
    { status: "PASS", proofStatus: "PROOF_FRESH" },
  ];
  let verifications = 0;
  let waits = 0;
  const result = await healer.runSelfHeal({
    verify: async () => (++verifications === 1 ? 1 : 0),
    wait: async () => { waits += 1; },
    readEvidence: () => evidence.shift() ?? null,
  });
  assert.deepEqual(result, { status: "VERIFIED", attempts: 2 });
  assert.equal(waits, 1);
});


test("runtime proof self-heal covers propagation, next cron interval and execution margin", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "autopilot-runtime-proof-self-heal.mjs"), "utf8");
  assert.equal(source.includes("?? 20"), true);
  const attempts = Number(source.match(/MAX_ATTEMPTS \?\? (\d+)/)[1]);
  const delay = Number(source.match(/DELAY_MS \?\? (\d+)/)[1]);
  const timeout = Number(workflow.match(/timeout-minutes: (\d+)/)[1]) * 60_000;
  assert.ok((attempts - 1) * delay >= 20 * 60_000 + 120_000);
  assert.ok(timeout >= (attempts - 1) * delay + 120_000);
});

test("runtime proof self-heal suppresses stale main after head mismatch", async () => {
  const healer = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "autopilot-runtime-proof-self-heal.mjs")).href + "?stale=" + Date.now());
  const previousSha = process.env.NUSA_RUNTIME_PROOF_SOURCE_SHA;
  const previousBranch = process.env.NUSA_RUNTIME_PROOF_SOURCE_BRANCH;
  process.env.NUSA_RUNTIME_PROOF_SOURCE_SHA = "a".repeat(40);
  process.env.NUSA_RUNTIME_PROOF_SOURCE_BRANCH = "main";
  try {
    const result = await healer.runSelfHeal({
      verify: async () => 1,
      wait: async () => {},
      readEvidence: () => ({ classification: "head_mismatch_failed_closed", reasonCode: "HEAD_MISMATCH_FAILED_CLOSED" }),
      readCurrentMain: async () => "b".repeat(40),
      expectedSourceSha: "a".repeat(40),
      expectedSourceBranch: "main",
    });
    assert.deepEqual(result, { status: "STALE_SOURCE_SUPPRESSED", attempts: 1, reason: "MAIN_ADVANCED" });
  } finally {
    if (previousSha === undefined) delete process.env.NUSA_RUNTIME_PROOF_SOURCE_SHA;
    else process.env.NUSA_RUNTIME_PROOF_SOURCE_SHA = previousSha;
    if (previousBranch === undefined) delete process.env.NUSA_RUNTIME_PROOF_SOURCE_BRANCH;
    else process.env.NUSA_RUNTIME_PROOF_SOURCE_BRANCH = previousBranch;
  }
});

test("runtime proof self-heal does not call insufficient evidence verified", async () => {
  const healer = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "autopilot-runtime-proof-self-heal.mjs")).href + "?insufficient=" + Date.now());
  const result = await healer.runSelfHeal({
    verify: async () => 0,
    wait: async () => {},
    readEvidence: () => ({ status: "INSUFFICIENT_EVIDENCE", proofStatus: "INSUFFICIENT_EVIDENCE" }),
  });
  assert.deepEqual(result, { status: "INSUFFICIENT_EVIDENCE", attempts: 1, reason: "INSUFFICIENT_EVIDENCE" });
});
