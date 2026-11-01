import { validatePersistedEvolutionLearningMemory, type EvolutionLearningMemoryStorage } from "./evolveDurableLearningMemory";
import { validatePersistedCodingExecutionEvidence, type CodingExecutionEvidence } from "./codingExecutionEvidence";
import { validateAutopilotExecutionTelemetry, type AutopilotExecutionTelemetry } from "./executionTelemetry";
import type { ExecutionHold, HoldClearance } from "./autonomousExecutionState";
import { claimCausalDispatchBinding, createCausalDispatchBinding, verifyClaimedCausalDispatchBinding, type CausalDispatchBinding } from "./causalDispatchBinding";
import type { SourceExecutionIdentity, VerifiedCodingPublisherIdentity } from "./githubActionsOidc";

interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface TransactionalDurableObjectStorageLike extends DurableObjectStorageLike {
  transaction<T>(closure: (storage: DurableObjectStorageLike) => Promise<T>): Promise<T>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface DurableObjectIdLike {}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type PersistentExecutionState = "LEASED" | "HANDED_OFF" | "DISPATCHED" | "RELEASED" | "COMPLETED" | "WAITING_RATE_LIMIT" | "BLOCKED";

export interface PersistentExecutionStop {
  schemaVersion: 1;
  taskId: string;
  executionId: string;
  provider: string;
  headSha: string;
  stopReason: string;
  stoppedAt: number;
  attemptCount: number;
  lastFailure: string;
  nextRetryAt: number;
  resumeCondition: string;
  dedupeKey: string;
  evidenceRef: string | null;
}

export interface PersistentExecutionRecord {
  dedupeKey: string;
  executionId: string;
  state: PersistentExecutionState;
  leaseExpiresAt: number;
  updatedAt: number;
  taskId?: string;
  provider?: string;
  headSha?: string;
  stop?: PersistentExecutionStop;
  resumeCount?: number;
  /** Fresh acquisitions of this dedupe identity through /acquire; a rate-limit resume does not count. */
  acquisitionCount?: number;
  /** A repository dispatch is asynchronous; one verified missing-consumer recovery is permitted. */
  auditDispatchRecoveryCount?: number;
}

type ExecutionRecord = PersistentExecutionRecord;

/** GitHub repository_dispatch is asynchronous; immediate replays are ordinary materialization lag. */
export const AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS = 30_000;

export interface PersistentExecutionAcquireRequest {
  dedupeKey: string;
  executionId: string;
  now: number;
  leaseExpiresAt: number;
  taskId?: string;
  provider?: string;
  headSha?: string;
  /** Optional ceiling on fresh acquisitions of the same dedupe identity (1-10); absent means unbounded. */
  maxAcquisitions?: number;
}

/** Internal-only: source is GitHub-verified before registration; digest commits a secret capability. */
export interface CausalDispatchRegistration {
  readonly dedupeKey: string;
  readonly executionId: string;
  readonly source: SourceExecutionIdentity;
  readonly capabilityDigest: string;
  readonly now: number;
  readonly expiresAt: number;
}

/** Internal-only: publisher OIDC and both GitHub run identities must be verified before claim. */
export interface CausalDispatchClaim {
  readonly dedupeKey: string;
  readonly executionId: string;
  readonly source: SourceExecutionIdentity;
  readonly publisher: VerifiedCodingPublisherIdentity;
  readonly capabilityDigest: string;
  readonly now: number;
}

interface CausalDispatchHistory {
  readonly schemaVersion: 1;
  readonly entries: readonly { readonly generation: number; readonly binding: CausalDispatchBinding }[];
}

function readCausalDispatchHistory(value: unknown): CausalDispatchHistory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const history = value as CausalDispatchHistory;
  if (history.schemaVersion !== 1 || !Array.isArray(history.entries) || history.entries.length > 3) return null;
  let previous = 0;
  for (const entry of history.entries) {
    if (!entry || !Number.isSafeInteger(entry.generation) || entry.generation <= previous || entry.generation > 3
      || !entry.binding || !Number.isSafeInteger(entry.binding.expiresAt)
      || !createCausalDispatchBinding(entry.binding.source, entry.binding.capabilityDigest, entry.binding.expiresAt - 1, entry.binding.expiresAt)
      || (entry.binding.publisher !== null && (typeof entry.binding.publisher !== "object" || Array.isArray(entry.binding.publisher)))) return null;
    previous = entry.generation;
  }
  return history;
}

export interface PersistentExecutionStopRequest extends PersistentExecutionStop {
  now: number;
}

export interface ActiveWipClaim {
  readonly dedupeKey: string;
  readonly executionId: string;
  readonly canonicalOwner: string;
  readonly conflictKeys: readonly string[];
  readonly claimedAt: number;
}
interface ActiveWipState { readonly schemaVersion: 1; readonly claims: readonly ActiveWipClaim[]; }
export interface ActiveWipAdmissionRequest extends ActiveWipClaim { readonly maxConcurrent: number; }
export interface ActiveWipCompletionRequest {
  readonly dedupeKey: string; readonly executionId: string; readonly workerId: string;
  readonly startedAt: number; readonly completedAt: number;
}
export interface ActiveWipCompletionEvidence {
  readonly dedupeKey: string; readonly executionId: string; readonly canonicalOwner: string;
  readonly conflictKeys: readonly string[]; readonly workerId: string;
  readonly queuedAt: number; readonly claimedAt: number; readonly startedAt: number; readonly completedAt: number;
  readonly queueWaitMs: number; readonly claimToStartMs: number; readonly claimToCompleteMs: number; readonly totalMs: number;
}
interface ActiveWipCompletionHistory { readonly schemaVersion: 1; readonly completions: readonly ActiveWipCompletionEvidence[]; }

export interface ScheduledRuntimeReceipt {
  scheduledTime: number;
  observedAt: number;
  status: string;
  reason: string;
  headSha: string | null;
  workflowRunId: number | null;
  liveAuthority: "NONE";
  productionMutationAllowed: false;
  aiAuthority: "ZERO_AUTHORITY";
}

export interface ScheduledRuntimeEvidenceSummary {
  readonly receiptCount: number;
  readonly windowStart: number | null;
  readonly windowEnd: number | null;
  readonly windowSpanMs: number;
  readonly statusCounts: Readonly<Record<string, number>>;
}

export interface ScheduledRuntimeEvidenceSnapshot {
  readonly receipt: ScheduledRuntimeReceipt | null;
  readonly history: readonly ScheduledRuntimeReceipt[];
  readonly summary: ScheduledRuntimeEvidenceSummary;
}

interface ScheduledRuntimeReceiptHistory {
  schemaVersion: 1;
  receipts: readonly ScheduledRuntimeReceipt[];
}

interface CodingExecutionEvidenceHistory {
  schemaVersion: 1;
  evidence: readonly CodingExecutionEvidence[];
}

interface AutopilotExecutionTelemetryHistory {
  schemaVersion: 1;
  telemetry: readonly AutopilotExecutionTelemetry[];
}

export interface ControlPlaneHoldIdentity {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
}

export interface PersistedControlPlaneHold extends ControlPlaneHoldIdentity {
  readonly schemaVersion: 1;
  readonly hold: ExecutionHold;
  readonly state: "ACTIVE" | "CLEARED";
  readonly updatedAt: number;
}

export interface ApplyControlPlaneHoldRequest extends ControlPlaneHoldIdentity {
  readonly hold: ExecutionHold;
  readonly now: number;
}

export interface ClearControlPlaneHoldRequest extends ControlPlaneHoldIdentity {
  readonly clearance: HoldClearance;
  readonly now: number;
}

const SCHEDULED_RECEIPT_COORDINATOR_KEY = "scheduled-runtime-observability";
const SCHEDULED_RECEIPT_HISTORY_KEY = "scheduled-runtime-receipts-v1";
const MAX_SCHEDULED_RECEIPTS = 120;
const EVOLVE_LEARNING_COORDINATOR_KEY = "evolve-learning-memory";
const CODING_EVIDENCE_COORDINATOR_KEY = "coding-execution-observability";
const CODING_EVIDENCE_HISTORY_KEY = "coding-execution-evidence-v1";
const MAX_CODING_EVIDENCE = 32;
const AUTOPILOT_TELEMETRY_COORDINATOR_KEY = "autopilot-execution-telemetry";
const AUTOPILOT_TELEMETRY_HISTORY_KEY = "autopilot-execution-telemetry-v1";
const MAX_AUTOPILOT_TELEMETRY = 120;
const CONTROL_PLANE_HOLD_STORAGE_KEY = "control-plane-hold-v1";
const ACTIVE_WIP_COORDINATOR_KEY = "evolve-active-wip-v1";
const ACTIVE_WIP_STORAGE_KEY = "evolve-active-wip-v1";
const ACTIVE_WIP_COMPLETION_HISTORY_KEY = "evolve-active-wip-completions-v1";
const MAX_ACTIVE_WIP = 8;
const MAX_ACTIVE_WIP_COMPLETIONS = 120;
/**
 * A claim is released only by a successful coding completion. A dispatch that fails closed, is
 * rejected or is never consumed left its claim in place forever, so with maxConcurrent 1 every later
 * backlog item was refused with WIP_LIMIT_REACHED (2026-10-13: 116 of 120 scheduled ticks). The
 * execution consumer job times out after 20 minutes, so a claim older than this cannot belong to
 * running work and is released at the next admission.
 */
export const ACTIVE_WIP_CLAIM_MAX_AGE_MS = 60 * 60 * 1000;
const CONTROL_PLANE_HOLD_COORDINATOR_PREFIX = "control-plane-hold";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/i;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function validSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validControlPlaneHoldIdentity(value: unknown): value is ControlPlaneHoldIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ControlPlaneHoldIdentity>;
  return typeof candidate.repository === "string"
    && REPOSITORY.test(candidate.repository)
    && Number.isSafeInteger(candidate.prNumber)
    && Number(candidate.prNumber) > 0
    && typeof candidate.headSha === "string"
    && SHA40.test(candidate.headSha)
    && typeof candidate.baseSha === "string"
    && SHA40.test(candidate.baseSha);
}

function validExecutionHold(value: unknown, identity?: ControlPlaneHoldIdentity): value is ExecutionHold {
  if (!value || typeof value !== "object") return false;
  const hold = value as Partial<ExecutionHold>;
  return validText(hold.holdId)
    && Number.isSafeInteger(hold.prNumber)
    && Number(hold.prNumber) > 0
    && typeof hold.headSha === "string"
    && SHA40.test(hold.headSha)
    && typeof hold.baseSha === "string"
    && SHA40.test(hold.baseSha)
    && ["GLOBAL_RELEASE_FREEZE", "BLOCKED_HUMAN", "REWORK", "EXPLICIT_HOLD"].includes(String(hold.reason))
    && validText(hold.source)
    && (!identity || (hold.prNumber === identity.prNumber && hold.headSha === identity.headSha && hold.baseSha === identity.baseSha));
}

function validHoldClearance(value: unknown, identity?: ControlPlaneHoldIdentity): value is HoldClearance {
  if (!value || typeof value !== "object") return false;
  const clearance = value as Partial<HoldClearance>;
  return validText(clearance.holdId)
    && Number.isSafeInteger(clearance.prNumber)
    && Number(clearance.prNumber) > 0
    && typeof clearance.headSha === "string"
    && SHA40.test(clearance.headSha)
    && typeof clearance.baseSha === "string"
    && SHA40.test(clearance.baseSha)
    && validText(clearance.clearedBy)
    && typeof clearance.globalReleaseFreeze === "boolean"
    && typeof clearance.blockedHuman === "boolean"
    && typeof clearance.reworkRequired === "boolean"
    && (!identity || (clearance.prNumber === identity.prNumber && clearance.headSha === identity.headSha && clearance.baseSha === identity.baseSha));
}

