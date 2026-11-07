const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
// A daily-quota stop's real resume time is up to ~24h away, not a transient rate-limit backoff.
// Reporting/evidence must reflect the provider's actual nextRetryAt so quota-usage telemetry
// (time-to-exhaustion, provider-wait duration) is accurate; only the LOCAL retry-loop sleep stays
// bounded by MAX_RETRY_DELAY_MS, since a daily-quota stop is never retried within one execution
// (decision is always NO_ACTION for it, so this ceiling never delays a real sleep).
const MAX_REPORTED_QUOTA_RETRY_DELAY_MS = 25 * 60 * 60 * 1_000;
const RETRY_JITTER_RATIO = 0.1;
const MAX_PATCH_BYTES = 24_000;
const MAX_VALIDATED_FILE_BYTES = 128_000;
const MAX_PROPOSAL_CONTEXT_BYTES = 20_000;
const INITIAL_PROPOSAL_CONTEXT_LINES = 160;
const PATCH_PATH = ".nusa-autopilot.patch";
const GENERATED_WORKSPACE_ARTIFACTS = new Set([
  "artifacts/autopilot-execution/repository-dispatch.json",
  "artifacts/autopilot-execution/coding-runner-request.json",
]);
const NO_ACTION_PROPOSAL_FAILURE_CODES = new Set([
  "CODING_PROPOSAL_FAILED_CLOSED",
  "CODING_PROPOSAL_INVALID",
  "CODING_PROPOSAL_JSON_INVALID",
  "CODING_PROPOSAL_PATCH_REQUIRED",
  "CODING_PROPOSAL_RESPONSE_INVALID",
  "CODING_PROPOSAL_SHAPE_INVALID",
  "CODING_PROPOSAL_TOO_LARGE",
  "CODING_PROPOSAL_UNAVAILABLE",
  "CODING_PROPOSAL_REPEATED",
  "SANDBOX_PATCH_APPLY_CHECK_FAILED",
  "SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED",
  "SANDBOX_BUILD_FAILED",
  "SANDBOX_PATCH_FILE_COUNT_INVALID",
  "SANDBOX_PATCH_REQUIRED",
  "SANDBOX_PATCH_TOO_LARGE",
]);
const RETRYABLE_PROPOSAL_FAILURE_CODES = new Set([
  "CODING_PROPOSAL_FAILED_CLOSED",
  "CODING_PROPOSAL_INVALID",
  "CODING_PROPOSAL_JSON_INVALID",
  "CODING_PROPOSAL_PATCH_REQUIRED",
  "CODING_PROPOSAL_RESPONSE_INVALID",
  "CODING_PROPOSAL_SHAPE_INVALID",
  "CODING_PROPOSAL_TOO_LARGE",
  "CODING_PROPOSAL_UNAVAILABLE",
  "SANDBOX_PATCH_APPLY_CHECK_FAILED",
  "SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED",
  "SANDBOX_BUILD_FAILED",
  "SANDBOX_PATCH_FILE_COUNT_INVALID",
  "SANDBOX_PATCH_REQUIRED",
  "SANDBOX_PATCH_TOO_LARGE",
]);

function transientStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function httpClass(status) {
  if (status === null || status === undefined) return "NETWORK";
  return String(Math.floor(Number(status) / 100)) + "xx";
}

function fixedFailureClass(status) {
  return transientStatus(status) ? "transient" : "deterministic";
}

function proposalFailureCode(reason) {
  const text = String(reason || "");
  const match = text.match(/^(CODING_PROPOSAL_[A-Z0-9_]+|SANDBOX_(?:PATCH|BUILD)_[A-Z0-9_]+)/);
  const code = match?.[1];
  if (!code || !NO_ACTION_PROPOSAL_FAILURE_CODES.has(code)) return null;
  if (code.startsWith("CODING_PROPOSAL_")) return text === code ? code : null;
  return text === code || text.startsWith(`${code}:`) ? code : null;
}

function retryableProposalFailureCode(reason) {
  const code = proposalFailureCode(reason);
  return code && RETRYABLE_PROPOSAL_FAILURE_CODES.has(code) ? code : null;
}

function providerRateLimitCode(reason) {
  const code = String(reason || "");
  // /coding/propose stops with error WAITING_PROVIDER_CAPACITY (and no stopReason) while a shared
  // Workers AI wait is recorded. That is bounded provider-capacity evidence, not a failure; left
  // unclassified it failed the consumer closed on every dispatch until the wait lifted.
  if (code === "WAITING_PROVIDER_CAPACITY") return "PROVIDER_RATE_LIMITED";
  return code === "RATE_LIMITED" || code === "WORKERS_AI_DAILY_QUOTA_EXHAUSTED" || code === "WORKERS_AI_RATE_LIMITED" || code === "PROVIDER_RATE_LIMITED"
    ? code
    : null;
}

function responseHeader(headers, name) {
  if (!headers || typeof name !== "string") return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  if (typeof headers !== "object" || Array.isArray(headers)) return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampRetryDelayMs(value, maxMs = MAX_RETRY_DELAY_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(maxMs, Math.floor(numeric));
}

function retryTimestampMs(value, observedAt, maxMs) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    return clampRetryDelayMs(milliseconds - observedAt, maxMs);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? clampRetryDelayMs(parsed - observedAt, maxMs) : null;
}

function retryHint(response, payload, observedAt, maxMs = MAX_RETRY_DELAY_MS) {
  const retryAfter = responseHeader(response?.headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { delayMs: clampRetryDelayMs(seconds * 1_000, maxMs), source: "retry-after-header" };
    }
    const timestampDelay = retryTimestampMs(retryAfter, observedAt, maxMs);
    if (timestampDelay !== null) return { delayMs: timestampDelay, source: "retry-after-header-date" };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  // An absolute timestamp is the provider's own authoritative clock value; a relative
  // retryAfterMs is only reconstructed into an absolute time using *this* observation's
  // clock, which already lags the Worker's by network + parse time. When both are present,
  // prefer the absolute timestamp so a daily-quota reset time is not drifted by that latency.
  for (const key of ["retryAt", "nextRetryAt", "resetAt", "resetTimestamp"]) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const delayMs = retryTimestampMs(payload[key], observedAt, maxMs);
    if (delayMs !== null) return { delayMs, source: `provider-${key}` };
  }
  if (Object.prototype.hasOwnProperty.call(payload, "retryAfterMs")) {
    const delayMs = clampRetryDelayMs(payload.retryAfterMs, maxMs);
    if (delayMs !== null) return { delayMs, source: "provider-retry-after-ms" };
  }
  return null;
}

function providerRateLimitCodeFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  for (const value of [payload.providerStopReason, payload.reason, payload.error, payload.code, payload.status, payload.stopReason, payload.lastFailure]) {
    const code = providerRateLimitCode(value);
    if (code) return code;
  }
  if (payload.status === "WAITING_RATE_LIMIT" || payload.status === "BLOCKED_RATE_LIMIT") return "PROVIDER_RATE_LIMITED";
  return null;
}

function rateLimitEvidence(response, payload, observedAt = Date.now()) {
  const remediationDecision = boundedRemediationDecision(payload?.remediationDecision);
  const code = providerRateLimitCodeFromPayload(payload)
    || (remediationDecision?.failureClass === "PROVIDER_CAPACITY" && remediationDecision.recovery === "WAIT_FOR_PROVIDER" ? "PROVIDER_RATE_LIMITED" : null)
    || (response?.status === 429 ? "RATE_LIMITED" : null);
  if (!code) return null;
  // A daily-quota stop is never locally retried (see decision logic below), so reporting its real
  // resume time cannot lengthen any actual sleep; only the evidence/telemetry value changes. Once
  // a provider-wide wait is already recorded, later executions are stopped with stopReason
  // WAITING_PROVIDER_CAPACITY (not WORKERS_AI_DAILY_QUOTA_EXHAUSTED) but still carry the same
  // long-lived absolute nextRetryAt, so they need the same uncapped reporting ceiling.
  const isLongLivedQuotaStop = code === "WORKERS_AI_DAILY_QUOTA_EXHAUSTED"
    || payload?.stopReason === "WORKERS_AI_DAILY_QUOTA_EXHAUSTED"
    || payload?.stopReason === "WAITING_PROVIDER_CAPACITY"
    || payload?.providerStopReason === "WORKERS_AI_DAILY_QUOTA_EXHAUSTED"
    || payload?.providerStopReason === "WAITING_PROVIDER_CAPACITY"
    || payload?.error === "WAITING_PROVIDER_CAPACITY";
  const maxMs = isLongLivedQuotaStop ? MAX_REPORTED_QUOTA_RETRY_DELAY_MS : MAX_RETRY_DELAY_MS;
  const hint = retryHint(response, payload, observedAt, maxMs);
  const reportedProvider = typeof payload?.provider === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(payload.provider)
    ? payload.provider
    : null;
  return Object.freeze({
    provider: code.startsWith("WORKERS_AI_") ? "workers-ai" : reportedProvider ?? "external-coding-runner",
    code,
    httpStatus: Number.isInteger(response?.status) ? response.status : null,
    lastRateLimitAt: observedAt,
    retryAfterMs: hint?.delayMs ?? null,
    nextRetryAt: hint ? observedAt + hint.delayMs : null,
    retrySource: hint?.source ?? "none",
  });
}

