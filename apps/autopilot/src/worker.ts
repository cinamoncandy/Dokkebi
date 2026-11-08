import baseWorker, { globalReleaseFreezeActive, handleCodingExecute, type Env as BaseEnv } from "./index";
import { acquirePersistentExecution, admitActiveWip, claimIsolatedCausalAttempt, completeActiveWip, ExecutionCoordinator, handoffOrAcquirePersistentExecution, markPersistentExecutionDispatched, readActiveWip, readActiveWipCompletions, readPersistentControlPlaneHold, readProviderCapacityWait, recordCodingExecutionEvidence, recordProviderCapacityWait, releaseActiveWip, releasePersistentExecution } from "./executionCoordinator";
import { createCodingExecutionEvidence } from "./codingExecutionEvidence";
import { reconcileCodingExecutionEvidence } from "./productionExecutionSpine";
import {
  CodingRunnerEvidenceError,
  CodingRunnerHttpEvidenceError,
  executeCodingRunner,
  isEligibleCausalWorkflowFailureRequest,
  isWorkflowFailureCodingReason,
  validateCodingRunnerRequest,
  verifyCodingRunnerRequestAgainstGitHub,
  type CodingProposal,
  type CodingRuntime,
  type CodingRuntimeExecutionResult,
  type CodingRunnerRequest,
} from "./codingRunner";
import { GithubValidatedPatchPublisher } from "./githubValidatedPatchPublisher";
import { verifyGithubActionsOidcToken, verifyGithubCodexWipCurrentMainSha, verifyGithubCodexWipIdentity, verifyGithubCodexWipRun, verifyGithubIsolatedConsumerIdentity, verifyGithubIsolatedConsumerRun, verifyGithubIsolatedSourceRun, verifyGithubReleaseControlOidcToken } from "./githubActionsOidc";
import { AUDIT_PROVIDER, executeIndependentAudit, executeProviderGatedAudit, validateAuditRunnerRequest } from "./auditRunner";
import { classifyAiBudgetState } from "./aiBudgetState";
import { decideCodingRunnerNoAction } from "./codingRunnerRemediation";
import { claimVerifiedCausalDispatch, verifyClaimedCausalDispatch } from "./causalAdmissionAuthorization";
import { hashCausalDispatchCapability } from "./causalDispatchBinding";
import { verifyCausalProducerAttestation, verifyIsolatedCausalVerificationAttestation } from "./sigstoreCausalAttestation";
import { executeVerifiedIsolatedCausalVerification } from "./isolatedCausalVerificationHarness";
import { verifyGithubCausalProducerEvidence, verifyGithubCodingPublisherIdentity, verifyGithubCodingPublisherRun, type SourceExecutionIdentity } from "./githubActionsOidc";
import { createCausalAdmissionReceipt } from "./causalRegressionAdmission";
import { applyCausalRepairPatch, verifyCausalPublishedFiles } from "./causalRepairPatch";
import { createCausalProposalReceipt, verifyCausalProposalReceipt, CAUSAL_REPAIR_TARGET as SIGNED_CAUSAL_REPAIR_TARGET } from "./causalProposalReceipt";
import { selectCodexBacklogTask } from "./evolveGithubIssueBacklog";

export { ExecutionCoordinator };

export interface WorkerEnv extends BaseEnv {
  NUSA_AI_AUDIT_MODEL?: string;
  /** Deliberately absent from deployment config until a separately authorized Worker release. */
  NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED?: string;
}

interface ReleaseControlPlaneCheckRequest {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
}

const AUDIT_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const MAX_VALIDATED_FILE_BYTES = 128_000;
const CAUSAL_REPAIR_TARGET = SIGNED_CAUSAL_REPAIR_TARGET;
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