function validPersistedControlPlaneHold(value: unknown): value is PersistedControlPlaneHold {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedControlPlaneHold>;
  if (candidate.schemaVersion !== 1 || !validControlPlaneHoldIdentity(candidate)) return false;
  const record = value as Partial<PersistedControlPlaneHold> & ControlPlaneHoldIdentity;
  return validExecutionHold(record.hold, record)
    && (record.state === "ACTIVE" || record.state === "CLEARED")
    && validSafeTimestamp(record.updatedAt);
}

function holdCoordinatorKey(identity: ControlPlaneHoldIdentity): string {
  return `${CONTROL_PLANE_HOLD_COORDINATOR_PREFIX}:${identity.repository}:${identity.prNumber}:${identity.headSha.toLowerCase()}:${identity.baseSha.toLowerCase()}`;
}

const SAFE_LIFECYCLE_ID = /^[A-Za-z0-9_.:/-]{1,256}$/;

function validPersistentExecutionStop(value: unknown): value is PersistentExecutionStop {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistentExecutionStop>;
  return candidate.schemaVersion === 1
    && typeof candidate.taskId === "string" && SAFE_LIFECYCLE_ID.test(candidate.taskId)
    && typeof candidate.executionId === "string" && SAFE_LIFECYCLE_ID.test(candidate.executionId)
    && typeof candidate.provider === "string" && SAFE_LIFECYCLE_ID.test(candidate.provider)
    && typeof candidate.headSha === "string" && SHA40.test(candidate.headSha)
    && typeof candidate.stopReason === "string" && SAFE_LIFECYCLE_ID.test(candidate.stopReason)
    && validSafeTimestamp(candidate.stoppedAt)
    && Number.isSafeInteger(candidate.attemptCount) && Number(candidate.attemptCount) >= 1 && Number(candidate.attemptCount) <= 100
    && typeof candidate.lastFailure === "string" && SAFE_LIFECYCLE_ID.test(candidate.lastFailure)
    && validSafeTimestamp(candidate.nextRetryAt)
    && candidate.nextRetryAt >= candidate.stoppedAt
    && typeof candidate.resumeCondition === "string" && SAFE_LIFECYCLE_ID.test(candidate.resumeCondition)
    && typeof candidate.dedupeKey === "string" && SAFE_LIFECYCLE_ID.test(candidate.dedupeKey)
    && (candidate.evidenceRef === null || (typeof candidate.evidenceRef === "string" && SAFE_LIFECYCLE_ID.test(candidate.evidenceRef)));
}

function validAcquire(value: unknown): value is PersistentExecutionAcquireRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistentExecutionAcquireRequest>;
  return validText(candidate.dedupeKey)
    && validText(candidate.executionId)
    && validSafeTimestamp(candidate.now)
    && validSafeTimestamp(candidate.leaseExpiresAt)
    && Number(candidate.leaseExpiresAt) > Number(candidate.now)
    && (candidate.taskId === undefined || (typeof candidate.taskId === "string" && SAFE_LIFECYCLE_ID.test(candidate.taskId)))
    && (candidate.provider === undefined || (typeof candidate.provider === "string" && SAFE_LIFECYCLE_ID.test(candidate.provider)))
    && (candidate.headSha === undefined || (typeof candidate.headSha === "string" && SHA40.test(candidate.headSha)))
    && (candidate.maxAcquisitions === undefined || (Number.isSafeInteger(candidate.maxAcquisitions) && Number(candidate.maxAcquisitions) >= 1 && Number(candidate.maxAcquisitions) <= 10));
}

function validScheduledReceipt(value: unknown): value is ScheduledRuntimeReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScheduledRuntimeReceipt>;
  return validSafeTimestamp(candidate.scheduledTime)
    && validSafeTimestamp(candidate.observedAt)
    && candidate.observedAt >= candidate.scheduledTime
    && validText(candidate.status)
    && validText(candidate.reason)
    && (candidate.headSha === null || (typeof candidate.headSha === "string" && /^[0-9a-f]{40}$/i.test(candidate.headSha)))
    && (candidate.workflowRunId === null || (Number.isSafeInteger(candidate.workflowRunId) && Number(candidate.workflowRunId) > 0))
    && candidate.liveAuthority === "NONE"
    && candidate.productionMutationAllowed === false
    && candidate.aiAuthority === "ZERO_AUTHORITY";
}

function sameScheduledReceipt(left: ScheduledRuntimeReceipt, right: ScheduledRuntimeReceipt): boolean {
  return left.scheduledTime === right.scheduledTime
    && left.observedAt === right.observedAt
    && left.status === right.status
    && left.reason === right.reason
    && left.headSha === right.headSha
    && left.workflowRunId === right.workflowRunId;
}

function validScheduledReceiptHistory(value: unknown): value is ScheduledRuntimeReceiptHistory {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScheduledRuntimeReceiptHistory>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.receipts) || candidate.receipts.length > MAX_SCHEDULED_RECEIPTS) return false;
  const scheduledTimes = new Set<number>();
  for (const receipt of candidate.receipts) {
    if (!validScheduledReceipt(receipt) || scheduledTimes.has(receipt.scheduledTime)) return false;
    scheduledTimes.add(receipt.scheduledTime);
  }
  return true;
}

function sortScheduledReceipts(receipts: readonly ScheduledRuntimeReceipt[]): readonly ScheduledRuntimeReceipt[] {
  return Object.freeze([...receipts].sort((left, right) => left.scheduledTime - right.scheduledTime || left.observedAt - right.observedAt));
}

function summarizeScheduledReceipts(receipts: readonly ScheduledRuntimeReceipt[]): ScheduledRuntimeEvidenceSummary {
  const sorted = sortScheduledReceipts(receipts);
  const statusCounts: Record<string, number> = {};
  for (const receipt of sorted) statusCounts[receipt.status] = (statusCounts[receipt.status] ?? 0) + 1;
  const windowStart = sorted[0]?.scheduledTime ?? null;
  const windowEnd = sorted.at(-1)?.scheduledTime ?? null;
  return Object.freeze({
    receiptCount: sorted.length,
    windowStart,
    windowEnd,
    windowSpanMs: windowStart === null || windowEnd === null ? 0 : windowEnd - windowStart,
    statusCounts: Object.freeze(statusCounts),
  });
}

function validScheduledRuntimeSummary(value: unknown): value is ScheduledRuntimeEvidenceSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScheduledRuntimeEvidenceSummary>;
  if (!Number.isSafeInteger(candidate.receiptCount) || Number(candidate.receiptCount) < 0) return false;
  if (candidate.windowStart !== null && !validSafeTimestamp(candidate.windowStart)) return false;
  if (candidate.windowEnd !== null && !validSafeTimestamp(candidate.windowEnd)) return false;
  if (!Number.isSafeInteger(candidate.windowSpanMs) || Number(candidate.windowSpanMs) < 0) return false;
  if (!candidate.statusCounts || typeof candidate.statusCounts !== "object" || Array.isArray(candidate.statusCounts)) return false;
  return Object.values(candidate.statusCounts).every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}

