import baseWorker, { globalReleaseFreezeActive, handleCodingExecute, type Env as BaseEnv } from "./index";
import { acquirePersistentExecution, ExecutionCoordinator, readPersistentControlPlaneHold, readProviderCapacityWait, recordCodingExecutionEvidence, recordProviderCapacityWait, releaseActiveWip, releasePersistentExecution } from "./executionCoordinator";
import { createCodingExecutionEvidence } from "./codingExecutionEvidence";
import { reconcileCodingExecutionEvidence } from "./productionExecutionSpine";
import {
  CodingRunnerEvidenceError,
  CodingRunnerHttpEvidenceError,
  executeCodingRunner,
  isWorkflowFailureCodingReason,
  validateCodingRunnerRequest,
  verifyCodingRunnerRequestAgainstGitHub,
  type CodingProposal,
  type CodingRuntime,
  type CodingRuntimeExecutionResult,
  type CodingRunnerRequest,
} from "./codingRunner";
import { GithubValidatedPatchPublisher } from "./githubValidatedPatchPublisher";
import { verifyGithubActionsOidcToken, verifyGithubReleaseControlOidcToken } from "./githubActionsOidc";
import { AUDIT_PROVIDER, executeIndependentAudit, executeProviderGatedAudit, validateAuditRunnerRequest } from "./auditRunner";
import { classifyAiBudgetState } from "./aiBudgetState";
import { decideCodingRunnerNoAction } from "./codingRunnerRemediation";
import { claimVerifiedCausalDispatch } from "./causalAdmissionAuthorization";
import { verifyCausalProducerAttestation } from "./sigstoreCausalAttestation";
import { verifyGithubCausalProducerEvidence, verifyGithubCodingPublisherIdentity, verifyGithubCodingPublisherRun, verifyGithubCodingSourceRun, type SourceExecutionIdentity } from "./githubActionsOidc";

export { ExecutionCoordinator };

export interface WorkerEnv extends BaseEnv {
  NUSA_AI_AUDIT_MODEL?: string;
}

interface ReleaseControlPlaneCheckRequest {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
}

const AUDIT_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const MAX_VALIDATED_FILE_BYTES = 128_000;
const SAFE_AUTOPILOT_PATH = /^apps\/autopilot\/[A-Za-z0-9._/-]+$/;
const SHA40 = /^[0-9a-f]{40}$/i;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function verifyCodingAuthorization(
  provided: string | undefined,
  configured: string | undefined,
  allowedRepository: string,
): Promise<boolean> {
  if (!provided) return false;
  if (configured && constantTimeEqual(configured, provided)) return true;
  try {
    await verifyGithubActionsOidcToken(provided, allowedRepository);
    return true;
  } catch {
    return false;
  }
}

async function verifyAuditAuthorization(provided: string | undefined, allowedRepository: string): Promise<boolean> {
  if (!provided) return false;
  try {
    await verifyGithubActionsOidcToken(provided, allowedRepository);
    return true;
  } catch {
    return false;
  }
}

function validateReleaseControlPlaneCheckRequest(value: unknown, allowedRepository: string): ReleaseControlPlaneCheckRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RELEASE_CONTROL_REQUEST_INVALID");
  const request = value as Partial<ReleaseControlPlaneCheckRequest>;
  if (request.repository !== allowedRepository
    || !Number.isSafeInteger(request.prNumber) || Number(request.prNumber) <= 0
    || typeof request.headSha !== "string" || !SHA40.test(request.headSha)
    || typeof request.baseSha !== "string" || !SHA40.test(request.baseSha)) {
    throw new Error("RELEASE_CONTROL_REQUEST_INVALID");
  }
  return Object.freeze({
    repository: request.repository,
    prNumber: Number(request.prNumber),
    headSha: request.headSha.toLowerCase(),
    baseSha: request.baseSha.toLowerCase(),
  });
}

class ProposalCaptureRuntime implements CodingRuntime {
  readonly name = "github-actions-proposal";
  proposal?: CodingProposal;

