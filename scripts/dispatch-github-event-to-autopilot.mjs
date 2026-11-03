import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WEBHOOK_URL = "https://nusa-autopilot.desporin12.workers.dev/github/webhook";
const DEFAULT_OIDC_AUDIENCE = "nusa-autopilot";
const SUPPORTED_EVENTS = new Set(["push", "pull_request", "workflow_run", "ping"]);
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
/**
 * Executor decisions that are the control plane working, not a delivery problem.
 *
 * The webhook itself succeeded; the executor then looked at the pull request's current state and
 * correctly declined to request an Audit for it. Sticky HOLD (#1876) exists precisely so a closed,
 * Draft or HOLD-labelled pull request cannot be advanced by an event, so treating that refusal as a
 * bridge failure reports the guard doing its job as a red run on main - and real delivery failures
 * then hide among the noise.
 *
 * Every other non-dispatch outcome still throws. In particular `github-executor-pr-number-required`
 * is also REJECTED but means the request was malformed, which is a defect and must stay loud.
 */
const EXECUTOR_STATE_DECLINES = new Set([
  "github-executor-pr-not-open",
  "github-executor-pr-draft-hold-active",
  "github-executor-pr-hold-label-active",
  "github-executor-duplicate-execution-suppressed",
  "github-executor-duplicate-audit-run-suppressed"
]);

/**
 * Statuses the control plane returns when it has decided, deliberately, not to execute.
 *
 * These carry no executor evidence because no executor was consulted. They are not malformed
 * responses, and treating them as such hides the `reason` that says why - the one field anyone
 * debugging a stuck pull request actually needs.
 */
const CONTROL_PLANE_TERMINAL_STATUSES = new Set([
  "NOOP",
  "NO_ACTION",
  "DUPLICATE_EXECUTION_SUPPRESSED"
]);

const MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const AUDIT_CREDENTIAL_FAILURES = new Set([
  "github-executor-token-not-configured",
  "github-executor-auth-rejected",
  "github-executor-repository-or-token-scope-invalid",
  "github-executor-pr-or-token-scope-invalid",
]);

function safeEventName(value) {
  const event = value === "pull_request_target" ? "pull_request" : value;
  return SUPPORTED_EVENTS.has(event) ? event : null;
}

function safeRunPart(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ""))) throw new Error(`${name}_INVALID`);
  return String(value);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function createDeliveryId({ repository, event, runId, runAttempt }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository ?? ""))) throw new Error("GITHUB_REPOSITORY_INVALID");
  const normalizedEvent = safeEventName(event);
  if (!normalizedEvent) throw new Error("GITHUB_EVENT_UNSUPPORTED");
  return `nusa-bridge:${repository}:${normalizedEvent}:${safeRunPart(runId, "GITHUB_RUN_ID")}:${safeRunPart(runAttempt, "GITHUB_RUN_ATTEMPT")}`;
}

