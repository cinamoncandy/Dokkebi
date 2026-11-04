const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  dispatchWithRetry,
  transientStatus,
  assertBoundedPatch,
  proposalFailureCode,
  providerRateLimitCode,
  readDispatchRequest,
  assertGithubRunnerWorkspaceClean,
  filterGithubRunnerWorkspacePaths,
  boundedWorkerFailureEvidence,
  boundedProposalContext,
  normalizeUnifiedDiffHunkCounts,
  applyPatchWithNormalizedHunkCounts,
  executeGithubActionsRunner,
  MAX_RETRY_DELAY_MS,
  retryHint,
  MAX_REPORTED_QUOTA_RETRY_DELAY_MS,
  boundedRemediationDecision,
  boundedDecisionDiagnostics,
  terminalFailureResult,
  authorizedJsonPost,
} = require("../scripts/autopilot-dispatch-retry.js");

test("invalid Worker decision preserves HTTP and bounded identity through terminal artifact", async () => {
  await withOidcEnvironment(async () => {
    const payload = {
      status: "CODING_PROPOSAL_FAILED_CLOSED",
      httpStatus: 503,
      remediationDecision: { outcome: "FAILED_CLOSED", failureClass: "FUTURE_CLASS", recovery: "STOP", retryable: false, attempt: 0, maxAttempts: 3, secret: "must-not-retain" },
      failureEvidence: { code: "WORKFLOW_NOT_ELIGIBLE", workflowRunId: 123, headSha: "a".repeat(40), workflowName: "Oracle PAPER Release", workflowEvent: "push", token: "example-key" },
    };
    let calls = 0;
    await assert.rejects(() => authorizedJsonPost("https://runner.example.test/coding/propose", { request }, async (url) => {
      if (String(url).startsWith("https://oidc.example.test/token")) return oidcSuccess();
      calls += 1;
      return response(409, payload);
    }), (error) => {
      const result = terminalFailureResult(request, error, 10, () => 20);
      assert.equal(error.message, "CODING_REMEDIATION_DECISION_INVALID");
      assert.equal(result.httpStatus, 409, "transport status cannot be replaced by payload status");
      assert.equal(result.workerHttpStatus, 503);
      assert.equal(result.attempts[0].http_class, "4xx");
      assert.equal(result.failureEvidence.workflowRunId, 123);
      assert.equal(result.failureEvidence.headSha, request.headSha);
      assert.equal(result.failureEvidence.workflowName, "Oracle PAPER Release");
      assert.equal(result.decisionDiagnostics.failureClass, "FUTURE_CLASS");
      assert.equal(result.decisionDiagnostics.recovery, "STOP");
      assert.equal(result.decisionValidationFailure, "SCHEMA_OR_ALLOWLIST_MISMATCH");
      assert.equal(result.workerStatus, payload.status);
      assert.equal(result.summary.execution_id, request.executionId);
      assert.equal(result.summary.dedupe_key, request.dedupeKey);
      assert.equal(result.status, "FAILED_CLOSED");
      assert.equal(result.summary.liveAuthority, "NONE");
      assert.equal(result.summary.productionMutationAllowed, false);
      assert.equal(result.summary.aiAuthority, "ZERO_AUTHORITY");
      assert.equal(JSON.stringify(result).includes("must-not-retain"), false);
      assert.equal(JSON.stringify(result).includes("example-key"), false);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("invalid decision after a bounded retry preserves the full attempt history", async () => {
  await withOidcEnvironment(async () => {
    let proposals = 0;
    const result = await executeGithubActionsRunner(request, "https://runner.example.test/coding/execute", async (url) => {
      if (String(url).startsWith("https://oidc.example.test/token")) return oidcSuccess();
      assert.equal(new URL(url).pathname, "/coding/propose");
      proposals += 1;
      return proposals === 1
        ? response(503, { error: "CODING_PROPOSAL_INVALID", remediationDecision: {
          outcome: "FAILED_TO_REMEDIATE", failureClass: "PROPOSAL_REJECTED",
          recovery: "REGENERATE_PROPOSAL", retryable: true, attempt: 0, maxAttempts: 3,
        } })
        : response(409, { status: "FAILED_CLOSED", remediationDecision: {
          outcome: "FAILED_CLOSED", failureClass: "FUTURE_CLASS", recovery: "STOP",
          retryable: false, attempt: 1, maxAttempts: 3,
        } });
    }, {
      validatePatch: () => { throw new Error("unexpected patch"); },
      publish: () => { throw new Error("unexpected publish"); },
      sleep: async () => { throw new Error("unexpected wait"); },
    });
    assert.equal(proposals, 2);
    assert.equal(result.status, "FAILED_CLOSED");
    assert.equal(result.summary.attempts, 2);
    assert.deepEqual(result.attempts.map((item) => item.attempt), [1, 2]);
    assert.deepEqual(result.attempts.map((item) => item.http_class), ["5xx", "4xx"]);
    assert.deepEqual(result.attempts.map((item) => item.decision), ["RETRY", "FAILED_CLOSED"]);
    assert.deepEqual(result.attempts.map((item) => item.recovery), ["REGENERATE_PROPOSAL", "STOP"]);
    assert.deepEqual(result.attempts.map((item) => item.retryable), [true, false]);
    assert.equal(result.attempts[1].failure_class, "FUTURE_CLASS");
    assert.equal(result.decisionValidationFailure, "SCHEMA_OR_ALLOWLIST_MISMATCH");
  });
});

test("terminal attempts record STOP independently of rejected Worker recovery", () => {
  for (const diagnostics of [null, { failureClass: "FUTURE_CLASS", recovery: "RETRY_BOUNDED" }]) {
    const error = new Error("CODING_REMEDIATION_DECISION_INVALID");
    error.decisionDiagnostics = diagnostics;
    const result = terminalFailureResult(request, error, 10, () => 20);
    assert.equal(result.attempts[0].recovery, "STOP");
    assert.equal(result.attempts[0].retryable, false);
    assert.equal(result.decisionDiagnostics, diagnostics);
  }
});

test("valid provider retry and exhaustion preserve transport and upstream status", async () => {
  await withOidcEnvironment(async () => {
    let proposals = 0;
    const result = await executeGithubActionsRunner(request, "https://runner.example.test/coding/execute", async (url) => {
      if (String(url).startsWith("https://oidc.example.test/token")) return oidcSuccess();
      assert.equal(new URL(url).pathname, "/coding/propose");
      proposals += 1;
      return response(409, { error: "CODING_PROVIDER_UNAVAILABLE", httpStatus: 503, remediationDecision: {
        outcome: "FAILED_TO_REMEDIATE", failureClass: "PROVIDER_FAILURE", recovery: "RETRY_BOUNDED", retryable: true, attempt: 0, maxAttempts: 3,
      } });
    }, {
      validatePatch: () => { throw new Error("unexpected patch"); },
      publish: () => { throw new Error("unexpected publish"); },
      sleep: async () => {},
    });
    assert.equal(proposals, 3);
    assert.equal(result.status, "FAILED_TO_REMEDIATE");
    assert.equal(result.httpStatus, 409);
    assert.equal(result.workerHttpStatus, 503);
    assert.deepEqual(result.attempts.map((item) => item.http_status), [409, 409, 409]);
    assert.deepEqual(result.attempts.map((item) => item.worker_http_status), [503, 503, 503]);
    assert.deepEqual(result.attempts.map((item) => item.worker_http_class), ["5xx", "5xx", "5xx"]);
    assert.deepEqual(result.attempts.map((item) => item.recovery), ["RETRY_BOUNDED", "RETRY_BOUNDED", "STOP"]);
    assert.deepEqual(result.attempts.map((item) => item.retryable), [true, true, false]);
    assert.equal(result.summary.productionMutationAllowed, false);
    assert.equal(result.summary.aiAuthority, "ZERO_AUTHORITY");
  });
});

test("actual Worker decisions retain governance and credential STOP while admitting bounded repair", () => {
  const { decideCodingRunnerNoAction } = require("../dist/apps/autopilot/src/codingRunnerRemediation.js");
  for (const [reason, httpStatus] of [
    ["AUDIT_BLOCKED", 503], ["RELEASE_BLOCKED", 503], ["DEPLOYMENT_FAILURE", 503],
    ["PERMISSION_FAILURE", 429], ["CREDENTIAL_UNAVAILABLE", 401], ["HUMAN_ONLY", 403],
    ["EXTERNAL_DEPENDENCY", 503], ["CODING_RUNNER_LIVE_AUTHORITY_FORBIDDEN", 429],
    ["WORKFLOW_NOT_ELIGIBLE", 503], ["ACTIONABLE_FAILURE_NOT_ALLOWLISTED", 503],
  ]) {
    const decision = decideCodingRunnerNoAction(reason, 0, 3, httpStatus);
    assert.equal(decision.outcome, "FAILED_CLOSED", reason);
    assert.equal(decision.recovery, "STOP", reason);
    assert.equal(decision.retryable, false, reason);
    assert.deepEqual(boundedRemediationDecision(decision), decision, reason);
  }
  const repair = decideCodingRunnerNoAction("SANDBOX_BUILD_FAILED", 0, 3);
  assert.equal(boundedRemediationDecision(repair).retryable, true);
  const exhausted = decideCodingRunnerNoAction("SANDBOX_BUILD_FAILED", 3, 3);
  assert.equal(exhausted.retryable, false);
  assert.equal(boundedRemediationDecision(exhausted), null, "the canonical Worker emits attempt zero; dispatcher owns the retry counter");
  assert.equal(boundedRemediationDecision({ ...repair, attempt: 1 }), null);
});

test("Worker terminal vocabulary is accepted only as fail-closed STOP", () => {
  for (const failureClass of ["AUDIT_BLOCKED", "RELEASE_BLOCKED", "DEPLOYMENT_FAILURE", "PERMISSION_FAILURE", "WORKFLOW_NOT_ELIGIBLE", "AUTHORITY_VIOLATION", "REQUEST_INVALID", "UNKNOWN"]) {
    const value = { outcome: "FAILED_CLOSED", failureClass, recovery: "STOP", retryable: false, attempt: 0, maxAttempts: 3 };
    assert.deepEqual(boundedRemediationDecision(value), value);
    assert.equal(boundedRemediationDecision({ ...value, recovery: "RETRY_BOUNDED" }), null);
    assert.equal(boundedRemediationDecision({ ...value, outcome: "FAILED_TO_REMEDIATE", retryable: true }), null);
  }
  assert.equal(boundedRemediationDecision({ outcome: "FAILED_CLOSED", failureClass: "EXTERNAL_DEPENDENCY", recovery: "STOP", retryable: false, attempt: 0, maxAttempts: 3 }), null);
});

test("diagnostic projection rejects arbitrary and credential-like response fields", () => {
  const result = boundedDecisionDiagnostics({ outcome: "FAILED_CLOSED", failureClass: "TOKEN_SECRET", recovery: "Bearer credential", retryable: false, attempt: 99999, maxAttempts: 99, password: "private" });
  assert.equal(result.failureClass, null);
  assert.equal(result.recovery, null);
  assert.equal(result.attempt, null);
  assert.equal(result.maxAttempts, null);
  assert.equal(Object.hasOwn(result, "password"), false);
});

test("terminal governance and permission decisions never propose again or publish", async () => {
  await withOidcEnvironment(async () => {
    for (const failureClass of ["AUDIT_BLOCKED", "RELEASE_BLOCKED", "DEPLOYMENT_FAILURE", "PERMISSION_FAILURE", "WORKFLOW_NOT_ELIGIBLE", "AUTHORITY_VIOLATION"]) {
      let calls = 0;
      const result = await executeGithubActionsRunner(request, "https://runner.example.test/coding/execute", async (url) => {
        if (String(url).startsWith("https://oidc.example.test/token")) return oidcSuccess();
        assert.match(String(url), /coding\/propose$/);
        calls += 1;
        return response(403, { error: failureClass, status: "CODING_PROPOSAL_FAILED_CLOSED", remediationDecision: { outcome: "FAILED_CLOSED", failureClass, recovery: "STOP", retryable: false, attempt: 0, maxAttempts: 3 } });
      }, { initialProposalContext: () => null });
      assert.equal(calls, 1);
      assert.equal(result.status, "FAILED_CLOSED");
      assert.equal(result.httpStatus, 403);
      assert.equal(result.attempts[0].failure_class, failureClass);
      assert.equal(result.summary.aiAuthority, "ZERO_AUTHORITY");
    }
  });
});

const request = Object.freeze({
  kind: "REPOSITORY_AUTOPILOT",
  repository: "cinamoncandy/NUSA",
  headSha: "a".repeat(40),
  workflowRunId: 123,
  reason: "continue-from:ci_succeeded",
  executionId: "github:execution-1283",
  dedupeKey: "ci:1283:aaa",
  mutationAllowed: false,
  liveAuthority: "NONE",
  productionMutationAllowed: false,
  aiAuthority: "ZERO_AUTHORITY",
});

function response(status, body = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  };
}

function oidcSuccess() {
  return response(200, { value: "oidc-test-value" });
}

async function withOidcEnvironment(run) {
  const previousUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const previousToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.example.test/token";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "oidc-request-test";
  try {
    return await run();
  } finally {
    if (previousUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previousToken;
  }
}

test("classifies only 429 and 5xx as retryable HTTP statuses", () => {
  assert.equal(transientStatus(429), true);
  assert.equal(transientStatus(500), true);
  assert.equal(transientStatus(503), true);
  assert.equal(transientStatus(400), false);
  assert.equal(transientStatus(404), false);
});

test("retries transient OIDC and runner failures with bounded exponential backoff", async () => {
  const calls = [];
  const waits = [];
  const now = 1000;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    maxAttempts: 3,
    baseBackoffMs: 10,
    jitter: () => 0.5,
    now: () => now,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) return response(503);
      if (calls.length === 2 || calls.length === 4) return oidcSuccess();
      if (calls.length === 3) return response(502);
      return response(200, { status: "EXECUTION_ACCEPTED" });
    },
  });
  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.summary.attempts, 3);
  assert.equal(result.summary.retries, 2);
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.decision), ["RETRY", "RETRY", "DISPATCHED"]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.http_class), ["5xx", "5xx", "2xx"]);
});


