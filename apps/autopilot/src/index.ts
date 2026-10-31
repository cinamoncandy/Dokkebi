import { isZeroCreditModeEnforced } from "./codingRunnerReadiness";
import { parseGithubWebhookPayload, planGithubWebhookDispatch, type SupportedGithubEvent } from "./dispatchPlanner";
import { resolveOpenPullRequestByHeadSha } from "./githubPrHeadShaResolver";
import { resolveCanonicalPrCiForReady } from "./githubCanonicalPrCiResolver";
import { planAutopilotExecution } from "./executionPlanner";
import { executeGithubDispatch } from "./githubExecutor";
import { resolveGithubReleaseCompletion } from "./githubReleaseCompletionResolver";
import { verifyGithubActionsOidcToken, verifyGithubEventBridgeOidcToken } from "./githubActionsOidc";
import { CodingRunnerEvidenceError, CodingRunnerHttpEvidenceError, executeCodingRunner, isWorkflowFailureCodingReason, validateCodingRunnerRequest, type CodingPublisher, type CodingRuntime, type WorkersAiBinding } from "./codingRunner";
import { prepareProductionExecution, reconcileCodingExecutionEvidence } from "./productionExecutionSpine";
import {
  acquirePersistentExecution,
  handoffOrAcquirePersistentExecution,
  applyPersistentControlPlaneHold,
  completePersistentExecution,
  completeActiveWip,
  readActiveWipCompletions,
  markPersistentExecutionDispatched,
  markPersistentExecutionRateLimitStopped,
  readProviderCapacityWait,
  reservePaidOverflowCall,
  utcDayKey,
  recordProviderCapacityWait,
  recordAutopilotExecutionTelemetry,
  readAutopilotExecutionTelemetry,
  readCodingExecutionEvidence,
  recordCodingExecutionEvidence,
  releasePersistentExecution,
  recoverPersistentAuditDispatch,
  readScheduledRuntimeEvidence,
  recordScheduledRuntimeReceipt,
  type ExecutionCoordinatorNamespace,
} from "./executionCoordinator";
import { runScheduledAutopilot } from "./scheduledRuntime";
import { createCodingExecutionEvidence } from "./codingExecutionEvidence";
import { classifyAutopilotFailure, createAutopilotExecutionTelemetry, type AutopilotExecutionTelemetryInput } from "./executionTelemetry";
import { workerOutcomeFromTelemetry, workerOutcomeWithReleaseCompletion } from "./workerThroughputEvidence";
import { observeJevCodingFailureShadow } from "./jevCodingFailureShadow";

export { ExecutionCoordinator } from "./executionCoordinator";
export * from "./worktreeWorkerPool";

export interface Env {
  NUSA_WEBHOOK_SECRET?: string;
  NUSA_GITHUB_TOKEN?: string;
  NUSA_GITHUB_REPOSITORY?: string;
  NUSA_CODING_RUNNER_TOKEN?: string;
  NUSA_AI_CODING_ENDPOINT?: string;
  NUSA_AI_CODING_TOKEN?: string;
  NUSA_AI_CODING_MODEL?: string;
  NUSA_AUTOPILOT_ZERO_CREDIT_MODE?: string;
  /** Owner-imposed ceiling on paid overflow calls per UTC day. Unset or 0 leaves no cap. */
  NUSA_AUTOPILOT_PAID_OVERFLOW_DAILY_CAP?: string;
  NUSA_JEV_SHADOW_ENABLED?: string;
  NUSA_JEV_BOUNDED_ROUTING_ENABLED?: string;
  NUSA_JEV_MODEL_TIERING_ENABLED?: string;
  NUSA_AI_CODING_MODEL_LUNA?: string;
  NUSA_AI_CODING_MODEL_TERRA?: string;
  NUSA_AI_CODING_MODEL_SOL?: string;
  NUSA_AI_CODING_MODEL_ASTRA?: string;
  NUSA_JEV_API_KEY?: string;
  NUSA_JEV_ENDPOINT?: string;
  NUSA_JEV_TIMEOUT_MS?: string;
  /** Secret shared only by the protected persistent runtime and this Worker route. */
  NUSA_AUTOPILOT_RUNTIME_TOKEN?: string;
  AI?: WorkersAiBinding;
  NUSA_DEPLOYMENT_REVISION?: string;
  /** Fail closed by default; only an explicit deployment configuration may clear the global Release freeze. */
  NUSA_GLOBAL_RELEASE_FREEZE?: string;
  NUSA_EXECUTION_COORDINATOR?: ExecutionCoordinatorNamespace;
}

const DEFAULT_REPOSITORY = "cinamoncandy/NUSA";
const CODING_EXECUTION_LEASE_MS = 20 * 60 * 1000;
const WEBHOOK_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const RELEASABLE_AUDIT_STATE_DECLINES = new Set([
  "github-executor-pr-draft-hold-active",
  "github-executor-pr-hold-label-active",
]);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const encoder = new TextEncoder();

function codingTaskId(request: { readonly reason: string; readonly dedupeKey: string }): string {
  const issue = request.reason.match(/(?:github-issue|issue)-[0-9]+/i)?.[0]?.toLowerCase();
  return (issue ? `autopilot:${issue}` : `autopilot:${request.dedupeKey}`).slice(0, 256);
}