export class ExecutionCoordinator {
  private executionMutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: DurableObjectStateLike) {}

  private async mutateExecutionAtomically<T>(operation: (storage: DurableObjectStorageLike) => Promise<T>): Promise<T> {
    const transactional = this.ctx.storage as DurableObjectStorageLike & Partial<TransactionalDurableObjectStorageLike>;
    if (typeof transactional.transaction === "function") return transactional.transaction(operation);

    let releaseQueue: (() => void) | undefined;
    const previous = this.executionMutationQueue;
    this.executionMutationQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await previous;
    try {
      return await operation(this.ctx.storage);
    } finally {
      releaseQueue?.();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/scheduled-receipt") return this.readScheduledReceiptLegacy();
    if (request.method === "GET" && url.pathname === "/scheduled-receipt-history") return this.readScheduledReceipt();
    if (request.method === "GET" && url.pathname === "/evolve-learning-memory") return this.readEvolutionLearningMemory();
    if (request.method === "GET" && url.pathname === "/coding-evidence-history") return this.readCodingExecutionEvidence();
    if (request.method === "GET" && url.pathname === "/execution-telemetry") return this.readExecutionTelemetry();
    if (request.method === "GET" && url.pathname === "/execution") return this.readExecution();
    if (request.method === "GET" && url.pathname === "/control-plane-hold") return this.readControlPlaneHold();
    if (request.method === "GET" && url.pathname === "/active-wip") return this.readActiveWip();
    if (request.method === "GET" && url.pathname === "/active-wip/completions") return this.readActiveWipCompletions();
    if (request.method === "GET" && url.pathname === "/provider-capacity-wait") return this.readProviderCapacityWait();
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    if (url.pathname === "/acquire") return this.acquire(await request.json());
    if (url.pathname === "/causal-dispatch/register") return this.registerCausalDispatch(await request.json());
    if (url.pathname === "/causal-dispatch/claim") return this.claimCausalDispatch(await request.json());
    if (url.pathname === "/causal-dispatch/verify") return this.verifyCausalDispatch(await request.json());
    if (url.pathname === "/handoff-or-acquire") return this.handoffOrAcquire(await request.json());
    if (url.pathname === "/dispatched") return this.markDispatched(await request.json());
    if (url.pathname === "/audit-dispatch-recovery") return this.recoverAuditDispatch(await request.json());
    if (url.pathname === "/release") return this.release(await request.json());
    if (url.pathname === "/complete") return this.complete(await request.json());
    if (url.pathname === "/active-wip/admit") return this.admitActiveWip(await request.json());
    if (url.pathname === "/active-wip/complete") return this.completeActiveWip(await request.json());
    if (url.pathname === "/active-wip/release") return this.releaseActiveWip(await request.json());
    if (url.pathname === "/scheduled-receipt") return this.writeScheduledReceipt(await request.json());
    if (url.pathname === "/evolve-learning-memory") return this.writeEvolutionLearningMemory(await request.json());
    if (url.pathname === "/coding-evidence") return this.writeCodingExecutionEvidence(await request.json());
    if (url.pathname === "/execution-telemetry") return this.writeExecutionTelemetry(await request.json());
    if (url.pathname === "/control-plane-hold/apply") return this.applyControlPlaneHold(await request.json());
    if (url.pathname === "/control-plane-hold/clear") return this.clearControlPlaneHold(await request.json());
    if (url.pathname === "/rate-limit-stop") return this.stopForRateLimit(await request.json());
    if (url.pathname === "/provider-capacity-wait") return this.recordProviderCapacityWait(await request.json());
    if (url.pathname === "/paid-overflow-reserve") return this.reservePaidOverflowCall(await request.json());
    return json({ error: "NOT_FOUND" }, 404);
  }

  private async acquire(value: unknown): Promise<Response> {
    if (!validAcquire(value)) return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    const request = value;
    return this.mutateExecutionAtomically(async (storage) => {
      const current = await storage.get<ExecutionRecord>("execution");

      if (current?.dedupeKey === request.dedupeKey) {
        if (current.state === "DISPATCHED") return json({ acquired: false, reason: "ALREADY_DISPATCHED", record: current }, 409);
        if (current.state === "COMPLETED") return json({ acquired: false, reason: "ALREADY_COMPLETED", record: current }, 409);
        if (current.state === "BLOCKED") return json({ acquired: false, reason: "EXECUTION_BLOCKED", record: current }, 409);
        if (current.state === "WAITING_RATE_LIMIT") {
          if (!current.stop || !validPersistentExecutionStop(current.stop)) return json({ error: "EXECUTION_STOP_STATE_CORRUPT" }, 500);
          if (current.executionId !== request.executionId) return json({ acquired: false, reason: "EXECUTION_ID_CONFLICT", record: current }, 409);
          if (request.now < current.stop.nextRetryAt) return json({ acquired: false, reason: "WAITING_RATE_LIMIT", nextRetryAt: current.stop.nextRetryAt, record: current }, 409);
        }
        if (current.state === "LEASED" && current.leaseExpiresAt > request.now) return json({ acquired: false, reason: "LEASE_ACTIVE", record: current }, 409);
        // A rate-limit resume is not a new attempt. A record written before counting existed was acquired once.
        if (request.maxAcquisitions !== undefined && current.state !== "WAITING_RATE_LIMIT" && (current.acquisitionCount ?? 1) >= request.maxAcquisitions) {
          return json({ acquired: false, reason: "ATTEMPT_LIMIT_REACHED", record: current }, 409);
        }
      }
      const sameIdentity = current?.dedupeKey === request.dedupeKey;

      const record: ExecutionRecord = Object.freeze({
        dedupeKey: request.dedupeKey,
        executionId: request.executionId,
        state: "LEASED",
        leaseExpiresAt: request.leaseExpiresAt,
        updatedAt: request.now,
        ...(request.taskId ? { taskId: request.taskId } : current?.taskId ? { taskId: current.taskId } : {}),
        ...(request.provider ? { provider: request.provider } : current?.provider ? { provider: current.provider } : {}),
        ...(request.headSha ? { headSha: request.headSha } : current?.headSha ? { headSha: current.headSha } : {}),
        ...(current?.stop ? { stop: current.stop, resumeCount: (current.resumeCount ?? 0) + (current.state === "WAITING_RATE_LIMIT" ? 1 : 0) } : {}),
        ...(current?.auditDispatchRecoveryCount !== undefined ? { auditDispatchRecoveryCount: current.auditDispatchRecoveryCount } : {}),
        acquisitionCount: sameIdentity && current ? (current.acquisitionCount ?? 1) + (current.state === "WAITING_RATE_LIMIT" ? 0 : 1) : 1,
      });
      await storage.put("execution", record);
      return json({ acquired: true, record }, 201);
    });
  }

  private async readExecution(): Promise<Response> {
    const record = await this.ctx.storage.get<ExecutionRecord>("execution");
    return json({ record: record ?? null });
  }

  private async registerCausalDispatch(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "CAUSAL_DISPATCH_REQUEST_INVALID" }, 400);
    const request = value as CausalDispatchRegistration;
    if (!validText(request.dedupeKey) || !validText(request.executionId)) return json({ error: "CAUSAL_DISPATCH_REQUEST_INVALID" }, 400);
    const pending = createCausalDispatchBinding(request.source, request.capabilityDigest, request.now, request.expiresAt);
    if (!pending) return json({ error: "CAUSAL_DISPATCH_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const execution = await storage.get<ExecutionRecord>("execution");
      if (!execution || execution.dedupeKey !== request.dedupeKey || execution.executionId !== request.executionId
        || execution.state !== "LEASED" || execution.headSha !== pending.source.sha
        || execution.leaseExpiresAt <= request.now || pending.expiresAt > execution.leaseExpiresAt) {
        return json({ registered: false, reason: "CAUSAL_DISPATCH_EXECUTION_MISMATCH" }, 409);
      }
      const generation = execution.acquisitionCount ?? 1;
      if (!Number.isSafeInteger(generation) || generation < 1 || generation > 3) return json({ registered: false, reason: "CAUSAL_DISPATCH_GENERATION_INVALID" }, 409);
      const stored = await storage.get<unknown>("causal-dispatch-bindings");
      const history = stored === undefined ? { schemaVersion: 1 as const, entries: [] } : readCausalDispatchHistory(stored);
      if (!history) return json({ registered: false, reason: "CAUSAL_DISPATCH_STATE_INVALID" }, 409);
      if (history.entries.some((entry) => entry.generation >= generation || entry.binding.publisher !== null)) {
        return json({ registered: false, reason: "CAUSAL_DISPATCH_ALREADY_REGISTERED" }, 409);
      }
      await storage.put("causal-dispatch-bindings", { schemaVersion: 1, entries: [...history.entries, { generation, binding: pending }] });
      return json({ registered: true }, 201);
    });
  }

  private async claimCausalDispatch(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "CAUSAL_DISPATCH_REQUEST_INVALID" }, 400);
    const request = value as CausalDispatchClaim;
    if (!validText(request.dedupeKey) || !validText(request.executionId)) return json({ error: "CAUSAL_DISPATCH_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const execution = await storage.get<ExecutionRecord>("execution");
      const history = readCausalDispatchHistory(await storage.get<unknown>("causal-dispatch-bindings"));
      const generation = execution?.acquisitionCount ?? 1;
      const binding = history?.entries.find((entry) => entry.generation === generation)?.binding;
      if (!execution || !binding || execution.dedupeKey !== request.dedupeKey || execution.executionId !== request.executionId
        || (execution.state !== "LEASED" && execution.state !== "HANDED_OFF") || execution.headSha !== binding.source?.sha
        || !validSafeTimestamp(request.now) || execution.leaseExpiresAt <= request.now) {
        return json({ claimed: false, reason: "CAUSAL_DISPATCH_EXECUTION_MISMATCH" }, 409);
      }
      const claimed = claimCausalDispatchBinding(binding, request.publisher, request.source, request.capabilityDigest, request.now);
      if (!claimed) return json({ claimed: false, reason: "CAUSAL_DISPATCH_BINDING_REJECTED" }, 409);
      await storage.put("causal-dispatch-bindings", { schemaVersion: 1, entries: history!.entries.map((entry) => entry.generation === generation ? { generation, binding: claimed } : entry) });
      return json({ claimed: true }, 201);
    });
  }

  private async verifyCausalDispatch(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "CAUSAL_DISPATCH_REQUEST_INVALID" }, 400);
    const request = value as CausalDispatchClaim;
    if (!validText(request.dedupeKey) || !validText(request.executionId)) return json({ error: "CAUSAL_DISPATCH_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const execution = await storage.get<ExecutionRecord>("execution");
      const history = readCausalDispatchHistory(await storage.get<unknown>("causal-dispatch-bindings"));
      const generation = execution?.acquisitionCount ?? 1;
      const binding = history?.entries.find((entry) => entry.generation === generation)?.binding;
      if (!execution || !binding || execution.dedupeKey !== request.dedupeKey || execution.executionId !== request.executionId
        || (execution.state !== "LEASED" && execution.state !== "HANDED_OFF") || execution.headSha !== binding.source?.sha
        || !validSafeTimestamp(request.now) || execution.leaseExpiresAt <= request.now
        || !verifyClaimedCausalDispatchBinding(binding, request.publisher, request.source, request.capabilityDigest, request.now)) {
        return json({ verified: false, reason: "CAUSAL_DISPATCH_BINDING_REJECTED" }, 409);
      }
      return json({ verified: true }, 200);
    });
  }

  private async markDispatched(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    const request = value as { dedupeKey?: unknown; executionId?: unknown; now?: unknown };
    if (!validText(request.dedupeKey) || !validText(request.executionId) || !validSafeTimestamp(request.now)) return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    const current = await this.ctx.storage.get<ExecutionRecord>("execution");
    if (!current || current.dedupeKey !== request.dedupeKey || current.executionId !== request.executionId) return json({ error: "EXECUTION_LEASE_MISMATCH" }, 409);
    if (current.state !== "LEASED" && current.state !== "HANDED_OFF") return json({ error: "EXECUTION_LEASE_NOT_ACTIVE" }, 409);
    const record: ExecutionRecord = Object.freeze({ ...current, state: "DISPATCHED", updatedAt: Number(request.now) });
    await this.ctx.storage.put("execution", record);
    return json({ updated: true, record });
  }

  private async recoverAuditDispatch(value: unknown): Promise<Response> {
    if (!validAcquire(value)) return json({ error: "AUDIT_DISPATCH_RECOVERY_REQUEST_INVALID" }, 400);
    const request = value;
    return this.mutateExecutionAtomically(async (storage) => {
      const current = await storage.get<ExecutionRecord>("execution");
      if (!current || current.dedupeKey !== request.dedupeKey || current.executionId !== request.executionId) return json({ recovered: false, reason: "EXECUTION_LEASE_MISMATCH" }, 409);
      if (current.state !== "DISPATCHED") return json({ recovered: false, reason: "EXECUTION_NOT_DISPATCHED" }, 409);
      if ((current.auditDispatchRecoveryCount ?? 0) !== 0) return json({ recovered: false, reason: "AUDIT_DISPATCH_RECOVERY_EXHAUSTED" }, 409);
      if (request.now < current.updatedAt + AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS) return json({ recovered: false, reason: "AUDIT_DISPATCH_MATERIALIZATION_PENDING" }, 409);
      const record: ExecutionRecord = Object.freeze({
        ...current,
        state: "LEASED",
        leaseExpiresAt: request.leaseExpiresAt,
        updatedAt: request.now,
        auditDispatchRecoveryCount: 1,
      });
      await storage.put("execution", record);
      return json({ recovered: true, record }, 201);
    });
  }

  private async release(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    const request = value as { dedupeKey?: unknown; executionId?: unknown; now?: unknown };
    if (!validText(request.dedupeKey) || !validText(request.executionId) || !validSafeTimestamp(request.now)) return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    const current = await this.ctx.storage.get<ExecutionRecord>("execution");
    if (!current || current.dedupeKey !== request.dedupeKey || current.executionId !== request.executionId) return json({ error: "EXECUTION_LEASE_MISMATCH" }, 409);
    if (current.state !== "LEASED" && current.state !== "HANDED_OFF") return json({ error: "EXECUTION_LEASE_NOT_ACTIVE" }, 409);
    const record: ExecutionRecord = Object.freeze({ ...current, state: "RELEASED", leaseExpiresAt: Number(request.now), updatedAt: Number(request.now) });
    await this.ctx.storage.put("execution", record);
    return json({ released: true, record });
  }

  /**
   * Lets the authenticated consumer take over one lease created by the
   * repository-dispatch producer.  The state change is atomic, so a replayed
   * consumer cannot run the same coding request twice.  Direct callers still
   * acquire a lease when no producer record exists.
   */
  private async handoffOrAcquire(value: unknown): Promise<Response> {
    if (!validAcquire(value)) return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    const request = value;
    return this.mutateExecutionAtomically(async (storage) => {
      const current = await storage.get<ExecutionRecord>("execution");
      if (current?.dedupeKey === request.dedupeKey) {
        if (current.state === "DISPATCHED") return json({ acquired: false, reason: "ALREADY_DISPATCHED", record: current }, 409);
        if (current.state === "COMPLETED") return json({ acquired: false, reason: "ALREADY_COMPLETED", record: current }, 409);
        if (current.state === "BLOCKED") return json({ acquired: false, reason: "EXECUTION_BLOCKED", record: current }, 409);
        if (current.state === "WAITING_RATE_LIMIT") {
          if (!current.stop || !validPersistentExecutionStop(current.stop)) return json({ error: "EXECUTION_STOP_STATE_CORRUPT" }, 500);
          if (current.executionId !== request.executionId) return json({ acquired: false, reason: "EXECUTION_ID_CONFLICT", record: current }, 409);
          if (request.now < current.stop.nextRetryAt) return json({ acquired: false, reason: "WAITING_RATE_LIMIT", nextRetryAt: current.stop.nextRetryAt, record: current }, 409);
        }
        if (current.executionId === request.executionId && current.state === "LEASED" && current.leaseExpiresAt > request.now) {
          const record: ExecutionRecord = Object.freeze({ ...current, state: "HANDED_OFF", updatedAt: request.now });
          await storage.put("execution", record);
          return json({ acquired: true, handoff: true, record }, 201);
        }
        if ((current.state === "LEASED" || current.state === "HANDED_OFF") && current.leaseExpiresAt > request.now) {
          return json({ acquired: false, reason: "LEASE_ACTIVE", record: current }, 409);
        }
      }
      const record: ExecutionRecord = Object.freeze({
        dedupeKey: request.dedupeKey,
        executionId: request.executionId,
        state: "LEASED",
        leaseExpiresAt: request.leaseExpiresAt,
        updatedAt: request.now,
        ...(request.taskId ? { taskId: request.taskId } : current?.taskId ? { taskId: current.taskId } : {}),
        ...(request.provider ? { provider: request.provider } : current?.provider ? { provider: current.provider } : {}),
        ...(request.headSha ? { headSha: request.headSha } : current?.headSha ? { headSha: current.headSha } : {}),
        ...(current?.stop ? { stop: current.stop, resumeCount: (current.resumeCount ?? 0) + (current.state === "WAITING_RATE_LIMIT" ? 1 : 0) } : {}),
        ...(current?.auditDispatchRecoveryCount !== undefined ? { auditDispatchRecoveryCount: current.auditDispatchRecoveryCount } : {}),
        ...(current?.dedupeKey === request.dedupeKey && current.acquisitionCount !== undefined ? { acquisitionCount: current.acquisitionCount } : {}),
      });
      await storage.put("execution", record);
      return json({ acquired: true, handoff: false, record }, 201);
    });
  }

  private async complete(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    const request = value as { dedupeKey?: unknown; executionId?: unknown; now?: unknown };
    if (!validText(request.dedupeKey) || !validText(request.executionId) || !validSafeTimestamp(request.now)) return json({ error: "EXECUTION_COORDINATION_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const current = await storage.get<ExecutionRecord>("execution");
      if (!current || current.dedupeKey !== request.dedupeKey || current.executionId !== request.executionId) return json({ error: "EXECUTION_LEASE_MISMATCH" }, 409);
      if (current.state === "COMPLETED") return json({ completed: false, record: current });
      if (current.state !== "DISPATCHED") return json({ error: "EXECUTION_NOT_DISPATCHED" }, 409);
      const record: ExecutionRecord = Object.freeze({ ...current, state: "COMPLETED", leaseExpiresAt: Number(request.now), updatedAt: Number(request.now) });
      await storage.put("execution", record);
      return json({ completed: true, record });
    });
  }

  private async stopForRateLimit(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "EXECUTION_STOP_REQUEST_INVALID" }, 400);
    const request = value as Partial<PersistentExecutionStopRequest>;
    const nowValue = (value as { now?: unknown }).now;
    const stoppedAtValue = (value as { stoppedAt?: unknown }).stoppedAt;
    if (!validSafeTimestamp(nowValue) || !validPersistentExecutionStop(request) || !validSafeTimestamp(stoppedAtValue) || Number(nowValue) < Number(stoppedAtValue) || request.nextRetryAt === undefined || Number(request.nextRetryAt) <= Number(nowValue)) {
      return json({ error: "EXECUTION_STOP_REQUEST_INVALID" }, 400);
    }
    const stopRequest = request as PersistentExecutionStopRequest;
    if (stopRequest.dedupeKey !== stopRequest.dedupeKey.trim() || stopRequest.executionId !== stopRequest.executionId.trim()) return json({ error: "EXECUTION_STOP_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const current = await storage.get<ExecutionRecord>("execution");
      if (!current || current.dedupeKey !== stopRequest.dedupeKey || current.executionId !== stopRequest.executionId) return json({ error: "EXECUTION_LEASE_MISMATCH" }, 409);
      if (current.state !== "LEASED" && current.state !== "HANDED_OFF") return json({ error: "EXECUTION_STOP_NOT_ACTIVE" }, 409);
      const { now: _now, ...rawStop } = stopRequest;
      const stop = Object.freeze({ ...rawStop, schemaVersion: 1 }) as PersistentExecutionStop;
      const record: ExecutionRecord = Object.freeze({
        ...current,
        state: "WAITING_RATE_LIMIT",
        leaseExpiresAt: stop.nextRetryAt,
        updatedAt: stopRequest.now,
        taskId: stop.taskId,
        provider: stop.provider,
        headSha: stop.headSha,
        stop,
      });
      await storage.put("execution", record);
      return json({ stopped: true, state: record.state, nextRetryAt: stop.nextRetryAt, record });
    });
  }

  private async readProviderCapacityWait(): Promise<Response> {
    const wait = await this.ctx.storage.get<PersistentExecutionStop>("provider-capacity-wait");
    if (wait !== undefined && !validPersistentExecutionStop(wait)) return json({ error: "PROVIDER_CAPACITY_WAIT_CORRUPT" }, 500);
    return json({ wait: wait ?? null });
  }

  private async recordProviderCapacityWait(value: unknown): Promise<Response> {
    if (!validPersistentExecutionStop(value)) return json({ error: "PROVIDER_CAPACITY_WAIT_INVALID" }, 400);
    const incoming = Object.freeze({ ...value, schemaVersion: 1 }) as PersistentExecutionStop;
    return this.mutateExecutionAtomically(async (storage) => {
      const current = await storage.get<PersistentExecutionStop>("provider-capacity-wait");
      // Monotonic: a late or replayed stop can never shorten a provider wait that is already longer.
      const kept = current && validPersistentExecutionStop(current) && current.nextRetryAt >= incoming.nextRetryAt ? current : incoming;
      if (kept === incoming) await storage.put("provider-capacity-wait", incoming);
      return json({ recorded: true, wait: kept });
    });
  }

  /**
   * Atomic per-UTC-day reservation of one paid overflow call. The owner-imposed cap is enforced
   * here rather than by the caller because two concurrent executions would otherwise both read the
   * same count and both spend. A reservation is only consumed when it is granted, so a refusal
   * never burns budget. The counter is keyed by day, so it resets with the provider's own daily
   * boundary and needs no cleanup.
   */
  private async reservePaidOverflowCall(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "PAID_OVERFLOW_RESERVE_INVALID" }, 400);
    const request = value as { day?: unknown; cap?: unknown };
    const day = request.day;
    const cap = request.cap;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "PAID_OVERFLOW_RESERVE_INVALID" }, 400);
    if (!Number.isSafeInteger(cap) || (cap as number) < 0) return json({ error: "PAID_OVERFLOW_RESERVE_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const stored = await storage.get<{ schemaVersion: 1; day: string; used: number }>("paid-overflow-usage");
      const sameDay = stored !== undefined
        && stored.schemaVersion === 1
        && stored.day === day
        && Number.isSafeInteger(stored.used)
        && stored.used >= 0;
      const used = sameDay ? stored.used : 0;
      if (used >= (cap as number)) return json({ allowed: false, day, used, cap });
      const next = Object.freeze({ schemaVersion: 1 as const, day, used: used + 1 });
      await storage.put("paid-overflow-usage", next);
      return json({ allowed: true, day, used: next.used, cap });
    });
  }

  private async admitActiveWip(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "ACTIVE_WIP_REQUEST_INVALID" }, 400);
    const request = value as Partial<ActiveWipAdmissionRequest>;
    const ownerOk = typeof request.canonicalOwner === "string" && /^[A-Za-z0-9_.:/-]{1,120}$/.test(request.canonicalOwner);
    const keysOk = Array.isArray(request.conflictKeys) && request.conflictKeys.length > 0 && request.conflictKeys.length <= 32
      && request.conflictKeys.every((key) => typeof key === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(key))
      && new Set(request.conflictKeys).size === request.conflictKeys.length;
    if (!validText(request.dedupeKey) || !validText(request.executionId) || !ownerOk || !keysOk || !validSafeTimestamp(request.claimedAt)
      || !Number.isSafeInteger(request.maxConcurrent) || Number(request.maxConcurrent) < 1 || Number(request.maxConcurrent) > MAX_ACTIVE_WIP) return json({ error: "ACTIVE_WIP_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const stored = await storage.get<ActiveWipState>(ACTIVE_WIP_STORAGE_KEY) ?? { schemaVersion: 1 as const, claims: [] };
      if (stored.schemaVersion !== 1 || !Array.isArray(stored.claims) || stored.claims.length > MAX_ACTIVE_WIP) return json({ error: "ACTIVE_WIP_STATE_CORRUPT" }, 500);
      const expiredClaims = stored.claims.filter((claim) => claim.claimedAt + ACTIVE_WIP_CLAIM_MAX_AGE_MS <= Number(request.claimedAt));
      const state: ActiveWipState = expiredClaims.length === 0
        ? stored
        : Object.freeze({ schemaVersion: 1, claims: Object.freeze(stored.claims.filter((claim) => !expiredClaims.includes(claim))) });
      if (expiredClaims.length > 0) await storage.put(ACTIVE_WIP_STORAGE_KEY, state);
      const same = state.claims.find((claim) => claim.dedupeKey === request.dedupeKey);
      if (same) return json({ admitted: false, reason: same.executionId === request.executionId ? "ALREADY_ACTIVE" : "DEDUPE_CONFLICT", claims: state.claims }, 409);
      const sameExecution = state.claims.find((claim) => claim.executionId === request.executionId);
      if (sameExecution) return json({ admitted: false, reason: "EXECUTION_ID_CONFLICT", claims: state.claims }, 409);
      if (state.claims.length >= Number(request.maxConcurrent)) return json({ admitted: false, reason: "WIP_LIMIT_REACHED", claims: state.claims }, 409);
      const occupied = new Set(state.claims.flatMap((claim) => [...claim.conflictKeys]));
      if (request.conflictKeys!.some((key) => occupied.has(key))) return json({ admitted: false, reason: "CONFLICT_KEY_ACTIVE", claims: state.claims }, 409);
      const claim: ActiveWipClaim = Object.freeze({ dedupeKey: request.dedupeKey!, executionId: request.executionId!, canonicalOwner: request.canonicalOwner!, conflictKeys: Object.freeze([...request.conflictKeys!]), claimedAt: Number(request.claimedAt) });
      const next: ActiveWipState = Object.freeze({ schemaVersion: 1, claims: Object.freeze([...state.claims, claim]) });
      await storage.put(ACTIVE_WIP_STORAGE_KEY, next);
      return json({ admitted: true, claim, claims: next.claims, expiredClaims }, 201);
    });
  }

  private async completeActiveWip(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "ACTIVE_WIP_REQUEST_INVALID" }, 400);
    const request = value as Partial<ActiveWipCompletionRequest>;
    if (!validText(request.dedupeKey) || !validText(request.executionId) || !validText(request.workerId)
      || !validSafeTimestamp(request.startedAt) || !validSafeTimestamp(request.completedAt)
      || Number(request.completedAt) < Number(request.startedAt)) return json({ error: "ACTIVE_WIP_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const state = await storage.get<ActiveWipState>(ACTIVE_WIP_STORAGE_KEY) ?? { schemaVersion: 1 as const, claims: [] };
      if (state.schemaVersion !== 1 || !Array.isArray(state.claims) || state.claims.length > MAX_ACTIVE_WIP) return json({ error: "ACTIVE_WIP_STATE_CORRUPT" }, 500);
      const claim = state.claims.find((candidate) => candidate.dedupeKey === request.dedupeKey);
      if (!claim || claim.executionId !== request.executionId) return json({ error: "ACTIVE_WIP_IDENTITY_MISMATCH" }, 409);
      if (Number(request.startedAt) < claim.claimedAt) return json({ error: "ACTIVE_WIP_TIMING_INVALID" }, 409);
      const evidence: ActiveWipCompletionEvidence = Object.freeze({
        dedupeKey: claim.dedupeKey, executionId: claim.executionId, canonicalOwner: claim.canonicalOwner,
        conflictKeys: Object.freeze([...claim.conflictKeys]), workerId: request.workerId!.trim(),
        queuedAt: claim.claimedAt, claimedAt: claim.claimedAt, startedAt: Number(request.startedAt), completedAt: Number(request.completedAt),
        queueWaitMs: 0, claimToStartMs: Number(request.startedAt) - claim.claimedAt,
        claimToCompleteMs: Number(request.completedAt) - claim.claimedAt, totalMs: Number(request.completedAt) - claim.claimedAt,
      });
      const history = await storage.get<ActiveWipCompletionHistory>(ACTIVE_WIP_COMPLETION_HISTORY_KEY) ?? { schemaVersion: 1 as const, completions: [] };
      if (history.schemaVersion !== 1 || !Array.isArray(history.completions) || history.completions.length > MAX_ACTIVE_WIP_COMPLETIONS) return json({ error: "ACTIVE_WIP_COMPLETION_STATE_CORRUPT" }, 500);
      if (history.completions.some((candidate) => candidate.dedupeKey === claim.dedupeKey)) return json({ error: "ACTIVE_WIP_COMPLETION_DUPLICATE" }, 409);
      const completions = Object.freeze([...history.completions, evidence].slice(-MAX_ACTIVE_WIP_COMPLETIONS));
      const claims = Object.freeze(state.claims.filter((candidate) => candidate.dedupeKey !== request.dedupeKey));
      await storage.put(ACTIVE_WIP_COMPLETION_HISTORY_KEY, Object.freeze({ schemaVersion: 1, completions }));
      await storage.put(ACTIVE_WIP_STORAGE_KEY, Object.freeze({ schemaVersion: 1, claims }));
      return json({ completed: true, evidence, claims });
    });
  }

  /**
   * Frees a claim once its execution ended without the completion path (the GitHub Actions coding
   * backend never reached completeActiveWip, so every claim waited for ACTIVE_WIP_CLAIM_MAX_AGE_MS).
   * Records no completion evidence. Idempotent: an absent claim is reported, not an error; a claim
   * held by another execution is never released.
   */
  private async releaseActiveWip(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "ACTIVE_WIP_REQUEST_INVALID" }, 400);
    const request = value as { dedupeKey?: unknown; executionId?: unknown };
    if (!validText(request.dedupeKey) || !validText(request.executionId)) return json({ error: "ACTIVE_WIP_REQUEST_INVALID" }, 400);
    return this.mutateExecutionAtomically(async (storage) => {
      const state = await storage.get<ActiveWipState>(ACTIVE_WIP_STORAGE_KEY) ?? { schemaVersion: 1 as const, claims: [] };
      if (state.schemaVersion !== 1 || !Array.isArray(state.claims) || state.claims.length > MAX_ACTIVE_WIP) return json({ error: "ACTIVE_WIP_STATE_CORRUPT" }, 500);
      const claim = state.claims.find((candidate) => candidate.dedupeKey === request.dedupeKey);
      if (!claim) return json({ released: false, reason: "CLAIM_NOT_FOUND", claims: state.claims });
      if (claim.executionId !== request.executionId) return json({ released: false, reason: "ACTIVE_WIP_IDENTITY_MISMATCH", claims: state.claims }, 409);
      const claims = Object.freeze(state.claims.filter((candidate) => candidate.dedupeKey !== request.dedupeKey));
      await storage.put(ACTIVE_WIP_STORAGE_KEY, Object.freeze({ schemaVersion: 1, claims }));
      return json({ released: true, claims });
    });
  }

  private async readActiveWipCompletions(): Promise<Response> {
    const history = await this.ctx.storage.get<ActiveWipCompletionHistory>(ACTIVE_WIP_COMPLETION_HISTORY_KEY) ?? { schemaVersion: 1 as const, completions: [] };
    if (history.schemaVersion !== 1 || !Array.isArray(history.completions) || history.completions.length > MAX_ACTIVE_WIP_COMPLETIONS) return json({ error: "ACTIVE_WIP_COMPLETION_STATE_CORRUPT" }, 500);
    return json({ completions: history.completions, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });
  }

  private async readActiveWip(): Promise<Response> {
    const state = await this.ctx.storage.get<ActiveWipState>(ACTIVE_WIP_STORAGE_KEY) ?? { schemaVersion: 1 as const, claims: [] };
    if (state.schemaVersion !== 1 || !Array.isArray(state.claims) || state.claims.length > MAX_ACTIVE_WIP) return json({ error: "ACTIVE_WIP_STATE_CORRUPT" }, 500);
    return json({ claims: state.claims, activeExecutions: state.claims.length, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });
  }

  private async writeScheduledReceipt(value: unknown): Promise<Response> {
    if (!validScheduledReceipt(value)) return json({ error: "SCHEDULED_RUNTIME_RECEIPT_INVALID" }, 400);
    const receipt = Object.freeze({ ...value });
    let current: ScheduledRuntimeReceiptHistory = { schemaVersion: 1, receipts: Object.freeze([]) };
    try {
      current = await this.readScheduledReceiptHistory();
    } catch {
      return json({ error: "SCHEDULED_RUNTIME_RECEIPT_CORRUPT" }, 500);
    }
    const existing = current.receipts.find((candidate) => candidate.scheduledTime === receipt.scheduledTime);
    if (existing) {
      if (!sameScheduledReceipt(existing, receipt)) return json({ error: "SCHEDULED_RUNTIME_RECEIPT_IDENTITY_CONFLICT" }, 409);
      return json({ updated: false, receipt: existing });
    }
    const receipts = sortScheduledReceipts([...current.receipts, receipt]).slice(-MAX_SCHEDULED_RECEIPTS);
    const history: ScheduledRuntimeReceiptHistory = Object.freeze({ schemaVersion: 1, receipts: Object.freeze(receipts) });
    await this.ctx.storage.put(SCHEDULED_RECEIPT_HISTORY_KEY, history);
    return json({ updated: true, receipt });
  }

  private async readScheduledReceipt(): Promise<Response> {
    try {
      const history = await this.readScheduledReceiptHistory();
      const receipts = sortScheduledReceipts(history.receipts);
      return json({
        receipt: receipts.at(-1) ?? null,
        history: receipts,
        summary: summarizeScheduledReceipts(receipts),
      });
    } catch {
      return json({ error: "SCHEDULED_RUNTIME_RECEIPT_CORRUPT" }, 500);
    }
  }

  private async readScheduledReceiptLegacy(): Promise<Response> {
    try {
      const history = await this.readScheduledReceiptHistory();
      return json({ receipt: sortScheduledReceipts(history.receipts).at(-1) ?? null });
    } catch {
      return json({ error: "SCHEDULED_RUNTIME_RECEIPT_CORRUPT" }, 500);
    }
  }

  private async readScheduledReceiptHistory(): Promise<ScheduledRuntimeReceiptHistory> {
    const stored = await this.ctx.storage.get<unknown>(SCHEDULED_RECEIPT_HISTORY_KEY);
    if (stored != null) {
      const candidate = stored && typeof stored === "object" ? stored as Partial<ScheduledRuntimeReceiptHistory> : null;
      const hasLegacyNullHead = candidate?.schemaVersion === 1
        && Array.isArray(candidate.receipts)
        && candidate.receipts.some((receipt) => validScheduledReceipt(receipt) && receipt.headSha === null);
      if (validScheduledReceiptHistory(stored) && !hasLegacyNullHead) {
        return Object.freeze({ schemaVersion: 1, receipts: sortScheduledReceipts(stored.receipts) });
      }
      if (candidate?.schemaVersion !== 1 || !Array.isArray(candidate.receipts) || candidate.receipts.length > MAX_SCHEDULED_RECEIPTS) {
        throw new Error("SCHEDULED_RUNTIME_RECEIPT_CORRUPT");
      }
      const receipts: ScheduledRuntimeReceipt[] = [];
      const scheduledTimes = new Set<number>();
      for (const rawReceipt of candidate.receipts) {
        const scheduledTime = rawReceipt && typeof rawReceipt === "object"
          ? (rawReceipt as Partial<ScheduledRuntimeReceipt>).scheduledTime
          : undefined;
        if (!validSafeTimestamp(scheduledTime) || scheduledTimes.has(scheduledTime)) {
          throw new Error("SCHEDULED_RUNTIME_RECEIPT_CORRUPT");
        }
        scheduledTimes.add(scheduledTime);
        if (validScheduledReceipt(rawReceipt)) {
          if (rawReceipt.headSha === null) continue;
          receipts.push(rawReceipt);
          continue;
        }
        const possibleHeadOnlyCorruption = rawReceipt && typeof rawReceipt === "object"
          ? { ...(rawReceipt as Record<string, unknown>), headSha: null }
          : null;
        if (!possibleHeadOnlyCorruption || !validScheduledReceipt(possibleHeadOnlyCorruption)) {
          throw new Error("SCHEDULED_RUNTIME_RECEIPT_CORRUPT");
        }
      }
      const history: ScheduledRuntimeReceiptHistory = Object.freeze({ schemaVersion: 1, receipts: sortScheduledReceipts(receipts) });
      await this.ctx.storage.put(SCHEDULED_RECEIPT_HISTORY_KEY, history);
      return history;
    }
    const legacy = await this.ctx.storage.get<unknown>("scheduled-receipt");
    if (legacy == null) return Object.freeze({ schemaVersion: 1, receipts: Object.freeze([]) });
    if (!validScheduledReceipt(legacy)) {
      const possibleHeadOnlyCorruption = legacy && typeof legacy === "object"
        ? { ...(legacy as Record<string, unknown>), headSha: null }
        : null;
      if (!possibleHeadOnlyCorruption || !validScheduledReceipt(possibleHeadOnlyCorruption)) {
        throw new Error("SCHEDULED_RUNTIME_RECEIPT_CORRUPT");
      }
      const history: ScheduledRuntimeReceiptHistory = Object.freeze({ schemaVersion: 1, receipts: Object.freeze([]) });
      await this.ctx.storage.put(SCHEDULED_RECEIPT_HISTORY_KEY, history);
      return history;
    }
    return Object.freeze({ schemaVersion: 1, receipts: Object.freeze([legacy]) });
  }

  private async writeEvolutionLearningMemory(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || !("value" in value)) return json({ error: "EVOLVE_LEARNING_MEMORY_REQUEST_INVALID" }, 400);
    try {
      validatePersistedEvolutionLearningMemory((value as { value: unknown }).value);
    } catch {
      return json({ error: "EVOLVE_LEARNING_MEMORY_VALUE_INVALID" }, 400);
    }
    await this.ctx.storage.put("value", (value as { value: unknown }).value);
    return json({ updated: true });
  }

  private async readEvolutionLearningMemory(): Promise<Response> {
    const value = await this.ctx.storage.get<unknown>("value");
    if (value == null) return json({ value: null });
    try {
      validatePersistedEvolutionLearningMemory(value);
    } catch {
      return json({ error: "EVOLVE_LEARNING_MEMORY_CORRUPT" }, 500);
    }
    return json({ value });
  }

  private async writeCodingExecutionEvidence(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || !("evidence" in value)) return json({ error: "CODING_EVIDENCE_REQUEST_INVALID" }, 400);
    const evidence = (value as { evidence: unknown }).evidence;
    try {
      validatePersistedCodingExecutionEvidence(evidence);
    } catch {
      return json({ error: "CODING_EVIDENCE_INVALID" }, 400);
    }
    let current: CodingExecutionEvidenceHistory;
    try {
      current = await this.readCodingExecutionEvidenceHistory();
    } catch {
      return json({ error: "CODING_EVIDENCE_CORRUPT" }, 500);
    }
    const existing = current.evidence.find((candidate) =>
      candidate.request.executionId === evidence.request.executionId
      && candidate.request.dedupeKey === evidence.request.dedupeKey);
    if (existing) {
      const equivalentReplay = JSON.stringify(existing.request) === JSON.stringify(evidence.request)
        && JSON.stringify(existing.outcome) === JSON.stringify(evidence.outcome)
        && existing.liveAuthority === evidence.liveAuthority
        && existing.productionMutationAllowed === evidence.productionMutationAllowed
        && existing.aiAuthority === evidence.aiAuthority;
      if (!equivalentReplay) return json({ error: "CODING_EVIDENCE_IDENTITY_CONFLICT" }, 409);
      return json({ updated: false, evidence: existing });
    }
    const next = [...current.evidence, evidence]
      .sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.evidenceId.localeCompare(right.evidenceId))
      .slice(-MAX_CODING_EVIDENCE);
    const history: CodingExecutionEvidenceHistory = Object.freeze({ schemaVersion: 1, evidence: Object.freeze(next) });
    await this.ctx.storage.put(CODING_EVIDENCE_HISTORY_KEY, history);
    return json({ updated: true, evidence });
  }

  private async readCodingExecutionEvidence(): Promise<Response> {
    try {
      const history = await this.readCodingExecutionEvidenceHistory();
      return json({
        evidence: history.evidence.at(-1) ?? null,
        history: history.evidence,
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      });
    } catch {
      return json({ error: "CODING_EVIDENCE_CORRUPT" }, 500);
    }
  }

  private async readCodingExecutionEvidenceHistory(): Promise<CodingExecutionEvidenceHistory> {
    const stored = await this.ctx.storage.get<unknown>(CODING_EVIDENCE_HISTORY_KEY);
    if (stored == null) return Object.freeze({ schemaVersion: 1, evidence: Object.freeze([]) });
    if (!stored || typeof stored !== "object" || (stored as { schemaVersion?: unknown }).schemaVersion !== 1 || !Array.isArray((stored as { evidence?: unknown }).evidence) || (stored as { evidence: unknown[] }).evidence.length > MAX_CODING_EVIDENCE) {
      throw new Error("CODING_EVIDENCE_CORRUPT");
    }
    const evidence = (stored as { evidence: unknown[] }).evidence;
    evidence.forEach(validatePersistedCodingExecutionEvidence);
    const validEvidence = evidence as CodingExecutionEvidence[];
    return Object.freeze({
      schemaVersion: 1,
      evidence: Object.freeze([...validEvidence].sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.evidenceId.localeCompare(right.evidenceId))),
    });
  }

  private async writeExecutionTelemetry(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object" || !("telemetry" in value)) return json({ error: "AUTOPILOT_TELEMETRY_REQUEST_INVALID" }, 400);
    const telemetry = (value as { telemetry: unknown }).telemetry;
    try {
      validateAutopilotExecutionTelemetry(telemetry);
    } catch {
      return json({ error: "AUTOPILOT_TELEMETRY_INVALID" }, 400);
    }
    let current: AutopilotExecutionTelemetryHistory;
    try {
      current = await this.readExecutionTelemetryHistory();
    } catch {
      return json({ error: "AUTOPILOT_TELEMETRY_CORRUPT" }, 500);
    }
    const existing = current.telemetry.find((candidate) => candidate.telemetryId === telemetry.telemetryId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(telemetry)) return json({ error: "AUTOPILOT_TELEMETRY_IDENTITY_CONFLICT" }, 409);
      return json({ updated: false, telemetry: existing });
    }
    const next = [...current.telemetry, telemetry]
      .sort((left, right) => left.timestampMs - right.timestampMs || left.telemetryId.localeCompare(right.telemetryId))
      .slice(-MAX_AUTOPILOT_TELEMETRY);
    const history: AutopilotExecutionTelemetryHistory = Object.freeze({ schemaVersion: 1, telemetry: Object.freeze(next) });
    await this.ctx.storage.put(AUTOPILOT_TELEMETRY_HISTORY_KEY, history);
    return json({ updated: true, telemetry });
  }

  private async readExecutionTelemetry(): Promise<Response> {
    try {
      const history = await this.readExecutionTelemetryHistory();
      const telemetry = history.telemetry;
      return json({
        telemetry: telemetry.at(-1) ?? null,
        history: telemetry,
        summary: summarizeExecutionTelemetry(telemetry),
      });
    } catch {
      return json({ error: "AUTOPILOT_TELEMETRY_CORRUPT" }, 500);
    }
  }

  private async readExecutionTelemetryHistory(): Promise<AutopilotExecutionTelemetryHistory> {
    const stored = await this.ctx.storage.get<unknown>(AUTOPILOT_TELEMETRY_HISTORY_KEY);
    if (stored == null) return Object.freeze({ schemaVersion: 1, telemetry: Object.freeze([]) });
    if (!stored || typeof stored !== "object" || (stored as { schemaVersion?: unknown }).schemaVersion !== 1 || !Array.isArray((stored as { telemetry?: unknown }).telemetry) || (stored as { telemetry: unknown[] }).telemetry.length > MAX_AUTOPILOT_TELEMETRY) {
      throw new Error("AUTOPILOT_TELEMETRY_CORRUPT");
    }
    const telemetry = (stored as { telemetry: unknown[] }).telemetry;
    telemetry.forEach(validateAutopilotExecutionTelemetry);
    return Object.freeze({
      schemaVersion: 1,
      telemetry: Object.freeze([...(telemetry as AutopilotExecutionTelemetry[])].sort((left, right) => left.timestampMs - right.timestampMs || left.telemetryId.localeCompare(right.telemetryId))),
    });
  }

  private async readControlPlaneHold(): Promise<Response> {
    const stored = await this.ctx.storage.get<unknown>(CONTROL_PLANE_HOLD_STORAGE_KEY);
    if (stored == null) return json({ hold: null });
    if (!validPersistedControlPlaneHold(stored)) return json({ error: "CONTROL_PLANE_HOLD_CORRUPT" }, 500);
    return json({ hold: stored });
  }

  private async applyControlPlaneHold(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "CONTROL_PLANE_HOLD_REQUEST_INVALID" }, 400);
    const candidate = value as Partial<ApplyControlPlaneHoldRequest>;
    if (!validControlPlaneHoldIdentity(candidate)) return json({ error: "CONTROL_PLANE_HOLD_REQUEST_INVALID" }, 400);
    const boundedCandidate = value as Partial<ApplyControlPlaneHoldRequest> & ControlPlaneHoldIdentity;
    if (!validExecutionHold(boundedCandidate.hold, boundedCandidate) || !validSafeTimestamp(boundedCandidate.now)) {
      return json({ error: "CONTROL_PLANE_HOLD_REQUEST_INVALID" }, 400);
    }
    const request = value as ApplyControlPlaneHoldRequest;
    const existing = await this.ctx.storage.get<unknown>(CONTROL_PLANE_HOLD_STORAGE_KEY);
    if (existing != null && !validPersistedControlPlaneHold(existing)) return json({ error: "CONTROL_PLANE_HOLD_CORRUPT" }, 500);
    // A stored hold always carries lower-cased SHAs, so the replay comparison has to be made against
    // the same normalised form the write below produces. Comparing the raw request instead made
    // idempotency depend on the case GitHub happened to send: the identical delivery replayed with
    // an upper-cased SHA compared unequal and came back as CONTROL_PLANE_HOLD_CONFLICT. That fails
    // closed, so the HOLD was never at risk -- but index.ts states that replayed deliveries are
    // idempotent, and they were not.
    const normalisedHold = Object.freeze({ ...request.hold, headSha: request.hold.headSha.toLowerCase(), baseSha: request.hold.baseSha.toLowerCase() });
    if (existing) {
      if (existing.state === "CLEARED") return json({ error: "CONTROL_PLANE_HOLD_REPLAY_AFTER_CLEAR", hold: existing }, 409);
      if (JSON.stringify(existing.hold) === JSON.stringify(normalisedHold)) return json({ updated: false, hold: existing });
      return json({ error: "CONTROL_PLANE_HOLD_CONFLICT", hold: existing }, 409);
    }
    const record: PersistedControlPlaneHold = Object.freeze({
      schemaVersion: 1,
      repository: request.repository,
      prNumber: request.prNumber,
      headSha: request.headSha.toLowerCase(),
      baseSha: request.baseSha.toLowerCase(),
      hold: normalisedHold,
      state: "ACTIVE",
      updatedAt: request.now,
    });
    await this.ctx.storage.put(CONTROL_PLANE_HOLD_STORAGE_KEY, record);
    return json({ updated: true, hold: record }, 201);
  }

  private async clearControlPlaneHold(value: unknown): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "CONTROL_PLANE_HOLD_REQUEST_INVALID" }, 400);
    const candidate = value as Partial<ClearControlPlaneHoldRequest>;
    if (!validControlPlaneHoldIdentity(candidate)) return json({ error: "CONTROL_PLANE_HOLD_REQUEST_INVALID" }, 400);
    const boundedCandidate = value as Partial<ClearControlPlaneHoldRequest> & ControlPlaneHoldIdentity;
    if (!validHoldClearance(boundedCandidate.clearance, boundedCandidate) || !validSafeTimestamp(boundedCandidate.now)) {
      return json({ error: "CONTROL_PLANE_HOLD_REQUEST_INVALID" }, 400);
    }
    const request = value as ClearControlPlaneHoldRequest;
    if (request.clearance.globalReleaseFreeze || request.clearance.blockedHuman || request.clearance.reworkRequired) {
      return json({ error: "CONTROL_PLANE_HOLD_CLEAR_BLOCKED" }, 409);
    }
    const existing = await this.ctx.storage.get<unknown>(CONTROL_PLANE_HOLD_STORAGE_KEY);
    if (existing == null) return json({ error: "CONTROL_PLANE_HOLD_NOT_FOUND" }, 409);
    if (!validPersistedControlPlaneHold(existing)) return json({ error: "CONTROL_PLANE_HOLD_CORRUPT" }, 500);
    if (existing.state === "CLEARED") {
      if (existing.hold.holdId === request.clearance.holdId) return json({ updated: false, hold: existing });
      return json({ error: "CONTROL_PLANE_HOLD_CLEAR_STALE", hold: existing }, 409);
    }
    if (existing.hold.holdId !== request.clearance.holdId) return json({ error: "CONTROL_PLANE_HOLD_CLEAR_STALE", hold: existing }, 409);
    const record: PersistedControlPlaneHold = Object.freeze({ ...existing, state: "CLEARED", updatedAt: request.now });
    await this.ctx.storage.put(CONTROL_PLANE_HOLD_STORAGE_KEY, record);
    return json({ updated: true, hold: record });
  }
}