test("does not retry malformed successful OIDC responses", async () => {
  let calls = 0;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    sleep: async () => { throw new Error("unexpected retry"); },
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => { throw new Error("malformed"); } };
    },
  });
  assert.equal(result.status, "FAILED_CLOSED");
  assert.equal(result.reason, "github-oidc-token-missing");
  assert.equal(result.summary.attempts, 1);
  assert.equal(calls, 1);
});
test("does not retry deterministic runner rejection", async () => {
  let calls = 0;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    sleep: async () => { throw new Error("unexpected retry"); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? oidcSuccess() : response(400);
    },
  });
  assert.equal(result.status, "FAILED_CLOSED");
  assert.equal(result.reason, "external-coding-runner-rejected-request");
  assert.equal(result.summary.attempts, 1);
  assert.equal(calls, 2);
  assert.equal(result.attempts[0].decision, "FAILED_CLOSED");
});

test("bounds repeated transient rejection and closes without mutation", async () => {
  const waits = [];
  let calls = 0;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    baseBackoffMs: 5,
    jitter: () => 0.5,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return calls % 2 === 1 ? oidcSuccess() : response(502);
    },
  });
  assert.equal(result.status, "FAILED_CLOSED");
  assert.equal(result.summary.attempts, 3);
  assert.equal(result.summary.retries, 2);
  assert.equal(result.summary.failedClosed, 1);
  assert.deepEqual(waits, [5, 10]);
  assert.equal(calls, 6);
  assert.equal(result.attempts.at(-1).decision, "FAILED_CLOSED");
});

test("records duplicate suppression as no action without retry", async () => {
  let calls = 0;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? oidcSuccess() : response(202, { status: "DUPLICATE_EXECUTION_SUPPRESSED" });
    },
  });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.summary.noAction, 1);
  assert.equal(result.attempts[0].decision, "NO_ACTION");
  assert.equal(calls, 2);
});