export function globalReleaseFreezeActive(env: Pick<Env, "NUSA_GLOBAL_RELEASE_FREEZE">): boolean {
  return env.NUSA_GLOBAL_RELEASE_FREEZE?.trim().toLowerCase() !== "false";
}

async function persistCodingTelemetry(env: Env, input: AutopilotExecutionTelemetryInput): Promise<void> {
  if (!env.NUSA_EXECUTION_COORDINATOR) return;
  try {
    await recordAutopilotExecutionTelemetry(env.NUSA_EXECUTION_COORDINATOR, createAutopilotExecutionTelemetry(input));
  } catch (error) {
    console.error(JSON.stringify({ event: "NUSA_AUTOPILOT_TELEMETRY_PERSIST_FAILED", reason: error instanceof Error ? error.message : "UNKNOWN", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }));
  }
}

async function releaseCodingExecutionLease(env: Env, request: { readonly dedupeKey: string; readonly executionId: string }): Promise<void> {
  if (!env.NUSA_EXECUTION_COORDINATOR) return;
  try {
    await releasePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, {
      dedupeKey: request.dedupeKey,
      executionId: request.executionId,
      now: Date.now(),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "NUSA_AUTOPILOT_LEASE_RELEASE_FAILED", reason: error instanceof Error ? error.message : "UNKNOWN", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }));
  }
}

export function classifyGithubEvent(value: string | null): SupportedGithubEvent | null {
  if (value === "ping" || value === "push" || value === "pull_request" || value === "workflow_run") return value;
  return null;
}
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
export async function computeGithubWebhookSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}
export async function verifyGithubWebhookSignature(secret: string, body: string, provided: string | null): Promise<boolean> {
  if (!provided?.startsWith("sha256=")) return false;
  return constantTimeEqual(await computeGithubWebhookSignature(secret, body), provided);
}

async function verifyGithubWebhookAuthorization(request: Request, env: Env, body: string, allowedRepository: string): Promise<boolean> {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    try {
      await verifyGithubEventBridgeOidcToken(bearer, allowedRepository);
      return true;
    } catch {
      // Fall through to the legacy HMAC path when configured.
    }
  }
  const secret = env.NUSA_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  return verifyGithubWebhookSignature(secret, body, request.headers.get("x-hub-signature-256"));
}

async function verifyCodingRunnerAuthorization(provided: string | undefined, configured: string | undefined, allowedRepository: string): Promise<boolean> {
  if (!provided) return false;
  if (configured && constantTimeEqual(configured, provided)) return true;
  try {
    await verifyGithubActionsOidcToken(provided, allowedRepository);
    return true;
  } catch {
    return false;
  }
}