export interface AutopilotExecutionTelemetrySummary {
  readonly telemetryCount: number;
  readonly actionCount: number;
  readonly noActionCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly duplicateSuppressedCount: number;
  readonly hourly: readonly Readonly<{
    hourStartMs: number;
    executions: number;
    actions: number;
    noActions: number;
    successes: number;
    failures: number;
    duplicates: number;
  }>[];
}

function summarizeExecutionTelemetry(telemetry: readonly AutopilotExecutionTelemetry[]): AutopilotExecutionTelemetrySummary {
  const hourly = new Map<number, { executions: number; actions: number; noActions: number; successes: number; failures: number; duplicates: number }>();
  let actionCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let duplicateSuppressedCount = 0;
  for (const entry of telemetry) {
    const hourStartMs = Math.floor(entry.timestampMs / 3_600_000) * 3_600_000;
    const bucket = hourly.get(hourStartMs) ?? { executions: 0, actions: 0, noActions: 0, successes: 0, failures: 0, duplicates: 0 };
    bucket.executions += 1;
    if (entry.action === "ACTION") { bucket.actions += 1; actionCount += 1; } else bucket.noActions += 1;
    if (/duplicate/i.test(entry.result)) { bucket.duplicates += 1; duplicateSuppressedCount += 1; }
    if (/accepted|success|dispatched/i.test(entry.result)) { bucket.successes += 1; successCount += 1; }
    if (/failed|error|blocked|rejected/i.test(entry.result)) { bucket.failures += 1; failureCount += 1; }
    hourly.set(hourStartMs, bucket);
  }
  return Object.freeze({
    telemetryCount: telemetry.length,
    actionCount,
    noActionCount: telemetry.length - actionCount,
    successCount,
    failureCount,
    duplicateSuppressedCount,
    hourly: Object.freeze([...hourly.entries()].sort(([left], [right]) => left - right).map(([hourStartMs, value]) => Object.freeze({ hourStartMs, ...value }))),
  });
}