test("classifies only bounded provider rate-limit reasons", () => {
  assert.equal(providerRateLimitCode("RATE_LIMITED"), "RATE_LIMITED");
  assert.equal(providerRateLimitCode("WORKERS_AI_DAILY_QUOTA_EXHAUSTED"), "WORKERS_AI_DAILY_QUOTA_EXHAUSTED");
  assert.equal(providerRateLimitCode("WORKERS_AI_RATE_LIMITED"), "WORKERS_AI_RATE_LIMITED");
  assert.equal(providerRateLimitCode("WAITING_PROVIDER_CAPACITY"), "PROVIDER_RATE_LIMITED");
  assert.equal(providerRateLimitCode("provider unavailable"), null);
  assert.equal(providerRateLimitCode("WORKERS_AI_RATE_LIMITED secret=unexpected"), null);
});

test("preserves bounded GitHub Models fallback evidence in a provider wait receipt", async () => {
  let calls = 0;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? oidcSuccess() : response(202, {
        status: "WAITING_RATE_LIMIT",
        provider: "workers-ai",
        reason: "WAITING_PROVIDER_CAPACITY",
        stopReason: "WAITING_PROVIDER_CAPACITY",
        lastFailure: "WAITING_PROVIDER_CAPACITY",
        nextRetryAt: Date.now() + 5_000,
        resumeCondition: "provider-capacity-and-exact-head-revalidation",
        fallbackProvider: "github-models",
        fallbackFailureReason: "GITHUB_MODELS_CODING_HTTP_401",
      });
    },
  });
  assert.equal(result.status, "WAITING_RATE_LIMIT");
  assert.equal(result.fallbackProvider, "github-models");
  assert.equal(result.fallbackFailureReason, "GITHUB_MODELS_CODING_HTTP_401");
  assert.equal(calls, 2);
});

test("uses a valid Retry-After hint before bounded retry backoff", async () => {
  const waits = [];
  let runnerCalls = 0;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    maxAttempts: 3,
    baseBackoffMs: 10,
    jitter: () => 0.5,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
      runnerCalls += 1;
      return runnerCalls === 1
        ? response(429, { error: "RATE_LIMITED" }, { "Retry-After": "2" })
        : response(200, { status: "EXECUTION_ACCEPTED" });
    },
  });
  assert.equal(result.status, "DISPATCHED");
  assert.deepEqual(waits, [2_000]);
  assert.equal(result.rateLimitEvents.length, 1);
  assert.equal(result.rateLimitEvents[0].retrySource, "retry-after-header");
});

test("falls back to bounded jitter when Retry-After is malformed or missing", async () => {
  const waits = [];
  let runnerCalls = 0;
  const result = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    maxAttempts: 3,
    baseBackoffMs: 5,
    jitter: () => 0.5,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
      runnerCalls += 1;
      if (runnerCalls === 1) return response(429, { error: "RATE_LIMITED" }, { "Retry-After": "malformed" });
      return response(200, { status: "EXECUTION_ACCEPTED" });
    },
  });
  assert.equal(result.status, "DISPATCHED");
  assert.deepEqual(waits, [5]);

  const exhausted = await dispatchWithRetry({
    request,
    url: "https://runner.example.test/coding/execute",
    oidcRequestUrl: "https://oidc.example.test/token",
    oidcRequestToken: "oidc-request-test",
    maxAttempts: 3,
    baseBackoffMs: 5,
    jitter: () => 0.5,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async (url) => String(url).startsWith("https://oidc.example.test/token")
      ? oidcSuccess()
      : response(429, { error: "RATE_LIMITED" }),
  });
  assert.equal(exhausted.status, "BLOCKED_RATE_LIMIT");
  assert.equal(exhausted.reason, "RATE_LIMITED");
  assert.equal(exhausted.provider, "external-coding-runner");
  assert.equal(exhausted.rateLimitEvents.length, 3);
  assert.equal(exhausted.retrySource, "bounded-exponential-backoff-jitter");
  assert.deepEqual(waits, [5, 5, 10]);
});

test("clamps excessive Retry-After values to the bounded retry ceiling", () => {
  const hint = retryHint(
    response(429, { error: "RATE_LIMITED" }, { "Retry-After": "999999" }),
    { error: "RATE_LIMITED" },
    1_700_000_000_000,
  );
  assert.deepEqual(hint, { delayMs: MAX_RETRY_DELAY_MS, source: "retry-after-header" });
});

test("treats Jev proposal abstention as one successful no-action without publish or retry", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    let publishCalls = 0;
    let validationCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          return response(200, {
            accepted: true,
            status: "JEV_ROUTING_ABSTAINED",
            reason: "NON_CODE_AUTOFIX_FORBIDDEN",
            jevAdmissionAction: "ABSTAIN_EXPENSIVE_INFERENCE",
            jevRequiredModel: "HUMAN",
            jevConfidence: 0.97,
            aiAuthority: "ZERO_AUTHORITY",
          });
        }
        if (value.endsWith("/coding/publish")) {
          publishCalls += 1;
          throw new Error("publish must not run after Jev abstention");
        }
        throw new Error("unexpected URL " + value);
      },
      {
        validatePatch() {
          validationCalls += 1;
          throw new Error("patch validation must not run after Jev abstention");
        },
      },
    );
    assert.equal(result.status, "NO_ACTION");
    assert.equal(result.reason, "NON_CODE_AUTOFIX_FORBIDDEN");
    assert.equal(result.workerStatus, "JEV_ROUTING_ABSTAINED");
    assert.equal(result.proposalAttempts, 1);
    assert.equal(result.proposalRetries, 0);
    assert.equal(result.codeChanged, false);
    assert.equal(result.jevAdmissionAction, "ABSTAIN_EXPENSIVE_INFERENCE");
    assert.equal(proposalCalls, 1);
    assert.equal(publishCalls, 0);
    assert.equal(validationCalls, 0);
  });
});

test("normalizes a non-2xx worker rate-limit stop into waiting without proposal retries", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    let publishCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          return response(409, {
            status: "CODING_PROPOSAL_FAILED_CLOSED",
            error: "WAITING_PROVIDER_CAPACITY",
            provider: "workers-ai",
            providerStopReason: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED",
            nextRetryAt: 90_001_000,
          });
        }
        if (value.endsWith("/coding/publish")) {
          publishCalls += 1;
          throw new Error("publish must not run");
        }
        throw new Error("unexpected URL " + value);
      },
      {
        now: () => 1_000,
        jitter: () => 0.5,
      },
    );
    assert.equal(result.status, "WAITING_RATE_LIMIT");
    assert.equal(result.reason, "WAITING_RATE_LIMIT");
    assert.equal(result.proposalAttempts, 1);
    assert.equal(result.proposalRetries, 0);
    assert.equal(result.codeChanged, false);
    assert.equal(result.blockedRateLimit, false);
    assert.equal(result.summary.blockedRateLimit, 0);
    assert.equal(result.summary.failedClosed, 0);
    assert.equal(result.provider, "workers-ai");
    assert.equal(result.lastRateLimitAt, 1000);
    assert.equal(result.nextRetryAt, 90_001_000);
    assert.equal(result.retrySource, "provider-nextRetryAt");
    assert.equal(result.stopReason, "WAITING_PROVIDER_CAPACITY");
    assert.equal(proposalCalls, 1);
    assert.equal(publishCalls, 0);
  });
});