export function createGithubSignature(secret, body) {
  if (typeof secret !== "string" || secret.trim().length === 0) throw new Error("WEBHOOK_SECRET_REQUIRED");
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function readCausalAttestationBundle(bundlePath, eventPayload, repository) {
  if (typeof bundlePath !== "string" || !bundlePath.trim() || !fs.existsSync(bundlePath)) return null;
  const raw = fs.readFileSync(bundlePath);
  if (raw.byteLength < 1 || raw.byteLength > 512 * 1024) throw new Error("CAUSAL_ATTESTATION_BUNDLE_SIZE_INVALID");
  let bundle;
  try { bundle = JSON.parse(raw.toString("utf8")); } catch { throw new Error("CAUSAL_ATTESTATION_BUNDLE_INVALID"); }
  const run = object(eventPayload?.workflow_run);
  if (!object(bundle) || !run || eventPayload?.repository?.full_name !== repository
    || run.name !== "CI" || run.event !== "push" || run.head_branch !== "main"
    || !["failure", "timed_out"].includes(run.conclusion)
    || !/^[1-9][0-9]{0,19}$/.test(String(run.id ?? ""))
    || !/^[1-9][0-9]{0,9}$/.test(String(run.run_attempt ?? ""))
    || !/^[a-f0-9]{40}$/.test(String(run.head_sha ?? ""))) {
    throw new Error("CAUSAL_ATTESTATION_SOURCE_INVALID");
  }
  return bundle;
}

export async function requestGithubActionsOidcToken({
  requestUrl,
  requestToken,
  audience = DEFAULT_OIDC_AUDIENCE,
  fetchImpl = fetch,
}) {
  const hasUrl = typeof requestUrl === "string" && requestUrl.trim().length > 0;
  const hasToken = typeof requestToken === "string" && requestToken.trim().length > 0;
  if (!hasUrl && !hasToken) return null;
  if (!hasUrl || !hasToken) throw new Error("GITHUB_OIDC_REQUEST_ENV_INCOMPLETE");
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new Error("GITHUB_OIDC_REQUEST_URL_INVALID");
  }
  if (url.protocol !== "https:") throw new Error("GITHUB_OIDC_REQUEST_URL_INVALID");
  url.searchParams.set("audience", audience);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${requestToken}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`GITHUB_OIDC_REQUEST_HTTP_${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GITHUB_OIDC_RESPONSE_INVALID");
  }
  if (!payload || typeof payload.value !== "string" || payload.value.trim().length === 0) throw new Error("GITHUB_OIDC_TOKEN_MISSING");
  return payload.value.trim();
}

function responseClass(status) {
  if (status >= 200 && status < 300) return "SUCCESS";
  if (status === 401 || status === 403) return "AUTH_REJECTED";
  if (TRANSIENT_STATUSES.has(status)) return "TRANSIENT_FAILURE";
  return "PERMANENT_FAILURE";
}

async function responseSafety(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("WEBHOOK_RESPONSE_INVALID");
  }
  if (!payload || payload.accepted !== true) throw new Error("WEBHOOK_RESPONSE_NOT_ACCEPTED");
  if (payload.liveAuthority !== "NONE") throw new Error("WEBHOOK_RESPONSE_LIVE_AUTHORITY_INVALID");
  if (payload.productionMutationAllowed !== false) throw new Error("WEBHOOK_RESPONSE_PRODUCTION_MUTATION_INVALID");
  if (payload.aiAuthority !== "ZERO_AUTHORITY") throw new Error("WEBHOOK_RESPONSE_AI_AUTHORITY_INVALID");
  const executor = object(payload.executor);
  if (!executor) {
    // The control plane can reach a terminal decision without ever consulting an executor: an
    // explicit NOOP when a Ready replay resolves no canonical CI identity (#1955), a NO_ACTION
    // under an active control-plane hold, or a suppressed duplicate. Those responses carry a
    // `reason` and no executor evidence, and demanding evidence from them reports a designed
    // decision as a malformed payload - which is how the reason the control plane actually gave
    // stops reaching anyone. Accept them, and carry the reason through.
    if (!CONTROL_PLANE_TERMINAL_STATUSES.has(String(payload.status ?? ""))) {
      throw new Error("WEBHOOK_EXECUTOR_EVIDENCE_INVALID");
    }
    const noopReason = payload.reason;
    if (noopReason !== null && noopReason !== undefined && (typeof noopReason !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(noopReason))) {
      throw new Error("WEBHOOK_CONTROL_PLANE_REASON_INVALID");
    }
    return Object.freeze({
      payload,
      executor: Object.freeze({
        status: "NOOP",
        reason: noopReason ?? null,
        httpStatus: null,
        requestedHeadSha: null,
        observedHeadSha: null,
        controlPlaneStatus: String(payload.status)
      })
    });
  }
  const status = executor.status;
  if (!["NOOP", "INTERFACE_READY", "DISPATCHED", "REJECTED", "FAILED"].includes(status)) throw new Error("WEBHOOK_EXECUTOR_STATUS_INVALID");
  const reason = executor.reason;
  if (reason !== null && reason !== undefined && (typeof reason !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(reason))) throw new Error("WEBHOOK_EXECUTOR_REASON_INVALID");
  const httpStatus = executor.httpStatus;
  if (httpStatus !== null && httpStatus !== undefined && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new Error("WEBHOOK_EXECUTOR_HTTP_STATUS_INVALID");
  const requestedHeadSha = executor.requestedHeadSha;
  const observedHeadSha = executor.observedHeadSha;
  for (const [name, value] of [["REQUESTED", requestedHeadSha], ["OBSERVED", observedHeadSha]]) {
    if (value !== null && value !== undefined && (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value))) throw new Error(`WEBHOOK_EXECUTOR_${name}_HEAD_SHA_INVALID`);
  }
  return Object.freeze({
    payload,
    executor: Object.freeze({
      status,
      reason: reason ?? null,
      httpStatus: httpStatus ?? null,
      requestedHeadSha: requestedHeadSha ? requestedHeadSha.toLowerCase() : null,
      observedHeadSha: observedHeadSha ? observedHeadSha.toLowerCase() : null,
    }),
  });
}

export function isAuditFallbackEligible(payload) {
  const value = object(payload);
  const execution = object(value?.execution);
  const executor = object(value?.executor);
  if (execution?.kind !== "AUDIT_REQUEST") return false;
  const reason = typeof executor?.reason === "string" ? executor.reason : "";
  if (!AUDIT_CREDENTIAL_FAILURES.has(reason)) return false;
  if (reason === "github-executor-token-not-configured") return executor?.status === "INTERFACE_READY";
  return executor?.status === "FAILED" && [401, 403, 404].includes(executor?.httpStatus);
}

export async function dispatchGithubEvent({
  secret,
  oidcToken,
  body,
  event,
  repository,
  runId,
  runAttempt,
  causalAttestationBundle,
  webhookUrl = DEFAULT_WEBHOOK_URL,
  fetchImpl = fetch,
  retryDelayMs = 200,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const normalizedEvent = safeEventName(event);
  if (!normalizedEvent) throw new Error("GITHUB_EVENT_UNSUPPORTED");
  if (!(body instanceof Uint8Array)) throw new Error("GITHUB_EVENT_BODY_INVALID");
  const deliveryId = createDeliveryId({ repository, event: normalizedEvent, runId, runAttempt });
  let deliveryBody = body;
  if (causalAttestationBundle !== undefined && causalAttestationBundle !== null) {
    let eventPayload;
    try { eventPayload = object(JSON.parse(Buffer.from(body).toString("utf8"))); } catch { eventPayload = null; }
    if (!eventPayload || normalizedEvent !== "workflow_run") throw new Error("CAUSAL_ATTESTATION_EVENT_INVALID");
    const run = object(eventPayload.workflow_run);
    if (!run || eventPayload.repository?.full_name !== repository || run.name !== "CI" || run.event !== "push"
      || run.head_branch !== "main" || !["failure", "timed_out"].includes(run.conclusion)) {
      throw new Error("CAUSAL_ATTESTATION_SOURCE_INVALID");
    }
    deliveryBody = Buffer.from(JSON.stringify({ ...eventPayload, nusa_causal_attestation_bundle: causalAttestationBundle }), "utf8");
    if (deliveryBody.byteLength > 768 * 1024) throw new Error("CAUSAL_ATTESTATION_EVENT_SIZE_INVALID");
  }
  const hasOidc = typeof oidcToken === "string" && oidcToken.trim().length > 0;
  const hasSecret = typeof secret === "string" && secret.trim().length > 0;
  if (!hasOidc && !hasSecret) throw new Error("WEBHOOK_AUTH_REQUIRED");
  if (typeof webhookUrl !== "string" || !/^https:\/\//.test(webhookUrl)) throw new Error("WEBHOOK_URL_INVALID");

  const authentication = hasOidc ? "OIDC" : "HMAC";
  const authHeaders = hasOidc
    ? { authorization: `Bearer ${oidcToken.trim()}` }
    : { "x-hub-signature-256": createGithubSignature(secret, deliveryBody) };
  let attempts = 0;
  let response;
  for (; attempts < MAX_ATTEMPTS; attempts += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": normalizedEvent,
          "user-agent": "nusa-github-event-bridge",
          ...authHeaders,
        },
          body: deliveryBody,
        signal: controller.signal,
      });
    } catch (error) {
      if (attempts + 1 >= MAX_ATTEMPTS) throw new Error(error?.name === "AbortError" ? "WEBHOOK_REQUEST_TIMEOUT" : "WEBHOOK_REQUEST_FAILED");
      response = null;
    } finally {
      clearTimeout(timeout);
    }
    if (!response) {
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }
    const classification = responseClass(response.status);
    if (classification === "SUCCESS") {
      const { payload, executor } = await responseSafety(response);
      const fallbackEligible = isAuditFallbackEligible(payload);
      const execution = object(payload.execution);
      const declined = executor.status === "REJECTED" && EXECUTOR_STATE_DECLINES.has(String(executor.reason ?? ""));
      if (execution?.kind === "AUDIT_REQUEST" && executor.status !== "DISPATCHED" && !fallbackEligible && !declined) {
        throw new Error(`WEBHOOK_AUDIT_NOT_DISPATCHED:${executor.status}:${executor.reason ?? "none"}:${executor.httpStatus ?? "none"}`);
      }
      return Object.freeze({
        status: "DELIVERED",
        authentication,
        event: normalizedEvent,
        deliveryId,
        attempts: attempts + 1,
        responseStatus: response.status,
        auditFallbackEligible: fallbackEligible,
        executorStatus: executor.status,
        executorReason: executor.reason,
        executorHttpStatus: executor.httpStatus,
        requestedHeadSha: executor.requestedHeadSha,
        observedHeadSha: executor.observedHeadSha,
      });
    }
    if (classification !== "TRANSIENT_FAILURE" || attempts + 1 >= MAX_ATTEMPTS) {
      throw new Error(`WEBHOOK_HTTP_${response.status}`);
    }
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new Error("WEBHOOK_REQUEST_FAILED");
}

function summaryLine(result) {
  return [
    "## NUSA Autopilot GitHub Event Bridge",
    "",
    `- status: ${result.status}`,
    `- authentication: ${result.authentication}`,
    `- event: ${result.event}`,
    `- delivery: ${result.deliveryId}`,
    `- attempts: ${result.attempts}`,
    `- response: ${result.responseStatus ?? "none"}`,
    `- audit fallback eligible: ${result.auditFallbackEligible === true ? "true" : "false"}`,
    `- executor: ${result.executorStatus ?? "none"}`,
    `- executor reason: ${result.executorReason ?? "none"}`,
    `- executor HTTP: ${result.executorHttpStatus ?? "none"}`,
    `- requested head: ${result.requestedHeadSha ?? "none"}`,
    `- observed head: ${result.observedHeadSha ?? "none"}`,
    "- liveAuthority: NONE",
    "- productionMutationAllowed: false",
    "- AI authority: ZERO_AUTHORITY",
  ].join("\n");
}

function writeSummary(result) {
  const destination = process.env.GITHUB_STEP_SUMMARY;
  if (destination) fs.appendFileSync(destination, `${summaryLine(result)}\n`);
}

function writeOutputs(result) {
  const destination = process.env.GITHUB_OUTPUT;
  if (!destination) return;
  fs.appendFileSync(destination, [
    `audit_fallback_eligible=${result.auditFallbackEligible === true ? "true" : "false"}`,
    `executor_status=${result.executorStatus ?? "unknown"}`,
    `executor_reason=${result.executorReason ?? "none"}`,
    `executor_http_status=${result.executorHttpStatus ?? "none"}`,
    `requested_head_sha=${result.requestedHeadSha ?? "none"}`,
    `observed_head_sha=${result.observedHeadSha ?? "none"}`,
  ].join("\n") + "\n");
}

async function main() {
  const event = process.env.GITHUB_EVENT_NAME;
  const bodyPath = process.env.GITHUB_EVENT_PATH;
  if (!bodyPath) throw new Error("GITHUB_EVENT_PATH_REQUIRED");
  const body = fs.readFileSync(bodyPath);
  const eventPayload = JSON.parse(body.toString("utf8"));
  const causalAttestationBundle = readCausalAttestationBundle(
    process.env.NUSA_CAUSAL_ATTESTATION_PATH,
    eventPayload,
    process.env.GITHUB_REPOSITORY,
  );
  const oidcToken = await requestGithubActionsOidcToken({
    requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  });
  const result = await dispatchGithubEvent({
    secret: process.env.NUSA_WEBHOOK_SECRET,
    oidcToken,
    body,
    event,
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    causalAttestationBundle,
    webhookUrl: process.env.NUSA_AUTOPILOT_WEBHOOK_URL || DEFAULT_WEBHOOK_URL,
  });
  writeSummary(result);
  writeOutputs(result);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const safeError = error instanceof Error ? error.message : "WEBHOOK_BRIDGE_FAILED";
    console.error(safeError);
    process.exitCode = 1;
  }
}