function validExecutionTelemetrySummary(value: unknown): value is AutopilotExecutionTelemetrySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutopilotExecutionTelemetrySummary>;
  if (![candidate.telemetryCount, candidate.actionCount, candidate.noActionCount, candidate.successCount, candidate.failureCount, candidate.duplicateSuppressedCount].every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) return false;
  if (!Array.isArray(candidate.hourly)) return false;
  return candidate.hourly.every((bucket) => {
    if (!bucket || typeof bucket !== "object") return false;
    const item = bucket as Record<string, unknown>;
    return ["hourStartMs", "executions", "actions", "noActions", "successes", "failures", "duplicates"].every((key) => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0);
  });
}

export interface ExecutionCoordinatorNamespace {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

/** Coordinator-only calls; HTTP routes must authenticate and verify GitHub identities before invoking them. */
export async function registerCausalDispatchBinding(namespace: ExecutionCoordinatorNamespace, input: CausalDispatchRegistration): Promise<boolean> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/causal-dispatch/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (response.status === 409) return false;
  if (response.status !== 201) throw new Error("CAUSAL_DISPATCH_REGISTRATION_FAILED");
  const body = await response.json() as { registered?: unknown };
  if (body.registered !== true) throw new Error("CAUSAL_DISPATCH_REGISTRATION_FAILED");
  return true;
}