function boundedBackoffMs(baseBackoffMs, attempt, jitter = Math.random) {
  const base = Math.min(MAX_RETRY_DELAY_MS, baseBackoffMs * 2 ** Math.max(0, attempt - 1));
  const sample = Number(jitter());
  const normalized = Number.isFinite(sample) && sample >= 0 && sample <= 1 ? sample : 0.5;
  return clampRetryDelayMs(base + (normalized * 2 - 1) * base * RETRY_JITTER_RATIO) ?? 0;
}

function rateLimitedResult(result, evidence, rateLimitEvents = []) {
  const fallbackProvider = evidence?.fallbackProvider === "github-models" ? evidence.fallbackProvider : undefined;
  const fallbackFailureReason = typeof evidence?.fallbackFailureReason === "string"
    && /^[A-Z0-9_:-]{1,160}$/.test(evidence.fallbackFailureReason)
    ? evidence.fallbackFailureReason
    : undefined;
  const enriched = {
    ...result,
    ...(fallbackProvider ? { fallbackProvider } : {}),
    ...(fallbackFailureReason ? { fallbackFailureReason } : {}),
    provider: evidence.provider,
    lastRateLimitAt: evidence.lastRateLimitAt,
    nextRetryAt: evidence.nextRetryAt,
    retrySource: evidence.retrySource,
    rateLimitEvents,
  };
  return {
    ...enriched,
    summary: {
      ...result.summary,
      provider: evidence.provider,
      lastRateLimitAt: evidence.lastRateLimitAt,
      nextRetryAt: evidence.nextRetryAt,
      retrySource: evidence.retrySource,
      rateLimitEvents: rateLimitEvents.length,
    },
  };
}

function withRateLimitEvents(result, rateLimitEvents) {
  if (!Array.isArray(rateLimitEvents) || rateLimitEvents.length === 0) return result;
  return {
    ...result,
    rateLimitEvents,
    summary: { ...result.summary, rateLimitEvents: rateLimitEvents.length },
  };
}

function proposalRepairFeedback(code, attempt) {
  return `attempt=${attempt};rejection=${code};repair=regenerate one valid unified diff against the exact head for one existing apps/autopilot/src TypeScript file;do_not_repeat_previous_patch=true`;
}

function safeWorkerStatus(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "UNKNOWN";
}

const REMEDIATION_FAILURE_CLASSES = new Set([
  "AUDIT_BLOCKED",
  "RELEASE_BLOCKED",
  "DEPLOYMENT_FAILURE",
  "PERMISSION_FAILURE",
  "WORKFLOW_NOT_ELIGIBLE",
  "AUTHORITY_VIOLATION",
  "EVIDENCE_UNVERIFIED",
  "EVIDENCE_MISMATCH",
  "REQUEST_INVALID",
  "PROVIDER_CAPACITY",
  "PROVIDER_FAILURE",
  "PROPOSAL_REJECTED",
  "UNKNOWN",
]);
const REMEDIATION_RECOVERIES = new Set(["STOP", "WAIT_FOR_PROVIDER", "RETRY_BOUNDED", "REGENERATE_PROPOSAL", "REDISPATCH_FRESH_EVIDENCE"]);
const TERMINAL_REMEDIATION_CLASSES = new Set([
  "AUDIT_BLOCKED", "RELEASE_BLOCKED", "DEPLOYMENT_FAILURE", "PERMISSION_FAILURE",
  "WORKFLOW_NOT_ELIGIBLE", "AUTHORITY_VIOLATION", "REQUEST_INVALID", "UNKNOWN",
]);

function boundedRemediationDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outcomes = new Set(["VALID_NO_ACTION", "FAILED_TO_REMEDIATE", "FAILED_CLOSED"]);
  if (!outcomes.has(value.outcome)
    || !REMEDIATION_FAILURE_CLASSES.has(value.failureClass)
    || !REMEDIATION_RECOVERIES.has(value.recovery)
    || typeof value.retryable !== "boolean"
    || !Number.isSafeInteger(value.attempt) || value.attempt !== 0
    || !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 3) return null;
  if (value.retryable && (value.outcome !== "FAILED_TO_REMEDIATE" || value.attempt >= value.maxAttempts)) return null;
  if (value.outcome === "VALID_NO_ACTION" && (value.retryable || value.failureClass !== "UNKNOWN" || value.recovery !== "STOP")) return null;
  if (value.outcome === "FAILED_CLOSED" && value.retryable) return null;
  if (TERMINAL_REMEDIATION_CLASSES.has(value.failureClass)
    && (value.retryable || value.recovery !== "STOP"
      || (value.outcome !== "FAILED_CLOSED" && value.outcome !== "VALID_NO_ACTION"))) return null;
  if (value.retryable && !(
    (value.failureClass === "PROPOSAL_REJECTED" && value.recovery === "REGENERATE_PROPOSAL")
    || (["PROVIDER_FAILURE", "EVIDENCE_UNVERIFIED"].includes(value.failureClass) && value.recovery === "RETRY_BOUNDED")
  )) return null;
  return Object.freeze({
    outcome: value.outcome,
    failureClass: value.failureClass,
    recovery: value.recovery,
    retryable: value.retryable,
    attempt: value.attempt,
    maxAttempts: value.maxAttempts,
  });
}

function attemptRecord({ request, attempt, decision, startedAt, status, workerStatus, failureClass, reason, now, recovery, workerHttpStatus = null }) {
  return Object.freeze({
    schemaVersion: 1,
    execution_id: request.executionId,
    dedupe_key: request.dedupeKey,
    backend: "github-actions-runner",
    decision,
    recovery: decision === "RETRY" ? recovery ?? "RETRY_BOUNDED" : "STOP",
    retryable: decision === "RETRY",
    attempt,
    latency_ms: Math.max(0, now() - startedAt),
    http_class: httpClass(status),
    http_status: Number.isInteger(status) ? status : null,
    worker_http_status: workerHttpStatus,
    worker_http_class: Number.isInteger(workerHttpStatus) ? httpClass(workerHttpStatus) : null,
    checkpoint_id: request.headSha,
    resumed: false,
    worker_status: workerStatus,
    failure_class: failureClass,
    reason,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
}

function resultSummary(request, attempts, status, reason, httpStatus, workerStatus) {
  const counts = attempts.reduce((summary, attempt) => {
    summary.attempts += 1;
    if (attempt.decision === "RETRY") summary.retries += 1;
    if (attempt.decision === "DISPATCHED") summary.dispatched += 1;
    if (attempt.decision === "NO_ACTION") summary.noAction += 1;
    if (attempt.decision === "FAILED_CLOSED") summary.failedClosed += 1;
    return summary;
  }, { attempts: 0, retries: 0, dispatched: 0, noAction: 0, failedClosed: 0 });
  return {
    status,
    reason,
    httpStatus,
    workerStatus,
    attempts,
    summary: {
      schemaVersion: 1,
      execution_id: request.executionId,
      dedupe_key: request.dedupeKey,
      backend: "github-actions-runner",
      checkpoint_id: request.headSha,
      ...counts,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    },
  };
}

async function oidcToken({ fetchImpl, requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }) {
  if (typeof requestUrl !== "string" || !requestUrl || typeof requestToken !== "string" || !requestToken) {
    return { ok: false, status: null, reason: "github-oidc-not-configured", retryable: false };
  }
  let response;
  try {
    const tokenUrl = new URL(requestUrl);
    tokenUrl.searchParams.set("audience", "nusa-autopilot");
    response = await fetchImpl(tokenUrl, { headers: { authorization: "Bearer " + requestToken } });
  } catch {
    return { ok: false, status: null, reason: "github-oidc-network-failure", retryable: true };
  }
  if (!response.ok) return { ok: false, status: response.status, reason: "github-oidc-request-failed", retryable: transientStatus(response.status) };
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: response.status, reason: "github-oidc-token-missing", retryable: false };
  }
  if (!payload || typeof payload.value !== "string" || !payload.value) return { ok: false, status: response.status, reason: "github-oidc-token-missing", retryable: false };
  return { ok: true, status: response.status, value: payload.value };
}