  async execute(request: CodingRunnerRequest, proposal?: CodingProposal): Promise<CodingRuntimeExecutionResult> {
    if (!proposal?.patch?.trim()) throw new Error("CODING_PROPOSAL_PATCH_REQUIRED");
    this.proposal = proposal;
    return Object.freeze({
      backend: this.name,
      checkpointId: request.headSha,
      workspaceVerified: true as const,
    });
  }
}

function validatePublishedFiles(value: unknown): readonly { readonly path: string; readonly content: string }[] {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("CODING_PUBLISH_FILE_COUNT_INVALID");
  const file = value[0];
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("CODING_PUBLISH_FILE_INVALID");
  const record = file as Record<string, unknown>;
  const path = record.path;
  const content = record.content;
  if (typeof path !== "string" || !SAFE_AUTOPILOT_PATH.test(path) || path.includes("..")) {
    throw new Error("CODING_PUBLISH_PATH_INVALID");
  }
  if (path === "apps/autopilot/src/index.ts" || path === "apps/autopilot/src/worker.ts") {
    throw new Error("CODING_PUBLISH_AUTHORITY_SURFACE_FORBIDDEN");
  }
  if (typeof content !== "string" || new TextEncoder().encode(content).byteLength > MAX_VALIDATED_FILE_BYTES) {
    throw new Error("CODING_PUBLISH_CONTENT_INVALID");
  }
  return Object.freeze([Object.freeze({ path, content })]);
}

const WIP_RELEASE_IDENTITY = /^[A-Za-z0-9_.:|-]{1,512}$/;

async function readBoundedCausalClaimBody(request: Request): Promise<string> {
  if (!request.body) throw new Error("CAUSAL_DISPATCH_REQUEST_INVALID");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("CAUSAL_DISPATCH_REQUEST_INVALID")), 5000);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      // A Sigstore bundle is larger than the identity-only claim. Keep a hard cap
      // while allowing the bounded attestation envelope to reach server policy.
      if (total > 512 * 1024) throw new Error("CAUSAL_DISPATCH_REQUEST_INVALID");
      text += decoder.decode(chunk.value, { stream: true });
    }
    completed = true;
    return text + decoder.decode();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!completed) void reader.cancel().catch(() => undefined);
  }
}