export async function claimRegisteredCausalDispatch(namespace: ExecutionCoordinatorNamespace, input: CausalDispatchClaim): Promise<boolean> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/causal-dispatch/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (response.status === 409) return false;
  if (response.status !== 201) throw new Error("CAUSAL_DISPATCH_CLAIM_FAILED");
  const body = await response.json() as { claimed?: unknown };
  if (body.claimed !== true) throw new Error("CAUSAL_DISPATCH_CLAIM_FAILED");
  return true;
}

export async function verifyRegisteredCausalDispatch(namespace: ExecutionCoordinatorNamespace, input: CausalDispatchClaim): Promise<boolean> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/causal-dispatch/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (response.status === 409) return false;
  if (response.status !== 200) throw new Error("CAUSAL_DISPATCH_VERIFICATION_FAILED");
  const body = await response.json() as { verified?: unknown };
  if (body.verified !== true) throw new Error("CAUSAL_DISPATCH_VERIFICATION_FAILED");
  return true;
}

export async function acquirePersistentExecution(namespace: ExecutionCoordinatorNamespace, input: PersistentExecutionAcquireRequest): Promise<{ acquired: boolean; reason?: string; nextRetryAt?: number }> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/acquire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { acquired?: boolean; reason?: string; nextRetryAt?: unknown };
  if (response.status === 201 && body.acquired === true) return { acquired: true };
  if (response.status === 409 && body.acquired === false) return { acquired: false, reason: body.reason ?? "DUPLICATE_EXECUTION", ...(Number.isSafeInteger(body.nextRetryAt) ? { nextRetryAt: Number(body.nextRetryAt) } : {}) };
  throw new Error("PERSISTENT_EXECUTION_COORDINATION_FAILED");
}