test("normalizes a non-2xx shared provider-capacity stop without failing the consumer", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        proposalCalls += 1;
        // Exact shape apps/autopilot/src/worker.ts handleCodingProposal returns while a shared
        // provider wait is active: no stopReason or lastFailure, only error + providerStopReason.
        return response(409, {
          accepted: false,
          status: "CODING_PROPOSAL_FAILED_CLOSED",
          error: "WAITING_PROVIDER_CAPACITY",
          providerStopReason: "WAITING_PROVIDER_CAPACITY",
          nextRetryAt: 1_700_000_100_000,
          liveAuthority: "NONE",
          productionMutationAllowed: false,
          aiAuthority: "ZERO_AUTHORITY",
        });
      },
      { now: () => 1_700_000_000_000, sleep: async () => { throw new Error("must not retry"); } },
    );
    assert.equal(result.status, "WAITING_RATE_LIMIT");
    assert.equal(result.reason, "WAITING_RATE_LIMIT");
    assert.equal(result.summary.failedClosed, 0);
    assert.equal(result.attempts[0].decision, "NO_ACTION");
    assert.equal(result.stopReason, "WAITING_PROVIDER_CAPACITY");
    // The shared wait's absolute resume time (~100s out) is reported, not the 60s local-retry cap.
    assert.equal(result.rateLimitEvents?.[0]?.nextRetryAt ?? result.nextRetryAt, 1_700_000_100_000);
    assert.equal(proposalCalls, 1);
  });
});

test("consumes the Worker's remediation verdict and regenerates a rejected proposal on the same identity", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    let publishCalls = 0;
    const proposalBodies = [];
    const remediationDecision = {
      outcome: "FAILED_TO_REMEDIATE",
      failureClass: "PROPOSAL_REJECTED",
      recovery: "REGENERATE_PROPOSAL",
      retryable: true,
      attempt: 0,
      maxAttempts: 3,
    };
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url, init = {}) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          proposalBodies.push(JSON.parse(init.body));
          if (proposalCalls === 1) return response(409, {
            status: "CODING_PROPOSAL_FAILED_CLOSED",
            error: "CODING_EDIT_ANCHOR_NOT_FOUND",
            remediationDecision,
          });
          return response(200, { status: "PROPOSAL_READY", patch: "repaired-patch" });
        }
        if (value.endsWith("/coding/publish")) {
          publishCalls += 1;
          return response(200, {
            status: "EXECUTION_ACCEPTED",
            proposalValidated: true,
            publisher: "github-validated-patch",
            branch: "autopilot/remediation-test",
            commitSha: "d".repeat(40),
            pullRequestNumber: 79,
            pullRequestUrl: "https://github.com/cinamoncandy/NUSA/pull/79",
          });
        }
        throw new Error("unexpected URL " + value);
      },
      {
        initialProposalContext: () => null,
        validatePatch(_value, patch) {
          assert.equal(patch, "repaired-patch");
          return [{ path: "apps/autopilot/src/example.ts", content: "export const repaired = true;\n" }];
        },
      },
    );
    assert.equal(result.status, "DISPATCHED");
    assert.equal(result.codeChanged, true);
    assert.equal(result.proposalAttempts, 2);
    assert.deepEqual(result.attempts.map((attempt) => attempt.decision), ["RETRY", "DISPATCHED"]);
    assert.equal(proposalCalls, 2);
    assert.equal(publishCalls, 1);
    assert.equal(proposalBodies[0].executionId, request.executionId);
    assert.equal(proposalBodies[1].executionId, request.executionId);
    assert.equal(proposalBodies[1].dedupeKey, request.dedupeKey);
    assert.equal(proposalBodies[1].headSha, request.headSha);
    assert.match(proposalBodies[1].proposalFeedback, /CODING_EDIT_ANCHOR_NOT_FOUND/);
  });
});

test("worker remediation exhaustion is a failure, never successful NO_ACTION", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          return response(409, {
            status: "CODING_PROPOSAL_FAILED_CLOSED",
            error: "CODING_EDIT_ANCHOR_NOT_FOUND",
            remediationDecision: {
              outcome: "FAILED_TO_REMEDIATE",
              failureClass: "PROPOSAL_REJECTED",
              recovery: "REGENERATE_PROPOSAL",
              retryable: true,
              attempt: 0,
              maxAttempts: 3,
            },
          });
        }
        throw new Error("publish must not run after failed remediation");
      },
      { initialProposalContext: () => null, maxProposalAttempts: 2 },
    );
    assert.equal(result.status, "FAILED_TO_REMEDIATE");
    assert.equal(result.reason, "CODING_EDIT_ANCHOR_NOT_FOUND");
    assert.equal(result.summary.noAction, 0);
    assert.equal(result.summary.failedClosed, 1);
    assert.equal(result.proposalRejected, 2, "terminal rejected proposal attempts remain in remediation metrics");
    assert.equal(result.summary.proposalRejected, 2);
    assert.deepEqual(result.attempts.map((attempt) => attempt.decision), ["RETRY", "FAILED_CLOSED"]);
    assert.equal(proposalCalls, 2);
  });
});

test("provider-capacity state lookup failure stays FAILED_CLOSED instead of becoming a rate-limit wait", async () => {
  await withOidcEnvironment(async () => {
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) return response(409, {
          status: "CODING_PROPOSAL_FAILED_CLOSED",
          error: "PROVIDER_CAPACITY_STATE_UNAVAILABLE",
          httpStatus: 409,
          remediationDecision: {
            outcome: "FAILED_CLOSED",
            failureClass: "PROVIDER_CAPACITY",
            recovery: "STOP",
            retryable: false,
            attempt: 0,
            maxAttempts: 3,
          },
        });
        throw new Error("publish must not run after failed-closed capacity-state lookup");
      },
      { initialProposalContext: () => null },
    );

    assert.equal(result.status, "FAILED_CLOSED");
    assert.equal(result.reason, "PROVIDER_CAPACITY_STATE_UNAVAILABLE");
    assert.equal(result.blockedRateLimit, false);
    assert.equal(result.summary.failedClosed, 1);
    assert.equal(result.rateLimitEvents?.length ?? 0, 0);
  });
});

test("malformed worker remediation verdict fails closed without retry", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    const result = await executeGithubActionsRunner(
        request,
        "https://runner.example.test/coding/execute",
        async (url) => {
          const value = String(url);
          if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
          proposalCalls += 1;
          return response(409, {
            status: "CODING_PROPOSAL_FAILED_CLOSED",
            error: "CODING_EDIT_ANCHOR_NOT_FOUND",
            remediationDecision: { outcome: "FAILED_TO_REMEDIATE", retryable: true, maxAttempts: 99 },
          });
        },
        { initialProposalContext: () => null },
    );
    assert.equal(result.status, "FAILED_CLOSED");
    assert.equal(result.reason, "CODING_REMEDIATION_DECISION_INVALID");
    assert.equal(result.httpStatus, 409);
    assert.equal(result.summary.failedClosed, 1);
    assert.equal(result.summary.retries, 0);
    assert.equal(result.codeChanged, false);
    assert.equal(proposalCalls, 1);
  });
});

test("preserves a worker WAITING_RATE_LIMIT stop and suppresses duplicate dispatch", async () => {
  await withOidcEnvironment(async () => {
    const now = 1_700_000_000_000;
    const waits = [];
    let runnerCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        runnerCalls += 1;
        return response(202, {
          status: "WAITING_RATE_LIMIT",
          provider: "workers-ai",
          stopReason: "WORKERS_AI_RATE_LIMITED",
          lastFailure: "WORKERS_AI_RATE_LIMITED",
          nextRetryAt: now + 5_000,
          resumeCondition: "provider-capacity-and-exact-head-revalidation",
        });
      },
      { now: () => now, sleep: async (milliseconds) => waits.push(milliseconds) },
    );
    assert.equal(result.status, "WAITING_RATE_LIMIT");
    assert.equal(result.reason, "WAITING_RATE_LIMIT");
    assert.equal(result.nextRetryAt, now + 5_000);
    assert.equal(result.stopReason, "WORKERS_AI_RATE_LIMITED");
    assert.equal(result.resumeCondition, "provider-capacity-and-exact-head-revalidation");
    assert.deepEqual(result.attempts.map((attempt) => attempt.decision), ["NO_ACTION"]);
    assert.deepEqual(waits, []);
    assert.equal(runnerCalls, 1);
  });
});