async function dispatchWithRetry({
  request,
  url,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  jitter = Math.random,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BACKOFF_MS,
  oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("AUTOPILOT_RETRY_LIMIT_INVALID");
  if (!Number.isSafeInteger(baseBackoffMs) || baseBackoffMs < 0 || baseBackoffMs > 30_000) throw new Error("AUTOPILOT_BACKOFF_INVALID");

  const attempts = [];
  const rateLimitEvents = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = now();
    const token = await oidcToken({ fetchImpl, requestUrl: oidcRequestUrl, requestToken: oidcRequestToken });
    if (!token.ok) {
      const decision = token.retryable && attempt < maxAttempts ? "RETRY" : "FAILED_CLOSED";
      attempts.push(attemptRecord({ request, attempt, decision, startedAt, status: token.status, workerStatus: "OIDC_UNAVAILABLE", failureClass: fixedFailureClass(token.status), reason: token.reason, now }));
      if (decision === "RETRY") {
        await sleep(boundedBackoffMs(baseBackoffMs, attempt, jitter));
        continue;
      }
      return resultSummary(request, attempts, "FAILED_CLOSED", token.reason, token.status, "OIDC_UNAVAILABLE");
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token.value,
          "content-type": "application/json",
          "x-nusa-execution-id": request.executionId,
          "x-nusa-dedupe-key": request.dedupeKey,
        },
        body: JSON.stringify(request),
      });
    } catch {
      const decision = attempt < maxAttempts ? "RETRY" : "FAILED_CLOSED";
      attempts.push(attemptRecord({ request, attempt, decision, startedAt, status: null, workerStatus: "NETWORK_FAILURE", failureClass: "transient", reason: "coding-runner-network-failure", now }));
      if (decision === "RETRY") {
        await sleep(boundedBackoffMs(baseBackoffMs, attempt, jitter));
        continue;
      }
      return resultSummary(request, attempts, "FAILED_CLOSED", "coding-runner-network-failure", null, "NETWORK_FAILURE");
    }

    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    const observedAt = now();
    const rateLimit = rateLimitEvidence(response, payload, observedAt);
    if (rateLimit) {
      const workerWaiting = payload?.status === "WAITING_RATE_LIMIT" || payload?.status === "BLOCKED_RATE_LIMIT";
      const providerQuotaExhausted = rateLimit.code === "WORKERS_AI_DAILY_QUOTA_EXHAUSTED";
      const providerCapacity = rateLimit.code === "PROVIDER_RATE_LIMITED"
        || rateLimit.code === "WORKERS_AI_RATE_LIMITED"
        || payload?.status === "CODING_PROPOSAL_FAILED_CLOSED";
      const decision = !workerWaiting && !providerQuotaExhausted && !providerCapacity && attempt < maxAttempts ? "RETRY" : "NO_ACTION";
      const delayMs = rateLimit.retryAfterMs ?? boundedBackoffMs(baseBackoffMs, attempt, jitter);
      const fallbackProvider = payload?.fallbackProvider === "github-models" ? payload.fallbackProvider : undefined;
      const fallbackFailureReason = typeof payload?.fallbackFailureReason === "string"
        && /^[A-Z0-9_:-]{1,160}$/.test(payload.fallbackFailureReason)
        ? payload.fallbackFailureReason
        : undefined;
      const nextEvidence = Object.freeze({
        ...rateLimit,
        nextRetryAt: observedAt + delayMs,
        stopReason: typeof payload?.stopReason === "string" ? payload.stopReason : rateLimit.code,
        stoppedAt: Number.isSafeInteger(payload?.stoppedAt) ? payload.stoppedAt : observedAt,
        resumeCondition: typeof payload?.resumeCondition === "string" ? payload.resumeCondition : "provider-capacity-and-exact-head-revalidation",
        retrySource: rateLimit.retryAfterMs === null ? "bounded-exponential-backoff-jitter" : rateLimit.retrySource,
        ...(fallbackProvider ? { fallbackProvider } : {}),
        ...(fallbackFailureReason ? { fallbackFailureReason } : {}),
      });
      rateLimitEvents.push(nextEvidence);
      const rateLimitEventsForResult = [...rateLimitEvents];
      attempts.push(attemptRecord({ request, attempt, decision, startedAt, status: response.status, workerStatus: "RATE_LIMITED", failureClass: "transient", reason: rateLimit.code, now }));
      if (decision === "RETRY") {
        await sleep(delayMs);
        continue;
      }
      const waitingStatus = workerWaiting || providerCapacity;
      return rateLimitedResult(resultSummary(request, attempts, waitingStatus ? "WAITING_RATE_LIMIT" : "BLOCKED_RATE_LIMIT", rateLimit.code, response.status, waitingStatus ? "WAITING_RATE_LIMIT" : "RATE_LIMITED"), nextEvidence, rateLimitEventsForResult);
    }

    if (response.ok) {
      const workerStatus = safeWorkerStatus(payload && payload.status);
      if (["EXECUTION_ACCEPTED", "EXECUTION_DISPATCHED"].includes(workerStatus)) {
        attempts.push(attemptRecord({ request, attempt, decision: "DISPATCHED", startedAt, status: response.status, workerStatus, failureClass: null, reason: null, now }));
        return withRateLimitEvents(resultSummary(request, attempts, "DISPATCHED", null, response.status, workerStatus), rateLimitEvents);
      }
      if (workerStatus === "DUPLICATE_EXECUTION_SUPPRESSED") {
        attempts.push(attemptRecord({ request, attempt, decision: "NO_ACTION", startedAt, status: response.status, workerStatus, failureClass: "deterministic", reason: "duplicate-execution-suppressed", now }));
        return resultSummary(request, attempts, "NO_ACTION", "duplicate-execution-suppressed", response.status, workerStatus);
      }
      attempts.push(attemptRecord({ request, attempt, decision: "FAILED_CLOSED", startedAt, status: response.status, workerStatus, failureClass: "deterministic", reason: "cloud-coding-runtime-not-ready", now }));
      return resultSummary(request, attempts, "FAILED_CLOSED", "cloud-coding-runtime-not-ready", response.status, workerStatus);
    }

    const decision = transientStatus(response.status) && attempt < maxAttempts ? "RETRY" : "FAILED_CLOSED";
    attempts.push(attemptRecord({ request, attempt, decision, startedAt, status: response.status, workerStatus: "HTTP_REJECTED", failureClass: fixedFailureClass(response.status), reason: transientStatus(response.status) ? "external-coding-runner-transient-failure" : "external-coding-runner-rejected-request", now }));
    if (decision === "RETRY") {
      await sleep(boundedBackoffMs(baseBackoffMs, attempt, jitter));
      continue;
    }
    return resultSummary(request, attempts, "FAILED_CLOSED", transientStatus(response.status) ? "external-coding-runner-transient-failure" : "external-coding-runner-rejected-request", response.status, "HTTP_REJECTED");
  }
  throw new Error("AUTOPILOT_RETRY_EXHAUSTED");
}

function readDispatchRequest() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (typeof eventPath !== "string" || !eventPath) throw new Error("GITHUB_EVENT_PATH_MISSING");
  let contents;
  try {
    contents = fs.readFileSync(eventPath, "utf8");
  } catch {
    throw new Error("GITHUB_EVENT_FILE_UNREADABLE");
  }
  let event;
  try {
    event = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("GITHUB_EVENT_JSON_INVALID");
  }
  const payload = event.client_payload || {};
  const isCausalFailure = typeof payload.reason === "string" && payload.reason.startsWith("gha:");
  const failure = isCausalFailure ? /^gha:([1-9][0-9]{0,19}):([a-f0-9]{40}):(failure|timed_out)$/.exec(payload.reason) : null;
  const capability = payload.causal_dispatch_capability;
  if (isCausalFailure && (!failure || Number(failure[1]) !== payload.workflow_run_id || failure[2] !== payload.head_sha
    || !Number.isSafeInteger(payload.causal_source_run_attempt) || payload.causal_source_run_attempt < 1
    || payload.causal_source_run_attempt > 9_999_999_999 || typeof capability !== "string" || !/^[a-f0-9]{64}$/.test(capability))) {
    throw new Error("CAUSAL_DISPATCH_SOURCE_IDENTITY_INVALID");
  }
  if (!isCausalFailure && capability !== undefined) throw new Error("CAUSAL_DISPATCH_CAPABILITY_UNEXPECTED");
  const request = {
    kind: payload.kind,
    repository: payload.repository,
    headSha: payload.head_sha,
    workflowRunId: payload.workflow_run_id,
    ...(isCausalFailure ? { workflowRunAttempt: payload.causal_source_run_attempt } : {}),
    reason: payload.reason,
    executionId: payload.execution_id,
    dedupeKey: payload.dedupe_key,
    mutationAllowed: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  };
  return { request, causalDispatchCapability: isCausalFailure ? capability : null };
}

function writeFailureArtifact(reason) {
  const directory = "artifacts/autopilot-execution";
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(directory + "/coding-runner-result.json", JSON.stringify({
    schemaVersion: 1,
    status: "FAILED_CLOSED",
    reason,
    workerStatus: "FAILED_CLOSED",
    request: null,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  }, null, 2));
}

function endpointFor(runnerUrl, suffix) {
  const url = new URL(runnerUrl);
  if (!url.pathname.endsWith("/coding/execute")) throw new Error("AUTOPILOT_CODING_RUNNER_URL_INVALID");
  url.pathname = `/coding/${suffix}`;
  url.search = "";
  return url.toString();
}