export async function readPersistentExecution(namespace: ExecutionCoordinatorNamespace, dedupeKey: string): Promise<PersistentExecutionRecord | null> {
  const stub = namespace.get(namespace.idFromName(dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/execution");
  if (!response.ok) throw new Error("PERSISTENT_EXECUTION_STATE_READ_FAILED");
  const body = await response.json() as { record?: PersistentExecutionRecord | null };
  return body.record ?? null;
}

export async function handoffOrAcquirePersistentExecution(namespace: ExecutionCoordinatorNamespace, input: PersistentExecutionAcquireRequest): Promise<{ acquired: boolean; reason?: string; nextRetryAt?: number }> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/handoff-or-acquire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { acquired?: boolean; reason?: string; nextRetryAt?: unknown };
  if (response.status === 201 && body.acquired === true) return { acquired: true };
  if (response.status === 409 && body.acquired === false) return { acquired: false, reason: body.reason ?? "DUPLICATE_EXECUTION", ...(Number.isSafeInteger(body.nextRetryAt) ? { nextRetryAt: Number(body.nextRetryAt) } : {}) };
  throw new Error("PERSISTENT_EXECUTION_HANDOFF_FAILED");
}

export async function markPersistentExecutionDispatched(namespace: ExecutionCoordinatorNamespace, input: { dedupeKey: string; executionId: string; now: number }): Promise<void> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/dispatched", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error("PERSISTENT_EXECUTION_DISPATCH_RECONCILIATION_FAILED");
}

export async function recoverPersistentAuditDispatch(namespace: ExecutionCoordinatorNamespace, input: PersistentExecutionAcquireRequest): Promise<{ recovered: boolean; reason?: string }> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/audit-dispatch-recovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { recovered?: boolean; reason?: unknown };
  if (response.status === 201 && body.recovered === true) return { recovered: true };
  if (response.status === 409 && body.recovered === false) return { recovered: false, reason: typeof body.reason === "string" ? body.reason : "AUDIT_DISPATCH_RECOVERY_REJECTED" };
  throw new Error("PERSISTENT_AUDIT_DISPATCH_RECOVERY_FAILED");
}

export async function releasePersistentExecution(namespace: ExecutionCoordinatorNamespace, input: { dedupeKey: string; executionId: string; now: number }): Promise<void> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error("PERSISTENT_EXECUTION_RELEASE_FAILED");
}

export async function markPersistentExecutionRateLimitStopped(namespace: ExecutionCoordinatorNamespace, input: PersistentExecutionStopRequest): Promise<{ stopped: boolean; nextRetryAt?: number; reason?: string }> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/rate-limit-stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { stopped?: boolean; nextRetryAt?: unknown; error?: unknown };
  if (response.status === 200 && body.stopped === true && Number.isSafeInteger(body.nextRetryAt)) return { stopped: true, nextRetryAt: Number(body.nextRetryAt) };
  if (response.status === 409) return { stopped: false, reason: typeof body.error === "string" ? body.error : "EXECUTION_STOP_REJECTED" };
  throw new Error("PERSISTENT_EXECUTION_RATE_LIMIT_STOP_FAILED");
}

/**
 * A provider rate-limit is a property of the provider, not of one execution. Execution records are
 * keyed by a dedupe key that includes the exact main SHA, so after main moves the next scheduled run
 * looks up a new, empty record and dispatches again inside the provider's wait window. This record is
 * keyed by provider only, so the wait survives main changes and applies to every new execution.
 */
function providerCapacityWaitId(provider: string): string {
  return `provider-capacity-wait:${provider}`;
}

export async function recordProviderCapacityWait(namespace: ExecutionCoordinatorNamespace, stop: PersistentExecutionStop): Promise<PersistentExecutionStop> {
  const stub = namespace.get(namespace.idFromName(providerCapacityWaitId(stop.provider)));
  const response = await stub.fetch("https://execution-coordinator/provider-capacity-wait", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(stop) });
  const body = await response.json() as { recorded?: boolean; wait?: unknown };
  if (response.status !== 200 || body.recorded !== true || !validPersistentExecutionStop(body.wait)) throw new Error("PROVIDER_CAPACITY_WAIT_RECORD_FAILED");
  return body.wait;
}

export async function readProviderCapacityWait(namespace: ExecutionCoordinatorNamespace, provider: string): Promise<PersistentExecutionStop | null> {
  const stub = namespace.get(namespace.idFromName(providerCapacityWaitId(provider)));
  const response = await stub.fetch("https://execution-coordinator/provider-capacity-wait");
  if (!response.ok) throw new Error("PROVIDER_CAPACITY_WAIT_READ_FAILED");
  const body = await response.json() as { wait?: unknown };
  if (body.wait === null || body.wait === undefined) return null;
  if (!validPersistentExecutionStop(body.wait)) throw new Error("PROVIDER_CAPACITY_WAIT_READ_FAILED");
  return body.wait;
}

/** UTC calendar day of a timestamp, the window the paid overflow cap and provider stop share. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Reserve one paid overflow call for the given UTC day, returning false once the cap is reached.
 * Keyed by provider and day so each provider has its own budget and the count resets daily.
 */
export async function reservePaidOverflowCall(
  namespace: ExecutionCoordinatorNamespace,
  input: { provider: string; day: string; cap: number },
): Promise<boolean> {
  const stub = namespace.get(namespace.idFromName(`paid-overflow-usage:${input.provider}:${input.day}`));
  const response = await stub.fetch("https://execution-coordinator/paid-overflow-reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ day: input.day, cap: input.cap }),
  });
  if (!response.ok) throw new Error("PAID_OVERFLOW_RESERVE_FAILED");
  const body = await response.json() as { allowed?: unknown };
  if (typeof body.allowed !== "boolean") throw new Error("PAID_OVERFLOW_RESERVE_FAILED");
  return body.allowed;
}

