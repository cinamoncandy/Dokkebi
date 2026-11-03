import { createHash } from "node:crypto";
import { validatePaperRuntimeExecutionCostEvidence } from "./paperRuntimeExecutionCostEvidence";
import { paperLedgerFingerprint } from "./paperLedgerFingerprint";
import { isOwnerBaselinePeriodInput } from "./ownerBaselinePaperPeriod";
import {
  PersistedPaperPeriodStoreError,
  SqlitePersistedPaperPeriodStore,
  type PersistedPaperCandidateProvenance,
  type PersistedPaperPeriodEnvelope,
  type PersistedPaperPeriodRetentionResult,
  type PersistedPaperPendingPeriod,
  type RealizedPeriodRetentionGuard,
  type PersistedPaperPendingDisposition,
} from "../../../packages/storage/src/persistedPaperPeriodStore";
import type { LeagueCapitalAllocationAdvisory } from "../../../packages/contracts/src/leagueCapitalAllocation";
import { PaperCanonicalOutcomeReconciliationError, reconcileCanonicalPaperOutcomeWindow } from "./paperCanonicalOutcomeReconciliation";
import type { PaperAccountState, PaperFillRecord } from "./paperTradingExecutionLoop";

export interface PaperRealizedPeriodOpenInput {
  readonly periodId: string;
  readonly periodIndex: number;
  readonly advisory: LeagueCapitalAllocationAdvisory;
  readonly candidateProvenance: readonly PersistedPaperCandidateProvenance[];
  /** Optional for legacy/manual periods; required by canonical market benchmark admission. */
  readonly market?: string;
  readonly periodStartAt: number;
}

export interface PersistedPaperRealizedPeriodPlan extends PaperRealizedPeriodOpenInput {
  readonly schemaVersion: 1;
  readonly observationIds: readonly string[];
  readonly observations: readonly PaperRuntimeObservation[];
  readonly lastObservedAt?: number;
  /** Sanitized canonical PAPER account boundary; raw orders/fills never enter period storage. */
  readonly accountBoundary?: PaperCanonicalAccountBoundary;
}

export interface PaperRealizedPeriodCloseInput {
  readonly envelope: PersistedPaperPeriodEnvelope;
}

export interface PaperCanonicalAccountBoundary {
  readonly initialCapital: number;
  readonly equity: number;
  readonly capturedAt: number;
}

export interface PaperCanonicalBenchmarkEvidence {
  readonly evidenceId: string;
  readonly observedAt: number;
  readonly benchmarkReturn: number;
  readonly market: string;
  readonly source: "UPBIT_PUBLIC_TICKER";
  readonly startObservedAt: number;
  readonly endObservedAt: number;
  readonly startPrice: number;
  readonly endPrice: number;
  readonly inputFingerprintSha256: string;
}

export interface PaperRealizedPeriodCanonicalCloseInput {
  readonly periodId: string;
  readonly periodEndAt: number;
}

export interface PaperRuntimeObservation {
  readonly observationId: string;
  readonly observedAt: number;
  readonly status: "FILLED" | "WAIT" | "BLOCKED" | "REJECTED" | "FAILED" | "DUPLICATE";
}

export type PaperRealizedPeriodLifecycleEvent =
  | { readonly type: "PERIOD_OPEN"; readonly periodId: string; readonly occurredAt: number }
  | { readonly type: "PERIOD_REALIZED_PERSISTED"; readonly periodId: string; readonly occurredAt: number }
  | { readonly type: "PERIOD_REJECTED"; readonly periodId: string; readonly occurredAt: number; readonly reasonCode: string; readonly retirementEvidenceFingerprintSha256?: string };

/**
 * Deterministic, replayable evidence that an open period was retired because its canonical fills mix candidate
 * bindings. It is derived only from the immutable canonical fill ledger and the period boundary (no wall clock, no
 * synthesized value), so the same ledger and period always yield the same receipt and fingerprint.
 */
export interface PaperPeriodMixedBindingReceipt {
  readonly schemaVersion: 1;
  readonly reason: "CANDIDATE_BINDING_MIXED";
  readonly retiredPeriodId: string;
  readonly periodStartAt: number;
  readonly retiredAtBoundary: number;
  readonly bindings: readonly { readonly candidateId: string; readonly bindingFingerprintSha256: string; readonly fillCount: number }[];
  readonly fillIds: readonly string[];
  readonly fillCount: number;
  readonly ledgerFingerprintSha256: string;
  readonly ledgerFillCount: number;
  readonly validPerformanceEvidence: false;
  readonly evidenceFingerprintSha256: string;
}

export interface PaperIncompletePeriodDispositionResult {
  readonly disposition: PersistedPaperPendingDisposition;
  readonly successor: PersistedPaperRealizedPeriodPlan;
}

export interface PaperRealizedPeriodProducerOptions {
  readonly sourceRuntimeSha?: string;
  readonly onLifecycleEvent?: (event: PaperRealizedPeriodLifecycleEvent) => void;
  readonly now?: () => number;
  readonly maximumPeriods?: number;
  /** Read-only canonical PAPER account source used by the canonical close path. */
  readonly readCanonicalPaperAccount?: () => PaperAccountState;
  /** Complete durable PAPER fill truth. Production supplies the canonical repository ledger. */
  readonly readCanonicalPaperFills?: () => readonly PaperFillRecord[];
  /** Read-only benchmark source; absent means canonical period admission remains fail-closed. */
  readonly readCanonicalBenchmarkEvidence?: (periodStartAt: number, periodEndAt: number, market?: string) => PaperCanonicalBenchmarkEvidence | undefined;
  /**
   * Required. Retention is the one place realized PAPER evidence is physically deleted, so it may
   * never run without a reference-aware guard (v2 Impact Analysis M1 / A7). Production supplies the
   * guard derived from the evolution ledger, whose surviving records cite `paper-period:<recordId>`.
   */
  readonly retentionGuard: RealizedPeriodRetentionGuard;
}