test("reports the real resume time when a later execution is stopped by an already-recorded provider wait", async () => {
  await withOidcEnvironment(async () => {
    const now = Date.parse("2026-09-23T11:05:37.000Z");
    const nextUtcDay = Date.parse("2026-09-24T00:00:00.000Z");
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        return response(202, {
          status: "WAITING_RATE_LIMIT",
          provider: "workers-ai",
          reason: "WAITING_PROVIDER_CAPACITY",
          stopReason: "WAITING_PROVIDER_CAPACITY",
          lastFailure: "WAITING_PROVIDER_CAPACITY",
          nextRetryAt: nextUtcDay,
          resumeCondition: "provider-capacity-and-exact-head-revalidation",
        });
      },
      { now: () => now, sleep: async () => { throw new Error("must not sleep"); } },
    );
    assert.equal(result.status, "WAITING_RATE_LIMIT");
    assert.equal(result.stopReason, "WAITING_PROVIDER_CAPACITY");
    // A wait already recorded by a different execution/task is just as long-lived as the
    // original daily-quota stop; it must not be truncated back down to the 60s ceiling.
    assert.equal(result.nextRetryAt, nextUtcDay);
    assert.ok(result.nextRetryAt - now > MAX_RETRY_DELAY_MS);
  });
});

test("reports the real next-UTC-day resume time for a daily-quota stop instead of the 60s retry ceiling", async () => {
  await withOidcEnvironment(async () => {
    const now = Date.parse("2026-09-23T10:53:36.040Z");
    const nextUtcDay = Date.parse("2026-09-24T00:00:00.000Z");
    const waits = [];
    let runnerCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        runnerCalls += 1;
        return response(202, {
          status: "WAITING_RATE_LIMIT",
          provider: "workers-ai",
          stopReason: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED",
          lastFailure: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED",
          nextRetryAt: nextUtcDay,
          resumeCondition: "provider-capacity-and-exact-head-revalidation",
        });
      },
      { now: () => now, sleep: async (milliseconds) => waits.push(milliseconds) },
    );
    assert.equal(result.status, "WAITING_RATE_LIMIT");
    assert.equal(result.stopReason, "WORKERS_AI_DAILY_QUOTA_EXHAUSTED");
    // The real resume time is ~13h away; it must not be clamped down to the 60s retry ceiling.
    assert.equal(result.nextRetryAt, nextUtcDay);
    assert.ok(result.nextRetryAt - now > MAX_RETRY_DELAY_MS);
    assert.deepEqual(result.attempts.map((attempt) => attempt.decision), ["NO_ACTION"]);
    assert.deepEqual(waits, []);
    assert.equal(runnerCalls, 1);
  });
});

test("prefers the provider's absolute reset timestamp over a relative retryAfterMs when both are present", () => {
  const observedAt = 1_700_000_000_000;
  const absoluteNextRetryAt = observedAt + 50_000_000; // far outside the 60s local retry ceiling
  const hint = retryHint(
    response(409, {}),
    { stopReason: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED", retryAfterMs: 500, nextRetryAt: absoluteNextRetryAt },
    observedAt,
    MAX_REPORTED_QUOTA_RETRY_DELAY_MS,
  );
  assert.deepEqual(hint, { delayMs: absoluteNextRetryAt - observedAt, source: "provider-nextRetryAt" });
});

test("still bounds a generic transient rate limit's reported resume time to the retry ceiling", () => {
  const hint = retryHint(
    response(429, { error: "WORKERS_AI_RATE_LIMITED" }),
    { error: "WORKERS_AI_RATE_LIMITED", nextRetryAt: 1_700_000_000_000 + 999_999_000 },
    1_700_000_000_000,
    MAX_RETRY_DELAY_MS,
  );
  assert.deepEqual(hint, { delayMs: MAX_RETRY_DELAY_MS, source: "provider-nextRetryAt" });
});

test("stops on provider capacity and preserves provider retry metadata", async () => {
  await withOidcEnvironment(async () => {
    const waits = [];
    let proposalCalls = 0;
    let publishCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          return response(409, {
            status: "CODING_PROPOSAL_FAILED_CLOSED",
            error: "WAITING_PROVIDER_CAPACITY",
            provider: "configured-coding-engine",
            providerStopReason: "PROVIDER_RATE_LIMITED",
            retryAfterMs: 25,
          });
        }
        if (value.endsWith("/coding/publish")) {
          publishCalls += 1;
          return response(200, { status: "EXECUTION_ACCEPTED", proposalValidated: true, commitSha: "c".repeat(40), pullRequestNumber: 88 });
        }
        throw new Error("unexpected URL " + value);
      },
      {
        validatePatch() { return [{ path: "apps/autopilot/src/example.ts", content: "export const valid = true;\n" }]; },
        sleep: async (milliseconds) => waits.push(milliseconds),
        now: () => 1_000,
        jitter: () => 0.5,
      },
    );
    assert.equal(result.status, "WAITING_RATE_LIMIT");
    assert.deepEqual(waits, []);
    assert.deepEqual(result.attempts.map((attempt) => attempt.decision), ["NO_ACTION"]);
    assert.equal(result.proposalAttempts, 1);
    assert.equal(result.codeChanged, false);
    assert.equal(proposalCalls, 1);
    assert.equal(publishCalls, 0);
    assert.equal(result.nextRetryAt, 1_025);
  });
});

test("causal dispatch capability is sent only as a Worker header on propose and publish", async () => {
  await withOidcEnvironment(async () => {
    const capability = "c".repeat(64);
    const target = "apps/autopilot/src/repairableWorkflowRun.ts";
    const causalRequest = {
      ...request,
      workflowRunAttempt: 2,
      reason: `gha:${request.workflowRunId}:${request.headSha}:failure`,
    };
    const apiCalls = [];
    const result = await executeGithubActionsRunner(
      causalRequest,
      "https://runner.example.test/coding/execute",
      async (url, init = {}) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        const headers = init.headers || {};
        assert.equal(headers["x-nusa-causal-dispatch-capability"], capability);
        assert.equal(headers.authorization, "Bearer oidc-test-value");
        const body = JSON.parse(String(init.body));
        assert.equal(JSON.stringify(body).includes(capability), false);
        apiCalls.push(new URL(value).pathname);
        if (value.endsWith("/coding/propose")) {
          assert.equal(body.workflowRunAttempt, 2);
          assert.equal(body.reason, causalRequest.reason);
          return response(200, {
            status: "PROPOSAL_READY",
            patch: "causal-single-file-patch",
            causalRepairTarget: target,
            causalProposalReceipt: "nusa-causal-proposal-v1." + "p".repeat(32) + "." + "s".repeat(32),
            headSha: causalRequest.headSha,
            workflowRunId: causalRequest.workflowRunId,
          });
        }
        if (value.endsWith("/coding/publish")) {
          assert.deepEqual(body.validatedFiles.map((file) => file.path), [target]);
          assert.equal(body.patch, "causal-single-file-patch");
          assert.match(body.causalProposalReceipt, /^nusa-causal-proposal-v1\./);
          return response(200, { status: "EXECUTION_ACCEPTED", proposalValidated: true, commitSha: "d".repeat(40), pullRequestNumber: 89 });
        }
        throw new Error(`unexpected URL ${value}`);
      },
      {
        causalDispatchCapability: capability,
        initialProposalContext: () => ({ path: target, startLine: 1, content: "export const repairable = true;\n" }),
        validatePatch: () => [{ path: target, content: "export const repairable = false;\n" }],
      },
    );
    assert.equal(result.status, "DISPATCHED");
    assert.deepEqual(apiCalls, ["/coding/propose", "/coding/publish"]);
  });
});

test("causal publish refuses a proposal response without the server-bound patch receipt", async () => {
  await withOidcEnvironment(async () => {
    const capability = "c".repeat(64);
    const causalRequest = {
      ...request,
      workflowRunAttempt: 1,
      reason: "gha:" + request.workflowRunId + ":" + request.headSha + ":failure",
    };
    let publishCalls = 0;
    await assert.rejects(
      () => executeGithubActionsRunner(
        causalRequest,
        "https://runner.example.test/coding/execute",
        async (url) => {
          const value = String(url);
          if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
          if (value.endsWith("/coding/propose")) return response(200, {
            status: "PROPOSAL_READY",
            patch: "causal-patch-without-server-receipt",
            causalRepairTarget: "apps/autopilot/src/repairableWorkflowRun.ts",
            headSha: causalRequest.headSha,
            workflowRunId: causalRequest.workflowRunId,
          });
          if (value.endsWith("/coding/publish")) publishCalls += 1;
          throw new Error("publish must not be reached");
        },
        {
          causalDispatchCapability: capability,
          initialProposalContext: () => ({ path: "apps/autopilot/src/repairableWorkflowRun.ts", startLine: 1, content: "export const repairable = true;\n" }),
          validatePatch: () => [{ path: "apps/autopilot/src/repairableWorkflowRun.ts", content: "export const repairable = false;\n" }],
        },
      ),
      /CAUSAL_PROPOSAL_RECEIPT_REQUIRED/,
    );
    assert.equal(publishCalls, 0);
  });
});