/** Binds provenance only. It cannot authorize a causal result or coding admission. */
export async function handleCausalDispatchClaim(request: Request, env: WorkerEnv, dependencies: { readonly now?: () => number; readonly fetchImpl?: NonNullable<Parameters<typeof claimVerifiedCausalDispatch>[0]["fetchImpl"]> } = {}): Promise<Response> {
  const authority = { liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" } as const;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!provided) return json({ claimed: false, error: "CAUSAL_DISPATCH_UNAUTHORIZED", ...authority }, 401);
  if (!env.NUSA_EXECUTION_COORDINATOR || !env.NUSA_GITHUB_TOKEN?.trim()) {
    return json({ claimed: false, error: "CAUSAL_DISPATCH_EVIDENCE_UNAVAILABLE", ...authority }, 503);
  }
  let body: { dedupeKey?: unknown; executionId?: unknown; source?: unknown; capability?: unknown; attestationBundle?: unknown };
  try {
    body = JSON.parse(await readBoundedCausalClaimBody(request)) as typeof body;
  } catch {
    return json({ claimed: false, error: "CAUSAL_DISPATCH_REQUEST_INVALID", ...authority }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.dedupeKey !== "string" || !WIP_RELEASE_IDENTITY.test(body.dedupeKey)
    || typeof body.executionId !== "string" || !WIP_RELEASE_IDENTITY.test(body.executionId)
    || !body.source || typeof body.source !== "object" || Array.isArray(body.source)
    || typeof body.capability !== "string" || !/^[0-9a-f]{64}$/.test(body.capability)) {
    return json({ claimed: false, error: "CAUSAL_DISPATCH_REQUEST_INVALID", ...authority }, 400);
  }
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const now = dependencies.now?.() ?? Date.now();
  let causalAttestationVerified = false;
  if (body.attestationBundle !== undefined) {
    try {
      // Authenticate and source-check before spending CPU on the bundle. The
      // claim helper repeats these checks immediately before its atomic write.
      const publisher = await verifyGithubCodingPublisherIdentity(provided, allowedRepository, dependencies.fetchImpl, Math.floor(now / 1000));
      await verifyGithubCodingPublisherRun(publisher, env.NUSA_GITHUB_TOKEN.trim(), dependencies.fetchImpl);
      await verifyGithubCodingSourceRun(body.source as SourceExecutionIdentity, allowedRepository, env.NUSA_GITHUB_TOKEN.trim(), dependencies.fetchImpl);
      await verifyGithubCausalProducerEvidence(body.source as SourceExecutionIdentity, allowedRepository, env.NUSA_GITHUB_TOKEN.trim(), dependencies.fetchImpl);
      await verifyCausalProducerAttestation(body.attestationBundle, body.source as SourceExecutionIdentity);
      causalAttestationVerified = true;
    } catch {
      return json({ claimed: false, causalAttestationVerified: false, error: "CAUSAL_ATTESTATION_REJECTED", ...authority }, 409);
    }
  }
  const claimed = await claimVerifiedCausalDispatch({
    coordinator: env.NUSA_EXECUTION_COORDINATOR,
    allowedRepository,
    githubToken: env.NUSA_GITHUB_TOKEN.trim(),
    dedupeKey: body.dedupeKey,
    executionId: body.executionId,
    source: body.source as SourceExecutionIdentity,
    now,
    fetchImpl: dependencies.fetchImpl,
  }, provided, body.capability);
  return claimed ? json({ claimed: true, causalAttestationVerified, ...authority }) : json({ claimed: false, causalAttestationVerified, error: "CAUSAL_DISPATCH_BINDING_REJECTED", ...authority }, 409);
}

/**
 * The execution consumer calls this when its coding attempt ends, successfully or not, so the single
 * active-WIP slot is freed at once instead of after ACTIVE_WIP_CLAIM_MAX_AGE_MS. Same authentication as
 * /coding/propose. It can only remove the claim whose dedupe key and execution id both match.
 */
export async function handleCodingWipRelease(request: Request, env: WorkerEnv): Promise<Response> {
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const authority = { liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" } as const;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!await verifyCodingAuthorization(provided, env.NUSA_CODING_RUNNER_TOKEN?.trim(), allowedRepository)) {
    return json({ released: false, error: "CODING_RUNNER_UNAUTHORIZED", ...authority }, 401);
  }
  let body: { dedupeKey?: unknown; executionId?: unknown };
  try {
    body = await request.json() as { dedupeKey?: unknown; executionId?: unknown };
  } catch {
    return json({ released: false, error: "WIP_RELEASE_REQUEST_INVALID", ...authority }, 400);
  }
  if (typeof body?.dedupeKey !== "string" || !WIP_RELEASE_IDENTITY.test(body.dedupeKey)
    || typeof body.executionId !== "string" || !WIP_RELEASE_IDENTITY.test(body.executionId)) {
    return json({ released: false, error: "WIP_RELEASE_REQUEST_INVALID", ...authority }, 400);
  }
  if (!env.NUSA_EXECUTION_COORDINATOR) return json({ released: false, error: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", ...authority }, 503);
  try {
    const result = await releaseActiveWip(env.NUSA_EXECUTION_COORDINATOR, { dedupeKey: body.dedupeKey, executionId: body.executionId });
    return json({ ...result, ...authority }, 200);
  } catch {
    return json({ released: false, error: "ACTIVE_WIP_RELEASE_FAILED", ...authority }, 503);
  }
}

export async function handleCodingProposal(request: Request, env: WorkerEnv): Promise<Response> {
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!await verifyCodingAuthorization(provided, env.NUSA_CODING_RUNNER_TOKEN?.trim(), allowedRepository)) {
    return json({ accepted: false, status: "CODING_PROPOSAL_FAILED_CLOSED", error: "CODING_RUNNER_UNAUTHORIZED" }, 401);
  }

  try {
    const runnerRequest = validateCodingRunnerRequest(await request.json(), allowedRepository);
    if (isWorkflowFailureCodingReason(runnerRequest.reason)) {
      return json({ accepted: false, status: "CODING_PROPOSAL_FAILED_CLOSED", error: "CAUSAL_ACTIONABILITY_UNVERIFIED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
    }
    const capture = new ProposalCaptureRuntime();
    const coordinator = env.NUSA_EXECUTION_COORDINATOR;
    const result = await executeCodingRunner(runnerRequest, env, undefined, capture, undefined, {
      maxProposalAttempts: 1,
      // /coding/execute and /coding/propose are separate entry points onto the same Workers AI
      // budget as independent Audit; without this, a proposal request never saw a provider stop
      // recorded by the other entry points, and never recorded its own, so the shared budget kept
      // taking real calls from whichever entry point a distinct task happened to arrive through.
      ...(coordinator ? { providerWaitUntil: async (provider: string) => (await readProviderCapacityWait(coordinator, provider))?.nextRetryAt ?? null } : {}),
    });
    if (result.status === "BLOCKED_RATE_LIMIT") {
      if (coordinator && result.provider && result.stopReason && result.stopReason !== "WAITING_PROVIDER_CAPACITY" && Number.isSafeInteger(result.nextRetryAt)) {
        const stoppedAt = Date.now();
        try {
          await recordProviderCapacityWait(coordinator, {
            schemaVersion: 1,
            taskId: `proposal:${runnerRequest.dedupeKey}`,
            executionId: runnerRequest.executionId,
            provider: result.provider,
            headSha: runnerRequest.headSha,
            stopReason: result.stopReason,
            stoppedAt,
            attemptCount: 1,
            lastFailure: result.reason ?? result.stopReason,
            nextRetryAt: result.nextRetryAt as number,
            resumeCondition: result.resumeCondition ?? "provider-capacity-and-exact-head-revalidation",
            dedupeKey: runnerRequest.dedupeKey,
            evidenceRef: `proposal-evidence:${runnerRequest.executionId}`,
          });
        } catch {
          console.error(JSON.stringify({ event: "NUSA_CODING_PROPOSAL_PROVIDER_WAIT_RECORD_FAILED", executionId: runnerRequest.executionId, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }));
        }
      }
      return json({
        accepted: false,
        status: "CODING_PROPOSAL_FAILED_CLOSED",
        error: result.reason ?? "WAITING_PROVIDER_CAPACITY",
        httpStatus: result.httpStatus ?? null,
        provider: result.provider ?? null,
        providerStopReason: result.stopReason ?? null,
        nextRetryAt: result.nextRetryAt ?? null,
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      }, 409);
    }
    if (result.status === "JEV_ROUTING_ABSTAINED") {
      return json({
        accepted: true,
        status: "JEV_ROUTING_ABSTAINED",
        reason: result.reason ?? "NON_CODE_AUTOFIX_FORBIDDEN",
        jevAdmissionAction: result.jevAdmissionAction ?? "ABSTAIN_EXPENSIVE_INFERENCE",
        jevRequiredModel: result.jevRequiredModel ?? null,
        jevConfidence: result.jevConfidence ?? 0,
        headSha: runnerRequest.headSha,
        workflowRunId: runnerRequest.workflowRunId,
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      });
    }
    if (result.status !== "EXECUTION_ACCEPTED" || !capture.proposal?.patch?.trim()) {
      const reason = result.reason || "CODING_PROPOSAL_UNAVAILABLE";
      if (typeof result.httpStatus === "number" && Number.isSafeInteger(result.httpStatus)) {
        throw new CodingRunnerHttpEvidenceError(reason, result.httpStatus);
      }
      throw new Error(reason);
    }
    return json({
      accepted: true,
      status: "PROPOSAL_READY",
      patch: capture.proposal.patch,
      headSha: runnerRequest.headSha,
      workflowRunId: runnerRequest.workflowRunId,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "CODING_PROPOSAL_FAILED";
    const decisionReason = reason === "NO_ACTION_WARRANTED" ? "CODING_RUNNER_NO_ACTION_EVIDENCE_MISSING" : reason;
    const httpStatus = error instanceof CodingRunnerHttpEvidenceError ? error.httpStatus : null;
    const remediationDecision = decideCodingRunnerNoAction(decisionReason, 0, 3, httpStatus ?? undefined);
    return json({
      accepted: false,
      status: "CODING_PROPOSAL_FAILED_CLOSED",
      error: reason,
      failureEvidence: error instanceof CodingRunnerEvidenceError ? error.evidence : null,
      httpStatus,
      remediationDecision,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    }, 409);
  }
}

export async function handleCodingPublish(request: Request, env: WorkerEnv): Promise<Response> {
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!await verifyCodingAuthorization(provided, env.NUSA_CODING_RUNNER_TOKEN?.trim(), allowedRepository)) {
    return json({ accepted: false, status: "CODING_PUBLISH_FAILED_CLOSED", error: "CODING_RUNNER_UNAUTHORIZED" }, 401);
  }

  try {
    const body = await request.json() as { request?: unknown; validatedFiles?: unknown };
    const runnerRequest = validateCodingRunnerRequest(body.request, allowedRepository);
    if (isWorkflowFailureCodingReason(runnerRequest.reason)) {
      return json({ accepted: false, status: "CODING_PUBLISH_FAILED_CLOSED", error: "CAUSAL_ACTIONABILITY_UNVERIFIED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
    }
    await verifyCodingRunnerRequestAgainstGitHub(runnerRequest, env.NUSA_GITHUB_TOKEN);
    const validatedFiles = validatePublishedFiles(body.validatedFiles);
    const runtime: CodingRuntimeExecutionResult = Object.freeze({
      backend: "github-actions-runner",
      checkpointId: runnerRequest.headSha,
      workspaceVerified: true,
      proposalValidated: true,
      changedFiles: Object.freeze(validatedFiles.map((file) => file.path)),
      validatedFiles,
    });
    const publisher = new GithubValidatedPatchPublisher({ token: env.NUSA_GITHUB_TOKEN, allowedRepository });
    const published = await publisher.publish(runnerRequest, runtime);
    if (!env.NUSA_EXECUTION_COORDINATOR) throw new Error("PERSISTENT_EXECUTION_COORDINATOR_REQUIRED");
    const outcome = Object.freeze({
      status: "EXECUTION_ACCEPTED" as const,
      backend: runtime.backend,
      checkpointId: runtime.checkpointId,
      workspaceVerified: true as const,
      proposalValidated: true as const,
      changedFiles: runtime.changedFiles,
      ...published,
    });
    const evidenceDecision = createCodingExecutionEvidence(runnerRequest, outcome, Date.now());
    if (evidenceDecision.status !== "RECORDED") throw new Error(`CODING_EVIDENCE_${evidenceDecision.reason}`);
    const persistedEvidence = await recordCodingExecutionEvidence(env.NUSA_EXECUTION_COORDINATOR, evidenceDecision.evidence);
    const nextCanonicalTransition = reconcileCodingExecutionEvidence(
      { executionId: runnerRequest.executionId, dedupeKey: runnerRequest.dedupeKey, status: "CODING_DISPATCHED" },
      persistedEvidence,
    );
    return json({
      accepted: true,
      ...outcome,
      executionEvidence: persistedEvidence,
      executionEvidencePersisted: true,
      nextCanonicalTransition,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    });
  } catch (error) {
    return json({
      accepted: false,
      status: "CODING_PUBLISH_FAILED_CLOSED",
      error: error instanceof Error ? error.message : "CODING_PUBLISH_FAILED",
      failureEvidence: error instanceof CodingRunnerEvidenceError ? error.evidence : null,
      httpStatus: error instanceof CodingRunnerHttpEvidenceError ? error.httpStatus : null,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    }, 409);
  }
}

async function handleReleaseControlPlaneCheck(request: Request, env: WorkerEnv): Promise<Response> {
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!provided) {
    return json({ accepted: false, status: "RELEASE_CONTROL_FAILED_CLOSED", error: "RELEASE_CONTROL_UNAUTHORIZED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 401);
  }
  try {
    await verifyGithubReleaseControlOidcToken(provided, allowedRepository);
  } catch {
    return json({ accepted: false, status: "RELEASE_CONTROL_FAILED_CLOSED", error: "RELEASE_CONTROL_UNAUTHORIZED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 401);
  }
  if (!env.NUSA_EXECUTION_COORDINATOR) {
    return json({ accepted: false, status: "RELEASE_CONTROL_FAILED_CLOSED", error: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
  }

  let identity: ReleaseControlPlaneCheckRequest;
  try {
    identity = validateReleaseControlPlaneCheckRequest(await request.json(), allowedRepository);
  } catch (error) {
    return json({ accepted: false, status: "RELEASE_CONTROL_FAILED_CLOSED", error: error instanceof Error ? error.message : "RELEASE_CONTROL_REQUEST_INVALID", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 400);
  }

  if (globalReleaseFreezeActive(env)) {
    return json({ accepted: false, status: "RELEASE_CONTROL_FAILED_CLOSED", error: "GLOBAL_RELEASE_FREEZE_ACTIVE", ...identity, globalReleaseFreeze: true, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
  }

  let persistedHold;
  try {
    persistedHold = await readPersistentControlPlaneHold(env.NUSA_EXECUTION_COORDINATOR, identity);
  } catch {
    return json({ accepted: false, status: "RELEASE_CONTROL_FAILED_CLOSED", error: "CONTROL_PLANE_HOLD_READ_FAILED", ...identity, globalReleaseFreeze: false, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
  }
  if (persistedHold?.state === "ACTIVE") {
    return json({ accepted: false, status: "RELEASE_CONTROL_FAILED_CLOSED", error: "CONTROL_PLANE_HOLD_ACTIVE", ...identity, holdState: "ACTIVE", holdId: persistedHold.hold.holdId, globalReleaseFreeze: false, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
  }

  return json({
    accepted: true,
    status: "RELEASE_CONTROL_CLEAR",
    ...identity,
    holdState: persistedHold?.state ?? "NONE",
    globalReleaseFreeze: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
}

async function handleAuditExecute(request: Request, env: WorkerEnv): Promise<Response> {
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!await verifyAuditAuthorization(provided, allowedRepository)) {
    return json({ accepted: false, status: "AUDIT_FAILED_CLOSED", error: "AUDIT_RUNNER_UNAUTHORIZED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 401);
  }
  if (!env.NUSA_EXECUTION_COORDINATOR) {
    return json({ accepted: false, status: "AUDIT_FAILED_CLOSED", error: "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 503);
  }

  const auditGithubToken = request.headers.get("x-nusa-audit-github-token")?.trim();
  if (!auditGithubToken) {
    return json({ accepted: false, status: "AUDIT_FAILED_CLOSED", error: "AUDIT_GITHUB_APP_TOKEN_NOT_PROVIDED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 401);
  }

  let auditRequest;
  try {
    auditRequest = validateAuditRunnerRequest(await request.json(), allowedRepository);
  } catch (error) {
    return json({ accepted: false, status: "AUDIT_FAILED_CLOSED", error: error instanceof Error ? error.message : "AUDIT_RUNNER_REQUEST_INVALID", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 400);
  }

  if (globalReleaseFreezeActive(env)) {
    return json({ accepted: false, status: "AUDIT_FAILED_CLOSED", error: "GLOBAL_RELEASE_FREEZE_ACTIVE", reviewedHeadSha: auditRequest.headSha, baseSha: auditRequest.baseSha, workflowRunId: auditRequest.workflowRunId, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
  }
  let persistedHold;
  try {
    persistedHold = await readPersistentControlPlaneHold(env.NUSA_EXECUTION_COORDINATOR, { repository: auditRequest.repository, prNumber: auditRequest.prNumber, headSha: auditRequest.headSha, baseSha: auditRequest.baseSha });
  } catch {
    return json({ accepted: false, status: "AUDIT_FAILED_CLOSED", error: "CONTROL_PLANE_HOLD_READ_FAILED", reviewedHeadSha: auditRequest.headSha, baseSha: auditRequest.baseSha, workflowRunId: auditRequest.workflowRunId, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
  }
  if (persistedHold?.state === "ACTIVE") {
    return json({ accepted: false, status: "AUDIT_FAILED_CLOSED", error: "CONTROL_PLANE_HOLD_ACTIVE", reviewedHeadSha: auditRequest.headSha, baseSha: auditRequest.baseSha, workflowRunId: auditRequest.workflowRunId, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
  }

  const startedAt = Date.now();
  const lease = await acquirePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, {
    dedupeKey: auditRequest.dedupeKey,
    executionId: auditRequest.executionId,
    now: startedAt,
    leaseExpiresAt: startedAt + AUDIT_EXECUTION_LEASE_MS,
  });
  if (!lease.acquired) {
    return json({
      accepted: false,
      status: "DUPLICATE_AUDIT_REQUEST",
      reason: lease.reason ?? "DUPLICATE_EXECUTION",
      executionId: auditRequest.executionId,
      dedupeKey: auditRequest.dedupeKey,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    }, 409);
  }

  try {
    const coordinator = env.NUSA_EXECUTION_COORDINATOR;
    const gated = await executeProviderGatedAudit(auditRequest, {
      readProviderWait: () => readProviderCapacityWait(coordinator, AUDIT_PROVIDER),
      recordProviderWait: (stop) => recordProviderCapacityWait(coordinator, stop),
      runAudit: () => executeIndependentAudit(auditRequest, { ...env, NUSA_AUDIT_GITHUB_TOKEN: auditGithubToken }),
      now: () => Date.now(),
    });
    if (gated.status === "AUDITED") return json({ accepted: true, ...gated.result }, 200);
    return json({
      accepted: false,
      status: "AUDIT_FAILED_CLOSED",
      error: gated.status === "WAITING_PROVIDER_CAPACITY" ? "WAITING_PROVIDER_CAPACITY" : "PROVIDER_CAPACITY_STATE_UNAVAILABLE",
      // Diagnostic only: does not change the gate above, which already blocked the call.
      ...(gated.status === "WAITING_PROVIDER_CAPACITY" ? { providerStopReason: gated.reason, nextRetryAt: gated.nextRetryAt, aiBudgetState: classifyAiBudgetState({ stopReason: gated.reason, nextRetryAt: gated.nextRetryAt }, Date.now()) } : {}),
      reviewedHeadSha: auditRequest.headSha,
      baseSha: auditRequest.baseSha,
      workflowRunId: auditRequest.workflowRunId,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    }, 409);
  } catch (error) {
    return json({
      accepted: false,
      status: "AUDIT_FAILED_CLOSED",
      error: error instanceof Error ? error.message : "AUDIT_EXECUTION_FAILED",
      reviewedHeadSha: auditRequest.headSha,
      baseSha: auditRequest.baseSha,
      workflowRunId: auditRequest.workflowRunId,
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    }, 409);
  } finally {
    try {
      await releasePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, {
        dedupeKey: auditRequest.dedupeKey,
        executionId: auditRequest.executionId,
        now: Date.now(),
      });
    } catch {
      console.error(JSON.stringify({ event: "NUSA_AUDIT_LEASE_RELEASE_FAILED", executionId: auditRequest.executionId, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }));
    }
  }
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/control-plane/release-check") {
      return handleReleaseControlPlaneCheck(request, env);
    }

    if (request.method === "POST" && url.pathname === "/audit/execute") {
      return handleAuditExecute(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/execute") {
      return handleCodingExecute(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/propose") {
      return handleCodingProposal(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/wip-release") {
      return handleCodingWipRelease(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/publish") {
      return handleCodingPublish(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/causal/claim") {
      return handleCausalDispatchClaim(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/sandbox/validate") {
      return json({
        accepted: false,
        status: "CONTAINER_RUNTIME_RETIRED",
        error: "GITHUB_ACTIONS_VALIDATION_REQUIRED",
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      }, 410);
    }

    return baseWorker.fetch(request, env);
  },
  scheduled: baseWorker.scheduled,
};

export default worker;