export async function completePersistentExecution(namespace: ExecutionCoordinatorNamespace, input: { dedupeKey: string; executionId: string; now: number }): Promise<void> {
  const stub = namespace.get(namespace.idFromName(input.dedupeKey));
  const response = await stub.fetch("https://execution-coordinator/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error("PERSISTENT_EXECUTION_COMPLETION_FAILED");
}

export async function admitActiveWip(namespace: ExecutionCoordinatorNamespace, input: ActiveWipAdmissionRequest): Promise<{ admitted: boolean; reason?: string }> {
  const stub = namespace.get(namespace.idFromName(ACTIVE_WIP_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/active-wip/admit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { admitted?: unknown; reason?: unknown };
  if (response.status === 409 && body.admitted === false) return Object.freeze({ admitted: false, reason: typeof body.reason === "string" ? body.reason : "ACTIVE_WIP_REJECTED" });
  if (!response.ok || body.admitted !== true) throw new Error("ACTIVE_WIP_ADMISSION_FAILED");
  return Object.freeze({ admitted: true });
}

export async function completeActiveWip(namespace: ExecutionCoordinatorNamespace, input: ActiveWipCompletionRequest): Promise<ActiveWipCompletionEvidence> {
  const stub = namespace.get(namespace.idFromName(ACTIVE_WIP_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/active-wip/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error("ACTIVE_WIP_COMPLETION_FAILED");
  const body = await response.json() as { evidence?: ActiveWipCompletionEvidence };
  if (!body.evidence || body.evidence.executionId !== input.executionId || body.evidence.dedupeKey !== input.dedupeKey) throw new Error("ACTIVE_WIP_COMPLETION_INVALID");
  return Object.freeze(body.evidence);
}

export async function releaseActiveWip(namespace: ExecutionCoordinatorNamespace, input: { dedupeKey: string; executionId: string }): Promise<{ readonly released: boolean; readonly reason?: string }> {
  const stub = namespace.get(namespace.idFromName(ACTIVE_WIP_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/active-wip/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { released?: unknown; reason?: unknown };
  if (response.status === 400 || response.status >= 500 || typeof body.released !== "boolean") throw new Error("ACTIVE_WIP_RELEASE_FAILED");
  return Object.freeze({ released: body.released, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) });
}

export async function readActiveWipCompletions(namespace: ExecutionCoordinatorNamespace): Promise<readonly ActiveWipCompletionEvidence[]> {
  const stub = namespace.get(namespace.idFromName(ACTIVE_WIP_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/active-wip/completions", { method: "GET" });
  if (!response.ok) throw new Error("ACTIVE_WIP_COMPLETION_READ_FAILED");
  const body = await response.json() as { completions?: unknown };
  if (!Array.isArray(body.completions)) throw new Error("ACTIVE_WIP_COMPLETION_READ_INVALID");
  return Object.freeze(body.completions as ActiveWipCompletionEvidence[]);
}

export async function readActiveWip(namespace: ExecutionCoordinatorNamespace): Promise<{ readonly claims: readonly ActiveWipClaim[]; readonly activeExecutions: number }> {
  const stub = namespace.get(namespace.idFromName(ACTIVE_WIP_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/active-wip", { method: "GET" });
  if (!response.ok) throw new Error("ACTIVE_WIP_READ_FAILED");
  const body = await response.json() as { claims?: unknown; activeExecutions?: unknown };
  if (!Array.isArray(body.claims) || !Number.isSafeInteger(body.activeExecutions) || Number(body.activeExecutions) !== body.claims.length) throw new Error("ACTIVE_WIP_READ_INVALID");
  return Object.freeze({ claims: Object.freeze(body.claims as ActiveWipClaim[]), activeExecutions: Number(body.activeExecutions) });
}

export async function recordScheduledRuntimeReceipt(namespace: ExecutionCoordinatorNamespace, receipt: ScheduledRuntimeReceipt): Promise<void> {
  const stub = namespace.get(namespace.idFromName(SCHEDULED_RECEIPT_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/scheduled-receipt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt) });
  if (!response.ok) throw new Error("SCHEDULED_RUNTIME_RECEIPT_PERSIST_FAILED");
}

export async function readScheduledRuntimeReceipt(namespace: ExecutionCoordinatorNamespace): Promise<ScheduledRuntimeReceipt | null> {
  return (await readScheduledRuntimeEvidence(namespace)).receipt;
}

export async function readScheduledRuntimeEvidence(namespace: ExecutionCoordinatorNamespace): Promise<ScheduledRuntimeEvidenceSnapshot> {
  const stub = namespace.get(namespace.idFromName(SCHEDULED_RECEIPT_COORDINATOR_KEY));
  // Current coordinators expose the complete snapshot in one read. Fall back
  // to the legacy endpoint only for older deployments, avoiding a second DO
  // round trip on every scheduled cycle.
  let body: Partial<ScheduledRuntimeEvidenceSnapshot> | null = null;
  try {
    const historyResponse = await stub.fetch("https://execution-coordinator/scheduled-receipt-history", { method: "GET" });
    if (historyResponse.ok) body = await historyResponse.json() as Partial<ScheduledRuntimeEvidenceSnapshot>;
  } catch {
    // Older coordinator deployments expose only the legacy latest-receipt response.
  }
  if (body === null) {
    const response = await stub.fetch("https://execution-coordinator/scheduled-receipt", { method: "GET" });
    if (!response.ok) throw new Error("SCHEDULED_RUNTIME_RECEIPT_READ_FAILED");
    body = await response.json() as Partial<ScheduledRuntimeEvidenceSnapshot>;
  }
  if (body.receipt !== null && body.receipt !== undefined && !validScheduledReceipt(body.receipt)) throw new Error("SCHEDULED_RUNTIME_RECEIPT_READ_INVALID");
  const history = body.history == null
    ? (body.receipt == null ? [] : [body.receipt])
    : body.history;
  if (!Array.isArray(history) || !history.every(validScheduledReceipt)) throw new Error("SCHEDULED_RUNTIME_RECEIPT_READ_INVALID");
  const summary = body.summary == null ? summarizeScheduledReceipts(history) : body.summary;
  if (!validScheduledRuntimeSummary(summary)) throw new Error("SCHEDULED_RUNTIME_RECEIPT_READ_INVALID");
  const expectedSummary = summarizeScheduledReceipts(history);
  if (summary.receiptCount !== expectedSummary.receiptCount
    || summary.windowStart !== expectedSummary.windowStart
    || summary.windowEnd !== expectedSummary.windowEnd
    || summary.windowSpanMs !== expectedSummary.windowSpanMs
    || JSON.stringify(summary.statusCounts) !== JSON.stringify(expectedSummary.statusCounts)) {
    throw new Error("SCHEDULED_RUNTIME_RECEIPT_READ_INVALID");
  }
  const latest = history.at(-1) ?? null;
  if (latest !== null && (body.receipt == null || !sameScheduledReceipt(latest, body.receipt))) throw new Error("SCHEDULED_RUNTIME_RECEIPT_READ_INVALID");
  if (latest === null && body.receipt != null) throw new Error("SCHEDULED_RUNTIME_RECEIPT_READ_INVALID");
  return Object.freeze({
    receipt: body.receipt ?? null,
    history: sortScheduledReceipts(history),
    summary,
  });
}

export async function applyPersistentControlPlaneHold(namespace: ExecutionCoordinatorNamespace, input: ApplyControlPlaneHoldRequest): Promise<PersistedControlPlaneHold> {
  const stub = namespace.get(namespace.idFromName(holdCoordinatorKey(input)));
  const response = await stub.fetch("https://execution-coordinator/control-plane-hold/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { hold?: unknown };
  if (!response.ok || !validPersistedControlPlaneHold(body.hold)) throw new Error(response.status === 409 ? "CONTROL_PLANE_HOLD_APPLY_BLOCKED" : "CONTROL_PLANE_HOLD_PERSIST_FAILED");
  return Object.freeze(body.hold);
}

export async function readPersistentControlPlaneHold(namespace: ExecutionCoordinatorNamespace, identity: ControlPlaneHoldIdentity): Promise<PersistedControlPlaneHold | null> {
  if (!validControlPlaneHoldIdentity(identity)) throw new Error("CONTROL_PLANE_HOLD_IDENTITY_INVALID");
  const stub = namespace.get(namespace.idFromName(holdCoordinatorKey(identity)));
  const response = await stub.fetch("https://execution-coordinator/control-plane-hold", { method: "GET" });
  if (!response.ok) throw new Error("CONTROL_PLANE_HOLD_READ_FAILED");
  const body = await response.json() as { hold?: unknown };
  if (body.hold == null) return null;
  if (!validPersistedControlPlaneHold(body.hold)) throw new Error("CONTROL_PLANE_HOLD_READ_INVALID");
  const hold = body.hold;
  if (hold.repository !== identity.repository || hold.prNumber !== identity.prNumber || hold.headSha !== identity.headSha.toLowerCase() || hold.baseSha !== identity.baseSha.toLowerCase()) {
    throw new Error("CONTROL_PLANE_HOLD_READ_STALE");
  }
  return Object.freeze(hold);
}

export async function clearPersistentControlPlaneHold(namespace: ExecutionCoordinatorNamespace, input: ClearControlPlaneHoldRequest): Promise<PersistedControlPlaneHold> {
  const stub = namespace.get(namespace.idFromName(holdCoordinatorKey(input)));
  const response = await stub.fetch("https://execution-coordinator/control-plane-hold/clear", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as { hold?: unknown };
  if (!response.ok || !validPersistedControlPlaneHold(body.hold)) throw new Error("CONTROL_PLANE_HOLD_CLEAR_FAILED");
  return Object.freeze(body.hold);
}

export function createEvolutionLearningMemoryStorage(namespace: ExecutionCoordinatorNamespace): EvolutionLearningMemoryStorage {
  const stub = namespace.get(namespace.idFromName(EVOLVE_LEARNING_COORDINATOR_KEY));
  return Object.freeze({
    async get<T>(_key: string): Promise<T | undefined> {
      const response = await stub.fetch("https://execution-coordinator/evolve-learning-memory", { method: "GET" });
      if (!response.ok) throw new Error("EVOLVE_DURABLE_MEMORY_READ_FAILED");
      const body = await response.json() as { value?: T | null };
      return body.value == null ? undefined : body.value;
    },
    async put<T>(_key: string, value: T): Promise<void> {
      const response = await stub.fetch("https://execution-coordinator/evolve-learning-memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!response.ok) throw new Error("EVOLVE_DURABLE_MEMORY_WRITE_FAILED");
    },
  });
}

export async function recordCodingExecutionEvidence(namespace: ExecutionCoordinatorNamespace, evidence: CodingExecutionEvidence): Promise<CodingExecutionEvidence> {
  const stub = namespace.get(namespace.idFromName(CODING_EVIDENCE_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/coding-evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evidence }),
  });
  if (!response.ok) throw new Error("CODING_EVIDENCE_PERSIST_FAILED");
  const body = await response.json() as { evidence?: unknown };
  validatePersistedCodingExecutionEvidence(body.evidence);
  const persisted = body.evidence;
  if (persisted.request.executionId !== evidence.request.executionId
    || persisted.request.dedupeKey !== evidence.request.dedupeKey) {
    throw new Error("CODING_EVIDENCE_PERSIST_IDENTITY_MISMATCH");
  }
  return Object.freeze(persisted);
}

export async function readCodingExecutionEvidence(namespace: ExecutionCoordinatorNamespace): Promise<{
  readonly evidence: CodingExecutionEvidence | null;
  readonly history: readonly CodingExecutionEvidence[];
}> {
  const stub = namespace.get(namespace.idFromName(CODING_EVIDENCE_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/coding-evidence-history", { method: "GET" });
  if (!response.ok) throw new Error("CODING_EVIDENCE_READ_FAILED");
  const body = await response.json() as { evidence?: unknown; history?: unknown };
  if (body.evidence !== null && body.evidence !== undefined) validatePersistedCodingExecutionEvidence(body.evidence);
  if (!Array.isArray(body.history) || !body.history.every((entry) => {
    try {
      validatePersistedCodingExecutionEvidence(entry);
      return true;
    } catch {
      return false;
    }
  })) throw new Error("CODING_EVIDENCE_READ_INVALID");
  const history = body.history as readonly CodingExecutionEvidence[];
  const latest = history.at(-1) ?? null;
  if (latest !== null && JSON.stringify(body.evidence) !== JSON.stringify(latest)) throw new Error("CODING_EVIDENCE_READ_INVALID");
  if (latest === null && body.evidence != null) throw new Error("CODING_EVIDENCE_READ_INVALID");
  return Object.freeze({ evidence: latest, history: Object.freeze([...history]) });
}

export async function recordAutopilotExecutionTelemetry(namespace: ExecutionCoordinatorNamespace, telemetry: AutopilotExecutionTelemetry): Promise<void> {
  validateAutopilotExecutionTelemetry(telemetry);
  const stub = namespace.get(namespace.idFromName(AUTOPILOT_TELEMETRY_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/execution-telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telemetry }),
  });
  if (!response.ok) throw new Error("AUTOPILOT_TELEMETRY_PERSIST_FAILED");
}

export async function readAutopilotExecutionTelemetry(namespace: ExecutionCoordinatorNamespace): Promise<{
  readonly telemetry: AutopilotExecutionTelemetry | null;
  readonly history: readonly AutopilotExecutionTelemetry[];
  readonly summary: AutopilotExecutionTelemetrySummary;
}> {
  const stub = namespace.get(namespace.idFromName(AUTOPILOT_TELEMETRY_COORDINATOR_KEY));
  const response = await stub.fetch("https://execution-coordinator/execution-telemetry", { method: "GET" });
  if (!response.ok) throw new Error("AUTOPILOT_TELEMETRY_READ_FAILED");
  const body = await response.json() as { telemetry?: unknown; history?: unknown; summary?: unknown };
  if (body.telemetry !== null && body.telemetry !== undefined) validateAutopilotExecutionTelemetry(body.telemetry);
  if (!Array.isArray(body.history)) throw new Error("AUTOPILOT_TELEMETRY_READ_INVALID");
  body.history.forEach(validateAutopilotExecutionTelemetry);
  const history = body.history as readonly AutopilotExecutionTelemetry[];
  const latest = history.at(-1) ?? null;
  if (latest !== null && JSON.stringify(body.telemetry) !== JSON.stringify(latest)) throw new Error("AUTOPILOT_TELEMETRY_READ_INVALID");
  if (latest === null && body.telemetry != null) throw new Error("AUTOPILOT_TELEMETRY_READ_INVALID");
  if (!validExecutionTelemetrySummary(body.summary)) throw new Error("AUTOPILOT_TELEMETRY_READ_INVALID");
  const expectedSummary = summarizeExecutionTelemetry(history);
  if (JSON.stringify(body.summary) !== JSON.stringify(expectedSummary)) throw new Error("AUTOPILOT_TELEMETRY_READ_INVALID");
  return Object.freeze({ telemetry: latest, history: Object.freeze([...history]), summary: body.summary });
}