test("causal dispatch fails closed before network access when capability is absent", async () => {
  await withOidcEnvironment(async () => {
    const causalRequest = {
      ...request,
      workflowRunAttempt: 1,
      reason: `gha:${request.workflowRunId}:${request.headSha}:timed_out`,
    };
    let calls = 0;
    await assert.rejects(
      () => executeGithubActionsRunner(causalRequest, "https://runner.example.test/coding/execute", async () => {
        calls += 1;
        return oidcSuccess();
      }),
      /CAUSAL_DISPATCH_ADMISSION_REQUIRED/,
    );
    assert.equal(calls, 0);
  });
});

test("allows only this workflow's generated artifacts before patch validation", () => {
  assert.doesNotThrow(() => assertGithubRunnerWorkspaceClean([
    "?? artifacts/autopilot-execution/repository-dispatch.json",
    "?? artifacts/autopilot-execution/coding-runner-request.json",
  ].join("\n")));
  assert.doesNotThrow(() => assertGithubRunnerWorkspaceClean(""));
  assert.deepEqual(
    filterGithubRunnerWorkspacePaths([
      ".nusa-autopilot.patch",
      "artifacts/autopilot-execution/repository-dispatch.json",
      "apps/autopilot/src/codingRunner.ts",
    ]),
    ["apps/autopilot/src/codingRunner.ts"],
  );
});

test("still rejects tracked or unrelated dirty workspace entries", () => {
  for (const status of [
    " M apps/autopilot/src/codingRunner.ts",
    "?? .nusa-autopilot.patch",
    "?? artifacts/autopilot-execution/unexpected.txt",
    "?? artifacts/",
    "?? artifacts/other.json",
    " M artifacts/autopilot-execution/repository-dispatch.json",
  ]) {
    assert.throws(
      () => assertGithubRunnerWorkspaceClean(status),
      /CODING_RUNTIME_WORKSPACE_DIRTY/,
    );
  }
});

test("rejects forbidden authority-surface patch paths", () => {
  assert.throws(
    () => assertBoundedPatch("diff --git a/apps/autopilot/src/live/broker/order/credential/secret/withdraw/transfer.ts b/apps/autopilot/src/live/broker/order/credential/secret/withdraw/transfer.ts\n+++ b/apps/autopilot/src/live/broker/order/credential/secret/withdraw/transfer.ts\n"),
    /SANDBOX_PATCH_PATH_FORBIDDEN/,
  );
});

test("builds a bounded exact-head retry excerpt around the rejected hunk", () => {
  const source = Array.from({ length: 300 }, (_value, index) => `line-${index + 1}`).join("\n");
  const contextPatch = [
    "diff --git a/apps/autopilot/src/example.ts b/apps/autopilot/src/example.ts",
    "--- a/apps/autopilot/src/example.ts",
    "+++ b/apps/autopilot/src/example.ts",
    "@@ -200,1 +200,1 @@",
    "-line-200",
    "+line-200-updated",
    "",
  ].join("\n");
  const context = boundedProposalContext("apps/autopilot/src/example.ts", source, contextPatch);
  assert.equal(context.path, "apps/autopilot/src/example.ts");
  assert.ok(context.startLine <= 200);
  assert.match(context.content, /line-200/);
  assert.ok(Buffer.byteLength(context.content, "utf8") <= 20_000);
});


test("normalizes only malformed unified-diff hunk counts before strict git apply", () => {
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-recount-"));
  try {
    process.chdir(directory);
    execFileSync("git", ["init", "-q"]);
    execFileSync("git", ["config", "core.autocrlf", "false"]);
    execFileSync("git", ["config", "core.eol", "lf"]);
    execFileSync("git", ["config", "user.email", "nusa-test@example.invalid"]);
    execFileSync("git", ["config", "user.name", "NUSA Test"]);
    fs.mkdirSync("apps/autopilot/src", { recursive: true });
    fs.writeFileSync("apps/autopilot/src/example.ts", "export const oldValue = true;\n");
    execFileSync("git", ["add", "."]);
    execFileSync("git", ["commit", "-qm", "fixture"]);
    const malformedCounts = [
      "diff --git a/apps/autopilot/src/example.ts b/apps/autopilot/src/example.ts",
      "--- a/apps/autopilot/src/example.ts",
      "+++ b/apps/autopilot/src/example.ts",
      "@@ -1,9 +1,9 @@",
      "-export const oldValue = true;",
      "+export const oldValue = false;",
      "",
    ].join("\n");
    fs.writeFileSync(".nusa-autopilot.patch", malformedCounts);
    assert.throws(
      () => execFileSync("git", ["apply", "--check", ".nusa-autopilot.patch"], { stdio: "pipe" }),
      /Command failed/,
    );
    const normalized = normalizeUnifiedDiffHunkCounts(malformedCounts);
    assert.match(normalized, /@@ -1,1 \+1,1 @@/);
    assert.equal(applyPatchWithNormalizedHunkCounts(".nusa-autopilot.patch"), "normalized");
    assert.equal(fs.readFileSync("apps/autopilot/src/example.ts", "utf8"), "export const oldValue = false;\n");
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("hunk-count normalization does not fuzz or accept mismatched source context", () => {
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-recount-mismatch-"));
  try {
    process.chdir(directory);
    execFileSync("git", ["init", "-q"]);
    execFileSync("git", ["config", "core.autocrlf", "false"]);
    execFileSync("git", ["config", "core.eol", "lf"]);
    execFileSync("git", ["config", "user.email", "nusa-test@example.invalid"]);
    execFileSync("git", ["config", "user.name", "NUSA Test"]);
    fs.mkdirSync("apps/autopilot/src", { recursive: true });
    fs.writeFileSync("apps/autopilot/src/example.ts", "export const actual = true;\n");
    execFileSync("git", ["add", "."]);
    execFileSync("git", ["commit", "-qm", "fixture"]);
    fs.writeFileSync(".nusa-autopilot.patch", [
      "diff --git a/apps/autopilot/src/example.ts b/apps/autopilot/src/example.ts",
      "--- a/apps/autopilot/src/example.ts",
      "+++ b/apps/autopilot/src/example.ts",
      "@@ -1,9 +1,9 @@",
      "-export const invented = true;",
      "+export const invented = false;",
      "",
    ].join("\n"));
    assert.throws(
      () => applyPatchWithNormalizedHunkCounts(".nusa-autopilot.patch"),
      /SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED/,
    );
    assert.equal(fs.readFileSync("apps/autopilot/src/example.ts", "utf8"), "export const actual = true;\n");
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("classifies only allowlisted proposal validation failures for bounded remediation", () => {
  assert.equal(proposalFailureCode("CODING_PROPOSAL_JSON_INVALID"), "CODING_PROPOSAL_JSON_INVALID");
  assert.equal(proposalFailureCode("SANDBOX_PATCH_APPLY_CHECK_FAILED:128:error: malformed diff"), "SANDBOX_PATCH_APPLY_CHECK_FAILED");
  assert.equal(
    proposalFailureCode("SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED:1:error: patch does not apply"),
    "SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED",
  );
  assert.equal(proposalFailureCode("CODING_RUNTIME_WORKSPACE_DIRTY"), null);
  assert.equal(proposalFailureCode("CODING_PROPOSAL_PATH_FORBIDDEN"), null);
  assert.equal(proposalFailureCode("SANDBOX_PATCH_FORBIDDEN_AUTHORITY_SURFACE"), null);
  assert.equal(proposalFailureCode("CODING_PROPOSAL_JSON_INVALID secret=redacted"), null);
});

test("regenerates an apply-check rejection inside one execution and publishes the repaired patch", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    let publishCalls = 0;
    let validateCalls = 0;
    const proposalBodies = [];
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url, init = {}) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          proposalBodies.push(JSON.parse(init.body));
          return response(200, { status: "PROPOSAL_READY", patch: proposalCalls === 1 ? "first-invalid-patch" : "second-valid-patch" });
        }
        if (value.endsWith("/coding/publish")) {
          publishCalls += 1;
          return response(200, {
            status: "EXECUTION_ACCEPTED",
            proposalValidated: true,
            publisher: "github-validated-patch",
            branch: "autopilot/test",
            commitSha: "b".repeat(40),
            pullRequestNumber: 77,
            pullRequestUrl: "https://github.com/cinamoncandy/NUSA/pull/77",
          });
        }
        throw new Error("unexpected URL " + value);
      },
      {
        now: () => 1_000,
        validatePatch(value, patch) {
          validateCalls += 1;
          assert.equal(value.executionId, request.executionId);
          if (validateCalls === 1) throw new Error("SANDBOX_PATCH_APPLY_CHECK_FAILED:128:error: patch failed");
          assert.equal(patch, "second-valid-patch");
          return [{ path: "apps/autopilot/src/example.ts", content: "export const repaired = true;\n" }];
        },
        initialProposalContext() {
          return { path: "apps/autopilot/src/first.ts", startLine: 1, content: "export const first = true;\n" };
        },
        proposalContextForPatch(patch) {
          assert.equal(patch, "first-invalid-patch");
          return {
            path: "apps/autopilot/src/example.ts",
            startLine: 1,
            content: "export const oldValue = true;\n",
          };
        },
      },
    );

    assert.equal(result.status, "DISPATCHED");
    assert.equal(result.proposalAttempts, 2);
    assert.equal(result.proposalRetries, 1);
    assert.equal(result.codeChanged, true);
    assert.equal(result.commitSha, "b".repeat(40));
    assert.equal(result.pullRequestNumber, 77);
    assert.equal(proposalCalls, 2);
    assert.equal(validateCalls, 2);
    assert.equal(publishCalls, 1);
    assert.equal(proposalBodies[0].executionId, request.executionId);
    assert.equal(proposalBodies[1].executionId, request.executionId);
    assert.equal(proposalBodies[1].dedupeKey, request.dedupeKey);
    assert.equal(proposalBodies[1].headSha, request.headSha);
    assert.match(proposalBodies[1].proposalFeedback, /SANDBOX_PATCH_APPLY_CHECK_FAILED/);
    // This asserted proposalContext === undefined, which pinned the defect: attempt 1 was sent
    // with no source excerpt, so the model had to invent the context lines that `git apply --check`
    // compares byte for byte. Attempt 1 now carries a real excerpt like every retry does.
    assert.deepEqual(proposalBodies[0].proposalContext, {
      path: "apps/autopilot/src/first.ts",
      startLine: 1,
      content: "export const first = true;\n",
    });
    assert.deepEqual(proposalBodies[1].proposalContext, {
      path: "apps/autopilot/src/example.ts",
      startLine: 1,
      content: "export const oldValue = true;\n",
    });
    assert.deepEqual(result.attempts.map((entry) => entry.decision), ["RETRY", "DISPATCHED"]);
  });
});