async function persistScheduledOutcome(env: Env, scheduledTime: number, outcome: Awaited<ReturnType<typeof runScheduledAutopilot>>): Promise<number> {
  if (!env.NUSA_EXECUTION_COORDINATOR) throw new Error("PERSISTENT_EXECUTION_COORDINATOR_REQUIRED");
  const observedAt = Math.max(Date.now(), scheduledTime);
  await recordScheduledRuntimeReceipt(env.NUSA_EXECUTION_COORDINATOR, {
    scheduledTime,
    observedAt,
    status: outcome.status,
    reason: outcome.reason,
    headSha: outcome.headSha,
    workflowRunId: outcome.workflowRunId,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
  return observedAt;
}

function verifyAutopilotRuntimeAuthorization(request: Request, configured: string | undefined): boolean {
  const expected = configured?.trim();
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return Boolean(expected && provided && constantTimeEqual(expected, provided));
}

export async function handleScheduledRuntimeTick(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "AUTOPILOT_RUNTIME_METHOD_NOT_ALLOWED" }, 405);
  const configured = env.NUSA_AUTOPILOT_RUNTIME_TOKEN?.trim();
  if (!configured) return json({ status: "INTERFACE_READY", reason: "AUTOPILOT_RUNTIME_TOKEN_NOT_CONFIGURED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
  if (!verifyAutopilotRuntimeAuthorization(request, configured)) return json({ error: "AUTOPILOT_RUNTIME_UNAUTHORIZED" }, 401);
  if (!env.NUSA_EXECUTION_COORDINATOR) return json({ status: "INTERFACE_READY", reason: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
  const scheduledTime = Date.now();
  try {
    const outcome = await runScheduledAutopilot(env, scheduledTime);
    const observedAt = await persistScheduledOutcome(env, scheduledTime, outcome);
    return json({ accepted: true, ...outcome, heartbeatAt: observedAt, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 202);
  } catch (error) {
    return json({ accepted: false, status: "EXECUTION_NOT_DISPATCHED", reason: error instanceof Error ? error.message : "SCHEDULED_RUNTIME_FAILED", heartbeatAt: Date.now(), liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
  }
}

export async function handleCodingExecute(
  request: Request,
  env: Env,
  runtime?: CodingRuntime,
  publisher?: CodingPublisher,
): Promise<Response> {
  const startedAt = Date.now();
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
  const configured = env.NUSA_CODING_RUNNER_TOKEN?.trim();
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!await verifyCodingRunnerAuthorization(provided, configured, allowedRepository)) return json({ error: "CODING_RUNNER_UNAUTHORIZED" }, 401);
  try {
    const runnerRequest = validateCodingRunnerRequest(await request.json(), allowedRepository);
    if (isWorkflowFailureCodingReason(runnerRequest.reason)) {
      return json({ accepted: false, status: "CODING_EXECUTION_FAILED_CLOSED", error: "CAUSAL_ACTIONABILITY_UNVERIFIED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
    }
    if (!env.NUSA_EXECUTION_COORDINATOR) return json({ error: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", status: "INTERFACE_READY" }, 503);
    const lease = await handoffOrAcquirePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, {
      dedupeKey: runnerRequest.dedupeKey,
      executionId: runnerRequest.executionId,
      now: startedAt,
      leaseExpiresAt: startedAt + CODING_EXECUTION_LEASE_MS,
      taskId: codingTaskId(runnerRequest),
      provider: "workers-ai",
      headSha: runnerRequest.headSha,
    });
    if (!lease.acquired) {
      const duplicateReason = lease.reason ?? "DUPLICATE_EXECUTION";
      const waitingRateLimit = duplicateReason === "WAITING_RATE_LIMIT";
      await persistCodingTelemetry(env, {
        executionId: runnerRequest.executionId,
        timestampMs: Date.now(),
        trigger: "repository_dispatch",
        decision: "dedupe-suppressed",
        action: "NO_ACTION",
        selectedExecutor: "cloud-coding-runner",
        dedupeKey: runnerRequest.dedupeKey,
        attempt: 1,
        retry: { attempt: 1, maxAttempts: 1, backoffMs: 0 },
        recovery: { action: "NONE", reason: duplicateReason },
        checkpoint: { checkpointId: null, resumed: false },
        durationMs: Math.max(0, Date.now() - startedAt),
        result: waitingRateLimit ? "WAITING_RATE_LIMIT" : "DUPLICATE_EXECUTION_SUPPRESSED",
        validationResult: "PASSED",
        ciResult: "UNVERIFIED",
        failureClass: "deterministic",
        commitSha: null,
        pullRequestNumber: null,
        failureReason: duplicateReason,
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      });
      return json({ accepted: true, status: waitingRateLimit ? "WAITING_RATE_LIMIT" : "DUPLICATE_EXECUTION_SUPPRESSED", reason: duplicateReason, nextRetryAt: lease.nextRetryAt ?? null, executionId: runnerRequest.executionId, dedupeKey: runnerRequest.dedupeKey, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 202);
    }

    let result: Awaited<ReturnType<typeof executeCodingRunner>>;
    try {
      const coordinator = env.NUSA_EXECUTION_COORDINATOR;
      const parsedCap = Number(env.NUSA_AUTOPILOT_PAID_OVERFLOW_DAILY_CAP?.trim() || "0");
      const paidOverflowDailyCap = Number.isSafeInteger(parsedCap) && parsedCap > 0 ? parsedCap : 0;
      result = await executeCodingRunner(runnerRequest, env, undefined, runtime, publisher, {
        providerWaitUntil: async (provider: string) => (await readProviderCapacityWait(coordinator, provider))?.nextRetryAt ?? null,
        // An unset or non-positive cap means the owner imposed none, so no reservation is taken and
        // spending stays bounded only by the purchased balance.
        ...(paidOverflowDailyCap > 0
          ? { reserveOverflowCall: async (provider: string) => reservePaidOverflowCall(coordinator, { provider, day: utcDayKey(Date.now()), cap: paidOverflowDailyCap }) }
          : {}),
      });
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : "CODING_RUNNER_EXECUTION_FAILED";
      const jevShadowReceipt = await observeJevCodingFailureShadow({ runnerRequest, failureReason, failureClass: classifyAutopilotFailure(failureReason), env });
      await releaseCodingExecutionLease(env, runnerRequest);
      await persistCodingTelemetry(env, {
        executionId: runnerRequest.executionId,
        timestampMs: Date.now(),
        trigger: "repository_dispatch",
        decision: "coding-dispatch",
        action: "ACTION",
        selectedExecutor: "cloud-coding-runner",
        dedupeKey: runnerRequest.dedupeKey,
        attempt: 1,
        retry: { attempt: 1, maxAttempts: 1, backoffMs: 0 },
        recovery: { action: "NONE", reason: failureReason },
        checkpoint: { checkpointId: null, resumed: false },
        durationMs: Math.max(0, Date.now() - startedAt),
        result: "EXECUTION_FAILED",
        validationResult: "FAILED",
        ciResult: "UNVERIFIED",
        failureClass: classifyAutopilotFailure(failureReason),
        commitSha: null,
        pullRequestNumber: null,
        failureReason,
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      });
      return json({
        error: failureReason,
        status: "EXECUTION_FAILED",
        failureEvidence: error instanceof CodingRunnerEvidenceError ? error.evidence : null,
        httpStatus: error instanceof CodingRunnerHttpEvidenceError ? error.httpStatus : null,
        jevShadowReceipt,
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      }, 400);
    }

    const stoppedAt = Date.now();
    const rateLimitStopped = result.status === "BLOCKED_RATE_LIMIT";
    const normalizedNextRetryAt = Number.isSafeInteger(result.nextRetryAt) && Number(result.nextRetryAt) > stoppedAt
      ? Number(result.nextRetryAt)
      : stoppedAt + 60_000;
    const normalizedStopReason = result.stopReason ?? result.reason ?? "WORKERS_AI_RATE_LIMITED";
    const normalizedResumeCondition = result.resumeCondition ?? "provider-capacity-and-exact-head-revalidation";
    const normalizedResult = rateLimitStopped
      ? {
          ...result,
          status: "WAITING_RATE_LIMIT",
          nextRetryAt: normalizedNextRetryAt,
          stopReason: normalizedStopReason,
          resumeCondition: normalizedResumeCondition,
        }
      : result;
    if (normalizedResult.status === "EXECUTION_ACCEPTED") {
      await markPersistentExecutionDispatched(env.NUSA_EXECUTION_COORDINATOR, {
        dedupeKey: runnerRequest.dedupeKey,
        executionId: runnerRequest.executionId,
        now: Date.now(),
      });
    } else if (rateLimitStopped) {
      const stop = {
        schemaVersion: 1 as const,
        taskId: codingTaskId(runnerRequest),
        executionId: runnerRequest.executionId,
        provider: result.provider ?? "workers-ai",
        headSha: runnerRequest.headSha,
        stopReason: normalizedStopReason,
        stoppedAt,
        attemptCount: Math.max(1, result.proposalAttempts ?? 1),
        lastFailure: result.reason ?? "WORKERS_AI_RATE_LIMITED",
        nextRetryAt: normalizedNextRetryAt,
        resumeCondition: normalizedResumeCondition,
        dedupeKey: runnerRequest.dedupeKey,
        evidenceRef: `coding-evidence:${runnerRequest.executionId}`,
      };
      const stopResult = await markPersistentExecutionRateLimitStopped(env.NUSA_EXECUTION_COORDINATOR, { ...stop, now: stoppedAt });
      if (!stopResult.stopped) throw new Error("PERSISTENT_EXECUTION_RATE_LIMIT_STOP_FAILED");
      await recordProviderCapacityWait(env.NUSA_EXECUTION_COORDINATOR, stop);
    } else {
      await releaseCodingExecutionLease(env, runnerRequest);
    }
    const failureReason = result.reason ?? null;
    const jevShadowReceipt = result.status === "JEV_ROUTING_ABSTAINED"
      ? null
      : await observeJevCodingFailureShadow({ runnerRequest, failureReason, failureClass: classifyAutopilotFailure(failureReason), env });
    const completedAt = Date.now();
    await persistCodingTelemetry(env, {
      executionId: runnerRequest.executionId,
      timestampMs: completedAt,
      trigger: "repository_dispatch",
      decision: normalizedResult.status === "EXECUTION_ACCEPTED" ? "coding-dispatch" : normalizedResult.status === "WAITING_RATE_LIMIT" ? "rate-limit-stop" : "coding-dispatch-failed",
      action: normalizedResult.status === "EXECUTION_ACCEPTED" ? "ACTION" : "NO_ACTION",
      selectedExecutor: "cloud-coding-runner",
      dedupeKey: runnerRequest.dedupeKey,
      attempt: 1,
      retry: { attempt: 1, maxAttempts: 1, backoffMs: 0 },
      recovery: { action: "NONE", reason: failureReason },
      checkpoint: { checkpointId: result.checkpointId ?? null, resumed: false },
      durationMs: Math.max(0, Date.now() - startedAt),
      result: normalizedResult.status,
      validationResult: normalizedResult.proposalValidated === true || normalizedResult.workspaceVerified === true ? "PASSED" : normalizedResult.status === "EXECUTION_ACCEPTED" ? "NOT_RUN" : "FAILED",
      ciResult: "VERIFIED",
      failureClass: classifyAutopilotFailure(failureReason),
      commitSha: normalizedResult.commitSha?.toLowerCase() ?? null,
      pullRequestNumber: normalizedResult.pullRequestNumber ?? null,
      failureReason,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    });
    const evidenceDecision = createCodingExecutionEvidence(runnerRequest, normalizedResult, completedAt);
    let nextCanonicalTransition: ReturnType<typeof reconcileCodingExecutionEvidence> | null = null;
    let evidencePersisted = false;
    if (evidenceDecision.status === "RECORDED" && env.NUSA_EXECUTION_COORDINATOR) {
      try {
        const persistedEvidence = await recordCodingExecutionEvidence(env.NUSA_EXECUTION_COORDINATOR, evidenceDecision.evidence);
        evidencePersisted = true;
        nextCanonicalTransition = reconcileCodingExecutionEvidence(
          { executionId: runnerRequest.executionId, dedupeKey: runnerRequest.dedupeKey, status: "CODING_DISPATCHED" },
          persistedEvidence,
        );
        if (normalizedResult.status === "EXECUTION_ACCEPTED") {
          await completePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, {
            dedupeKey: runnerRequest.dedupeKey,
            executionId: runnerRequest.executionId,
            now: Date.now(),
          });
          if (/(?:github-issue|issue)-[0-9]+/i.test(runnerRequest.reason)) {
            await completeActiveWip(env.NUSA_EXECUTION_COORDINATOR, {
              dedupeKey: runnerRequest.dedupeKey,
              executionId: runnerRequest.executionId,
              workerId: "cloud-coding-runner",
              startedAt,
              completedAt,
            });
          }
        }
      } catch {
        console.error(JSON.stringify({ event: "NUSA_CODING_EVIDENCE_PERSIST_FAILED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }));
      }
    }
    return json({ accepted: true, ...normalizedResult, executionEvidence: evidenceDecision.status === "RECORDED" ? evidenceDecision.evidence : null, executionEvidencePersisted: evidencePersisted, nextCanonicalTransition, jevShadowReceipt, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, normalizedResult.status === "EXECUTION_FAILED" ? 502 : 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "CODING_RUNNER_REQUEST_INVALID" }, 400);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
    if (request.method === "GET" && url.pathname === "/health") return json({ service: "nusa-autopilot", status: "WEBHOOK_READY", webhookAuthentication: env.NUSA_WEBHOOK_SECRET ? "OIDC_OR_HMAC" : "OIDC", deploymentRevision: env.NUSA_DEPLOYMENT_REVISION?.trim() || "UNVERIFIED", executionPlanning: "ENABLED", boundedExecutionSpine: "ENABLED", persistentExecutionCoordination: env.NUSA_EXECUTION_COORDINATOR ? "CONFIGURED" : "INTERFACE_READY", codingExecutionEvidence: env.NUSA_EXECUTION_COORDINATOR ? "CONFIGURED" : "INTERFACE_READY", executionTelemetry: env.NUSA_EXECUTION_COORDINATOR ? "CONFIGURED" : "INTERFACE_READY", authenticatedExecutor: env.NUSA_GITHUB_TOKEN ? "CONFIGURED" : "INTERFACE_READY", releaseProvenanceConsumer: env.NUSA_GITHUB_TOKEN ? "CONFIGURED" : "INTERFACE_READY", codingRunner: "OIDC_READY", legacyCodingRunnerToken: env.NUSA_CODING_RUNNER_TOKEN ? "CONFIGURED" : "NOT_REQUIRED", zeroCreditMode: isZeroCreditModeEnforced(env.NUSA_AUTOPILOT_ZERO_CREDIT_MODE) ? "ENFORCED" : "DISABLED", aiCodingEngine: isZeroCreditModeEnforced(env.NUSA_AUTOPILOT_ZERO_CREDIT_MODE) ? "ZERO_CREDIT" : (env.NUSA_AI_CODING_ENDPOINT && env.NUSA_AI_CODING_TOKEN) || env.AI ? "CONFIGURED" : "INTERFACE_READY", allowedRepository, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });

    if (request.method === "GET" && url.pathname === "/release/status") {
      const prNumber = Number(url.searchParams.get("pr"));
      const release = await resolveGithubReleaseCompletion(prNumber, { token: env.NUSA_GITHUB_TOKEN, allowedRepository });
      let verifiedWorkerOutcome = null;
      if (env.NUSA_EXECUTION_COORDINATOR) {
        try {
          const coding = await readCodingExecutionEvidence(env.NUSA_EXECUTION_COORDINATOR);
          const evidence = [...coding.history].reverse().find((candidate) => candidate.outcome.pullRequestNumber === prNumber) ?? null;
          if (evidence?.outcome.commitSha) {
            const completions = await readActiveWipCompletions(env.NUSA_EXECUTION_COORDINATOR);
            const completion = [...completions].reverse().find((candidate) => candidate.executionId === evidence.request.executionId) ?? null;
            const telemetry = await readAutopilotExecutionTelemetry(env.NUSA_EXECUTION_COORDINATOR);
            const attempt = completion ? [...telemetry.history].reverse().find((candidate) =>
              candidate.executionId === evidence.request.executionId
              && candidate.pullRequestNumber === prNumber
              && candidate.commitSha === evidence.outcome.commitSha
              && candidate.timestampMs === completion.completedAt) ?? null : null;
            if (completion && attempt) {
              const measured = workerOutcomeFromTelemetry({
                taskId: completion.executionId, workerId: completion.workerId,
                queuedAt: completion.queuedAt, claimedAt: completion.claimedAt, startedAt: completion.startedAt, completedAt: completion.completedAt,
                queueWaitMs: completion.queueWaitMs, claimToStartMs: completion.claimToStartMs,
                claimToCompleteMs: completion.claimToCompleteMs, totalMs: completion.totalMs,
              }, attempt);
              if (measured) verifiedWorkerOutcome = workerOutcomeWithReleaseCompletion(measured, evidence, release);
            }
          }
        } catch {
          verifiedWorkerOutcome = null;
        }
      }
      const unavailable = release.reason === "release-github-token-not-configured";
      return json({ ...release, verifiedWorkerOutcome }, unavailable ? 503 : 200);
    }

    if (request.method === "GET" && url.pathname === "/scheduled/status") {
      if (!env.NUSA_EXECUTION_COORDINATOR) return json({ status: "UNAVAILABLE", reason: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
      try {
        const evidence = await readScheduledRuntimeEvidence(env.NUSA_EXECUTION_COORDINATOR);
        return json({
          status: evidence.receipt ? "OBSERVED" : "AWAITING_FIRST_SCHEDULED_EVENT",
          deploymentRevision: env.NUSA_DEPLOYMENT_REVISION?.trim() || "UNVERIFIED",
          receipt: evidence.receipt,
          history: evidence.history,
          summary: evidence.summary,
          liveAuthority: "NONE",
          productionMutationAllowed: false,
          aiAuthority: "ZERO_AUTHORITY",
        });
      } catch {
        return json({ status: "UNAVAILABLE", reason: "SCHEDULED_RUNTIME_RECEIPT_READ_FAILED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
      }
    }

    if (request.method === "POST" && url.pathname === "/scheduled/run") return handleScheduledRuntimeTick(request, env);

    if (request.method === "GET" && url.pathname === "/coding/evidence") {
      if (!env.NUSA_EXECUTION_COORDINATOR) return json({ status: "UNAVAILABLE", reason: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
      try {
        const evidence = await readCodingExecutionEvidence(env.NUSA_EXECUTION_COORDINATOR);
        return json({ status: evidence.evidence ? "OBSERVED" : "AWAITING_FIRST_EXECUTION", ...evidence, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });
      } catch {
        return json({ status: "UNAVAILABLE", reason: "CODING_EVIDENCE_READ_FAILED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
      }
    }

    if (request.method === "GET" && url.pathname === "/coding/telemetry") {
      if (!env.NUSA_EXECUTION_COORDINATOR) return json({ status: "UNAVAILABLE", reason: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
      try {
        const telemetry = await readAutopilotExecutionTelemetry(env.NUSA_EXECUTION_COORDINATOR);
        return json({ status: telemetry.telemetry ? "OBSERVED" : "AWAITING_FIRST_EXECUTION", ...telemetry, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });
      } catch {
        return json({ status: "UNAVAILABLE", reason: "AUTOPILOT_TELEMETRY_READ_FAILED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
      }
    }

    if (request.method === "POST" && url.pathname === "/coding/execute") return handleCodingExecute(request, env);

    if (request.method !== "POST" || url.pathname !== "/github/webhook") return json({ error: "NOT_FOUND" }, 404);
    if (!env.NUSA_WEBHOOK_SECRET && !request.headers.get("authorization")?.trim()) return json({ error: "WEBHOOK_AUTH_NOT_PROVIDED", status: "INTERFACE_READY" }, 503);
    const deliveryId = request.headers.get("x-github-delivery");
    if (!deliveryId?.trim()) return json({ error: "GITHUB_DELIVERY_ID_REQUIRED" }, 400);
    const event = classifyGithubEvent(request.headers.get("x-github-event"));
    if (!event) return json({ error: "GITHUB_EVENT_UNSUPPORTED" }, 422);
    const body = await request.text();
    if (!await verifyGithubWebhookAuthorization(request, env, body, allowedRepository)) return json({ error: "GITHUB_WEBHOOK_UNAUTHORIZED" }, 401);
    let dispatch;
    let payload: Record<string, unknown>;
    try {
      payload = parseGithubWebhookPayload(body);
      dispatch = planGithubWebhookDispatch(event, payload);
    } catch (error) { return json({ error: error instanceof Error ? error.message : "GITHUB_WEBHOOK_PAYLOAD_INVALID" }, 400); }

    // During a global Release freeze, every observed PR identity is bound to one durable exact
    // PR/head/base HOLD in the existing execution coordinator. Duplicate/replayed deliveries are
    // idempotent; they can never clear the HOLD. A ready_for_review event is treated as evidence
    // of an attempted promotion, not as authority to advance the pipeline.
    if (event === "pull_request" && dispatch.kind === "PR_CHANGED" && dispatch.prNumber && dispatch.headSha && globalReleaseFreezeActive(env)) {
      if (!env.NUSA_EXECUTION_COORDINATOR) return json({ error: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", status: "CONTROL_PLANE_HOLD_REQUIRED" }, 503);
      const pull = payload.pull_request && typeof payload.pull_request === "object" && !Array.isArray(payload.pull_request) ? payload.pull_request as Record<string, unknown> : null;
      const base = pull?.base && typeof pull.base === "object" && !Array.isArray(pull.base) ? pull.base as Record<string, unknown> : null;
      const baseSha = typeof base?.sha === "string" ? base.sha : "";
      if (!/^[0-9a-f]{40}$/i.test(baseSha)) return json({ error: "CONTROL_PLANE_HOLD_BASE_SHA_REQUIRED" }, 409);
      const holdId = `global-release-freeze:${dispatch.prNumber}:${dispatch.headSha.toLowerCase()}:${baseSha.toLowerCase()}`;
      try {
        await applyPersistentControlPlaneHold(env.NUSA_EXECUTION_COORDINATOR, {
          repository: allowedRepository, prNumber: dispatch.prNumber, headSha: dispatch.headSha, baseSha, now: Date.now(),
          hold: { holdId, prNumber: dispatch.prNumber, headSha: dispatch.headSha, baseSha, reason: "GLOBAL_RELEASE_FREEZE", source: "#1803/#1861" },
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "CONTROL_PLANE_HOLD_PERSIST_FAILED", status: "CONTROL_PLANE_HOLD_FAILED_CLOSED" }, 409);
      }
      if (dispatch.reason === "pull-request:ready_for_review") {
        return json({ accepted: true, status: "NO_ACTION", reason: "CONTROL_PLANE_HOLD_ACTIVE", deliveryId, event, dispatch, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 202);
      }
    }

    // A PR may finish canonical CI while still Draft. GitHub later sends ready_for_review as a
    // PR_CHANGED event without a workflow-run identity, so recover only the one already-completed
    // canonical pull_request CI run for this exact immutable head. The resulting dispatch is the
    // existing PR_CI_SUCCEEDED identity; planning, dedupe, and executor revalidation stay shared.
    if (dispatch.kind === "PR_CHANGED" && dispatch.reason === "pull-request:ready_for_review") {
      const resolution = await resolveCanonicalPrCiForReady(dispatch, {
        token: env.NUSA_GITHUB_TOKEN,
        allowedRepository,
      });
      if (!resolution.resolved || !resolution.dispatch) {
        return json({
          accepted: true,
          status: "NOOP",
          reason: resolution.reason,
          deliveryId,
          event,
          dispatch,
          executor: {
            status: "NOOP",
            reason: "github-executor-ready-ci-replay-unresolved",
            httpStatus: null,
            requestedHeadSha: dispatch.headSha,
            observedHeadSha: null,
          },
          liveAuthority: "NONE",
          productionMutationAllowed: false,
          aiAuthority: "ZERO_AUTHORITY",
        }, 202);
      }
      dispatch = resolution.dispatch;
    }

    // workflow_run.pull_requests is empty for cross-repository PRs, restricted forks, and some
    // pull_request_target runs -- not a reliable "no PR" signal. dispatchPlanner.ts still surfaces
    // PR_CI_SUCCEEDED with prNumber: null in that case; resolve it here by exact head SHA before
    // falling through. Any failure to resolve (zero or multiple matches, API error) leaves prNumber
    // null, and planAutopilotExecution already NOOPs that -- no separate fail-closed path needed.
    if (dispatch.kind === "PR_CI_SUCCEEDED" && dispatch.prNumber === null && dispatch.headSha && env.NUSA_GITHUB_TOKEN) {
      const resolution = await resolveOpenPullRequestByHeadSha(dispatch.headSha, {
        token: env.NUSA_GITHUB_TOKEN,
        allowedRepository,
      });
      if (resolution.resolved) dispatch = { ...dispatch, prNumber: resolution.prNumber, reason: `${dispatch.reason}:${resolution.reason}` };
    }

    const planned = planAutopilotExecution(dispatch);
    let execution = planned;
    let boundedExecution = null;
    let persistentExecutionIdentity: { readonly dedupeKey: string; readonly executionId: string } | null = null;
    try {
      boundedExecution = prepareProductionExecution(dispatch, {
        deliveryId,
        origin: "AUTO_BACKGROUND",
        now: Date.now(),
        allowedRepository,
      });
      if (dispatch.kind === "CI_SUCCEEDED" || dispatch.kind === "PR_CI_SUCCEEDED") {
        if (!env.NUSA_EXECUTION_COORDINATOR) throw new Error("PERSISTENT_EXECUTION_COORDINATOR_REQUIRED");
        if (dispatch.kind === "CI_SUCCEEDED") {
          if (!boundedExecution) throw new Error("PRODUCTION_EXECUTION_BOUNDARY_REQUIRED");
          const lease = boundedExecution.state.lease;
          if (!lease) throw new Error("PERSISTENT_EXECUTION_LEASE_REQUIRED");
          execution = boundedExecution.request;
          persistentExecutionIdentity = boundedExecution.envelope;
        } else {
          if (planned.kind !== "AUDIT_REQUEST" || !planned.dedupeKey || !planned.executionId) {
            throw new Error("PERSISTENT_EXECUTION_IDENTITY_REQUIRED");
          }
          persistentExecutionIdentity = { dedupeKey: planned.dedupeKey, executionId: planned.executionId };
        }
        const persistent = await acquirePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, {
          dedupeKey: persistentExecutionIdentity.dedupeKey,
          executionId: persistentExecutionIdentity.executionId,
          now: Date.now(),
          leaseExpiresAt: boundedExecution?.state.lease?.expiresAt ?? Date.now() + WEBHOOK_EXECUTION_LEASE_MS,
        });
        if (!persistent.acquired) {
          const canRecoverMissingAudit = dispatch.kind === "PR_CI_SUCCEEDED"
            && persistent.reason === "ALREADY_DISPATCHED"
            && planned.kind === "AUDIT_REQUEST"
            && Boolean(env.NUSA_GITHUB_TOKEN);
          if (canRecoverMissingAudit) {
            const recovered = await recoverPersistentAuditDispatch(env.NUSA_EXECUTION_COORDINATOR, {
              dedupeKey: persistentExecutionIdentity.dedupeKey,
              executionId: persistentExecutionIdentity.executionId,
              now: Date.now(),
              leaseExpiresAt: Date.now() + WEBHOOK_EXECUTION_LEASE_MS,
            });
            if (recovered.recovered) {
              const recoveredExecutor = await executeGithubDispatch(execution, { token: env.NUSA_GITHUB_TOKEN, allowedRepository });
              if (recoveredExecutor.status === "DISPATCHED" || (recoveredExecutor.status === "REJECTED" && recoveredExecutor.reason === "github-executor-duplicate-audit-run-suppressed")) {
                await markPersistentExecutionDispatched(env.NUSA_EXECUTION_COORDINATOR, { dedupeKey: persistentExecutionIdentity.dedupeKey, executionId: persistentExecutionIdentity.executionId, now: Date.now() });
              } else {
                await releasePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, { dedupeKey: persistentExecutionIdentity.dedupeKey, executionId: persistentExecutionIdentity.executionId, now: Date.now() });
              }
              const recoveryExecutor = recoveredExecutor.status === "REJECTED" && recoveredExecutor.reason === "github-executor-duplicate-audit-run-suppressed"
                ? { status: "REJECTED" as const, reason: "github-executor-duplicate-execution-suppressed", httpStatus: null, requestedHeadSha: dispatch.headSha, observedHeadSha: null }
                : recoveredExecutor;
              return json({ accepted: true, status: recoveredExecutor.status === "DISPATCHED" ? "AUDIT_DISPATCH_RECOVERED" : "DUPLICATE_EXECUTION_SUPPRESSED", reason: recoveryExecutor.reason, deliveryId, event, dispatch, execution, executor: recoveryExecutor, executionBoundary: { dedupeKey: persistentExecutionIdentity.dedupeKey, origin: boundedExecution?.envelope.origin ?? "AUTO_BACKGROUND" }, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 202);
            }
          }
          return json({
          accepted: true,
          status: "DUPLICATE_EXECUTION_SUPPRESSED",
          reason: persistent.reason,
          deliveryId,
          event,
          dispatch,
          execution,
          executor: {
            status: "REJECTED",
            reason: "github-executor-duplicate-execution-suppressed",
            httpStatus: null,
            requestedHeadSha: dispatch.headSha,
            observedHeadSha: null,
          },
          executionBoundary: { dedupeKey: persistentExecutionIdentity.dedupeKey, origin: boundedExecution?.envelope.origin ?? "AUTO_BACKGROUND" },
          liveAuthority: "NONE",
          productionMutationAllowed: false,
          aiAuthority: "ZERO_AUTHORITY",
          }, 202);
        }
      }
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "PRODUCTION_EXECUTION_INVALID", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
    }

    const executor = await executeGithubDispatch(execution, { token: env.NUSA_GITHUB_TOKEN, allowedRepository });
    if (
      persistentExecutionIdentity
      && dispatch.kind === "PR_CI_SUCCEEDED"
      && (
        executor.status === "FAILED"
        || executor.status === "INTERFACE_READY"
        || (executor.status === "REJECTED" && RELEASABLE_AUDIT_STATE_DECLINES.has(executor.reason ?? ""))
      )
      && env.NUSA_EXECUTION_COORDINATOR
    ) {
      try {
        await releasePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, {
          dedupeKey: persistentExecutionIdentity.dedupeKey,
          executionId: persistentExecutionIdentity.executionId,
          now: Date.now(),
        });
      } catch {
        return json({
          error: "PERSISTENT_AUDIT_EXECUTION_RELEASE_FAILED",
          liveAuthority: "NONE",
          productionMutationAllowed: false,
          aiAuthority: "ZERO_AUTHORITY",
        }, 409);
      }
    }
    if (persistentExecutionIdentity && executor.status === "DISPATCHED" && env.NUSA_EXECUTION_COORDINATOR) {
      await markPersistentExecutionDispatched(env.NUSA_EXECUTION_COORDINATOR, {
        dedupeKey: persistentExecutionIdentity.dedupeKey,
        executionId: persistentExecutionIdentity.executionId,
        now: Date.now(),
      });
    }
    return json({
      accepted: true,
      status: execution.kind === "NOOP" ? "NO_ACTION" : executor.status === "DISPATCHED" ? "EXECUTION_DISPATCHED" : "EXECUTION_REQUEST_PLANNED",
      deliveryId,
      event,
      dispatch,
      execution,
      executionBoundary: boundedExecution ? {
        cycleId: boundedExecution.envelope.cycleId,
        workItemId: boundedExecution.envelope.workItemId,
        executionId: boundedExecution.envelope.executionId,
        dedupeKey: boundedExecution.envelope.dedupeKey,
        origin: boundedExecution.envelope.origin,
        state: boundedExecution.state.status,
        leaseExpiresAt: boundedExecution.state.lease?.expiresAt ?? null,
        evidenceRefs: boundedExecution.envelope.evidenceRefs,
      } : null,
      executor,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    }, 202);
  },

  async scheduled(controller: { scheduledTime?: number }, env: Env): Promise<void> {
    const scheduledTime = Number.isSafeInteger(controller?.scheduledTime) && Number(controller.scheduledTime) >= 0
      ? Number(controller.scheduledTime)
      : Date.now();
    const outcome = await runScheduledAutopilot(env, scheduledTime);
    if (env.NUSA_EXECUTION_COORDINATOR) {
      try {
        await persistScheduledOutcome(env, scheduledTime, outcome);
      } catch (error) {
        console.error(JSON.stringify({ event: "NUSA_SCHEDULED_RECEIPT_FAILED", reason: error instanceof Error ? error.message : "UNKNOWN" }));
      }
    }
    console.log(JSON.stringify({ event: "NUSA_SCHEDULED_AUTOPILOT", ...outcome }));
  },
};