function causalSourceForCodingRequest(runnerRequest: CodingRunnerRequest, allowedRepository: string): SourceExecutionIdentity | null {
  if (!isEligibleCausalWorkflowFailureRequest(runnerRequest)
    || runnerRequest.repository !== allowedRepository
    || !Number.isSafeInteger(runnerRequest.workflowRunAttempt)) return null;
  return Object.freeze({
    repository: allowedRepository,
    workflowPath: ".github/workflows/ci.yml",
    sha: runnerRequest.headSha.toLowerCase(),
    runId: String(runnerRequest.workflowRunId),
    runAttempt: String(runnerRequest.workflowRunAttempt),
  });
}

async function verifyCausalCodingAdmission(
  request: Request,
  runnerRequest: CodingRunnerRequest,
  env: WorkerEnv,
  allowedRepository: string,
): Promise<{ source: SourceExecutionIdentity; publisher: NonNullable<Awaited<ReturnType<typeof verifyClaimedCausalDispatch>>["publisher"]>; capabilityDigest: string } | null> {
  const source = causalSourceForCodingRequest(runnerRequest, allowedRepository);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const capability = request.headers.get("x-nusa-causal-dispatch-capability")?.trim();
  if (!source || !token || !capability || !/^[a-f0-9]{64}$/.test(capability)
    || !env.NUSA_EXECUTION_COORDINATOR || !env.NUSA_GITHUB_TOKEN?.trim()) return null;
  const now = Date.now();
  const verification = await verifyClaimedCausalDispatch({
    coordinator: env.NUSA_EXECUTION_COORDINATOR,
    allowedRepository,
    githubToken: env.NUSA_GITHUB_TOKEN.trim(),
    dedupeKey: runnerRequest.dedupeKey,
    executionId: runnerRequest.executionId,
    source,
    now,
  }, token, capability);
  if (!verification.verified || !verification.causalAdmissionGranted || !verification.publisher) return null;
  return { source, publisher: verification.publisher, capabilityDigest: await hashCausalDispatchCapability(capability) };
}

async function trustedCausalRepairContext(
  repository: string,
  headSha: string,
  token: string,
): Promise<{ path: string; startLine: number; content: string }> {
  const url = `https://api.github.com/repos/${repository}/contents/${CAUSAL_REPAIR_TARGET}?ref=${encodeURIComponent(headSha)}`;
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "nusa-autopilot-worker", "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error("CAUSAL_REPAIR_SOURCE_UNAVAILABLE");
  const file = await response.json() as { type?: unknown; path?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
  if (file.type !== "file" || file.path !== CAUSAL_REPAIR_TARGET || file.encoding !== "base64"
    || !Number.isSafeInteger(file.size) || Number(file.size) < 1 || Number(file.size) > 20_000
    || typeof file.content !== "string" || file.content.length > 32_000 || !/^[A-Za-z0-9+/=\s]+$/.test(file.content)) {
    throw new Error("CAUSAL_REPAIR_SOURCE_INVALID");
  }
  const binary = atob(file.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== Number(file.size)) throw new Error("CAUSAL_REPAIR_SOURCE_INVALID");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return Object.freeze({ path: CAUSAL_REPAIR_TARGET, startLine: 1, content });
}

const WIP_RELEASE_IDENTITY = /^[A-Za-z0-9_.:|-]{1,512}$/;
const CODEX_WIP_LIMIT = 2;
type CodexWipFetch = (input: string, init?: RequestInit) => Promise<Response>;

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
  let body: { dedupeKey?: unknown; executionId?: unknown; source?: unknown; capability?: unknown; attestationBundle?: unknown; causalAdmissionRequired?: unknown };
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
  let causalAdmission = null;
  if (body.attestationBundle !== undefined) {
    try {
      // Authenticate and source-check before spending CPU on the bundle. The
      // claim helper repeats these checks immediately before its atomic write.
      const publisher = await verifyGithubCodingPublisherIdentity(provided, allowedRepository, dependencies.fetchImpl, Math.floor(now / 1000));
      await verifyGithubCodingPublisherRun(publisher, env.NUSA_GITHUB_TOKEN.trim(), dependencies.fetchImpl);
      const producer = await verifyGithubCausalProducerEvidence(body.source as SourceExecutionIdentity, allowedRepository, env.NUSA_GITHUB_TOKEN.trim(), dependencies.fetchImpl);
      const verified = await verifyCausalProducerAttestation(body.attestationBundle, body.source as SourceExecutionIdentity);
      causalAdmission = await createCausalAdmissionReceipt({
        source: body.source as SourceExecutionIdentity, producer, verified, now, expiresAt: now + 30 * 60 * 1000,
      });
    } catch {
      return json({ claimed: false, causalAttestationVerified: false, error: "CAUSAL_ATTESTATION_REJECTED", ...authority }, 409);
    }
  }
  if (body.causalAdmissionRequired === true && !causalAdmission) {
    return json({ claimed: false, causalAdmissionGranted: false, error: "CAUSAL_ADMISSION_REQUIRED", ...authority }, 409);
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
    causalAdmission,
  }, provided, body.capability);
  return claimed.claimed
    ? json({ claimed: true, causalAttestationVerified: causalAdmission !== null, causalAdmissionGranted: claimed.causalAdmissionGranted, ...authority })
    : json({ claimed: false, causalAttestationVerified: causalAdmission !== null, causalAdmissionGranted: false, error: "CAUSAL_DISPATCH_BINDING_REJECTED", ...authority }, 409);
}