test("regenerates a bounded build rejection before publishing", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    let validateCalls = 0;
    const proposalBodies = [];
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url, init = {}) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          proposalBodies.push(JSON.parse(init.body));
          return response(200, { status: "PROPOSAL_READY", patch: proposalCalls === 1 ? "first-build-failure" : "second-build-safe" });
        }
        if (value.endsWith("/coding/publish")) {
          return response(200, {
            status: "EXECUTION_ACCEPTED",
            proposalValidated: true,
            publisher: "github-validated-patch",
            branch: "autopilot/build-repair",
            commitSha: "c".repeat(40),
            pullRequestNumber: 78,
            pullRequestUrl: "https://github.com/cinamoncandy/NUSA/pull/78",
          });
        }
        throw new Error("unexpected URL " + value);
      },
      {
        validatePatch(value, patch) {
          validateCalls += 1;
          assert.equal(value.executionId, request.executionId);
          if (validateCalls === 1) throw new Error("SANDBOX_BUILD_FAILED:2:tsc failed");
          assert.equal(patch, "second-build-safe");
          return [{ path: "apps/autopilot/src/example.ts", content: "export const repaired = true;\n" }];
        },
        initialProposalContext() {
          return { path: "apps/autopilot/src/example.ts", startLine: 1, content: "export const current = true;\n" };
        },
      },
    );

    assert.equal(result.status, "DISPATCHED");
    assert.equal(result.proposalAttempts, 2);
    assert.equal(result.proposalRetries, 1);
    assert.equal(result.codeChanged, true);
    assert.equal(proposalCalls, 2);
    assert.equal(validateCalls, 2);
    assert.match(proposalBodies[1].proposalFeedback, /SANDBOX_BUILD_FAILED/);
    assert.deepEqual(proposalBodies[1].proposalContext, {
      path: "apps/autopilot/src/example.ts",
      startLine: 1,
      content: "export const current = true;\n",
    });
  });
});

test("stops after one correction repeats the same deterministic apply-check failure", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          return response(200, { status: "PROPOSAL_READY", patch: "invalid-patch-" + proposalCalls });
        }
        throw new Error("publish must not run");
      },
      {
        validatePatch() {
          throw new Error("SANDBOX_PATCH_APPLY_CHECK_FAILED:128:error: patch failed");
        },
      },
    );

    assert.equal(result.status, "FAILED_TO_REMEDIATE");
    assert.equal(result.reason, "SANDBOX_PATCH_APPLY_CHECK_FAILED");
    assert.equal(result.proposalAttempts, 2);
    assert.equal(result.proposalRetries, 1);
    assert.equal(result.codeChanged, false);
    assert.equal(proposalCalls, 2);
    assert.deepEqual(result.attempts.map((entry) => entry.decision), ["RETRY", "FAILED_CLOSED"]);
  });
});

test("stops on a repeated deterministic proposal validation failure before another provider call", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          return response(200, { status: "PROPOSAL_READY", patch: `invalid-patch-${proposalCalls}` });
        }
        throw new Error("publish must not run");
      },
      {
        validatePatch() {
          throw new Error("CODING_PROPOSAL_JSON_INVALID");
        },
      },
    );

    assert.equal(result.status, "FAILED_TO_REMEDIATE");
    assert.equal(result.reason, "CODING_PROPOSAL_JSON_INVALID");
    assert.equal(result.proposalAttempts, 2);
    assert.equal(result.proposalRetries, 1);
    assert.equal(proposalCalls, 2);
    assert.deepEqual(result.attempts.map((entry) => entry.decision), ["RETRY", "FAILED_CLOSED"]);
  });
});

test("terminates when the AI repeats the same rejected patch", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    let validateCalls = 0;
    const result = await executeGithubActionsRunner(
      request,
      "https://runner.example.test/coding/execute",
      async (url) => {
        const value = String(url);
        if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
        if (value.endsWith("/coding/propose")) {
          proposalCalls += 1;
          return response(200, { status: "PROPOSAL_READY", patch: "same-invalid-patch" });
        }
        throw new Error("publish must not run");
      },
      {
        validatePatch() {
          validateCalls += 1;
          throw new Error("SANDBOX_PATCH_APPLY_CHECK_FAILED:128:error: patch failed");
        },
      },
    );

    assert.equal(result.status, "FAILED_TO_REMEDIATE");
    assert.equal(result.reason, "CODING_PROPOSAL_REPEATED");
    assert.equal(result.proposalAttempts, 2);
    assert.equal(proposalCalls, 2);
    assert.equal(validateCalls, 1);
  });
});