function boundedWorkerFailureEvidence(payload, url, httpStatus) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const evidence = payload.failureEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const code = typeof evidence.code === "string" && /^[A-Z0-9_]{1,128}$/.test(evidence.code) ? evidence.code : null;
  const workflowRunId = Number.isSafeInteger(evidence.workflowRunId) && evidence.workflowRunId > 0 ? evidence.workflowRunId : null;
  const headSha = typeof evidence.headSha === "string" && /^[0-9a-f]{40}$/i.test(evidence.headSha) ? evidence.headSha.toLowerCase() : null;
  if (!code || !workflowRunId || !headSha) return null;
  const bounded = (value, pattern = /^[A-Za-z0-9_.:/ -]{1,128}$/) => typeof value === "string" && pattern.test(value) ? value : null;
  return Object.freeze({
    code,
    endpoint: new URL(url).pathname,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    workflowRunId,
    workflowId: Number.isSafeInteger(evidence.workflowId) && evidence.workflowId > 0 ? evidence.workflowId : null,
    workflowPath: bounded(evidence.workflowPath, /^\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/),
    workflowName: bounded(evidence.workflowName),
    workflowEvent: bounded(evidence.workflowEvent, /^[A-Za-z0-9_.:-]{1,64}$/),
    workflowStatus: bounded(evidence.workflowStatus, /^[A-Za-z0-9_.:-]{1,64}$/),
    workflowConclusion: bounded(evidence.workflowConclusion, /^[A-Za-z0-9_.:-]{1,64}$/),
    headSha,
  });
}

// Diagnostic projection only: never retain arbitrary response fields or credential-like text.
function boundedDecisionDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const label = (v) => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v)
    && !/TOKEN|SECRET|PASSWORD|CREDENTIAL_VALUE|PRIVATE_KEY/.test(v) ? v : null;
  return Object.freeze({
    outcome: label(value.outcome),
    failureClass: label(value.failureClass),
    recovery: label(value.recovery),
    retryable: typeof value.retryable === "boolean" ? value.retryable : null,
    attempt: Number.isSafeInteger(value.attempt) && value.attempt >= 0 && value.attempt <= 3 ? value.attempt : null,
    maxAttempts: Number.isSafeInteger(value.maxAttempts) && value.maxAttempts >= 1 && value.maxAttempts <= 3 ? value.maxAttempts : null,
  });
}

function terminalFailureResult(request, error, startedAt, now = () => Date.now(), attempt = 1) {
  const reason = error instanceof Error ? error.message : "AUTOPILOT_GITHUB_RUNNER_FAILED";
  const safeFailure = proposalFailureCode(reason);
  const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : null;
  const diagnostics = error?.decisionDiagnostics ?? null;
  const workerStatus = error?.workerStatus ?? (safeFailure ? "REMEDIATION_EXHAUSTED" : "FAILED_CLOSED");
  const attempts = [attemptRecord({
    request, attempt, decision: "FAILED_CLOSED", startedAt, status, workerStatus,
    failureClass: diagnostics?.failureClass ?? "deterministic", reason: safeFailure || reason, now, workerHttpStatus: error?.workerHttpStatus ?? null,
  })];
  const diagnosticAttempt = Object.freeze({
    ...attempts[0],
    recovery: "STOP",
    retryable: false,
    decision_validation_failure: error?.decisionValidationFailure ?? null,
  });
  attempts[0] = diagnosticAttempt;
  return {
    ...resultSummary(request, attempts, safeFailure ? "FAILED_TO_REMEDIATE" : "FAILED_CLOSED", safeFailure || reason, status, workerStatus),
    failureEvidence: error?.failureEvidence ?? null,
    decisionDiagnostics: diagnostics,
    workerHttpStatus: error?.workerHttpStatus ?? null,
    workerFailureCode: error?.workerFailureCode ?? null,
    decisionValidationFailure: error?.decisionValidationFailure ?? null,
    workflowRunId: request.workflowRunId,
    headSha: request.headSha,
  };
}

async function authorizedJsonPost(url, body, fetchImpl = fetch, now = () => Date.now(), extraHeaders = {}) {
  const token = await oidcToken({ fetchImpl });
  if (!token.ok) throw new Error(token.reason);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* fail below */ }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
  if (!response.ok) {
    const hasRemediationDecision = payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "remediationDecision");
    const remediationDecision = hasRemediationDecision ? boundedRemediationDecision(payload.remediationDecision) : null;
    const invalidDecision = hasRemediationDecision && !remediationDecision;
    const error = new Error(invalidDecision ? "CODING_REMEDIATION_DECISION_INVALID"
      : typeof payload.error === "string" ? payload.error : `AUTOPILOT_WORKER_HTTP_${response.status}`);
    error.failureEvidence = boundedWorkerFailureEvidence(payload, url, response.status);
    error.httpStatus = response.status;
    error.workerHttpStatus = Number.isInteger(payload.httpStatus) && payload.httpStatus >= 100 && payload.httpStatus <= 599 ? payload.httpStatus : null;
    error.workerFailureCode = typeof payload.error === "string" && /^[A-Z0-9_]{1,128}$/.test(payload.error) ? payload.error : null;
    error.workerStatus = safeWorkerStatus(payload?.status);
    error.decisionDiagnostics = boundedDecisionDiagnostics(payload?.remediationDecision);
    error.decisionValidationFailure = invalidDecision ? "SCHEMA_OR_ALLOWLIST_MISMATCH" : null;
    if (invalidDecision) throw error;
    if (remediationDecision) error.remediationDecision = remediationDecision;
    error.rateLimit = rateLimitEvidence(response, payload, now());
    const workerRateLimitStop = error.rateLimit && (
      payload?.status === "WAITING_RATE_LIMIT"
      || payload?.status === "BLOCKED_RATE_LIMIT"
      || payload?.error === "WAITING_PROVIDER_CAPACITY"
      || payload?.status === "CODING_PROPOSAL_FAILED_CLOSED" && typeof payload?.providerStopReason === "string"
    );
    if (workerRateLimitStop) {
      error.workerStop = true;
      error.rateLimit = Object.freeze({
        ...error.rateLimit,
        ...(typeof payload.error === "string" ? { stopReason: payload.error, lastFailure: payload.error } : {}),
        ...(typeof payload.stopReason === "string" ? { stopReason: payload.stopReason } : {}),
        ...(typeof payload.resumeCondition === "string" ? { resumeCondition: payload.resumeCondition } : {}),
        ...(Number.isSafeInteger(payload.stoppedAt) ? { stoppedAt: payload.stoppedAt } : {}),
        ...(typeof payload.lastFailure === "string" ? { lastFailure: payload.lastFailure } : {}),
      });
    }
    throw error;
  }
  const rateLimit = rateLimitEvidence(response, payload, now());
  if (rateLimit) {
    const workerStop = payload?.status === "WAITING_RATE_LIMIT"
      || payload?.status === "BLOCKED_RATE_LIMIT"
      || payload?.error === "WAITING_PROVIDER_CAPACITY"
      || payload?.status === "CODING_PROPOSAL_FAILED_CLOSED" && typeof payload?.providerStopReason === "string";
    const error = new Error(workerStop ? (payload.status || payload.error) : rateLimit.code);
    error.workerStop = workerStop;
    error.rateLimit = Object.freeze({
      ...rateLimit,
      ...(workerStop && typeof payload.stopReason === "string" ? { stopReason: payload.stopReason } : {}),
      ...(workerStop && typeof payload.providerStopReason === "string" ? { stopReason: payload.providerStopReason } : {}),
      ...(workerStop && typeof payload.error === "string" ? { lastFailure: payload.error } : {}),
      ...(workerStop && typeof payload.resumeCondition === "string" ? { resumeCondition: payload.resumeCondition } : {}),
      ...(workerStop && Number.isSafeInteger(payload.stoppedAt) ? { stoppedAt: payload.stoppedAt } : {}),
      ...(workerStop && typeof payload.lastFailure === "string" ? { lastFailure: payload.lastFailure } : {}),
    });
    throw error;
  }
  return payload;
}

function assertBoundedPatch(patch) {
  if (typeof patch !== "string" || !patch.trim()) throw new Error("SANDBOX_PATCH_REQUIRED");
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) throw new Error("SANDBOX_PATCH_TOO_LARGE");
  if (/liveAuthority|productionMutationAllowed|aiAuthority|NUSA_|wrangler|\.github\//i.test(patch)) {
    throw new Error("SANDBOX_PATCH_FORBIDDEN_AUTHORITY_SURFACE");
  }
  const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1].trim());
  const unique = [...new Set(paths)];
  if (unique.length !== 1) throw new Error("SANDBOX_PATCH_FILE_COUNT_INVALID");
  const path = unique[0];
  return assertAllowedPatchTargetPath(path);
}

function assertAllowedPatchTargetPath(path) {
  if (!path.startsWith("apps/autopilot/") || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`SANDBOX_PATCH_PATH_OUTSIDE_ALLOWED_SCOPE:${path}`);
  if (path === "apps/autopilot/src/index.ts" || path === "apps/autopilot/src/worker.ts" || /(?:^|\/)(?:live|live-trading|broker|order|credential|secret|secrets|withdraw|transfer|production-authority)(?:\/|$)/i.test(path)) throw new Error(`SANDBOX_PATCH_PATH_FORBIDDEN:${path}`);
  return path;
}