export class PaperRealizedPeriodProducerError extends Error {
  public constructor(readonly code: string, message: string, readonly periodId?: string) {
    super(message);
    this.name = "PaperRealizedPeriodProducerError";
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const MARKET = /^KRW-[A-Z0-9-]+$/;
const FORBIDDEN_KEY = /(authorization|bearer|token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|cookie|jwt|nonce|signature|account[_-]?id|order[_-]?id|fill[_-]?id)/i;
const OBSERVATION_STATUSES = new Set<PaperRuntimeObservation["status"]>(["FILLED", "WAIT", "BLOCKED", "REJECTED", "FAILED", "DUPLICATE"]);
const MAXIMUM_OBSERVATIONS = 1_024;
const NON_FILL_SAMPLE_INTERVAL = 64;
/** Slots only a FILLED observation may use, so the fill that closes a period is never rejected by sampled non-fill observations. The total cap is unchanged. */
const FILL_RESERVED_OBSERVATIONS = 16;
function shouldPersistObservation(observation: PaperRuntimeObservation, existingCount: number): boolean {
  if (observation.status === "FILLED") return true;
  if (existingCount === 0) return true;
  if (existingCount >= MAXIMUM_OBSERVATIONS - FILL_RESERVED_OBSERVATIONS) return false;
  let hash = 0;
  for (const char of observation.observationId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % NON_FILL_SAMPLE_INTERVAL === 0;
}
const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PaperRealizedPeriodProducerError("NON_FINITE_VALUE", "PAPER period contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(",")}]`;
  if (typeof value === "object") {
    if (seen.has(value)) throw new PaperRealizedPeriodProducerError("CYCLIC_INPUT", "PAPER period must be acyclic");
    seen.add(value);
    const result = `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, seen)}`).join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new PaperRealizedPeriodProducerError("UNSUPPORTED_VALUE", "PAPER period contains an unsupported value");
}

function digest(value: unknown): string { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }

function safeText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PaperRealizedPeriodProducerError("INVALID_IDENTIFIER", `${field} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || FORBIDDEN_KEY.test(normalized)) throw new PaperRealizedPeriodProducerError("INVALID_IDENTIFIER", `${field} is invalid`);
  return normalized;
}

function safeMarket(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PaperRealizedPeriodProducerError("INVALID_MARKET", `${field} must be a market`);
  const market = value.trim().toUpperCase();
  if (!MARKET.test(market)) throw new PaperRealizedPeriodProducerError("INVALID_MARKET", `${field} is invalid`);
  return market;
}

function safeTime(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PaperRealizedPeriodProducerError("INVALID_TIMESTAMP", `${field} must be a non-negative safe integer`);
  return Number(value);
}

function rejectForbidden(value: unknown, seen = new Set<object>()): void {
  if (value == null || typeof value !== "object") return;
  if (seen.has(value)) throw new PaperRealizedPeriodProducerError("CYCLIC_INPUT", "PAPER period must be acyclic");
  seen.add(value);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) throw new PaperRealizedPeriodProducerError("FORBIDDEN_FIELD", "PAPER period contains a forbidden field");
    rejectForbidden(child, seen);
  }
  seen.delete(value);
}

function validateObservation(input: PaperRuntimeObservation): PaperRuntimeObservation {
  rejectForbidden(input);
  const observation = freeze({ observationId: safeText(input.observationId, "observationId"), observedAt: safeTime(input.observedAt, "observedAt"), status: input.status });
  if (!OBSERVATION_STATUSES.has(observation.status)) throw new PaperRealizedPeriodProducerError("INVALID_RUNTIME_OBSERVATION", "PAPER runtime observation status is unsupported");
  return observation;
}

function validateAccountBoundary(input: PaperCanonicalAccountBoundary, expectedAt: number, periodId: string): PaperCanonicalAccountBoundary {
  if (input == null || typeof input !== "object") throw new PaperRealizedPeriodProducerError("INVALID_ACCOUNT_BOUNDARY", "canonical PAPER account boundary is missing", periodId);
  if (!Number.isFinite(input.initialCapital) || input.initialCapital <= 0 || !Number.isFinite(input.equity) || input.equity <= 0) {
    throw new PaperRealizedPeriodProducerError("INVALID_ACCOUNT_BOUNDARY", "canonical PAPER account boundary is invalid", periodId);
  }
  if (!Number.isSafeInteger(input.capturedAt) || input.capturedAt < 0 || input.capturedAt !== expectedAt) {
    throw new PaperRealizedPeriodProducerError("STALE_ACCOUNT_SNAPSHOT", "canonical PAPER account boundary must match the period start", periodId);
  }
  return freeze({ initialCapital: input.initialCapital, equity: input.equity, capturedAt: input.capturedAt });
}
function validateCanonicalAccountState(state: PaperAccountState, expectedAt: number, periodId: string): PaperAccountState {
  if (state == null || state.version !== 1) throw new PaperRealizedPeriodProducerError("UNSUPPORTED_ACCOUNT_SCHEMA", "canonical PAPER account schema is unsupported", periodId);
  if (!Number.isFinite(state.initialCapital) || state.initialCapital <= 0 || !Number.isFinite(state.equity) || state.equity < 0) throw new PaperRealizedPeriodProducerError("INVALID_ACCOUNT_BOUNDARY", "canonical PAPER account state is invalid", periodId);
  if (!Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0 || state.updatedAt !== expectedAt) throw new PaperRealizedPeriodProducerError("STALE_ACCOUNT_SNAPSHOT", "canonical PAPER account snapshot is not aligned to the period boundary", periodId);
  return state;
}

function boundaryFromCanonicalAccount(state: PaperAccountState, expectedAt: number, periodId: string): PaperCanonicalAccountBoundary {
  const validated = validateCanonicalAccountState(state, expectedAt, periodId);
  return validateAccountBoundary({ initialCapital: validated.initialCapital, equity: validated.equity, capturedAt: validated.updatedAt }, expectedAt, periodId);
}
function boundaryAsAccountState(boundary: PaperCanonicalAccountBoundary): PaperAccountState {
  return Object.freeze({ version: 1, initialCapital: boundary.initialCapital, cash: boundary.equity, equity: boundary.equity, realizedPnL: 0, unrealizedPnL: 0, positions: Object.freeze([]), orders: Object.freeze([]), fills: Object.freeze([]), processedIdempotencyKeys: Object.freeze([]), updatedAt: boundary.capturedAt });
}
function validateBenchmarkEvidence(input: PaperCanonicalBenchmarkEvidence | undefined, periodStartAt: number, periodEndAt: number, expectedMarket: string, periodId: string): PaperCanonicalBenchmarkEvidence {
  if (input == null) throw new PaperRealizedPeriodProducerError("MISSING_BENCHMARK_EVIDENCE", "canonical PAPER period benchmark evidence is unavailable", periodId);
  const evidenceId = safeText(input.evidenceId, "benchmarkEvidence.evidenceId");
  const market = safeMarket(input.market, "benchmarkEvidence.market");
  const observedAt = safeTime(input.observedAt, "benchmarkEvidence.observedAt");
  const startObservedAt = safeTime(input.startObservedAt, "benchmarkEvidence.startObservedAt");
  const endObservedAt = safeTime(input.endObservedAt, "benchmarkEvidence.endObservedAt");
  if (market !== expectedMarket || input.source !== "UPBIT_PUBLIC_TICKER") throw new PaperRealizedPeriodProducerError("BENCHMARK_PROVENANCE_CONFLICT", "benchmark evidence source does not match the canonical PAPER market", periodId);
  if (startObservedAt < periodStartAt || endObservedAt > periodEndAt || startObservedAt >= endObservedAt || observedAt !== endObservedAt) throw new PaperRealizedPeriodProducerError("INVALID_BENCHMARK_EVIDENCE", "benchmark evidence coverage is outside the realized PAPER period", periodId);
  if (![input.startPrice, input.endPrice].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) throw new PaperRealizedPeriodProducerError("NON_FINITE_VALUE", "benchmark prices must be finite and positive", periodId);
  if (typeof input.benchmarkReturn !== "number" || !Number.isFinite(input.benchmarkReturn) || input.benchmarkReturn !== input.endPrice / input.startPrice - 1) throw new PaperRealizedPeriodProducerError("INVALID_BENCHMARK_EVIDENCE", "benchmark return does not match observed prices", periodId);
  if (typeof input.inputFingerprintSha256 !== "string" || !SHA256.test(input.inputFingerprintSha256)) throw new PaperRealizedPeriodProducerError("INVALID_BENCHMARK_EVIDENCE", "benchmark input provenance is invalid", periodId);
  return freeze({ evidenceId, observedAt, benchmarkReturn: input.benchmarkReturn, market, source: "UPBIT_PUBLIC_TICKER", startObservedAt, endObservedAt, startPrice: input.startPrice, endPrice: input.endPrice, inputFingerprintSha256: input.inputFingerprintSha256 });
}
function validatePlan(input: PersistedPaperRealizedPeriodPlan): PersistedPaperRealizedPeriodPlan {
  rejectForbidden(input);
  if (input.schemaVersion !== 1) throw new PaperRealizedPeriodProducerError("UNSUPPORTED_SCHEMA", "PAPER period schema is unsupported", input.periodId);
  const periodId = safeText(input.periodId, "periodId");
  const periodIndex = input.periodIndex;
  if (!Number.isSafeInteger(periodIndex) || periodIndex < 0) throw new PaperRealizedPeriodProducerError("INVALID_PERIOD_INDEX", "periodIndex must be a non-negative safe integer", periodId);
  const periodStartAt = safeTime(input.periodStartAt, "periodStartAt");
  const market = input.market === undefined ? undefined : safeMarket(input.market, "market");
  const advisoryGeneratedAt = Date.parse(input.advisory.generatedAt);
  if (!Number.isFinite(advisoryGeneratedAt) || advisoryGeneratedAt >= periodStartAt) throw new PaperRealizedPeriodProducerError("LOOKAHEAD_ADVISORY", "advisory must predate the PAPER period", periodId);
  const candidateProvenance = [...input.candidateProvenance].map((item) => freeze({ candidateId: safeText(item.candidateId, "candidateId"), datasetId: safeText(item.datasetId, "datasetId"), datasetContentSha256: safeText(item.datasetContentSha256, "datasetContentSha256") })).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  if (candidateProvenance.length === 0 || candidateProvenance.some((item) => !SHA256.test(item.datasetContentSha256))) throw new PaperRealizedPeriodProducerError("INVALID_DATASET_PROVENANCE", "candidate dataset provenance is incomplete", periodId);
  if (new Set(candidateProvenance.map((item) => item.candidateId)).size !== candidateProvenance.length) throw new PaperRealizedPeriodProducerError("INVALID_CANDIDATE_PROVENANCE", "candidate provenance identity is duplicated", periodId);
  const observationIds = [...input.observationIds].map((id) => safeText(id, "observationId"));
  const observations = [...input.observations].map(validateObservation);
  if (observationIds.length !== observations.length || observations.some((item, index) => item.observationId !== observationIds[index]) || observationIds.length > MAXIMUM_OBSERVATIONS || new Set(observationIds).size !== observationIds.length) throw new PaperRealizedPeriodProducerError("INVALID_OBSERVATIONS", "period observation identities are inconsistent or unbounded", periodId);
  const lastObservedAt = input.lastObservedAt === undefined ? undefined : safeTime(input.lastObservedAt, "lastObservedAt");
  const latestObservedAt = observations.reduce<number | undefined>((latest, item) => latest === undefined ? item.observedAt : Math.max(latest, item.observedAt), undefined);
  if (lastObservedAt !== undefined && latestObservedAt !== undefined && lastObservedAt !== latestObservedAt) throw new PaperRealizedPeriodProducerError("INVALID_OBSERVATION_TIME", "period observation timestamp is inconsistent", periodId);
  if (lastObservedAt !== undefined && lastObservedAt < periodStartAt) throw new PaperRealizedPeriodProducerError("INVALID_OBSERVATION_TIME", "runtime observation predates the period start", periodId);
  const accountBoundary = input.accountBoundary === undefined ? undefined : validateAccountBoundary(input.accountBoundary, periodStartAt, periodId);
  const plan = { schemaVersion: 1 as const, periodId, periodIndex, advisory: input.advisory, candidateProvenance, ...(market === undefined ? {} : { market }), periodStartAt, observationIds, observations, ...(lastObservedAt === undefined ? {} : { lastObservedAt }), ...(accountBoundary === undefined ? {} : { accountBoundary }) } satisfies PersistedPaperRealizedPeriodPlan;
  return freeze({ ...plan, candidateProvenance: freeze(candidateProvenance), observationIds: freeze(observationIds), observations: freeze(observations) });
}

function samePlanIdentity(left: PaperRealizedPeriodOpenInput, right: PaperRealizedPeriodOpenInput): boolean {
  return left.periodId === right.periodId
    && left.periodIndex === right.periodIndex
    && left.periodStartAt === right.periodStartAt
    && left.market === right.market
    && digest(left.advisory) === digest(right.advisory)
    && digest([...left.candidateProvenance].sort((a, b) => a.candidateId.localeCompare(b.candidateId))) === digest([...right.candidateProvenance].sort((a, b) => a.candidateId.localeCompare(b.candidateId)));
}

function validateEnvelope(envelope: PersistedPaperPeriodEnvelope): PersistedPaperPeriodEnvelope {
  rejectForbidden(envelope);
  const record = envelope.record;
  if (record == null || record.recordId == null) throw new PaperRealizedPeriodProducerError("INVALID_RECORD_ID", "PAPER realized record is missing");
  if (!Number.isSafeInteger(record.periodIndex) || record.periodIndex < 0) throw new PaperRealizedPeriodProducerError("INVALID_PERIOD_INDEX", "PAPER periodIndex is invalid", record.recordId);
  safeTime(record.periodStartAt, "periodStartAt"); safeTime(record.periodEndAt, "periodEndAt");
  if (record.market !== undefined) safeMarket(record.market, "market");
  if (!(Date.parse(record.advisory.generatedAt) < record.periodStartAt && record.periodStartAt < record.periodEndAt)) throw new PaperRealizedPeriodProducerError("INVALID_PERIOD_BOUNDS", "PAPER period chronology is invalid", record.recordId);
  if (!record.costEvidence || record.costEvidence.source !== "PAPER_EXECUTION_RECEIPT" || !safeText(record.costEvidence.evidenceId, "costEvidence.evidenceId")) throw new PaperRealizedPeriodProducerError("MISSING_COST_PROVENANCE", "PAPER realized period requires an attributable execution cost receipt", record.recordId);
  if ((record.costEvidence.evidenceKind !== "OBSERVED" && record.costEvidence.evidenceKind !== "CONSERVATIVE_MODEL") || !SHA256.test(record.costEvidence.evidenceFingerprintSha256)) throw new PaperRealizedPeriodProducerError("INVALID_COST_PROVENANCE", "PAPER realized period cost evidence provenance is invalid", record.recordId);
  safeTime(record.costEvidence.observedAt, "costEvidence.observedAt");
  if (record.costEvidence.observedAt < record.periodStartAt) throw new PaperRealizedPeriodProducerError("INVALID_COST_EVIDENCE", "cost receipt must be observed during the PAPER period", record.recordId);
  for (const [field, value] of Object.entries({ benchmarkReturn: record.benchmarkReturn, turnoverCostRate: record.turnoverCostRate, ...record.realizedReturns, feeRate: record.costEvidence.feeRate, spreadRate: record.costEvidence.spreadRate, slippageRate: record.costEvidence.slippageRate })) if (typeof value !== "number" || !Number.isFinite(value)) throw new PaperRealizedPeriodProducerError("NON_FINITE_VALUE", `${field} must be finite`, record.recordId);
  if (record.turnoverCostRate < 0 || record.costEvidence.feeRate < 0 || record.costEvidence.spreadRate < 0 || record.costEvidence.slippageRate < 0) throw new PaperRealizedPeriodProducerError("INVALID_COST_EVIDENCE", "PAPER period costs must be non-negative", record.recordId);
  if (!(record.status === "COMPLETED" || record.status === "REJECTED" || record.status === "HALTED")) throw new PaperRealizedPeriodProducerError("INVALID_STATUS", "PAPER period status is unsupported", record.recordId);
  if (record.benchmarkEvidenceId !== undefined) safeText(record.benchmarkEvidenceId, "benchmarkEvidenceId");
  if (record.canonicalOutcomeReceiptFingerprint !== undefined && !SHA256.test(record.canonicalOutcomeReceiptFingerprint)) throw new PaperRealizedPeriodProducerError("INVALID_OUTCOME_PROVENANCE", "canonical PAPER outcome fingerprint is invalid", record.recordId);
  if (record.canonicalOutcomeReceiptFingerprint !== undefined && record.costEvidence.evidenceId !== "paper-canonical-outcome:" + record.canonicalOutcomeReceiptFingerprint) throw new PaperRealizedPeriodProducerError("INVALID_COST_PROVENANCE", "canonical PAPER cost evidence is not bound to its outcome receipt", record.recordId);
  return freeze({ record: freeze({ ...record, realizedReturns: freeze({ ...record.realizedReturns }), costEvidence: freeze({ ...record.costEvidence }) }), candidateProvenance: freeze([...envelope.candidateProvenance].sort((a, b) => a.candidateId.localeCompare(b.candidateId)).map((item) => freeze({ ...item }))) });
}

function decodePlan(pending: PersistedPaperPendingPeriod): PersistedPaperRealizedPeriodPlan {
  try {
    if (digest(JSON.parse(pending.payloadJson)) !== pending.checksum) throw new PaperRealizedPeriodProducerError("PENDING_CHECKSUM_MISMATCH", "pending PAPER period checksum mismatch", pending.periodId);
    const plan = validatePlan(JSON.parse(pending.payloadJson) as PersistedPaperRealizedPeriodPlan);
    if (plan.periodId !== pending.periodId || plan.periodIndex !== pending.periodIndex || plan.periodStartAt !== pending.periodStartAt) throw new PaperRealizedPeriodProducerError("PENDING_IDENTITY_CONFLICT", "pending PAPER period identity mismatch", pending.periodId);
    return plan;
  } catch (error) {
    if (error instanceof PaperRealizedPeriodProducerError) throw error;
    throw new PaperRealizedPeriodProducerError("MALFORMED_PENDING_PERIOD", "pending PAPER period payload is malformed", pending.periodId);
  }
}

export class PaperRealizedPeriodProducer {
  private readonly openPeriods = new Map<string, PersistedPaperRealizedPeriodPlan>();
  private lastRetention: PersistedPaperPeriodRetentionResult | undefined;

  public constructor(private readonly repository: SqlitePersistedPaperPeriodStore, private readonly options: PaperRealizedPeriodProducerOptions) {
    if (options.retentionGuard == null || typeof options.retentionGuard.referencedRecordIds !== "function") throw new PaperRealizedPeriodProducerError("MISSING_RETENTION_GUARD", "PAPER realized-period retention requires a reference-aware guard");
    if (options.maximumPeriods !== undefined && (!Number.isSafeInteger(options.maximumPeriods) || options.maximumPeriods < 1 || options.maximumPeriods > 1_000)) throw new PaperRealizedPeriodProducerError("INVALID_RETENTION", "PAPER period retention must be between 1 and 1000");
    const pending = repository.listPending().map(decodePlan);
    if (pending.length > 1) throw new PaperRealizedPeriodProducerError("MULTIPLE_OPEN_PERIODS", "multiple open PAPER realized periods are unsafe");
    for (const plan of pending) this.openPeriods.set(plan.periodId, plan);
    this.lastRetention = repository.prune(options.maximumPeriods ?? 100, options.retentionGuard);
  }

  /**
   * The most recent retention report. A period kept past the bound because a surviving record cites
   * it is visible here rather than hidden, and the bound is never relaxed to clear it.
   */
  public retention(): PersistedPaperPeriodRetentionResult | undefined { return this.lastRetention; }

  public openPeriod(input: PaperRealizedPeriodOpenInput): PersistedPaperRealizedPeriodPlan {
    try { return this.openPeriodInternal(input); } catch (error) { throw this.reject(error, input.periodId); }
  }

  /** Opens a period only from the canonical PAPER account boundary owned by this runtime. */
  public openPeriodFromCanonicalAccount(input: PaperRealizedPeriodOpenInput): PersistedPaperRealizedPeriodPlan {
    try {
      const accountBoundary = this.readCanonicalAccountBoundary(input.periodStartAt, input.periodId);
      return this.openPeriodInternal(input, accountBoundary);
    } catch (error) { throw this.reject(error, input.periodId); }
  }

  private openPeriodInternal(input: PaperRealizedPeriodOpenInput, accountBoundary?: PaperCanonicalAccountBoundary): PersistedPaperRealizedPeriodPlan {
    if ([...this.openPeriods.values()].some((plan) => plan.periodId !== input.periodId)) throw new PaperRealizedPeriodProducerError("PERIOD_ALREADY_OPEN", "only one canonical PAPER realized period may be open at a time", input.periodId);
    const plan = validatePlan({ ...input, schemaVersion: 1, observationIds: [], observations: [], ...(accountBoundary === undefined ? {} : { accountBoundary }) });
    const pending = { periodId: plan.periodId, periodIndex: plan.periodIndex, periodStartAt: plan.periodStartAt, payloadJson: canonical(plan), checksum: digest(plan) } satisfies PersistedPaperPendingPeriod;
    this.repository.putPending(pending);
    this.openPeriods.set(plan.periodId, plan);
    this.emit({ type: "PERIOD_OPEN", periodId: plan.periodId, occurredAt: plan.periodStartAt });
    return plan;
  }

  private readCanonicalAccountState(expectedAt: number, periodId: string): PaperAccountState {
    const reader = this.options.readCanonicalPaperAccount;
    if (reader == null) throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_UNAVAILABLE", "canonical PAPER account source is unavailable", periodId);
    let state: PaperAccountState;
    try { state = reader(); } catch { throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_UNAVAILABLE", "canonical PAPER account source could not be read", periodId); }
    validateCanonicalAccountState(state, expectedAt, periodId);
    return state;
  }

  private readCanonicalAccountBoundary(expectedAt: number, periodId: string): PaperCanonicalAccountBoundary {
    return boundaryFromCanonicalAccount(this.readCanonicalAccountState(expectedAt, periodId), expectedAt, periodId);
  }

  private readCanonicalPaperFills(periodId: string): readonly PaperFillRecord[] | undefined {
    const reader = this.options.readCanonicalPaperFills;
    if (reader == null) return undefined;
    try {
      const fills = reader();
      if (!Array.isArray(fills)) throw new Error("canonical PAPER fill ledger is invalid");
      return fills;
    } catch {
      throw new PaperRealizedPeriodProducerError("CANONICAL_FILL_LEDGER_UNAVAILABLE", "canonical PAPER fill ledger could not be read", periodId);
    }
  }

  public observeExecution(observation: PaperRuntimeObservation): "RECORDED" | "DUPLICATE" | "NO_ACTIVE_PERIOD" {
    const normalized = validateObservation(observation);
    if (this.openPeriods.size === 0) return "NO_ACTIVE_PERIOD";
    let duplicate = true;
    try {
      for (const [periodId, current] of this.openPeriods) {
        if (!current.observationIds.includes(normalized.observationId)) duplicate = false;
        const pending = this.repository.getPending(periodId);
        if (pending == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
        const stored = decodePlan(pending);
        if (!samePlanIdentity(stored, current)) throw new PaperRealizedPeriodProducerError("PENDING_IDENTITY_CONFLICT", "pending PAPER period changed during observation", periodId);
        const existing = current.observations.find((item) => item.observationId === normalized.observationId);
        if (existing != null) {
          if (existing.observedAt !== normalized.observedAt || existing.status !== normalized.status) throw new PaperRealizedPeriodProducerError("OBSERVATION_ID_CONFLICT", "PAPER runtime observation identity was reused with different evidence", periodId);
          continue;
        }
        if (!shouldPersistObservation(normalized, current.observationIds.length)) continue;
        if (current.observationIds.length >= MAXIMUM_OBSERVATIONS) throw new PaperRealizedPeriodProducerError("OBSERVATION_LIMIT", "PAPER period observation limit reached", periodId);
        const next = validatePlan({ ...current, observationIds: [...current.observationIds, normalized.observationId], observations: [...current.observations, normalized], lastObservedAt: Math.max(current.lastObservedAt ?? 0, normalized.observedAt) });
        this.repository.updatePending({ ...pending, payloadJson: canonical(next), checksum: digest(next) });
        this.openPeriods.set(periodId, next);
      }
      return duplicate ? "DUPLICATE" : "RECORDED";
    } catch (error) { throw this.reject(error); }
  }

  public closePeriod(input: PaperRealizedPeriodCloseInput): PersistedPaperPeriodEnvelope {
    const periodId = input.envelope.record.recordId;
    try { return this.finalizeEnvelope(input.envelope); } catch (error) { throw this.reject(error, periodId); }
  }

  /** Closes a period from the canonical PAPER account and never accepts caller-supplied returns or costs. */
  public closePeriodFromCanonicalAccount(input: PaperRealizedPeriodCanonicalCloseInput): PersistedPaperPeriodEnvelope {
    const periodId = input.periodId;
    try {
      safeText(periodId, "periodId");
      const periodEndAt = safeTime(input.periodEndAt, "periodEndAt");
      const current = this.openPeriods.get(periodId);
      if (current == null) {
        const existing = this.repository.list().find((item) => item.record.recordId === periodId);
        if (existing != null && existing.record.periodEndAt === periodEndAt) return existing;
        if (existing != null) throw new PaperRealizedPeriodProducerError("PERIOD_ID_CONFLICT", "realized PAPER period was reused with different evidence", periodId);
        throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
      }
      if (current.accountBoundary == null) throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_BOUNDARY_UNAVAILABLE", "PAPER period was not opened from a canonical account boundary", periodId);
      if (current.observationIds.length === 0) throw new PaperRealizedPeriodProducerError("PERIOD_OUTCOME_NOT_OBSERVED", "PAPER period cannot be realized without a runtime observation", periodId);
      if (periodEndAt <= current.periodStartAt) throw new PaperRealizedPeriodProducerError("INVALID_PERIOD_BOUNDS", "periodEndAt must be after periodStartAt", periodId);
      const endState = this.readCanonicalAccountState(periodEndAt, periodId);
      const canonicalFills = this.readCanonicalPaperFills(periodId);
      let receipt: ReturnType<typeof reconcileCanonicalPaperOutcomeWindow>;
      try {
        receipt = reconcileCanonicalPaperOutcomeWindow({
          periodStartAt: current.periodStartAt,
          periodEndAt,
          startState: boundaryAsAccountState(current.accountBoundary),
          endState,
          ...(canonicalFills === undefined ? {} : { canonicalFills }),
        });
      } catch (error) {
        if (error instanceof PaperCanonicalOutcomeReconciliationError) throw new PaperRealizedPeriodProducerError(error.code, error.message, periodId);
        throw error;
      }
      if (receipt.fillCount === 0 || receipt.candidateIds.length !== 1 || current.candidateProvenance.length !== 1) throw new PaperRealizedPeriodProducerError("CANDIDATE_ATTRIBUTION_UNAVAILABLE", "PAPER period outcome cannot be attributed to exactly one candidate", periodId);
      const candidateId = receipt.candidateIds[0]!;
      if (current.candidateProvenance[0]!.candidateId !== candidateId) throw new PaperRealizedPeriodProducerError("PROVENANCE_CONFLICT", "canonical PAPER fill candidate does not match the open period", periodId);
      if (receipt.executionCostEvidenceKind === undefined || receipt.executionCostEvidenceFingerprint === undefined) throw new PaperRealizedPeriodProducerError("MISSING_COST_PROVENANCE", "canonical PAPER execution-cost provenance is unavailable", periodId);
      const market = current.market;
      if (market == null) throw new PaperRealizedPeriodProducerError("MISSING_BENCHMARK_MARKET", "canonical PAPER period market identity is unavailable", periodId);
      const benchmarkReader = this.options.readCanonicalBenchmarkEvidence;
      if (benchmarkReader == null) throw new PaperRealizedPeriodProducerError("MISSING_BENCHMARK_EVIDENCE", "canonical PAPER benchmark evidence is unavailable", periodId);
      let benchmark: PaperCanonicalBenchmarkEvidence | undefined;
      try { benchmark = benchmarkReader(current.periodStartAt, periodEndAt, market); } catch { throw new PaperRealizedPeriodProducerError("BENCHMARK_EVIDENCE_UNAVAILABLE", "canonical PAPER benchmark evidence could not be read", periodId); }
      const validatedBenchmark = validateBenchmarkEvidence(benchmark, current.periodStartAt, periodEndAt, market, periodId);
      const turnoverCostRate = receipt.feeRate + receipt.spreadRate + receipt.slippageRate;
      if (!Number.isFinite(turnoverCostRate) || turnoverCostRate < 0) throw new PaperRealizedPeriodProducerError("NON_FINITE_VALUE", "canonical PAPER cost rate is invalid", periodId);
      const envelope: PersistedPaperPeriodEnvelope = {
        record: {
          recordId: periodId,
          periodIndex: current.periodIndex,
          ...(market === undefined ? {} : { market }),
          advisory: current.advisory,
          periodStartAt: current.periodStartAt,
          periodEndAt,
          realizedReturns: { [candidateId]: receipt.netReturn },
          benchmarkReturn: validatedBenchmark.benchmarkReturn,
          turnoverCostRate,
          costEvidence: { evidenceId: "paper-canonical-outcome:" + receipt.receiptFingerprint, source: "PAPER_EXECUTION_RECEIPT", evidenceKind: receipt.executionCostEvidenceKind, evidenceFingerprintSha256: receipt.executionCostEvidenceFingerprint, observedAt: periodEndAt, feeRate: receipt.feeRate, spreadRate: receipt.spreadRate, slippageRate: receipt.slippageRate },
          status: "COMPLETED",
          benchmarkEvidenceId: validatedBenchmark.evidenceId,
          benchmarkInputFingerprintSha256: validatedBenchmark.inputFingerprintSha256,
          canonicalOutcomeReceiptFingerprint: receipt.receiptFingerprint,
        },
        candidateProvenance: current.candidateProvenance,
      };
      return this.finalizeEnvelope(envelope);
    } catch (error) { throw this.reject(error, periodId); }
  }

  /** Preserve a proven incomplete window without manufacturing realized returns or costs. */
  public disposeIncompletePeriodFromCanonicalAccount(input: PaperRealizedPeriodCanonicalCloseInput): PaperIncompletePeriodDispositionResult {
    const replay = this.repository.listPendingDispositions().find((item) => item.original.periodId === input.periodId);
    if (replay != null) {
      if (replay.reason.boundaryAt !== input.periodEndAt) throw new PaperRealizedPeriodProducerError("PERIOD_ID_CONFLICT", "disposition boundary changed", input.periodId);
      return Object.freeze({ disposition: replay, successor: decodePlan(replay.successor) });
    }
    const current = this.openPeriods.get(input.periodId);
    if (current == null || current.accountBoundary == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "canonical pending period is unavailable", input.periodId);
    const endState = this.readCanonicalAccountState(input.periodEndAt, input.periodId);
    if (endState.initialCapital !== current.accountBoundary.initialCapital) throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_BOUNDARY_CONFLICT", "account identity changed", input.periodId);
    if (endState.positions.some((position) => position.quantity !== 0) || (endState.workingOrders?.length ?? 0) !== 0) {
      throw new PaperRealizedPeriodProducerError("INCOMPLETE_PERIOD_WAITING_FOR_FLAT_BOUNDARY", "incomplete period must retain exposure until a canonical flat boundary", input.periodId);
    }
    const canonicalFills = this.readCanonicalPaperFills(input.periodId);
    if (canonicalFills == null) throw new PaperRealizedPeriodProducerError("CANONICAL_FILL_LEDGER_UNAVAILABLE", "full fill truth is required for disposition", input.periodId);
    // Re-derive the failure from canonical account/ledger evidence; a caller's error code is insufficient.
    try {
      reconcileCanonicalPaperOutcomeWindow({ periodStartAt: current.periodStartAt, periodEndAt: input.periodEndAt,
        startState: boundaryAsAccountState(current.accountBoundary), endState, canonicalFills });
      throw new PaperRealizedPeriodProducerError("PERIOD_NOT_INCOMPLETE", "canonical evidence does not prove incomplete execution costs", input.periodId);
    } catch (error) {
      if (!(error instanceof PaperCanonicalOutcomeReconciliationError) || error.code !== "INCOMPLETE_EXECUTION_COST_EVIDENCE") throw error;
    }
    const window = [...canonicalFills].filter((fill) => fill.filledAt > current.periodStartAt && fill.filledAt <= input.periodEndAt)
      .sort((left, right) => left.filledAt - right.filledAt || left.id.localeCompare(right.id));
    const incomplete = window.filter((fill) => fill.executionCostAttribution == null && fill.runtimeExecutionCostEvidence != null);
    if (incomplete.length === 0) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_INCOMPLETE", "incomplete cost receipt is unavailable", input.periodId);
    for (const fill of incomplete) validatePaperRuntimeExecutionCostEvidence(fill, fill.runtimeExecutionCostEvidence!);
    const original = this.repository.getPending(input.periodId);
    if (original == null || canonical(decodePlan(original)) !== canonical(current)) throw new PaperRealizedPeriodProducerError("PENDING_IDENTITY_CONFLICT", "pending evidence changed", input.periodId);
    const periodIndex = this.repository.nextPeriodIndex();
    const successor = validatePlan({ ...current, periodId: `closed-learning-rollover:${periodIndex}:${input.periodEndAt}`, periodIndex,
      periodStartAt: input.periodEndAt, observationIds: [], observations: [], lastObservedAt: undefined,
      accountBoundary: boundaryFromCanonicalAccount(endState, input.periodEndAt, input.periodId) });
    // Optional fields must be absent, never encoded as undefined in canonical persistence.
    const { lastObservedAt: _last, ...cleanSuccessor } = successor;
    const next = validatePlan(cleanSuccessor);
    const pending = { periodId: next.periodId, periodIndex: next.periodIndex, periodStartAt: next.periodStartAt, payloadJson: canonical(next), checksum: digest(next) };
    const disposition = this.repository.markPendingIneligible({ original, successor: pending,
      reason: { stage: "PERIOD_CLOSE", code: "INCOMPLETE_EXECUTION_COST_EVIDENCE", boundaryAt: input.periodEndAt,
        sourceRuntimeSha: this.options.sourceRuntimeSha ?? null,
        blockedEvidenceFingerprintSha256: digest({ window: window.map((fill) => digest(fill)), incomplete: incomplete.map((fill) => fill.runtimeExecutionCostEvidence!.evidenceFingerprintSha256) }) } });
    // In-memory ownership changes only after both durable records commit.
    this.openPeriods.delete(input.periodId);
    this.openPeriods.set(next.periodId, next);
    this.emit({ type: "PERIOD_REJECTED", periodId: input.periodId, occurredAt: input.periodEndAt,
      reasonCode: "INCOMPLETE_EXECUTION_COST_EVIDENCE", retirementEvidenceFingerprintSha256: disposition.evidenceFingerprintSha256 });
    this.emit({ type: "PERIOD_OPEN", periodId: next.periodId, occurredAt: next.periodStartAt });
    return Object.freeze({ disposition, successor: next });
  }

  private finalizeEnvelope(envelope: PersistedPaperPeriodEnvelope): PersistedPaperPeriodEnvelope {
    const periodId = envelope.record.recordId;
    const validated = validateEnvelope(envelope);
    const current = this.openPeriods.get(periodId);
    if (current == null) {
      const existing = this.repository.list().find((item) => item.record.recordId === periodId);
      if (existing != null && canonical(existing) === canonical(validated)) return existing;
      if (existing != null) throw new PaperRealizedPeriodProducerError("PERIOD_ID_CONFLICT", "realized PAPER period was reused with different evidence", periodId);
      throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
    }
    if (current.observationIds.length === 0) throw new PaperRealizedPeriodProducerError("PERIOD_OUTCOME_NOT_OBSERVED", "PAPER period cannot be realized without a runtime observation", periodId);
    if (!samePlanIdentity(current, { periodId: validated.record.recordId, periodIndex: validated.record.periodIndex, advisory: validated.record.advisory, candidateProvenance: validated.candidateProvenance, periodStartAt: validated.record.periodStartAt, market: validated.record.market })) throw new PaperRealizedPeriodProducerError("PROVENANCE_CONFLICT", "realized PAPER outcome does not match its open candidate/advisory provenance", periodId);
    const pending = this.repository.getPending(periodId);
    if (pending == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
    const stored = this.repository.finalizePending(periodId, pending.checksum, validated);
    this.lastRetention = this.repository.prune(this.options.maximumPeriods ?? 100, this.options.retentionGuard);
    this.openPeriods.delete(periodId);
    this.emit({ type: "PERIOD_REALIZED_PERSISTED", periodId, occurredAt: validated.record.periodEndAt });
    return stored;
  }

  /**
   * Retires the open period when the canonical PAPER account it was opened against was replaced
   * (a different initial capital means a different account). Its outcome can never be reconciled
   * against the new account, and only one period may be open, so without this the learning loop
   * would stay blocked forever. Only a period whose boundary provably differs is retired.
   */
  public retireOpenPeriodForReplacement(periodId: string, reason: string): PersistedPaperRealizedPeriodPlan {
    const normalizedReason = reason.trim();
    if (!normalizedReason.startsWith("SUPERSEDED_BY_QUALIFIED_CHALLENGER:")) throw new PaperRealizedPeriodProducerError("INVALID_RETIREMENT_REASON", "PAPER period replacement reason is invalid", periodId);
    const current = this.openPeriods.get(periodId);
    if (current == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
    if (!isOwnerBaselinePeriodInput(current)) throw new PaperRealizedPeriodProducerError("PERIOD_REPLACEMENT_FORBIDDEN", "only canonical owner baseline periods may be replaced by a qualified challenger", periodId);
    const pending = this.repository.getPending(periodId);
    if (pending == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
    this.repository.retirePending(periodId, pending.checksum);
    this.openPeriods.delete(periodId);
    this.emit({ type: "PERIOD_REJECTED", periodId, occurredAt: this.options.now?.() ?? Date.now(), reasonCode: "SUPERSEDED_BY_QUALIFIED_CHALLENGER" });
    return current;
  }

  /**
   * Retires the open period when it is bound to a market the runtime no longer streams. Its benchmark can only
   * come from that market's public ticker observations, so it can never close; only one period may be open, so
   * without this the learning loop stays blocked forever. A period without a market, or whose market is still
   * streamed, is never retired. Nothing is closed or scored: the period simply leaves the open set.
   */
  public retireOpenPeriodForUnstreamedMarket(periodId: string, streamedMarkets: readonly string[]): PersistedPaperRealizedPeriodPlan {
    try {
      const current = this.openPeriods.get(periodId);
      if (current == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
      const streamed = new Set(streamedMarkets.map((market) => market.trim().toUpperCase()));
      if (streamed.size === 0) throw new PaperRealizedPeriodProducerError("STREAMED_MARKETS_UNAVAILABLE", "runtime streamed markets are unavailable", periodId);
      if (current.market == null || streamed.has(current.market)) throw new PaperRealizedPeriodProducerError("MARKET_STILL_STREAMED", "PAPER period market is still streamed", periodId);
      const pending = this.repository.getPending(periodId);
      if (pending == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
      this.repository.retirePending(periodId, pending.checksum);
      this.openPeriods.delete(periodId);
      this.emit({ type: "PERIOD_REJECTED", periodId, occurredAt: this.options.now?.() ?? Date.now(), reasonCode: "MARKET_NOT_STREAMED" });
      return current;
    } catch (error) { throw error instanceof PaperRealizedPeriodProducerError ? error : this.reject(error, periodId); }
  }

  /**
   * Inspects the open period against the canonical fill ledger. Returns the retirement receipt only when the window
   * (periodStartAt, canonical account updatedAt] holds fills from more than one candidate binding; otherwise null.
   * Read-only and deterministic. A mixed window can never become scorable (fills are immutable), so it may be retired
   * as soon as it is observed instead of waiting for the trading-day close.
   */
  public inspectOpenPeriodForMixedBinding(periodId: string): PaperPeriodMixedBindingReceipt | null {
    const current = this.openPeriods.get(periodId);
    if (current == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
    const reader = this.options.readCanonicalPaperAccount;
    if (reader == null) throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_UNAVAILABLE", "canonical PAPER account source is unavailable", periodId);
    let account: PaperAccountState;
    try { account = reader(); } catch { throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_UNAVAILABLE", "canonical PAPER account source could not be read", periodId); }
    const boundary = account.updatedAt;
    if (!Number.isSafeInteger(boundary) || boundary <= current.periodStartAt) return null;
    const fills = this.readCanonicalPaperFills(periodId) ?? account.fills;
    // A repeated fill identity is one fill (the canonical ledger forbids duplicates), so it cannot distort the counts.
    const unique = new Map<string, PaperFillRecord>();
    for (const fill of fills) if (!unique.has(fill.id)) unique.set(fill.id, fill);
    const window = [...unique.values()].filter((fill) => fill.filledAt > current.periodStartAt && fill.filledAt <= boundary)
      .sort((left, right) => left.filledAt - right.filledAt || left.id.localeCompare(right.id));
    const byBinding = new Map<string, { candidateId: string; bindingFingerprintSha256: string; fillCount: number }>();
    for (const fill of window) {
      const binding = fill.candidateProvenance?.binding;
      if (binding == null) continue;
      const entry = byBinding.get(binding.bindingFingerprintSha256) ?? { candidateId: binding.candidateId, bindingFingerprintSha256: binding.bindingFingerprintSha256, fillCount: 0 };
      byBinding.set(binding.bindingFingerprintSha256, { ...entry, fillCount: entry.fillCount + 1 });
    }
    if (byBinding.size < 2) return null;
    const bindings = [...byBinding.values()].sort((left, right) => left.bindingFingerprintSha256.localeCompare(right.bindingFingerprintSha256));
    const ledger = paperLedgerFingerprint({ ...account, fills: [...fills] });
    const core = {
      schemaVersion: 1 as const,
      reason: "CANDIDATE_BINDING_MIXED" as const,
      retiredPeriodId: periodId,
      periodStartAt: current.periodStartAt,
      retiredAtBoundary: boundary,
      bindings,
      fillIds: window.map((fill) => fill.id),
      fillCount: window.length,
      ledgerFingerprintSha256: ledger.ledgerFingerprintSha256,
      ledgerFillCount: ledger.fillCount,
      validPerformanceEvidence: false as const,
    };
    return Object.freeze({ ...core, evidenceFingerprintSha256: digest(core) });
  }

  /**
   * Retires an open period whose fills mix more than one candidate binding (CANDIDATE_BINDING_MIXED). Such a window can never be
   * attributed to a single strategy version, so it can never close; only one period may be open, so without this the learning
   * loop stays blocked forever. It re-derives the receipt itself and refuses (NOT_MIXED) unless the canonical fills prove the
   * mix. Nothing is closed or scored and no return, fill or cost is synthesized: the period leaves the open set and every fill
   * stays in the canonical ledger.
   */
  public retireOpenPeriodForMixedBinding(periodId: string): PersistedPaperRealizedPeriodPlan {
    try {
      const current = this.openPeriods.get(periodId);
      if (current == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
      const receipt = this.inspectOpenPeriodForMixedBinding(periodId);
      if (receipt == null) throw new PaperRealizedPeriodProducerError("NOT_MIXED", "PAPER period fills do not mix candidate bindings", periodId);
      const pending = this.repository.getPending(periodId);
      if (pending == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
      this.repository.retirePending(periodId, pending.checksum);
      this.openPeriods.delete(periodId);
      this.emit({ type: "PERIOD_REJECTED", periodId, occurredAt: this.options.now?.() ?? Date.now(), reasonCode: "CANDIDATE_BINDING_MIXED", retirementEvidenceFingerprintSha256: receipt.evidenceFingerprintSha256 });
      return current;
    } catch (error) { throw error instanceof PaperRealizedPeriodProducerError ? error : this.reject(error, periodId); }
  }

  public retireOpenPeriodForAccountChange(periodId: string): PersistedPaperRealizedPeriodPlan {
    try {
      const current = this.openPeriods.get(periodId);
      if (current == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
      if (current.accountBoundary == null) throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_BOUNDARY_UNAVAILABLE", "PAPER period was not opened from a canonical account boundary", periodId);
      const reader = this.options.readCanonicalPaperAccount;
      if (reader == null) throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_UNAVAILABLE", "canonical PAPER account source is unavailable", periodId);
      let account: PaperAccountState;
      try { account = reader(); } catch { throw new PaperRealizedPeriodProducerError("CANONICAL_ACCOUNT_UNAVAILABLE", "canonical PAPER account source could not be read", periodId); }
      if (!Number.isFinite(account?.initialCapital) || account.initialCapital === current.accountBoundary.initialCapital) {
        throw new PaperRealizedPeriodProducerError("ACCOUNT_NOT_CHANGED", "canonical PAPER account was not replaced", periodId);
      }
      const pending = this.repository.getPending(periodId);
      if (pending == null) throw new PaperRealizedPeriodProducerError("PERIOD_NOT_OPEN", "PAPER period is not open", periodId);
      this.repository.retirePending(periodId, pending.checksum);
      this.openPeriods.delete(periodId);
      this.emit({ type: "PERIOD_REJECTED", periodId, occurredAt: this.options.now?.() ?? Date.now(), reasonCode: "ACCOUNT_REPLACED" });
      return current;
    } catch (error) { throw error instanceof PaperRealizedPeriodProducerError ? error : this.reject(error, periodId); }
  }

  public nextPeriodIndex(): number { return this.repository.nextPeriodIndex(); }

  public listRealizedPeriods(): readonly PersistedPaperPeriodEnvelope[] {
    try { return this.repository.list(); }
    catch (error) { throw this.reject(error); }
  }
  public listOpenPeriods(): readonly PersistedPaperRealizedPeriodPlan[] { return freeze([...this.openPeriods.values()].sort((left, right) => left.periodIndex - right.periodIndex || left.periodId.localeCompare(right.periodId))); }
  public hasOpenPeriod(): boolean { return this.openPeriods.size > 0; }

  private emit(event: PaperRealizedPeriodLifecycleEvent): void { try { this.options.onLifecycleEvent?.(event); } catch { /* lifecycle telemetry cannot alter PAPER execution */ } }
  private reject(error: unknown, periodId?: string): PaperRealizedPeriodProducerError {
    const normalized = error instanceof PaperRealizedPeriodProducerError ? error : error instanceof PersistedPaperPeriodStoreError ? new PaperRealizedPeriodProducerError(error.code, error.message, error.recordId ?? periodId) : new PaperRealizedPeriodProducerError("PAPER_PERIOD_REJECTED", "PAPER realized period evidence was rejected", periodId);
    this.emit({ type: "PERIOD_REJECTED", periodId: normalized.periodId ?? periodId ?? "unknown", occurredAt: this.options.now?.() ?? Date.now(), reasonCode: normalized.code });
    return normalized;
  }
}

export { SqlitePersistedPaperPeriodStore as SqlitePaperRealizedPeriodRepository };

export function paperExecutionObservationId(market: string, observedAt: number, status: string): string {
  return `paper-runtime:${digest({ market: market.trim().toUpperCase(), observedAt, status }).slice(0, 32)}`;
}