/** Disabled-by-default isolated proof lane; claim and CodingRunner execution stay inside this Worker. */
export async function handleIsolatedCausalVerification(
  request: Request,
  env: WorkerEnv,
  dependencies: { readonly now?: () => number; readonly fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const authority = { mutationAllowed: false, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" } as const;
  if (env.NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED !== "true") {
    return json({ accepted: false, error: "ISOLATED_CAUSAL_VERIFICATION_DISABLED", ...authority }, 404);
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ accepted: false, error: "ISOLATED_CONSUMER_UNAUTHORIZED", ...authority }, 401);
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  if (allowedRepository !== "cinamoncandy/NUSA" || !env.NUSA_GITHUB_TOKEN?.trim() || !env.NUSA_EXECUTION_COORDINATOR) {
    return json({ accepted: false, error: "ISOLATED_VERIFICATION_DEPENDENCY_UNAVAILABLE", ...authority }, 503);
  }

  let body: { sourceRunId?: unknown; sourceRunAttempt?: unknown; attestationBundle?: unknown };
  try {
    body = JSON.parse(await readBoundedCausalClaimBody(request)) as typeof body;
  } catch {
    return json({ accepted: false, error: "ISOLATED_VERIFICATION_REQUEST_INVALID", ...authority }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.sourceRunId !== "string" || !/^[1-9][0-9]{0,19}$/.test(body.sourceRunId)
    || typeof body.sourceRunAttempt !== "string" || !/^[1-9][0-9]{0,9}$/.test(body.sourceRunAttempt)
    || !body.attestationBundle || typeof body.attestationBundle !== "object" || Array.isArray(body.attestationBundle)) {
    return json({ accepted: false, error: "ISOLATED_VERIFICATION_REQUEST_INVALID", ...authority }, 400);
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now?.() ?? Date.now();
  try {
    const consumer = await verifyGithubIsolatedConsumerIdentity(token, allowedRepository, fetchImpl as never, Math.floor(now / 1000));
    await verifyGithubIsolatedConsumerRun(consumer, env.NUSA_GITHUB_TOKEN.trim(), fetchImpl as never);
    const sourceRun = await verifyGithubIsolatedSourceRun(body.sourceRunId, body.sourceRunAttempt, env.NUSA_GITHUB_TOKEN.trim(), fetchImpl as never);
    const verified = await verifyIsolatedCausalVerificationAttestation(body.attestationBundle, {
      sha: sourceRun.sha,
      runId: sourceRun.runId,
      runAttempt: sourceRun.runAttempt,
    });
    const result = await executeVerifiedIsolatedCausalVerification(verified, {
      githubToken: env.NUSA_GITHUB_TOKEN.trim(),
      fetchImpl,
      verifiedSourceRun: sourceRun,
      claimAttempt: (evidence) => claimIsolatedCausalAttempt(env.NUSA_EXECUTION_COORDINATOR!, evidence, now),
    });
    return json({ accepted: true, receipt: result, ...authority });
  } catch (error) {
    const code = error instanceof Error ? error.message : "ISOLATED_VERIFICATION_REJECTED";
    const unavailable = /UNAVAILABLE|STORAGE|JWKS_HTTP/.test(code);
    return json({
      accepted: false,
      error: unavailable ? "ISOLATED_VERIFICATION_EVIDENCE_UNAVAILABLE" : "ISOLATED_VERIFICATION_REJECTED",
      ...authority,
    }, unavailable ? 503 : 409);
  }
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

/**
 * Claims/releases one slot in the existing two-slot WIP coordinator for the exact
 * protected-main Codex workflow run. This endpoint conveys no coding or repository-write authority.
 */
export async function handleCodexWipCoordination(
  request: Request,
  env: WorkerEnv,
  dependencies: { readonly now?: () => number; readonly fetchImpl?: CodexWipFetch } = {},
): Promise<Response> {
  const authority = { liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" } as const;
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!provided) return json({ accepted: false, error: "CODEX_WIP_OIDC_REQUIRED", ...authority }, 401);
  if (allowedRepository !== "cinamoncandy/NUSA" || !env.NUSA_GITHUB_TOKEN?.trim() || !env.NUSA_EXECUTION_COORDINATOR) {
    return json({ accepted: false, error: "CODEX_WIP_COORDINATOR_UNAVAILABLE", ...authority }, 503);
  }
  const fetchImpl = dependencies.fetchImpl ?? (fetch as unknown as CodexWipFetch);
  const now = dependencies.now ?? Date.now;
  let identity: Awaited<ReturnType<typeof verifyGithubCodexWipIdentity>>;
  try {
    identity = await verifyGithubCodexWipIdentity(provided, allowedRepository, fetchImpl as never, Math.floor(now() / 1000));
    await verifyGithubCodexWipRun(identity, env.NUSA_GITHUB_TOKEN.trim(), fetchImpl as never);
  } catch (error) {
    const code = error instanceof Error ? error.message : "CODEX_WIP_IDENTITY_INVALID";
    const unavailable = /UNAVAILABLE|JWKS_HTTP/.test(code);
    return json({ accepted: false, error: unavailable ? "CODEX_WIP_IDENTITY_UNAVAILABLE" : "CODEX_WIP_IDENTITY_REJECTED", ...authority }, unavailable ? 503 : 401);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 1024)) {
    return json({ accepted: false, error: "CODEX_WIP_REQUEST_INVALID", ...authority }, 400);
  }
  let body: { action?: unknown; issueNumber?: unknown; headSha?: unknown };
  try {
    body = await request.json() as { action?: unknown; issueNumber?: unknown; headSha?: unknown };
  } catch {
    return json({ accepted: false, error: "CODEX_WIP_REQUEST_INVALID", ...authority }, 400);
  }
  if ((body.action !== "claim" && body.action !== "release")
    || typeof body.issueNumber !== "number" || !Number.isSafeInteger(body.issueNumber) || body.issueNumber < 1 || body.issueNumber > 1_000_000) {
    return json({ accepted: false, error: "CODEX_WIP_REQUEST_INVALID", ...authority }, 400);
  }
  if (typeof body.headSha !== "string" || !/^[a-f0-9]{40}$/i.test(body.headSha)) {
    return json({ accepted: false, error: "CODEX_WIP_REQUEST_INVALID", ...authority }, 400);
  }
  if (body.headSha.toLowerCase() !== identity.sha) {
    return json({ accepted: false, error: "CODEX_WIP_HEAD_SHA_MISMATCH", ...authority }, 409);
  }
  const issueNumber = Number(body.issueNumber);
  const dedupeKey = `codex-wip:${identity.runId}:${identity.runAttempt}:issue:${issueNumber}:sha:${identity.sha}`;
  const executionId = `codex-execution:${identity.runId}:${identity.runAttempt}:issue:${issueNumber}:sha:${identity.sha}`;
  if (!WIP_RELEASE_IDENTITY.test(dedupeKey) || !WIP_RELEASE_IDENTITY.test(executionId)) {
    return json({ accepted: false, error: "CODEX_WIP_IDENTITY_INVALID", ...authority }, 400);
  }

  if (body.action === "claim") {
    try {
      await verifyGithubCodexWipCurrentMainSha(identity, env.NUSA_GITHUB_TOKEN.trim(), fetchImpl as never);
    } catch (error) {
      const code = error instanceof Error ? error.message : "CODEX_WIP_MAIN_UNAVAILABLE";
      const unavailable = code.includes("UNAVAILABLE");
      return json({ accepted: false, error: unavailable ? "CODEX_WIP_MAIN_UNAVAILABLE" : "CODEX_WIP_MAIN_MISMATCH", ...authority }, unavailable ? 503 : 409);
    }
    let selectedTask: ReturnType<typeof selectCodexBacklogTask>;
    try {
      const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${env.NUSA_GITHUB_TOKEN.trim()}`, "user-agent": "nusa-autopilot-worker", "x-github-api-version": "2022-11-28" };
      const [issueResponse, pullResponse] = await Promise.all([
        fetchImpl(`https://api.github.com/repos/${allowedRepository}/issues?state=open&per_page=100`, { headers }),
        fetchImpl(`https://api.github.com/repos/${allowedRepository}/pulls?state=open&per_page=100`, { headers }),
      ]);
      if (!issueResponse.ok || !pullResponse.ok) throw new Error("CODEX_WIP_TASK_UNAVAILABLE");
      const [issues, pulls] = await Promise.all([issueResponse.json(), pullResponse.json()]);
      if (!Array.isArray(issues) || !Array.isArray(pulls)) throw new Error("CODEX_WIP_TASK_UNAVAILABLE");
      selectedTask = selectCodexBacklogTask(issues, pulls);
    } catch {
      return json({ accepted: false, error: "CODEX_WIP_TASK_UNAVAILABLE", ...authority }, 503);
    }
    if (!selectedTask || selectedTask.issueNumber !== issueNumber || !selectedTask.canonicalOwner || selectedTask.conflictKeys.length === 0) {
      return json({ accepted: false, error: "CODEX_WIP_TASK_NOT_CURRENT_OR_UNCLAIMABLE", ...authority }, 409);
    }
    try {
      const result = await admitActiveWip(env.NUSA_EXECUTION_COORDINATOR, {
        dedupeKey,
        executionId,
        canonicalOwner: selectedTask.canonicalOwner,
        conflictKeys: selectedTask.conflictKeys,
        claimedAt: now(),
        maxConcurrent: CODEX_WIP_LIMIT,
      });
      if (!result.admitted) return json({ accepted: false, error: result.reason ?? "CODEX_WIP_ADMISSION_REJECTED", ...authority }, 409);
      return json({ accepted: true, action: "claim", issueNumber, dedupeKey, executionId, ...authority }, 201);
    } catch {
      return json({ accepted: false, error: "CODEX_WIP_ADMISSION_UNAVAILABLE", ...authority }, 503);
    }
  }

  try {
    const active = await readActiveWip(env.NUSA_EXECUTION_COORDINATOR);
    const claim = active.claims.find((candidate) => candidate.dedupeKey === dedupeKey);
    if (!claim) {
      const completions = await readActiveWipCompletions(env.NUSA_EXECUTION_COORDINATOR);
      const completed = completions.some((entry) => entry.dedupeKey === dedupeKey && entry.executionId === executionId);
      return json({ accepted: completed, released: false, reason: completed ? "ALREADY_COMPLETED" : "CLAIM_NOT_ACTIVE", ...authority }, completed ? 200 : 409);
    }
    if (claim.executionId !== executionId) return json({ accepted: false, error: "CODEX_WIP_OWNER_MISMATCH", ...authority }, 409);
    await completeActiveWip(env.NUSA_EXECUTION_COORDINATOR, {
      dedupeKey,
      executionId,
      workerId: `github-actions-codex:${identity.runId}`,
      startedAt: claim.claimedAt,
      completedAt: now(),
      kind: "CLAIM_RELEASED",
    });
    return json({ accepted: true, action: "release", issueNumber, released: true, ...authority }, 200);
  } catch {
    return json({ accepted: false, error: "CODEX_WIP_RELEASE_UNAVAILABLE", ...authority }, 503);
  }
}

export async function handleCodingProposal(request: Request, env: WorkerEnv): Promise<Response> {
  const allowedRepository = env.NUSA_GITHUB_REPOSITORY?.trim() || "cinamoncandy/NUSA";
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!await verifyCodingAuthorization(provided, env.NUSA_CODING_RUNNER_TOKEN?.trim(), allowedRepository)) {
    return json({ accepted: false, status: "CODING_PROPOSAL_FAILED_CLOSED", error: "CODING_RUNNER_UNAUTHORIZED" }, 401);
  }

  try {
    let runnerRequest = validateCodingRunnerRequest(await request.json(), allowedRepository);
    let causalAdmission: Awaited<ReturnType<typeof verifyCausalCodingAdmission>> = null;
    if (isWorkflowFailureCodingReason(runnerRequest.reason)) {
      causalAdmission = await verifyCausalCodingAdmission(request, runnerRequest, env, allowedRepository);
      if (!causalAdmission) return json({ accepted: false, status: "CODING_PROPOSAL_FAILED_CLOSED", error: "CAUSAL_ACTIONABILITY_UNVERIFIED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
      const proposalContext = await trustedCausalRepairContext(allowedRepository, runnerRequest.headSha, env.NUSA_GITHUB_TOKEN!.trim());
      runnerRequest = Object.freeze({ ...runnerRequest, causalRepairTarget: CAUSAL_REPAIR_TARGET, proposalContext });
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
    const causalProposalReceipt = causalAdmission
      ? await createCausalProposalReceipt(runnerRequest, causalAdmission, capture.proposal.patch, env.NUSA_GITHUB_TOKEN!.trim())
      : undefined;
    return json({
      accepted: true,
      status: "PROPOSAL_READY",
      patch: capture.proposal.patch,
      headSha: runnerRequest.headSha,
      workflowRunId: runnerRequest.workflowRunId,
      ...(runnerRequest.causalRepairTarget ? { causalRepairTarget: runnerRequest.causalRepairTarget } : {}),
      ...(causalProposalReceipt ? { causalProposalReceipt } : {}),
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

  let causalHandoff: { dedupeKey: string; executionId: string } | null = null;
  let causalPublishSucceeded = false;
  try {
    const body = await request.json() as { request?: unknown; validatedFiles?: unknown; patch?: unknown; causalProposalReceipt?: unknown };
    let runnerRequest = validateCodingRunnerRequest(body.request, allowedRepository);
    let admission: Awaited<ReturnType<typeof verifyCausalCodingAdmission>> = null;
    let validatedFiles: readonly { readonly path: string; readonly content: string }[];
    if (isWorkflowFailureCodingReason(runnerRequest.reason)) {
      admission = await verifyCausalCodingAdmission(request, runnerRequest, env, allowedRepository);
      if (!admission) return json({ accepted: false, status: "CODING_PUBLISH_FAILED_CLOSED", error: "CAUSAL_ACTIONABILITY_UNVERIFIED", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" }, 409);
      runnerRequest = Object.freeze({ ...runnerRequest, causalRepairTarget: CAUSAL_REPAIR_TARGET });
      if (!await verifyCausalProposalReceipt(body.causalProposalReceipt, runnerRequest, admission, body.patch, env.NUSA_GITHUB_TOKEN!.trim())) {
        throw new Error("CAUSAL_PROPOSAL_RECEIPT_INVALID");
      }
      const expectedContent = applyCausalRepairPatch(
        (await trustedCausalRepairContext(allowedRepository, runnerRequest.headSha, env.NUSA_GITHUB_TOKEN!.trim())).content,
        body.patch as string,
      );
      const clientValidatedFiles = validatePublishedFiles(body.validatedFiles);
      validatedFiles = verifyCausalPublishedFiles(expectedContent, clientValidatedFiles);
    } else {
      validatedFiles = validatePublishedFiles(body.validatedFiles);
    }
    await verifyCodingRunnerRequestAgainstGitHub(runnerRequest, env.NUSA_GITHUB_TOKEN);
    if (admission && (validatedFiles.length !== 1 || validatedFiles[0]!.path !== CAUSAL_REPAIR_TARGET)) {
      throw new Error("CAUSAL_REPAIR_TARGET_MISMATCH");
    }
    const runtime: CodingRuntimeExecutionResult = Object.freeze({
      backend: "github-actions-runner",
      checkpointId: runnerRequest.headSha,
      workspaceVerified: true,
      proposalValidated: true,
      changedFiles: Object.freeze(validatedFiles.map((file) => file.path)),
      validatedFiles,
    });
    const publisher = new GithubValidatedPatchPublisher({ token: env.NUSA_GITHUB_TOKEN, allowedRepository });
    if (admission) {
      const now = Date.now();
      const handoff = await handoffOrAcquirePersistentExecution(env.NUSA_EXECUTION_COORDINATOR!, {
        dedupeKey: runnerRequest.dedupeKey,
        executionId: runnerRequest.executionId,
        now,
        leaseExpiresAt: now + 30 * 60 * 1000,
        taskId: `autopilot:ci-failure-${runnerRequest.workflowRunId}`,
        provider: "workers-ai",
        headSha: runnerRequest.headSha,
        causalAdmissionHandoff: {
          source: admission.source,
          publisher: admission.publisher,
          capabilityDigest: admission.capabilityDigest,
        },
      });
      if (!handoff.acquired) throw new Error(handoff.reason ?? "CAUSAL_ADMISSION_CONSUMPTION_REJECTED");
      causalHandoff = { dedupeKey: runnerRequest.dedupeKey, executionId: runnerRequest.executionId };
    }
    const published = await publisher.publish(runnerRequest, runtime);
    if (!env.NUSA_EXECUTION_COORDINATOR) throw new Error("PERSISTENT_EXECUTION_COORDINATOR_REQUIRED");
    if (causalHandoff) {
      causalPublishSucceeded = true;
      await markPersistentExecutionDispatched(env.NUSA_EXECUTION_COORDINATOR, { ...causalHandoff, now: Date.now() });
    }
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
    if (causalHandoff && !causalPublishSucceeded && env.NUSA_EXECUTION_COORDINATOR) {
      try { await releasePersistentExecution(env.NUSA_EXECUTION_COORDINATOR, { ...causalHandoff, now: Date.now() }); } catch { /* retain the consumed receipt and lease when reconciliation is unavailable */ }
    }
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

    if (request.method === "POST" && url.pathname === "/coding/codex-wip") {
      return handleCodexWipCoordination(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/publish") {
      return handleCodingPublish(request, env);
    }

    if (request.method === "POST" && url.pathname === "/coding/causal/claim") {
      return handleCausalDispatchClaim(request, env);
    }

    if (request.method === "POST" && url.pathname === "/isolated/causal/verify-and-run") {
      return handleIsolatedCausalVerification(request, env);
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