function run(command, args, label, timeout = 300_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}:${result.status}:${String(result.stderr || result.stdout || "").slice(-1200)}`);
  return String(result.stdout || "");
}

function boundedProposalContext(path, content, patch) {
  if (assertBoundedPatch(patch) !== path) throw new Error("CODING_PROPOSAL_CONTEXT_PATH_MISMATCH");
  if (typeof content !== "string" || !content.trim()) throw new Error("CODING_PROPOSAL_CONTEXT_CONTENT_INVALID");
  const lines = content.split(/\r?\n/);
  const hunk = patch.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/m);
  const anchorLine = hunk ? Number(hunk[1]) : 1;
  const anchorIndex = Math.max(0, Math.min(lines.length - 1, Number.isSafeInteger(anchorLine) ? anchorLine - 1 : 0));
  const startIndex = Math.max(0, anchorIndex - 40);
  let endIndex = Math.min(lines.length, startIndex + 160);
  let excerpt = lines.slice(startIndex, endIndex).join("\n");
  while (Buffer.byteLength(excerpt, "utf8") > MAX_PROPOSAL_CONTEXT_BYTES && endIndex - startIndex > 20) {
    endIndex -= 10;
    excerpt = lines.slice(startIndex, endIndex).join("\n");
  }
  if (!excerpt.trim() || Buffer.byteLength(excerpt, "utf8") > MAX_PROPOSAL_CONTEXT_BYTES) {
    throw new Error("CODING_PROPOSAL_CONTEXT_TOO_LARGE");
  }
  return Object.freeze({ path, startLine: startIndex + 1, content: excerpt });
}

/**
 * The first proposal of an execution used to carry no source context at all, so the model was
 * asked for a unified diff against files it had never seen. `git apply --check` in the sandbox
 * runs without fuzz and without --3way, so every context line it invented had to match the
 * repository byte for byte; attempt 1 could only ever apply by coincidence. Retries were fine —
 * proposalContextFromGithubRunner reads the real working tree — so the fix is to give attempt 1
 * the same kind of real excerpt instead of nothing.
 *
 * The target is never guessed. Only a file the request itself names (by full path, or by a
 * basename that matches exactly one eligible file) is supplied; zero or several matches supply
 * nothing. A guessed file would be worse than none: the prompt tells the model to patch the
 * supplied file only, so an unrelated file invites an unrelated change that can still validate
 * and publish. Files above the publishing limit are excluded, because a patch to one of them
 * fails CODING_PUBLISH_CONTENT_INVALID after the full validation suite has already run. Every
 * failure path returns null, which leaves the caller exactly where it was before this existed.
 */
function initialProposalContextTargets() {
  const listed = run("git", ["ls-files", "--", "apps/autopilot/src"], "CODING_PROPOSAL_CONTEXT_LIST_FAILED");
  return listed
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.endsWith(".test.ts"))
    .filter((path) => {
      try {
        assertAllowedPatchTargetPath(path);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function requestNamedTarget(request, targets) {
  const text = [request?.reason, request?.proposalFeedback].filter((value) => typeof value === "string").join("\n");
  if (!text) return null;
  const mentioned = (needle, before) => new RegExp(`${before}${needle.replace(/[.]/g, "\\.")}(?![A-Za-z0-9_])`).test(text);
  const byPath = targets.filter((path) => mentioned(path, "(?:^|[^A-Za-z0-9_./-])"));
  if (byPath.length === 1) return byPath[0];
  if (byPath.length > 1) return null;
  const byName = targets.filter((path) => mentioned(path.split("/").pop(), "(?:^|[^A-Za-z0-9_./-])"));
  return byName.length === 1 ? byName[0] : null;
}

function initialProposalContextFromGithubRunner(request) {
  let targets;
  try {
    targets = initialProposalContextTargets();
  } catch {
    return null;
  }
  const path = /^gha:[1-9][0-9]{0,19}:[a-f0-9]{40}:(?:failure|timed_out)$/.test(request?.reason || "")
    ? "apps/autopilot/src/repairableWorkflowRun.ts"
    : requestNamedTarget(request, targets);
  if (path && !targets.includes(path)) return null;
  if (!path) return null;
  let content;
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_VALIDATED_FILE_BYTES) return null;
    content = fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (typeof content !== "string" || !content.trim()) return null;
  const lines = content.split(/\r?\n/);
  let endIndex = Math.min(lines.length, INITIAL_PROPOSAL_CONTEXT_LINES);
  let excerpt = lines.slice(0, endIndex).join("\n");
  while (Buffer.byteLength(excerpt, "utf8") > MAX_PROPOSAL_CONTEXT_BYTES && endIndex > 20) {
    endIndex -= 10;
    excerpt = lines.slice(0, endIndex).join("\n");
  }
  if (!excerpt.trim() || Buffer.byteLength(excerpt, "utf8") > MAX_PROPOSAL_CONTEXT_BYTES) return null;
  return Object.freeze({ path, startLine: 1, content: excerpt });
}

function proposalContextFromGithubRunner(patch) {
  const path = assertBoundedPatch(patch);
  run("git", ["ls-files", "--error-unmatch", "--", path], "CODING_PROPOSAL_CONTEXT_TRACKED_FILE_REQUIRED");
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CODING_PROPOSAL_CONTEXT_FILE_INVALID");
  return boundedProposalContext(path, fs.readFileSync(path, "utf8"), patch);
}

function isGeneratedWorkspaceArtifact(path) {
  return GENERATED_WORKSPACE_ARTIFACTS.has(path);
}

function filterGithubRunnerWorkspacePaths(paths) {
  return paths.filter((path) => path && path !== PATCH_PATH && !isGeneratedWorkspaceArtifact(path));
}

function assertGithubRunnerWorkspaceClean(statusOutput) {
  const unexpected = String(statusOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const status = line.slice(0, 2);
      const path = line.slice(3).trim();
      return status !== "??" || !isGeneratedWorkspaceArtifact(path);
    });
  if (unexpected.length > 0) throw new Error("CODING_RUNTIME_WORKSPACE_DIRTY");
}

function resetProposalRetryWorkspace() {
  // validatePatchOnGithubRunner applies the candidate before running the build. Every
  // retry starts from the exact clean head that was checked before proposal generation.
  // Local unit tests intentionally run in the developer checkout; only the ephemeral
  // GitHub runner is safe to restore destructively.
  if (process.env.GITHUB_ACTIONS === "true") {
    run("git", ["reset", "--hard", "HEAD"], "GITHUB_RUNNER_RETRY_RESTORE_FAILED");
  }
  fs.rmSync(PATCH_PATH, { force: true });
  if (process.env.GITHUB_ACTIONS === "true") {
    const tracked = run("git", ["diff", "--name-only"], "GITHUB_RUNNER_RETRY_TRACKED_STATUS_FAILED").trim();
    const staged = run("git", ["diff", "--cached", "--name-only"], "GITHUB_RUNNER_RETRY_STAGED_STATUS_FAILED").trim();
    if (tracked || staged) throw new Error("CODING_RUNTIME_WORKSPACE_DIRTY");
  }
}

function normalizeUnifiedDiffHunkCounts(patch) {
  const lines = String(patch).replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (!match) continue;
    let oldCount = 0;
    let newCount = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.startsWith("@@ ") || line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line === "") break;
      if (line.startsWith("\\ No newline at end of file")) continue;
      if (line.startsWith(" ")) {
        oldCount += 1;
        newCount += 1;
        continue;
      }
      if (line.startsWith("-")) {
        oldCount += 1;
        continue;
      }
      if (line.startsWith("+")) {
        newCount += 1;
        continue;
      }
      break;
    }
    lines[index] = `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}`;
  }
  return lines.join("\n");
}

function applyPatchWithNormalizedHunkCounts(patchPath = PATCH_PATH) {
  let strictFailure;
  try {
    run("git", ["apply", "--check", patchPath], "SANDBOX_PATCH_APPLY_CHECK_FAILED");
  } catch (error) {
    strictFailure = error;
  }
  if (!strictFailure) {
    run("git", ["apply", patchPath], "SANDBOX_PATCH_APPLY_FAILED");
    return "strict";
  }

  const originalPatch = fs.readFileSync(patchPath, "utf8");
  const normalizedPatch = normalizeUnifiedDiffHunkCounts(originalPatch);
  if (normalizedPatch === originalPatch) throw strictFailure;
  fs.writeFileSync(patchPath, normalizedPatch, "utf8");

  try {
    // Only unified-diff hunk count numerals are normalized. The repaired patch must then pass the
    // ordinary strict apply check: exact source context is still required and no fuzz/3-way merge
    // or alternate Git apply mode is enabled.
    run("git", ["apply", "--check", patchPath], "SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED");
    run("git", ["apply", patchPath], "SANDBOX_PATCH_NORMALIZED_APPLY_FAILED");
    console.log("SANDBOX_PATCH_HUNK_COUNTS_NORMALIZED");
    return "normalized";
  } catch (error) {
    fs.writeFileSync(patchPath, originalPatch, "utf8");
    // Recounting was attempted and failed independently. Preserve that exact transition instead
    // of collapsing it back to the original strict-apply failure so the bounded repair loop can
    // distinguish a post-recount apply failure from the initial malformed-hunk rejection.
    throw error;
  }
}

function validatePatchOnGithubRunner(request, patch) {
  const expectedPath = assertBoundedPatch(patch);
  if (String(request.reason || "").startsWith("gha:") && expectedPath !== "apps/autopilot/src/repairableWorkflowRun.ts") {
    throw new Error("CAUSAL_REPAIR_TARGET_MISMATCH");
  }
  if (run("git", ["rev-parse", "HEAD"], "GITHUB_RUNNER_HEAD_FAILED").trim().toLowerCase() !== request.headSha.toLowerCase()) {
    throw new Error("CODING_RUNTIME_HEAD_MISMATCH");
  }
  assertGithubRunnerWorkspaceClean(run("git", ["status", "--porcelain", "--untracked-files=all"], "GITHUB_RUNNER_STATUS_FAILED"));

  fs.writeFileSync(PATCH_PATH, `${patch.trim()}\n`);
  applyPatchWithNormalizedHunkCounts(PATCH_PATH);
  run("git", ["diff", "--check"], "SANDBOX_PATCH_DIFF_CHECK_FAILED");

  const tracked = run("git", ["diff", "--name-only"], "SANDBOX_PATCH_DIFF_LIST_FAILED").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const untracked = filterGithubRunnerWorkspacePaths(run("git", ["ls-files", "--others", "--exclude-standard"], "SANDBOX_PATCH_UNTRACKED_LIST_FAILED")
    .split(/\r?\n/)
    .map((value) => value.trim()));
  const changed = [...new Set([...tracked, ...untracked])];
  if (changed.length !== 1 || changed[0] !== expectedPath) throw new Error("SANDBOX_PATCH_CHANGED_FILES_MISMATCH");

  run("corepack", ["enable"], "GITHUB_RUNNER_COREPACK_ENABLE_FAILED");
  run("corepack", ["prepare", "pnpm@11.7.0", "--activate"], "GITHUB_RUNNER_PNPM_ACTIVATE_FAILED");
  run("pnpm", ["install", "--frozen-lockfile"], "SANDBOX_INSTALL_FAILED", 480_000);
  run("pnpm", ["run", "build"], "SANDBOX_BUILD_FAILED", 480_000);
  run("pnpm", ["run", "architecture:check"], "SANDBOX_ARCHITECTURE_FAILED", 300_000);
  run("pnpm", ["run", "safety:invariants"], "SANDBOX_SAFETY_FAILED", 300_000);
  run("pnpm", ["run", "ai:architecture"], "SANDBOX_AI_ARCHITECTURE_FAILED", 300_000);

  const content = fs.readFileSync(expectedPath, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_VALIDATED_FILE_BYTES) throw new Error("CODING_PUBLISH_CONTENT_INVALID");
  return [{ path: expectedPath, content }];
}

async function executeGithubActionsRunner(request, runnerUrl, fetchImpl = fetch, options = {}) {
  const proposalUrl = endpointFor(runnerUrl, "propose");
  const publishUrl = endpointFor(runnerUrl, "publish");
  const validatePatch = options.validatePatch ?? validatePatchOnGithubRunner;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const jitter = options.jitter ?? Math.random;
  const maxProposalAttempts = options.maxProposalAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const causalCapability = options.causalDispatchCapability ?? null;
  const causalFailure = String(request.reason || "").startsWith("gha:");
  const causalHeaders = causalCapability ? { "x-nusa-causal-dispatch-capability": causalCapability } : {};
  if (causalFailure
    && (!/^gha:[1-9][0-9]{0,19}:[a-f0-9]{40}:(failure|timed_out)$/.test(request.reason)
      || !Number.isSafeInteger(request.workflowRunAttempt) || !causalCapability || !/^[a-f0-9]{64}$/.test(causalCapability))) {
    throw new Error("CAUSAL_DISPATCH_ADMISSION_REQUIRED");
  }
  const proposalContextForPatch = options.proposalContextForPatch ?? proposalContextFromGithubRunner;
  const initialProposalContext = options.initialProposalContext ?? initialProposalContextFromGithubRunner;
  if (!Number.isSafeInteger(maxProposalAttempts) || maxProposalAttempts < 1 || maxProposalAttempts > DEFAULT_MAX_ATTEMPTS) {
    throw new Error("AUTOPILOT_PROPOSAL_RETRY_LIMIT_INVALID");
  }

  const attempts = [];
  const rateLimitEvents = [];
  const seenPatches = new Set();
  const seenDeterministicFailureCodes = new Set();
  let feedback = null;
  // Attempt 1 gets a real excerpt of a real in-scope file. Without it the model has to invent the
  // context lines that `git apply --check` compares byte for byte, so the first attempt of every
  // execution was spent on a proposal that could not apply.
  let proposalContext = null;
  try {
    proposalContext = initialProposalContext(request) ?? null;
  } catch {
    proposalContext = null;
  }

  const finish = (status, reason, httpStatus, workerStatus, extra = {}) => {
    const base = resultSummary(request, attempts, status, reason, httpStatus, workerStatus);
    const proposalRetries = attempts.filter((entry) => entry.decision === "RETRY").length;
    const proposalRejected = attempts.filter((entry) => entry.decision === "RETRY" || entry.decision === "NO_ACTION" || entry.decision === "FAILED_CLOSED").length;
    const changedFiles = Array.isArray(extra.changedFiles) ? extra.changedFiles : [];
    const codeChanged = status === "DISPATCHED" && changedFiles.length > 0;
    const blockedRateLimit = status === "BLOCKED_RATE_LIMIT";
    const rateLimit = extra.rateLimitEvidence;
    return {
      ...base,
      proposalAttempts: attempts.length,
      proposalRetries,
      proposalRejected,
      proposalAccepted: status === "DISPATCHED",
      codeChanged,
      blockedRateLimit,
      ...extra,
      summary: {
        ...base.summary,
        proposalAttempts: attempts.length,
        proposalRetries,
        proposalRejected,
        proposalAccepted: status === "DISPATCHED" ? 1 : 0,
        codeChanged: codeChanged ? 1 : 0,
        blockedRateLimit: blockedRateLimit ? 1 : 0,
        ...(rateLimit ? {
          provider: rateLimit.provider,
          lastRateLimitAt: rateLimit.lastRateLimitAt,
          nextRetryAt: rateLimit.nextRetryAt,
          retrySource: rateLimit.retrySource,
        } : {}),
      },
    };
  };

  for (let attempt = 1; attempt <= maxProposalAttempts; attempt += 1) {
    const startedAt = now();
    const proposalRequest = feedback || proposalContext
      ? {
          ...request,
          ...(feedback ? { proposalFeedback: feedback } : {}),
          ...(proposalContext ? { proposalContext } : {}),
        }
      : request;
    let proposal;
    try {
      proposal = await authorizedJsonPost(proposalUrl, proposalRequest, fetchImpl, now, causalHeaders);
      if (proposal.status === "JEV_ROUTING_ABSTAINED") {
        const reason = typeof proposal.reason === "string" && /^[A-Z0-9_:-]{1,160}$/.test(proposal.reason)
          ? proposal.reason
          : "NON_CODE_AUTOFIX_FORBIDDEN";
        attempts.push(attemptRecord({
          request,
          attempt,
          decision: "NO_ACTION",
          startedAt,
          status: 200,
          workerStatus: "JEV_ROUTING_ABSTAINED",
          failureClass: "deterministic",
          reason,
          now,
        }));
        return finish("NO_ACTION", reason, 200, "JEV_ROUTING_ABSTAINED", {
          jevAdmissionAction: proposal.jevAdmissionAction === "ABSTAIN_EXPENSIVE_INFERENCE"
            ? proposal.jevAdmissionAction
            : "ABSTAIN_EXPENSIVE_INFERENCE",
          jevRequiredModel: typeof proposal.jevRequiredModel === "string" ? proposal.jevRequiredModel : null,
          jevConfidence: typeof proposal.jevConfidence === "number" && Number.isFinite(proposal.jevConfidence)
            ? proposal.jevConfidence
            : 0,
        });
      }
      if (proposal.status !== "PROPOSAL_READY" || typeof proposal.patch !== "string") {
        throw new Error("CODING_PROPOSAL_UNAVAILABLE");
      }
      if (causalFailure && (proposal.causalRepairTarget !== "apps/autopilot/src/repairableWorkflowRun.ts"
        || proposal.headSha !== request.headSha || proposal.workflowRunId !== request.workflowRunId
        || typeof proposal.causalProposalReceipt !== "string" || proposal.causalProposalReceipt.length < 32
        || proposal.causalProposalReceipt.length > 4096)) {
        throw new Error("CAUSAL_PROPOSAL_RECEIPT_REQUIRED");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "CODING_PROPOSAL_UNAVAILABLE";
      if (error?.decisionValidationFailure) {
        const terminal = terminalFailureResult(request, error, startedAt, now, attempt);
        attempts.push(terminal.attempts[0]);
        return finish("FAILED_CLOSED", terminal.reason, terminal.httpStatus, terminal.workerStatus, {
          failureEvidence: terminal.failureEvidence, decisionDiagnostics: terminal.decisionDiagnostics,
          workerHttpStatus: terminal.workerHttpStatus, workerFailureCode: terminal.workerFailureCode,
          decisionValidationFailure: terminal.decisionValidationFailure,
          workflowRunId: terminal.workflowRunId, headSha: terminal.headSha,
        });
      }
      const terminalDecision = error?.remediationDecision;
      if (terminalDecision?.outcome === "FAILED_CLOSED" && terminalDecision.recovery === "STOP") {
        const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : null;
        const code = /^[A-Za-z0-9_:-]{1,160}$/.test(reason) ? reason : "CODING_REMEDIATION_FAILURE";
        attempts.push(attemptRecord({ request, attempt, decision: "FAILED_CLOSED", startedAt, status, workerStatus: "FAILED_CLOSED", failureClass: terminalDecision.failureClass, reason: code, now, workerHttpStatus: error.workerHttpStatus }));
        return finish("FAILED_CLOSED", code, status, "FAILED_CLOSED", {
          remediationDecision: terminalDecision, failureEvidence: error.failureEvidence,
          workerHttpStatus: error.workerHttpStatus, workerFailureCode: error.workerFailureCode,
        });
      }
      if (error?.workerStop === true && error?.rateLimit) {
        const observedAt = Number.isSafeInteger(error.rateLimit.lastRateLimitAt) ? error.rateLimit.lastRateLimitAt : now();
        const hintedDelayMs = Number.isSafeInteger(error.rateLimit.retryAfterMs) && error.rateLimit.retryAfterMs >= 0
          ? error.rateLimit.retryAfterMs
          : null;
        const fallbackDelayMs = boundedBackoffMs(DEFAULT_BACKOFF_MS, attempt, jitter);
        const nextRetryAt = Number.isSafeInteger(error.rateLimit.nextRetryAt) && error.rateLimit.nextRetryAt > observedAt
          ? error.rateLimit.nextRetryAt
          : observedAt + (hintedDelayMs ?? fallbackDelayMs);
        const evidence = Object.freeze({
          ...error.rateLimit,
          lastRateLimitAt: observedAt,
          nextRetryAt,
          retrySource: error.rateLimit.nextRetryAt === nextRetryAt && error.rateLimit.retrySource
            ? error.rateLimit.retrySource
            : hintedDelayMs === null ? "bounded-exponential-backoff-jitter" : error.rateLimit.retrySource ?? "provider-state",
        });
        attempts.push(attemptRecord({
          request,
          attempt,
          decision: "NO_ACTION",
          startedAt,
          status: evidence.httpStatus,
          workerStatus: "WAITING_RATE_LIMIT",
          failureClass: "transient",
          reason: "WAITING_RATE_LIMIT",
          now,
        }));
        return rateLimitedResult(
          finish("WAITING_RATE_LIMIT", "WAITING_RATE_LIMIT", evidence.httpStatus, "WAITING_RATE_LIMIT", {
            stopReason: typeof error.rateLimit.stopReason === "string" ? error.rateLimit.stopReason : "PROVIDER_RATE_LIMITED",
            lastFailure: typeof error.rateLimit.lastFailure === "string" ? error.rateLimit.lastFailure : "PROVIDER_RATE_LIMITED",
            resumeCondition: typeof error.rateLimit.resumeCondition === "string" ? error.rateLimit.resumeCondition : "provider-recovery-and-exact-head-revalidation",
            nextRetryAt: evidence.nextRetryAt,
            rateLimitEvidence: evidence,
          }),
          evidence,
          [...rateLimitEvents],
        );
      }
      const rateLimitCode = providerRateLimitCode(reason) || providerRateLimitCode(error?.rateLimit?.code);
      if (rateLimitCode) {
        const observedAt = error?.rateLimit?.lastRateLimitAt ?? now();
        const rawEvidence = error?.rateLimit ?? Object.freeze({
          provider: rateLimitCode.startsWith("WORKERS_AI_") ? "workers-ai" : "external-coding-runner",
          code: rateLimitCode,
          httpStatus: null,
          lastRateLimitAt: observedAt,
          retryAfterMs: null,
          nextRetryAt: null,
          retrySource: "none",
        });
        const retryable = !["WORKERS_AI_DAILY_QUOTA_EXHAUSTED", "WORKERS_AI_RATE_LIMITED", "PROVIDER_RATE_LIMITED"].includes(rateLimitCode);
        if (retryable && attempt < maxProposalAttempts) {
          const delayMs = rawEvidence.retryAfterMs ?? boundedBackoffMs(DEFAULT_BACKOFF_MS, attempt, jitter);
          attempts.push(attemptRecord({
            request,
            attempt,
            decision: "RETRY",
            startedAt,
            status: rawEvidence.httpStatus,
            workerStatus: "RATE_LIMITED",
            failureClass: "transient",
            reason: rateLimitCode,
            now,
          }));
          await sleep(delayMs);
          continue;
        }
        const fallbackRetryDelayMs = boundedBackoffMs(DEFAULT_BACKOFF_MS, attempt, jitter);
        const evidence = Object.freeze({
          ...rawEvidence,
          nextRetryAt: rawEvidence.retryAfterMs !== null
            ? rawEvidence.nextRetryAt
            : retryable
              ? rawEvidence.lastRateLimitAt + fallbackRetryDelayMs
              : null,
          retrySource: rawEvidence.retryAfterMs !== null
            ? rawEvidence.retrySource
            : retryable
              ? "bounded-exponential-backoff-jitter"
              : "none",
        });
        return finish("BLOCKED_RATE_LIMIT", rateLimitCode, evidence.httpStatus, "RATE_LIMITED", {
          provider: evidence.provider,
          lastRateLimitAt: evidence.lastRateLimitAt,
          nextRetryAt: evidence.nextRetryAt,
          retrySource: evidence.retrySource,
          rateLimitEvidence: evidence,
        });
      }
      const workerDecision = error?.remediationDecision;
      if (workerDecision) {
        const code = /^[A-Za-z0-9_:-]{1,160}$/.test(reason) ? reason : "CODING_REMEDIATION_FAILURE";
        const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : null;
        if (workerDecision.outcome === "VALID_NO_ACTION") {
          attempts.push(attemptRecord({ request, attempt, decision: "NO_ACTION", startedAt, status, workerStatus: "VALID_NO_ACTION", failureClass: "deterministic", reason: "NO_ACTION_WARRANTED", now, workerHttpStatus: error.workerHttpStatus }));
          return finish("NO_ACTION", "NO_ACTION_WARRANTED", status, "VALID_NO_ACTION", { remediationDecision: workerDecision, failureEvidence: error.failureEvidence, workerHttpStatus: error.workerHttpStatus, workerFailureCode: error.workerFailureCode, decisionDiagnostics: error.decisionDiagnostics });
        }
        if (workerDecision.outcome === "FAILED_TO_REMEDIATE") {
          const repeatedFailure = workerDecision.failureClass === "PROPOSAL_REJECTED" && seenDeterministicFailureCodes.has(code);
          if (workerDecision.failureClass === "PROPOSAL_REJECTED") seenDeterministicFailureCodes.add(code);
          const withinBudget = attempt < maxProposalAttempts && attempt < workerDecision.maxAttempts;
          if (workerDecision.retryable && withinBudget && !repeatedFailure) {
            attempts.push(attemptRecord({ request, attempt, decision: "RETRY", startedAt, status, workerStatus: "REMEDIATION_RETRY", failureClass: workerDecision.failureClass, reason: code, now, recovery: workerDecision.recovery, workerHttpStatus: error.workerHttpStatus }));
            if (workerDecision.recovery === "REGENERATE_PROPOSAL") {
              feedback = proposalRepairFeedback(code, attempt + 1);
            } else {
              await sleep(boundedBackoffMs(DEFAULT_BACKOFF_MS, attempt, jitter));
            }
            continue;
          }
          attempts.push(attemptRecord({ request, attempt, decision: "FAILED_CLOSED", startedAt, status, workerStatus: "REMEDIATION_EXHAUSTED", failureClass: workerDecision.failureClass, reason: code, now, recovery: workerDecision.recovery, workerHttpStatus: error.workerHttpStatus }));
          return finish("FAILED_TO_REMEDIATE", code, status, "REMEDIATION_EXHAUSTED", { remediationDecision: workerDecision, failureEvidence: error.failureEvidence, workerHttpStatus: error.workerHttpStatus, workerFailureCode: error.workerFailureCode, decisionDiagnostics: error.decisionDiagnostics });
        }
        attempts.push(attemptRecord({ request, attempt, decision: "FAILED_CLOSED", startedAt, status, workerStatus: "FAILED_CLOSED", failureClass: workerDecision.failureClass, reason: code, now, recovery: workerDecision.recovery, workerHttpStatus: error.workerHttpStatus }));
        return finish("FAILED_CLOSED", code, status, "FAILED_CLOSED", { remediationDecision: workerDecision, failureEvidence: error.failureEvidence, workerHttpStatus: error.workerHttpStatus, workerFailureCode: error.workerFailureCode, decisionDiagnostics: error.decisionDiagnostics });
      }

      const code = retryableProposalFailureCode(reason);
      if (!code) throw error;
      const repeatedFailure = seenDeterministicFailureCodes.has(code);
      seenDeterministicFailureCodes.add(code);
      const decision = attempt < maxProposalAttempts && !repeatedFailure ? "RETRY" : "FAILED_CLOSED";
      attempts.push(attemptRecord({
        request,
        attempt,
        decision,
        startedAt,
        status: null,
        workerStatus: "PROPOSAL_REJECTED",
        failureClass: "deterministic",
        reason: code,
        now,
      }));
      if (decision === "RETRY") {
        feedback = proposalRepairFeedback(code, attempt + 1);
        continue;
      }
      return finish("FAILED_TO_REMEDIATE", code, null, "REMEDIATION_EXHAUSTED");
    }

    if (seenPatches.has(proposal.patch)) {
      const code = "CODING_PROPOSAL_REPEATED";
      attempts.push(attemptRecord({
        request,
        attempt,
        decision: "FAILED_CLOSED",
        startedAt,
        status: null,
        workerStatus: "PROPOSAL_REJECTED",
        failureClass: "deterministic",
        reason: code,
        now,
      }));
      return finish("FAILED_TO_REMEDIATE", code, null, "REMEDIATION_EXHAUSTED");
    }
    seenPatches.add(proposal.patch);

    let validatedFiles;
    try {
      validatedFiles = validatePatch(request, proposal.patch);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "AUTOPILOT_GITHUB_RUNNER_FAILED";
      const code = retryableProposalFailureCode(reason);
      if (!code) throw error;

      resetProposalRetryWorkspace();

      const repeatedFailure = seenDeterministicFailureCodes.has(code);
      seenDeterministicFailureCodes.add(code);
      const decision = attempt < maxProposalAttempts && !repeatedFailure ? "RETRY" : "FAILED_CLOSED";
      attempts.push(attemptRecord({
        request,
        attempt,
        decision,
        startedAt,
        status: null,
        workerStatus: "PROPOSAL_REJECTED",
        failureClass: "deterministic",
        reason: code,
        now,
      }));
      if (decision === "RETRY") {
        if (code === "SANDBOX_PATCH_APPLY_CHECK_FAILED" || code === "SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED") {
          try {
            proposalContext = proposalContextForPatch(proposal.patch);
          } catch {
            proposalContext = null;
          }
        }
        feedback = proposalRepairFeedback(code, attempt + 1);
        continue;
      }
      return finish("FAILED_TO_REMEDIATE", code, null, "REMEDIATION_EXHAUSTED");
    }

    fs.rmSync(PATCH_PATH, { force: true });
    const publishBody = {
      request,
      validatedFiles,
      ...(causalFailure ? { patch: proposal.patch, causalProposalReceipt: proposal.causalProposalReceipt } : {}),
    };
    const published = await authorizedJsonPost(publishUrl, publishBody, fetchImpl, now, causalHeaders);
    if (published.status !== "EXECUTION_ACCEPTED" || published.proposalValidated !== true) {
      throw new Error("CODING_PUBLISH_VALIDATION_REQUIRED");
    }

    attempts.push(attemptRecord({
      request,
      attempt,
      decision: "DISPATCHED",
      startedAt,
      status: 200,
      workerStatus: "EXECUTION_ACCEPTED",
      failureClass: null,
      reason: null,
      now,
    }));
    const changedFiles = validatedFiles.map((file) => file.path);
    return finish("DISPATCHED", null, 200, "EXECUTION_ACCEPTED", {
      backend: "github-actions-runner",
      checkpointId: request.headSha,
      workspaceVerified: true,
      proposalValidated: true,
      changedFiles,
      publisher: published.publisher,
      branch: published.branch,
      commitSha: published.commitSha,
      pullRequestNumber: published.pullRequestNumber,
      pullRequestUrl: published.pullRequestUrl,
    });
  }

  throw new Error("AUTOPILOT_PROPOSAL_RETRY_EXHAUSTED");
}

function writeArtifacts(request, result) {
  const directory = "artifacts/autopilot-execution";
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(directory + "/coding-runner-result.json", JSON.stringify({ ...result, request }, null, 2));
  fs.writeFileSync(directory + "/execution-attempts.json", JSON.stringify({
    schemaVersion: 1,
    attempts: result.attempts || [],
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  }, null, 2));
  fs.writeFileSync(directory + "/execution-summary.json", JSON.stringify(result.summary || {
    schemaVersion: 1,
    execution_id: request.executionId,
    dedupe_key: request.dedupeKey,
    backend: "github-actions-runner",
    attempts: 1,
    retries: 0,
    dispatched: 0,
    noAction: 0,
    failedClosed: 1,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  }, null, 2));
}

/**
 * Best effort: tells the Worker this coding attempt is over so its active-WIP claim is freed at once.
 * Without it the GitHub Actions backend never released a claim and the next item waited up to an
 * hour. Never changes the execution outcome or exit code.
 */
async function releaseActiveWipClaim(request, runnerUrl, fetchImpl = fetch) {
  try {
    const token = await oidcToken({ fetchImpl });
    if (!token.ok) return { released: false, reason: token.reason };
    const response = await fetchImpl(endpointFor(runnerUrl, "wip-release"), {
      method: "POST",
      headers: { authorization: "Bearer " + token.value, "content-type": "application/json" },
      body: JSON.stringify({ dedupeKey: request.dedupeKey, executionId: request.executionId }),
    });
    const payload = await response.json().catch(() => null);
    return { released: payload?.released === true, reason: typeof payload?.reason === "string" ? payload.reason : (typeof payload?.error === "string" ? payload.error : `http-${response.status}`) };
  } catch (error) {
    return { released: false, reason: error instanceof Error ? error.message : "wip-release-failed" };
  }
}

async function main() {
  const startedAt = Date.now();
  let request;
  let causalDispatchCapability = null;
  try {
    const dispatch = readDispatchRequest();
    request = dispatch.request;
    causalDispatchCapability = dispatch.causalDispatchCapability;
    const runnerUrl = process.env.NUSA_CODING_RUNNER_URL;
    if (typeof runnerUrl !== "string" || !runnerUrl) throw new Error("AUTOPILOT_CODING_RUNNER_URL_MISSING");
    const result = await executeGithubActionsRunner(request, runnerUrl, fetch, { causalDispatchCapability });
    const wipRelease = await releaseActiveWipClaim(request, runnerUrl);
    console.log(`wip_release=${wipRelease.released ? "released" : "not_released"} reason=${wipRelease.reason ?? "none"}`);
    writeArtifacts(request, result);
    console.log(`execution=${result.status} backend=github-actions-runner changed=${(result.changedFiles || []).join(",")}`);
    if (result.status === "FAILED_TO_REMEDIATE" || result.status === "FAILED_CLOSED") process.exitCode = 1;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "AUTOPILOT_GITHUB_RUNNER_FAILED";
    if (!request) {
      try { writeFailureArtifact(reason); } catch { /* preserve the original bounded failure below */ }
      console.error(reason);
      process.exitCode = 1;
      return;
    }
    const safeProposalFailure = proposalFailureCode(reason);
    const runnerUrlForRelease = process.env.NUSA_CODING_RUNNER_URL;
    if (typeof runnerUrlForRelease === "string" && runnerUrlForRelease) {
      const wipRelease = await releaseActiveWipClaim(request, runnerUrlForRelease);
      console.log(`wip_release=${wipRelease.released ? "released" : "not_released"} reason=${wipRelease.reason ?? "none"}`);
    }
    const result = terminalFailureResult(request, error, startedAt);
    writeArtifacts(request, result);
    if (safeProposalFailure) {
      console.log(`execution=FAILED_TO_REMEDIATE backend=github-actions-runner reason=${safeProposalFailure}`);
      process.exitCode = 1;
      return;
    }
    console.error(reason);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "AUTOPILOT_GITHUB_RUNNER_UNHANDLED");
    process.exitCode = 1;
  });
}

module.exports = {
  releaseActiveWipClaim,
  MAX_RETRY_DELAY_MS,
  MAX_REPORTED_QUOTA_RETRY_DELAY_MS,
  RETRY_JITTER_RATIO,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  dispatchWithRetry,
  transientStatus,
  httpClass,
  resultSummary,
  assertBoundedPatch,
  proposalFailureCode,
  retryableProposalFailureCode,
  providerRateLimitCode,
  responseHeader,
  clampRetryDelayMs,
  retryTimestampMs,
  retryHint,
  providerRateLimitCodeFromPayload,
  rateLimitEvidence,
  boundedBackoffMs,
  rateLimitedResult,
  withRateLimitEvents,
  proposalRepairFeedback,
  boundedProposalContext,
  proposalContextFromGithubRunner,
  initialProposalContextFromGithubRunner,
  initialProposalContextTargets,
  executeGithubActionsRunner,
  resetProposalRetryWorkspace,
  readDispatchRequest,
  assertGithubRunnerWorkspaceClean,
  filterGithubRunnerWorkspacePaths,
  validatePatchOnGithubRunner,
  executeGithubActionsRunner,
  normalizeUnifiedDiffHunkCounts,
  applyPatchWithNormalizedHunkCounts,
  endpointFor,
  boundedWorkerFailureEvidence,
  boundedRemediationDecision,
  boundedDecisionDiagnostics,
  terminalFailureResult,
  authorizedJsonPost,
};