test("does not retry forbidden authority or path failures", async () => {
  await withOidcEnvironment(async () => {
    let proposalCalls = 0;
    await assert.rejects(
      () => executeGithubActionsRunner(
        request,
        "https://runner.example.test/coding/execute",
        async (url) => {
          const value = String(url);
          if (value.startsWith("https://oidc.example.test/token")) return oidcSuccess();
          if (value.endsWith("/coding/propose")) {
            proposalCalls += 1;
            return response(200, { status: "PROPOSAL_READY", patch: "forbidden-patch" });
          }
          throw new Error("publish must not run");
        },
        {
          validatePatch() {
            throw new Error("SANDBOX_PATCH_PATH_FORBIDDEN:apps/autopilot/src/live/order.ts");
          },
        },
      ),
      /SANDBOX_PATCH_PATH_FORBIDDEN/,
    );
    assert.equal(proposalCalls, 1);
  });
});

test("normalizes a UTF-8 BOM and rejects malformed dispatch events with bounded reasons", () => {
  const eventPath = path.join(os.tmpdir(), `nusa-autopilot-event-${process.pid}-${Date.now()}.json`);
  const previousEventPath = process.env.GITHUB_EVENT_PATH;
  try {
    fs.writeFileSync(eventPath, `\uFEFF${JSON.stringify({ client_payload: {
      kind: "REPOSITORY_AUTOPILOT",
      repository: request.repository,
      head_sha: request.headSha,
      workflow_run_id: request.workflowRunId,
      reason: request.reason,
      execution_id: request.executionId,
      dedupe_key: request.dedupeKey,
    } })}`);
    process.env.GITHUB_EVENT_PATH = eventPath;
    const dispatch = readDispatchRequest();
    assert.equal(dispatch.request.headSha, request.headSha);
    assert.equal(dispatch.causalDispatchCapability, null);

    fs.writeFileSync(eventPath, "not-json");
    assert.throws(() => readDispatchRequest(), /GITHUB_EVENT_JSON_INVALID/);
  } finally {
    if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previousEventPath;
    fs.rmSync(eventPath, { force: true });
  }
});

test("separates a causal dispatch capability from the coding request and rejects missing capability", () => {
  const eventPath = path.join(os.tmpdir(), `nusa-autopilot-causal-event-${process.pid}-${Date.now()}.json`);
  const previousEventPath = process.env.GITHUB_EVENT_PATH;
  const capability = "e".repeat(64);
  const payload = {
    kind: "REPOSITORY_AUTOPILOT",
    repository: request.repository,
    head_sha: request.headSha,
    workflow_run_id: request.workflowRunId,
    causal_source_run_attempt: 3,
    reason: `gha:${request.workflowRunId}:${request.headSha}:failure`,
    execution_id: request.executionId,
    dedupe_key: request.dedupeKey,
    causal_dispatch_capability: capability,
  };
  try {
    process.env.GITHUB_EVENT_PATH = eventPath;
    fs.writeFileSync(eventPath, JSON.stringify({ client_payload: payload }));
    const dispatch = readDispatchRequest();
    assert.equal(dispatch.request.workflowRunAttempt, 3);
    assert.equal(dispatch.causalDispatchCapability, capability);
    assert.equal(Object.hasOwn(dispatch.request, "causalDispatchCapability"), false);
    assert.equal(JSON.stringify(dispatch.request).includes(capability), false);

    fs.writeFileSync(eventPath, JSON.stringify({ client_payload: { ...payload, causal_dispatch_capability: undefined } }));
    assert.throws(() => readDispatchRequest(), /CAUSAL_DISPATCH_SOURCE_IDENTITY_INVALID/);

    fs.writeFileSync(eventPath, JSON.stringify({ client_payload: { ...payload, reason: "continue-from:ci_succeeded" } }));
    assert.throws(() => readDispatchRequest(), /CAUSAL_DISPATCH_CAPABILITY_UNEXPECTED/);
  } finally {
    if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previousEventPath;
    fs.rmSync(eventPath, { force: true });
  }
});


test("preserves only bounded structured Worker workflow evidence", () => {
  const evidence = boundedWorkerFailureEvidence({
    error: "CODING_RUNNER_WORKFLOW_NOT_SUCCESSFUL",
    failureEvidence: {
      code: "CODING_RUNNER_WORKFLOW_NOT_SUCCESSFUL",
      workflowRunId: 35336423782,
      workflowName: "Scheduled Autopilot",
      workflowEvent: "schedule",
      workflowStatus: "completed",
      workflowConclusion: "failure",
      headSha: "b".repeat(40),
      secret: "must-not-propagate",
    },
  }, "https://nusa-autopilot.example/coding/propose", 409);
  assert.deepEqual(evidence, {
    code: "CODING_RUNNER_WORKFLOW_NOT_SUCCESSFUL",
    endpoint: "/coding/propose",
    httpStatus: 409,
    workflowRunId: 35336423782,
    workflowId: null,
    workflowPath: null,
    workflowName: "Scheduled Autopilot",
    workflowEvent: "schedule",
    workflowStatus: "completed",
    workflowConclusion: "failure",
    headSha: "b".repeat(40),
  });
  assert.equal(boundedWorkerFailureEvidence({ failureEvidence: { code: "BAD secret" } }, "https://example.test/coding/propose", 409), null);
});


test("terminal STOP takes precedence over capacity hints and 429", async () => {
  await withOidcEnvironment(async () => {
    for (const failureClass of ["AUTHORITY_VIOLATION", "PERMISSION_FAILURE", "AUDIT_BLOCKED", "RELEASE_BLOCKED", "WORKFLOW_NOT_ELIGIBLE", "UNKNOWN"]) {
      let calls = 0;
      const result = await executeGithubActionsRunner(request, "https://runner.example.test/coding/execute", async (url) => {
        if (String(url).startsWith("https://oidc.example.test/token")) return oidcSuccess();
        calls += 1;
        return response(429, { error: "PROVIDER_RATE_LIMITED", status: "WAITING_RATE_LIMIT", remediationDecision: { outcome: "FAILED_CLOSED", failureClass, recovery: "STOP", retryable: false, attempt: 0, maxAttempts: 3 } });
      }, { initialProposalContext: () => null });
      assert.equal(calls, 1);
      assert.equal(result.status, "FAILED_CLOSED");
      assert.equal(result.httpStatus, 429);
      assert.equal(result.remediationDecision.failureClass, failureClass);
      assert.equal(result.summary.retries, 0);
    }
  });
});

test("malformed non-object Worker response still retains the actual HTTP status", async () => {
  await withOidcEnvironment(async () => {
    for (const payload of [null, [], "untrusted response"]) {
      await assert.rejects(() => authorizedJsonPost("https://runner.example.test/coding/propose", request, async (url) => {
        return String(url).startsWith("https://oidc.example.test/token") ? oidcSuccess() : response(502, payload);
      }), error => {
        assert.equal(error.httpStatus, 502);
        assert.equal(error.message, "AUTOPILOT_WORKER_HTTP_502");
        return true;
      });
    }
  });
});

test("a finished attempt asks the Worker to free its active-WIP claim and never fails because of it", async () => {
  const { releaseActiveWipClaim } = require("../scripts/autopilot-dispatch-retry.js");
  const saved = { url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN };
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.actions.example/id";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token";
  try {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://token.actions.example/")) return new Response(JSON.stringify({ value: "oidc" }), { status: 200 });
      return new Response(JSON.stringify({ released: true }), { status: 200 });
    };
    const request = { dedupeKey: "evolve-coding:abc:github-issue-2118", executionId: "evolve-coding:abc" };
    const result = await releaseActiveWipClaim(request, "https://nusa-autopilot.example/coding/execute", fetchImpl);
    assert.equal(result.released, true);
    const release = calls.find((call) => call.url === "https://nusa-autopilot.example/coding/wip-release");
    assert.ok(release, "posts to /coding/wip-release");
    assert.equal(release.init.headers.authorization, "Bearer oidc");
    assert.deepEqual(JSON.parse(release.init.body), request);

    const failing = await releaseActiveWipClaim(request, "https://nusa-autopilot.example/coding/execute", async () => { throw new Error("network down"); });
    assert.equal(failing.released, false);
  } finally {
    if (saved.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL; else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = saved.url;
    if (saved.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN; else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = saved.token;
  }
});
