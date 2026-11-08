import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../../../packages/storage/src/index";
import { validatePersonalPaperOrderCommand, type PersonalPaperOrderCommand } from "../../../packages/contracts/src/personalPaperOrderCommand";
import { validatePaperCandidateExecutionBinding, type CioDecision, type PaperCandidateExecutionBinding } from "./cioDecisionEngine";
import type { MobileDashboardApiInput } from "./mobileDashboardApi";
import type { PortfolioPlan } from "./portfolioOrchestrator";
import { buildPaperObservedExecutionCostAttribution, buildPaperRuntimeExecutionCostEvidence, validatePaperObservedExecutionCostAttribution, validatePaperObservedExecutionQuote, type PaperObservedExecutionQuote, type PaperRuntimeExecutionCostEvidence, type PaperExecutionCostAttribution } from "./paperRuntimeExecutionCostEvidence";
import { validatePaperOrderBookQuoteReceipt, type PaperOrderBookQuoteReceipt } from "./paperOrderBookQuoteReceipt";
import { guardCashInvestmentAllocation } from "../../mobile/src/capitalAllocationGuard";
import { LEGACY_PAPER_ACCOUNTING_MIGRATION_VERSION, assertPaperAccountingReconciled, assertRecognizedLegacyPaperAccountingV1, projectPaperAccounting } from "./paperAccountingLedger";
import { createPaperOrderLifecycle, transitionPaperOrderLifecycle, validatePaperOrderLifecycle, type PaperOrderLifecycleState } from "./paperOrderLifecycle";
import { paperExecutionIntentCommandId, validatePaperExecutionIntent, type PaperExecutionIntent } from "./paperExecutionIntent";
import { buildPaperOrderBookExecutionReceipt, validatePaperOrderBookExecutionReceipt, PaperOrderBookExecutionError, type PaperOrderBookExecutionReceipt } from "./paperOrderBookExecution";

/** Account identity used by every PAPER deployment before per-capital accounts existed. */
export const LEGACY_PAPER_ACCOUNT_ID = "paper-default";
const LEGACY_PAPER_INITIAL_CAPITAL_KRW = 10_000_000;

/**
 * Canonical PAPER account identity for a configured initial capital (owner decision 2026-09-28).
 * The original KRW 10,000,000 account keeps its historical id; any other capital opens its own
 * account, so changing capital never rewrites, resets or deletes an existing ledger.
 */
export function paperAccountIdForCapital(initialCapitalKrw: number): string {
  if (!Number.isFinite(initialCapitalKrw) || initialCapitalKrw <= 0) throw new Error("paper initial capital must be positive");
  if (initialCapitalKrw === LEGACY_PAPER_INITIAL_CAPITAL_KRW) return LEGACY_PAPER_ACCOUNT_ID;
  const normalized = Number.isInteger(initialCapitalKrw) ? String(initialCapitalKrw) : String(initialCapitalKrw).replace(".", "_");
  return `paper-krw-${normalized}`;
}
const SCHEMA_VERSION = 1;
const LEDGER_ROUND_SCALE = 100_000_000n;
const round8 = (value: number): number => Number(value.toFixed(8));
const floor8 = (value: number): number => Math.floor((value + Number.EPSILON) * 100_000_000) / 100_000_000;
const toScaledLedgerAmount = (value: number): bigint => BigInt(Math.round(value * Number(LEDGER_ROUND_SCALE)));
const fromScaledLedgerAmount = (value: bigint): number => Number(value) / Number(LEDGER_ROUND_SCALE);
function divideRound8(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new Error("division denominator must be positive");
  return fromScaledLedgerAmount((numerator + denominator / 2n) / denominator);
}
const finiteNonNegative = (value: number, name: string): void => { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`); };
const SHA256 = /^[a-f0-9]{64}$/;

export interface PaperExecutionProfile {
  readonly schemaVersion: 1;
  readonly engineVersion: "cloud-paper-execution-v1";
  readonly feeRate: number;
  readonly slippageBps: number;
  readonly spreadBps: number;
  readonly maxFillRatio: number;
  readonly latencyTicks: number;
  readonly fingerprintSha256: string;
}
function buildExecutionProfile(input: Omit<PaperExecutionProfile, "schemaVersion" | "engineVersion" | "fingerprintSha256">): PaperExecutionProfile {
  for (const [name, value] of [["feeRate", input.feeRate], ["slippageBps", input.slippageBps], ["spreadBps", input.spreadBps]] as const) finiteNonNegative(value, name);
  if (!Number.isFinite(input.maxFillRatio) || input.maxFillRatio <= 0 || input.maxFillRatio > 1) throw new Error("maxFillRatio must be in (0, 1]");
  if (!Number.isSafeInteger(input.latencyTicks) || input.latencyTicks < 0) throw new Error("latencyTicks must be a non-negative integer");
  const canonical = Object.freeze({ schemaVersion: 1 as const, engineVersion: "cloud-paper-execution-v1" as const, ...input });
  const fingerprintSha256 = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return Object.freeze({ ...canonical, fingerprintSha256 });
}
function validateExecutionProfile(profile: PaperExecutionProfile): PaperExecutionProfile {
  const rebuilt = buildExecutionProfile({ feeRate: profile.feeRate, slippageBps: profile.slippageBps, spreadBps: profile.spreadBps, maxFillRatio: profile.maxFillRatio, latencyTicks: profile.latencyTicks });
  if (profile.schemaVersion !== 1 || profile.engineVersion !== "cloud-paper-execution-v1" || JSON.stringify(profile) !== JSON.stringify(rebuilt)) throw new Error("paper execution profile is invalid");
  return profile;
}

function deterministicFill(profile: PaperExecutionProfile, side: "BUY" | "SELL", requestedQuantity: number, quotePrice: number, liquidityBaseQuantity = requestedQuantity): Readonly<{ quantity: number; price: number }> {
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0 || !Number.isFinite(liquidityBaseQuantity) || liquidityBaseQuantity <= 0 || !Number.isFinite(quotePrice) || quotePrice <= 0) throw new Error("paper fill input is invalid");
  const quantity = Math.min(requestedQuantity, round8(liquidityBaseQuantity * profile.maxFillRatio));
  if (quantity <= 0) throw new Error("paper liquidity model produced zero fill");
  const adverseBps = profile.slippageBps + profile.spreadBps / 2;
  const multiplier = side === "BUY" ? 1 + adverseBps / 10_000 : 1 - adverseBps / 10_000;
  const price = round8(quotePrice * multiplier);
  if (!Number.isFinite(price) || price <= 0) throw new Error("paper execution profile produced invalid fill price");
  return Object.freeze({ quantity, price });
}

export interface PaperAccountPosition {
  readonly market: string;
  readonly quantity: number;
  readonly averageEntryPrice: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly markPrice: number;
}
export interface PaperOrderRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly market: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly price: number;
  readonly fee: number;
  readonly status: "FILLED" | "CANCELLED";
  readonly createdAt: number;
  readonly filledAt: number;
  readonly requestFingerprint?: string;
  /** Canonical lifecycle evidence. Optional only for persisted schema-v1 compatibility. */
  readonly lifecycle?: PaperOrderLifecycleState;
  readonly executionProfile?: PaperExecutionProfile;
}
export interface PaperWorkingOrderRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly market: string;
  readonly side: "BUY" | "SELL";
  readonly orderType: "MARKET" | "LIMIT";
  readonly requestedQuantity: number;
  readonly limitPrice?: number;
  readonly createdAt: number;
  readonly requestFingerprint: string;
  readonly lifecycle: PaperOrderLifecycleState;
  readonly executionProfile: PaperExecutionProfile;
  /** Number of deterministic fill attempts observed since OPEN. */
  readonly observedTicks?: number;
  /** Present only for canonical automatic strategy working orders. */
  readonly candidateProvenance?: PaperFillCandidateProvenance;
  /** Immutable PortfolioPlan-derived intent retained across restart-safe partial fills. */
  readonly executionIntent?: PaperExecutionIntent;
  /** Remaining BUY gross-notional budget from the original immutable execution intent. SELL uses null. */
  readonly remainingAllocationCapital?: number | null;
  /** Last public orderbook snapshot actually consumed or rejected for liquidity by this strategy order. */
  readonly lastOrderBookObservedAt?: number;
}
export interface PaperFillCandidateProvenance {
  readonly schemaVersion: 1;
  readonly source: "CIO_DECISION_BINDING";
  readonly decisionAt: number;
  readonly binding: PaperCandidateExecutionBinding;
}
export interface PaperFillRecord {
  readonly id: string;
  readonly orderId: string;
  readonly market: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly price: number;
  readonly fee: number;
  readonly filledAt: number;
  /** Immutable execution-model identity for canonical working-order fills. */
  readonly executionProfileFingerprintSha256?: string;
  readonly executionEngineVersion?: PaperExecutionProfile["engineVersion"];
  /** Canonical public best-quote receipt retained with the fill for restart-safe attribution. */
  readonly orderBookQuoteReceipt?: PaperOrderBookQuoteReceipt;
  /** Derived depth/VWAP execution facts. Stores only consumed levels, never the full raw book. */
  readonly orderBookExecutionReceipt?: PaperOrderBookExecutionReceipt;
  /** Point-in-time candidate binding copied from the exact CIO decision that caused this strategy fill. */
  readonly candidateProvenance?: PaperFillCandidateProvenance;
  /** Canonical PortfolioPlan-derived execution intent that crossed the risk boundary. */
  readonly executionIntent?: PaperExecutionIntent;
  /**
   * Canonical boundary evidence for only the execution costs the simulator actually observed.
   * This remains INCOMPLETE until trusted spread/slippage evidence completes it, so it cannot
   * satisfy realized-period admission on its own.
   */
  readonly runtimeExecutionCostEvidence?: PaperRuntimeExecutionCostEvidence;
  /** Complete observed cost attribution, present only when a fresh public quote was captured. */
  readonly executionCostAttribution?: PaperExecutionCostAttribution;
}
export interface PaperAccountState {
  readonly version: 1;
  readonly initialCapital: number;
  readonly cash: number;
  readonly equity: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly positions: readonly PaperAccountPosition[];
  readonly orders: readonly PaperOrderRecord[];
  readonly fills: readonly PaperFillRecord[];
  readonly processedIdempotencyKeys: readonly string[];
  /** Restart-safe non-terminal orders. Optional only for persisted schema-v1 compatibility. */
  readonly workingOrders?: readonly PaperWorkingOrderRecord[];
  readonly updatedAt: number;
}
export interface PaperAccountRepository { save(state: PaperAccountState): void; loadLatest(): PaperAccountState | undefined; loadHistory?: () => readonly PaperAccountState[]; loadFills?: () => readonly PaperFillRecord[]; clear(): void; startWriterLease?: () => void; close?: () => void; }

export interface PaperWriterLeaseOptions {
  /** Canonical PAPER account this repository owns; defaults to the legacy account. */
  readonly accountId?: string;
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly ownerId?: string;
  readonly maxClockAdvanceMs?: number;
  readonly maxTakeoverAgeMs?: number;
  readonly deferWriterLease?: boolean;
  readonly onWriterLeaseReady?: (initializationMs: number) => void;
}

/**
 * Short, secret-free description of why saving the PAPER account failed (error code and message, characters
 * limited to letters, digits and a few separators, so no path or payload can ride along). The reason string of the
 * result stays exactly "paper account persistence failed"; this is only for the owner's advanced diagnostic line.
 */
export function describePersistenceFailure(error: unknown): string {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const detail = typeof (error as { detail?: unknown } | null)?.detail === "string" ? (error as { detail: string }).detail : "";
  const clean = `${code} ${message} ${detail}`.replace(/[^A-Za-z0-9 _.-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 170);
  return clean === "" ? "UNKNOWN" : clean;
}

export class SqliteCloudPaperAccountRepository implements PaperAccountRepository {
  private readonly ownerId: string;
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxClockAdvanceMs: number;
  private readonly maxTakeoverAgeMs: number;
  private readonly onWriterLeaseReady?: (initializationMs: number) => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private writerLeaseStarted = false;
  private leaseLost = false;
  private leaseFailure: unknown;
  private lastObservedNowMs = 0;
  private readonly accountId: string;
  public constructor(private readonly db: SqliteDatabase, options: PaperWriterLeaseOptions = {}) {
    this.accountId = options.accountId ?? LEGACY_PAPER_ACCOUNT_ID;
    if (!/^paper-[a-z0-9_-]{1,64}$/.test(this.accountId)) throw new Error("paper account id is invalid");
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 3));
    this.maxClockAdvanceMs = options.maxClockAdvanceMs ?? Math.max(this.leaseDurationMs * 2, 60_000);
    this.maxTakeoverAgeMs = options.maxTakeoverAgeMs ?? this.leaseDurationMs * 4;
    this.onWriterLeaseReady = options.onWriterLeaseReady;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000) throw new Error("paper writer lease duration is invalid");
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1_000 || this.heartbeatIntervalMs >= this.leaseDurationMs) throw new Error("paper writer heartbeat interval is invalid");
    if (!Number.isSafeInteger(this.maxClockAdvanceMs) || this.maxClockAdvanceMs < this.leaseDurationMs) throw new Error("paper writer clock advance limit is invalid");
    if (!Number.isSafeInteger(this.maxTakeoverAgeMs) || this.maxTakeoverAgeMs < this.leaseDurationMs) throw new Error("paper writer takeover age limit is invalid");
    if (!options.deferWriterLease) this.startWriterLease();
  }
  public startWriterLease(): void {
    if (this.writerLeaseStarted) return;
    if (this.closed) throw new Error("PAPER_WRITER_REPOSITORY_CLOSED");
    const startedAt = performance.now();
    try {
      this.acquireLease();
      this.writerLeaseStarted = true;
      this.recoverRecognizedLegacyAccounting();
      this.backfillFillLedgerFromHistory();
      const timer = setInterval(() => this.heartbeatLease(), this.heartbeatIntervalMs);
      timer.unref?.();
      this.heartbeat = timer;
      this.onWriterLeaseReady?.(performance.now() - startedAt);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  public save(state: PaperAccountState): void {
    validateState(state);
    const stateJson = JSON.stringify(state);
    this.db.transaction(() => {
      this.assertLeaseHeld();
      this.appendFillLedgerRows(state.fills);
      this.assertFillLedgerReconcilesState(state);
      this.db.connection.prepare(`
        INSERT INTO cloud_paper_accounts (account_id, schema_version, updated_at, state_json, checksum, status)
        VALUES (?, ?, ?, ?, ?, 'VALID')
        ON CONFLICT(account_id) DO UPDATE SET schema_version=excluded.schema_version, updated_at=excluded.updated_at,
          state_json=excluded.state_json, checksum=excluded.checksum, status='VALID'
      `).run(this.accountId, SCHEMA_VERSION, state.updatedAt, stateJson, accountChecksum(state));
    });
  }
  public loadLatest(): PaperAccountState | undefined {
    this.assertLeaseHeld();
    const row = this.db.connection.prepare("SELECT * FROM cloud_paper_accounts WHERE account_id = ? AND status = 'VALID'").get(this.accountId) as Record<string, string | number | null> | undefined;
    if (row == null) return undefined;
    try {
      if (Number(row.schema_version) !== SCHEMA_VERSION) throw new Error("unsupported paper account schema");
      const state = JSON.parse(String(row.state_json)) as PaperAccountState;
      validateState(state);
      if (String(row.checksum) !== accountChecksum(state)) throw new Error("paper account checksum mismatch");
      this.assertFillLedgerReconcilesState(state);
      return state;
    } catch (error) {
      this.db.connection.prepare("UPDATE cloud_paper_accounts SET status = 'CORRUPTED' WHERE account_id = ?").run(this.accountId);
      throw error;
    }
  }
  public loadHistory(): readonly PaperAccountState[] {
    this.assertLeaseHeld();
    const rows = this.db.connection.prepare(
      "SELECT schema_version, updated_at, state_json, checksum FROM cloud_paper_account_history WHERE account_id = ? ORDER BY updated_at ASC"
    ).all(this.accountId) as Array<Record<string, string | number | null>>;
    return Object.freeze(rows.map((row) => {
      if (Number(row.schema_version) !== SCHEMA_VERSION) throw new Error("unsupported paper account history schema");
      const state = JSON.parse(String(row.state_json)) as PaperAccountState;
      validateState(state, "canonical-or-recognized-legacy");
      if (Number(row.updated_at) !== state.updatedAt || String(row.checksum) !== accountChecksum(state)) throw new Error("paper account history checksum mismatch");
      return state;
    }));
  }
  public loadFills(): readonly PaperFillRecord[] {
    this.assertLeaseHeld();
    return this.readFillLedgerRows();
  }
  /** Verify the existing writer boundary before a supervised learning tick can proceed. */
  public verifyWriterLease(): void {
    this.db.transaction(() => this.assertLeaseHeld());
  }
  public clear(): void {
    this.db.transaction(() => {
      this.assertLeaseHeld();
      this.db.connection.prepare("DELETE FROM cloud_paper_fill_ledger WHERE account_id = ?").run(this.accountId);
      this.db.connection.prepare("DELETE FROM cloud_paper_account_history WHERE account_id = ?").run(this.accountId);
      this.db.connection.prepare("DELETE FROM cloud_paper_accounts WHERE account_id = ?").run(this.accountId);
    });
  }
  private fillChecksum(fill: PaperFillRecord): string {
    return createHash("sha256").update(JSON.stringify(fill), "utf8").digest("hex");
  }
  private appendFillLedgerRows(fills: readonly PaperFillRecord[]): void {
    const ordered = [...fills].sort((left, right) => left.filledAt - right.filledAt || left.id.localeCompare(right.id));
    let sequence = Number((this.db.connection.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM cloud_paper_fill_ledger WHERE account_id = ?"
    ).get(this.accountId) as Record<string, number | bigint>).sequence);
    for (const fill of ordered) {
      const fillJson = JSON.stringify(fill);
      const checksum = this.fillChecksum(fill);
      const existing = this.db.connection.prepare(
        "SELECT fill_json, checksum, filled_at FROM cloud_paper_fill_ledger WHERE account_id = ? AND fill_id = ?"
      ).get(this.accountId, fill.id) as Record<string, string | number> | undefined;
      if (existing != null) {
        if (String(existing.fill_json) !== fillJson || String(existing.checksum) !== checksum || Number(existing.filled_at) !== fill.filledAt) {
          throw new Error("PAPER_FILL_LEDGER_CONFLICT");
        }
        continue;
      }
      sequence += 1;
      this.db.connection.prepare(
        "INSERT INTO cloud_paper_fill_ledger(account_id,sequence,fill_id,filled_at,fill_json,checksum) VALUES(?,?,?,?,?,?)"
      ).run(this.accountId, sequence, fill.id, fill.filledAt, fillJson, checksum);
    }
  }
  private readFillLedgerRows(): readonly PaperFillRecord[] {
    const rows = this.db.connection.prepare(
      "SELECT sequence, fill_id, filled_at, fill_json, checksum FROM cloud_paper_fill_ledger WHERE account_id = ? ORDER BY sequence ASC"
    ).all(this.accountId) as Array<Record<string, string | number>>;
    const ids = new Set<string>();
    return Object.freeze(rows.map((row, index) => {
      if (Number(row.sequence) !== index + 1) throw new Error("PAPER_FILL_LEDGER_SEQUENCE_GAP");
      const fill = JSON.parse(String(row.fill_json)) as PaperFillRecord;
      if (!fill.id.trim() || ids.has(fill.id) || fill.id !== String(row.fill_id) || fill.filledAt !== Number(row.filled_at)) throw new Error("PAPER_FILL_LEDGER_IDENTITY_INVALID");
      ids.add(fill.id);
      if (String(row.checksum) !== this.fillChecksum(fill)) throw new Error("PAPER_FILL_LEDGER_CHECKSUM_MISMATCH");
      return fill;
    }));
  }
  private assertFillLedgerReconcilesState(state: PaperAccountState): void {
    const fills = this.readFillLedgerRows();
    if (fills.length === 0 && state.fills.length === 0) return;
    const byId = new Map(fills.map((fill) => [fill.id, JSON.stringify(fill)]));
    for (const fill of state.fills) {
      if (byId.get(fill.id) !== JSON.stringify(fill)) throw new Error("PAPER_FILL_LEDGER_STATE_CONFLICT");
    }
    assertPaperAccountingReconciled({
      initialCapital: state.initialCapital,
      fills,
      cash: state.cash,
      realizedPnL: state.realizedPnL,
      positions: state.positions
    });
  }
  private recoverRecognizedLegacyAccounting(): void {
    const row = this.db.connection.prepare(
      "SELECT schema_version, updated_at, state_json, checksum, status FROM cloud_paper_accounts WHERE account_id = ?"
    ).get(this.accountId) as Record<string, string | number | null> | undefined;
    if (row == null || Number(row.schema_version) !== SCHEMA_VERSION) return;
    const sourceStatus = String(row.status);
    if (sourceStatus !== "VALID" && sourceStatus !== "CORRUPTED") {
      throw new Error("PAPER_LEGACY_RECONCILIATION_STATUS_NOT_RECOVERABLE");
    }
    const ledgerCount = Number((this.db.connection.prepare(
      "SELECT COUNT(*) AS count FROM cloud_paper_fill_ledger WHERE account_id = ?"
    ).get(this.accountId) as Record<string, number | bigint>).count);
    if (ledgerCount !== 0) {
      // Preserve constructor-time fail-closed integrity checks without replaying the
      // full account-history projection. This validates sequence, identity and checksum
      // for canonical fill truth while keeping startup work bounded to the fill ledger.
      this.readFillLedgerRows();
      return;
    }

    const sourceState = JSON.parse(String(row.state_json)) as PaperAccountState;
    const sourceChecksum = String(row.checksum);
    if (sourceChecksum !== accountChecksum(sourceState)) throw new Error("PAPER_LEGACY_RECONCILIATION_SOURCE_CHECKSUM_MISMATCH");
    validateState(sourceState, "canonical-or-recognized-legacy");
    const accountingInput = {
      initialCapital: sourceState.initialCapital,
      fills: sourceState.fills,
      cash: sourceState.cash,
      realizedPnL: sourceState.realizedPnL,
      positions: sourceState.positions,
    };
    try {
      assertPaperAccountingReconciled(accountingInput);
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PAPER_LEDGER_RECONCILIATION_REQUIRED") throw error;
    }
    assertRecognizedLegacyPaperAccountingV1(accountingInput);

    const history = this.loadHistory();
    const latest = history.at(-1);
    if (latest == null || JSON.stringify(latest) !== JSON.stringify(sourceState)) {
      throw new Error("PAPER_LEGACY_RECONCILIATION_HISTORY_TIP_MISMATCH");
    }
    const fillsById = new Map<string, PaperFillRecord>();
    const sourceProcessedKeys = new Set(sourceState.processedIdempotencyKeys);
    const orderIdByKey = new Map<string, string>();
    const orderKeyById = new Map<string, string>();
    for (const state of history) {
      for (const order of [...state.orders, ...(state.workingOrders ?? [])]) {
        if (!sourceProcessedKeys.has(order.idempotencyKey)) {
          throw new Error("PAPER_LEGACY_RECONCILIATION_ORPHAN_EXECUTION_IDENTITY");
        }
        const previousOrderId = orderIdByKey.get(order.idempotencyKey);
        if (previousOrderId != null && previousOrderId !== order.id) {
          throw new Error("PAPER_LEGACY_RECONCILIATION_ORDER_IDENTITY_CONFLICT");
        }
        const previousKey = orderKeyById.get(order.id);
        if (previousKey != null && previousKey !== order.idempotencyKey) {
          throw new Error("PAPER_LEGACY_RECONCILIATION_ORDER_IDENTITY_CONFLICT");
        }
        orderIdByKey.set(order.idempotencyKey, order.id);
        orderKeyById.set(order.id, order.idempotencyKey);
      }
      for (const fill of state.fills) {
        if (!orderKeyById.has(fill.orderId)) {
          throw new Error("PAPER_LEGACY_RECONCILIATION_ORPHAN_FILL_IDENTITY");
        }
        const previous = fillsById.get(fill.id);
        if (previous != null && JSON.stringify(previous) !== JSON.stringify(fill)) {
          throw new Error("PAPER_LEGACY_RECONCILIATION_FILL_CONFLICT");
        }
        fillsById.set(fill.id, fill);
      }
    }
    if (!sourceState.processedIdempotencyKeys.every((key) => orderIdByKey.has(key))) {
      throw new Error("PAPER_LEGACY_RECONCILIATION_HISTORY_INCOMPLETE");
    }
    for (const fill of sourceState.fills) {
      if (JSON.stringify(fillsById.get(fill.id)) !== JSON.stringify(fill)) {
        throw new Error("PAPER_LEGACY_RECONCILIATION_HISTORY_INCOMPLETE");
      }
    }
    const fills = Object.freeze([...fillsById.values()].sort((a, b) => a.filledAt - b.filledAt || a.id.localeCompare(b.id)));
    const marks = Object.fromEntries(sourceState.positions.map((position) => [position.market, position.markPrice]));
    const canonical = projectPaperAccounting(sourceState.initialCapital, fills, marks);
    if (round8(sourceState.cash) !== round8(canonical.cash)) {
      throw new Error("PAPER_LEGACY_RECONCILIATION_CASH_CHANGED");
    }
    const actualPositions = new Map(sourceState.positions.map((position) => [position.market, position]));
    if (canonical.positions.length !== actualPositions.size || canonical.positions.some((position) => {
      const actual = actualPositions.get(position.market);
      return actual == null || round8(actual.quantity) !== round8(position.quantity) || actual.markPrice !== position.markPrice;
    })) {
      throw new Error("PAPER_LEGACY_RECONCILIATION_POSITION_IDENTITY_CHANGED");
    }

    const existingReceiptRow = this.db.connection.prepare(`
      SELECT source_updated_at, fill_count, canonical_ledger_fingerprint, migrated_updated_at,
             migrated_account_checksum, receipt_json, receipt_checksum
      FROM cloud_paper_legacy_reconciliation_receipts
      WHERE account_id = ? AND migration_version = ? AND source_checksum = ?
    `).get(this.accountId, LEGACY_PAPER_ACCOUNTING_MIGRATION_VERSION, sourceChecksum) as Record<string, string | number | bigint> | undefined;
    let existingReceipt: Record<string, unknown> | undefined;
    if (existingReceiptRow != null) {
      const receiptJson = String(existingReceiptRow.receipt_json);
      const checksum = createHash("sha256").update(receiptJson, "utf8").digest("hex");
      if (String(existingReceiptRow.receipt_checksum) !== checksum) {
        throw new Error("PAPER_LEGACY_RECONCILIATION_RECEIPT_CHECKSUM_MISMATCH");
      }
      try { existingReceipt = JSON.parse(receiptJson) as Record<string, unknown>; }
      catch { throw new Error("PAPER_LEGACY_RECONCILIATION_RECEIPT_INVALID"); }
      if (
        Number(existingReceiptRow.source_updated_at) !== sourceState.updatedAt ||
        Number(existingReceiptRow.fill_count) !== fills.length ||
        String(existingReceiptRow.canonical_ledger_fingerprint) !== canonical.fingerprintSha256 ||
        existingReceipt.schemaVersion !== 1 ||
        existingReceipt.migrationVersion !== LEGACY_PAPER_ACCOUNTING_MIGRATION_VERSION ||
        existingReceipt.accountId !== this.accountId ||
        Number(existingReceipt.sourceUpdatedAt) !== sourceState.updatedAt ||
        existingReceipt.sourceChecksum !== sourceChecksum ||
        Number(existingReceipt.fillCount) !== fills.length ||
        existingReceipt.canonicalLedgerFingerprintSha256 !== canonical.fingerprintSha256
      ) {
        throw new Error("PAPER_LEGACY_RECONCILIATION_RECEIPT_CONFLICT");
      }
    }
    const migratedUpdatedAt = existingReceiptRow == null
      ? Math.max(sourceState.updatedAt + 1, this.now())
      : Number(existingReceiptRow.migrated_updated_at);
    if (!Number.isSafeInteger(migratedUpdatedAt) || migratedUpdatedAt <= sourceState.updatedAt) throw new Error("PAPER_LEGACY_RECONCILIATION_TIMESTAMP_INVALID");
    const unrealizedPnL = round8(canonical.positions.reduce((sum, position) => sum + position.unrealizedPnL, 0));
    const equity = round8(canonical.cash + canonical.positions.reduce((sum, position) => sum + position.quantity * position.markPrice, 0));
    const migratedState = Object.freeze({
      ...sourceState,
      cash: canonical.cash,
      equity,
      realizedPnL: canonical.realizedPnL,
      unrealizedPnL,
      positions: canonical.positions,
      updatedAt: migratedUpdatedAt,
    });
    validateState(migratedState);
    const migratedStateJson = JSON.stringify(migratedState);
    const migratedChecksum = accountChecksum(migratedState);
    const receipt = Object.freeze({
      schemaVersion: 1,
      migrationVersion: LEGACY_PAPER_ACCOUNTING_MIGRATION_VERSION,
      accountId: this.accountId,
      sourceUpdatedAt: sourceState.updatedAt,
      sourceChecksum,
      fillCount: fills.length,
      canonicalLedgerFingerprintSha256: canonical.fingerprintSha256,
      migratedUpdatedAt,
      migratedAccountChecksum: migratedChecksum,
    });
    const receiptJson = JSON.stringify(receipt);
    const receiptChecksum = createHash("sha256").update(receiptJson, "utf8").digest("hex");
    if (existingReceiptRow != null && (
      String(existingReceiptRow.migrated_account_checksum) !== migratedChecksum ||
      existingReceipt?.migratedUpdatedAt !== migratedUpdatedAt ||
      existingReceipt?.migratedAccountChecksum !== migratedChecksum ||
      String(existingReceiptRow.receipt_json) !== receiptJson ||
      String(existingReceiptRow.receipt_checksum) !== receiptChecksum
    )) {
      throw new Error("PAPER_LEGACY_RECONCILIATION_RECEIPT_CONFLICT");
    }

    this.db.transaction(() => {
      this.assertLeaseHeld();
      const current = this.db.connection.prepare(
        "SELECT checksum, status FROM cloud_paper_accounts WHERE account_id = ?"
      ).get(this.accountId) as Record<string, string> | undefined;
      if (current == null || String(current.checksum) !== sourceChecksum) {
        throw new Error("PAPER_LEGACY_RECONCILIATION_SOURCE_MOVED");
      }
      if (String(current.status) !== sourceStatus || (sourceStatus !== "VALID" && sourceStatus !== "CORRUPTED")) {
        throw new Error("PAPER_LEGACY_RECONCILIATION_STATUS_MOVED");
      }
      const transactionReceipt = this.db.connection.prepare(`
        SELECT receipt_json, receipt_checksum
        FROM cloud_paper_legacy_reconciliation_receipts
        WHERE account_id = ? AND migration_version = ? AND source_checksum = ?
      `).get(this.accountId, LEGACY_PAPER_ACCOUNTING_MIGRATION_VERSION, sourceChecksum) as Record<string, string> | undefined;
      if ((transactionReceipt == null) !== (existingReceiptRow == null)
        || (transactionReceipt != null && (
          String(transactionReceipt.receipt_json) !== receiptJson
          || String(transactionReceipt.receipt_checksum) !== receiptChecksum
        ))) {
        throw new Error("PAPER_LEGACY_RECONCILIATION_RECEIPT_MOVED");
      }
      const currentLedgerCount = Number((this.db.connection.prepare(
        "SELECT COUNT(*) AS count FROM cloud_paper_fill_ledger WHERE account_id = ?"
      ).get(this.accountId) as Record<string, number | bigint>).count);
      if (currentLedgerCount !== 0) throw new Error("PAPER_LEGACY_RECONCILIATION_LEDGER_NOT_EMPTY");

      this.appendFillLedgerRows(fills);
      this.assertFillLedgerReconcilesState(migratedState);
      const updated = this.db.connection.prepare(`
        UPDATE cloud_paper_accounts
        SET schema_version = ?, updated_at = ?, state_json = ?, checksum = ?, status = 'VALID'
        WHERE account_id = ? AND checksum = ? AND status = ?
      `).run(SCHEMA_VERSION, migratedUpdatedAt, migratedStateJson, migratedChecksum, this.accountId, sourceChecksum, sourceStatus);
      if (Number(updated.changes) !== 1) throw new Error("PAPER_LEGACY_RECONCILIATION_ACCOUNT_UPDATE_FAILED");
      this.db.connection.prepare(`
        INSERT INTO cloud_paper_legacy_reconciliation_receipts(
          account_id, migration_version, source_updated_at, source_checksum, fill_count,
          canonical_ledger_fingerprint, migrated_updated_at, migrated_account_checksum,
          receipt_json, receipt_checksum
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id, migration_version, source_checksum) DO NOTHING
      `).run(
        this.accountId,
        LEGACY_PAPER_ACCOUNTING_MIGRATION_VERSION,
        sourceState.updatedAt,
        sourceChecksum,
        fills.length,
        canonical.fingerprintSha256,
        migratedUpdatedAt,
        migratedChecksum,
        receiptJson,
        receiptChecksum,
      );
    });
  }

  private backfillFillLedgerFromHistory(): void {
    const account = this.db.connection.prepare(
      "SELECT schema_version, updated_at, state_json, checksum FROM cloud_paper_accounts WHERE account_id = ? AND status = 'VALID'"
    ).get(this.accountId) as Record<string, string | number | null> | undefined;
    if (account == null) return;
    // A non-empty canonical fill ledger can only be created atomically by the existing
    // writer transactions. Re-reading every historical account snapshot here is therefore
    // unnecessary once canonical fill truth exists, and on a large PAPER database that
    // synchronous scan can outlive the writer lease before the event-loop heartbeat starts.
    // loadLatest()/save() still reconcile the canonical ledger against account state and fail
    // closed on any identity/accounting conflict.
    const ledgerCount = Number((this.db.connection.prepare(
      "SELECT COUNT(*) AS count FROM cloud_paper_fill_ledger WHERE account_id = ?"
    ).get(this.accountId) as Record<string, number | bigint>).count);
    if (ledgerCount !== 0) {
      // Keep restart work bounded without weakening constructor-time integrity. The current
      // account snapshot is the projection the runtime will resume from, so validate its
      // embedded quote/depth/cost receipts and reconcile it against canonical fill truth.
      // This avoids replaying every historical snapshot while still failing closed if an
      // attacker recomputes the outer account checksum after tampering with receipt bytes.
      if (Number(account.schema_version) !== SCHEMA_VERSION) throw new Error("unsupported paper account schema");
      const state = JSON.parse(String(account.state_json)) as PaperAccountState;
      validateState(state);
      if (Number(account.updated_at) !== state.updatedAt || String(account.checksum) !== accountChecksum(state)) {
        throw new Error("paper account checksum mismatch");
      }
      this.assertFillLedgerReconcilesState(state);
      return;
    }
    const states = this.loadHistory();
    const fillsById = new Map<string, PaperFillRecord>();
    for (const state of states) {
      for (const fill of state.fills) {
        const previous = fillsById.get(fill.id);
        if (previous != null && JSON.stringify(previous) !== JSON.stringify(fill)) throw new Error("PAPER_FILL_LEDGER_HISTORY_CONFLICT");
        fillsById.set(fill.id, fill);
      }
    }
    this.db.transaction(() => {
      this.assertLeaseHeld();
      this.appendFillLedgerRows([...fillsById.values()]);
    });
  }
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat != null) clearInterval(this.heartbeat);
    try { this.db.transaction(() => { this.db.connection.prepare("DELETE FROM cloud_paper_writer_leases WHERE account_id = ? AND owner_id = ?").run(this.accountId, this.ownerId); }); } catch { /* DB close/recovery remains fail-closed until lease expiry. */ }
  }
  private acquireLease(): void {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("paper writer clock is invalid");
    this.db.transaction(() => {
      const row = this.db.connection.prepare("SELECT owner_id, lease_until_ms, heartbeat_at_ms FROM cloud_paper_writer_leases WHERE account_id = ?").get(this.accountId) as { owner_id?: string; lease_until_ms?: number; heartbeat_at_ms?: number } | undefined;
      if (row != null) {
        const heartbeatAt = Number(row.heartbeat_at_ms);
        const leaseUntil = Number(row.lease_until_ms);
        if (!Number.isSafeInteger(heartbeatAt) || heartbeatAt < 0 || !Number.isSafeInteger(leaseUntil) || leaseUntil < heartbeatAt) throw new Error("PAPER_WRITER_LEASE_CORRUPTED");
        if (now < heartbeatAt) throw new Error("PAPER_WRITER_CLOCK_REGRESSION");
        if (now - heartbeatAt > this.maxTakeoverAgeMs) throw new Error("PAPER_WRITER_CLOCK_ANOMALY");
      }
      if (row != null && String(row.owner_id) !== this.ownerId && Number(row.lease_until_ms) > now) throw new Error("PAPER_WRITER_ALREADY_ACTIVE");
      this.db.connection.prepare(`
        INSERT INTO cloud_paper_writer_leases (account_id, owner_id, lease_until_ms, heartbeat_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET owner_id=excluded.owner_id, lease_until_ms=excluded.lease_until_ms, heartbeat_at_ms=excluded.heartbeat_at_ms
      `).run(this.accountId, this.ownerId, now + this.leaseDurationMs, now);
    });
    this.lastObservedNowMs = now;
  }
  private heartbeatLease(): void {
    if (this.closed || this.leaseLost) return;
    try { this.db.transaction(() => this.assertLeaseHeld()); } catch (error) {
      this.leaseFailure ??= error;
      this.leaseLost = true;
    }
  }
  private assertLeaseHeld(): void {
    if (!this.writerLeaseStarted) throw new Error("PAPER_WRITER_LEASE_NOT_STARTED");
    if (this.closed || this.leaseLost) throw new Error("PAPER_WRITER_LEASE_LOST", { cause: this.leaseFailure });
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) { this.leaseLost = true; const error = new Error("PAPER_WRITER_CLOCK_INVALID"); this.leaseFailure ??= error; throw error; }
    if (now < this.lastObservedNowMs) { this.leaseLost = true; const error = new Error("PAPER_WRITER_CLOCK_REGRESSION"); this.leaseFailure ??= error; throw error; }
    if (now - this.lastObservedNowMs > this.maxClockAdvanceMs) { this.leaseLost = true; const error = new Error("PAPER_WRITER_CLOCK_ANOMALY"); this.leaseFailure ??= error; throw error; }
    const result = this.db.connection.prepare(`UPDATE cloud_paper_writer_leases SET lease_until_ms = ?, heartbeat_at_ms = ? WHERE account_id = ? AND owner_id = ? AND lease_until_ms > ?`).run(now + this.leaseDurationMs, now, this.accountId, this.ownerId, now);
    if (Number(result.changes) !== 1) {
      this.leaseLost = true;
      let code = "PAPER_WRITER_LEASE_RENEWAL_REJECTED";
      try {
        const row = this.db.connection.prepare("SELECT owner_id, lease_until_ms FROM cloud_paper_writer_leases WHERE account_id = ?").get(this.accountId) as { owner_id: string; lease_until_ms: number } | undefined;
        if (row == null) code = "PAPER_WRITER_LEASE_ROW_MISSING";
        else if (row.owner_id !== this.ownerId) code = "PAPER_WRITER_LEASE_OWNER_MISMATCH";
        else if (Number.isSafeInteger(row.lease_until_ms) && row.lease_until_ms <= now) code = "PAPER_WRITER_LEASE_EXPIRED";
      } catch { /* Diagnosis must not mask the rejected renewal or recover authority. */ }
      this.leaseFailure ??= new Error(code);
      throw new Error("PAPER_WRITER_LEASE_LOST", { cause: this.leaseFailure });
    }
    this.lastObservedNowMs = now;
  }
}

function accountChecksum(state: PaperAccountState): string { return createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex"); }
function validateFillCandidateProvenance(fill: PaperFillRecord): void {
  const provenance = fill.candidateProvenance;
  if (provenance == null) return;
  if (provenance.schemaVersion !== 1 || provenance.source !== "CIO_DECISION_BINDING") throw new Error("paper fill candidate provenance is invalid");
  if (!Number.isSafeInteger(provenance.decisionAt) || provenance.decisionAt < 0 || provenance.decisionAt > fill.filledAt) throw new Error("paper fill candidate decision time is invalid");
  validatePaperCandidateExecutionBinding(provenance.binding, provenance.decisionAt);
}
function validateRuntimeExecutionCostEvidence(fill: PaperFillRecord): void {
  const evidence = fill.runtimeExecutionCostEvidence;
  if (evidence == null) return;
  if (fill.candidateProvenance == null) throw new Error("paper runtime execution-cost evidence requires candidate provenance");
  const rebuilt = buildPaperRuntimeExecutionCostEvidence(fill, evidence.quotePrice);
  if (JSON.stringify(evidence) !== JSON.stringify(rebuilt)) throw new Error("paper runtime execution-cost evidence is invalid");
}
function validateObservedExecutionCostAttribution(fill: PaperFillRecord): void {
  const attribution = fill.executionCostAttribution;
  if (attribution == null) return;
  if (attribution.evidenceKind !== "OBSERVED") {
    if (attribution.source !== "PAPER_EXECUTION_BOUNDARY" || attribution.schemaVersion !== 1 || !attribution.evidenceId.trim() || !SHA256.test(attribution.evidenceFingerprintSha256)) throw new Error("paper modeled execution-cost attribution identity is invalid");
    if (attribution.candidateId !== canonicalCandidateIdForFill(fill) || attribution.fillPrice !== fill.price || attribution.feeAmount !== fill.fee || ![attribution.quotePrice, attribution.spreadAmount, attribution.slippageAmount].every(Number.isFinite) || attribution.quotePrice <= 0 || attribution.fillPrice <= 0 || attribution.feeAmount < 0 || attribution.spreadAmount < 0 || attribution.slippageAmount < 0) throw new Error("paper modeled execution-cost attribution is invalid");
    return;
  }
  const quoteEvidenceId = attribution.quoteEvidenceId;
  const quoteFingerprint = attribution.quoteEvidenceFingerprintSha256;
  const quoteObservedAt = attribution.quoteObservedAt;
  const quoteBidPrice = attribution.quoteBidPrice;
  const quoteAskPrice = attribution.quoteAskPrice;
  if (fill.orderBookQuoteReceipt == null || typeof quoteEvidenceId !== "string" || typeof quoteFingerprint !== "string" || !Number.isSafeInteger(quoteObservedAt) || typeof quoteBidPrice !== "number" || typeof quoteAskPrice !== "number") throw new Error("paper observed execution-cost quote provenance is missing");
  validatePaperObservedExecutionCostAttribution(fill, {
    schemaVersion: 1,
    source: "UPBIT_PUBLIC_ORDERBOOK",
    market: fill.market,
    observedAt: fill.orderBookQuoteReceipt.observedAt,
    bidPrice: fill.orderBookQuoteReceipt.bestBidPrice,
    askPrice: fill.orderBookQuoteReceipt.bestAskPrice,
    evidenceId: quoteEvidenceId,
    evidenceFingerprintSha256: quoteFingerprint,
    receipt: fill.orderBookQuoteReceipt,
  }, attribution);
}

function canonicalCandidateIdForFill(fill: PaperFillRecord): string {
  const provenance = fill.candidateProvenance;
  if (provenance == null) throw new Error("paper execution-cost attribution requires candidate provenance");
  try { return validatePaperCandidateExecutionBinding(provenance.binding, provenance.decisionAt).candidateId; }
  catch { throw new Error("paper execution-cost attribution candidate provenance is invalid"); }
}

type PaperAccountingValidationMode = "canonical" | "canonical-or-recognized-legacy";
function validateState(state: PaperAccountState, accountingMode: PaperAccountingValidationMode = "canonical"): void {
  if (state.version !== 1) throw new Error("unsupported paper account state version");
  for (const [name, value] of [["initialCapital", state.initialCapital], ["cash", state.cash], ["equity", state.equity], ["realizedPnL", state.realizedPnL], ["unrealizedPnL", state.unrealizedPnL]] as const) if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  if (state.initialCapital <= 0 || state.cash < 0 || state.equity < 0) throw new Error("paper account balance invariant failed");
  if (!Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0) throw new Error("paper account updatedAt is invalid");
  const positionMarkets = new Set<string>();
  for (const position of state.positions) {
    if (!position.market.trim() || positionMarkets.has(position.market)) throw new Error("paper position identity is invalid");
    positionMarkets.add(position.market);
    finiteNonNegative(position.quantity, "position.quantity"); finiteNonNegative(position.averageEntryPrice, "position.averageEntryPrice"); finiteNonNegative(position.markPrice, "position.markPrice");
    if (![position.realizedPnL, position.unrealizedPnL].every(Number.isFinite)) throw new Error("paper position PnL is invalid");
  }
  const orderIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const order of state.orders) {
    if (!order.id.trim() || orderIds.has(order.id) || !order.idempotencyKey.trim() || idempotencyKeys.has(order.idempotencyKey) || !order.market.trim() || (order.status !== "FILLED" && order.status !== "CANCELLED")) throw new Error("paper order identity is invalid");
    orderIds.add(order.id); idempotencyKeys.add(order.idempotencyKey);
    finiteNonNegative(order.quantity, "paper order quantity"); finiteNonNegative(order.price, "paper order price"); finiteNonNegative(order.fee, "paper order fee");
    if ((order.status === "FILLED" && order.quantity <= 0) || order.price <= 0 || !Number.isSafeInteger(order.createdAt) || !Number.isSafeInteger(order.filledAt) || order.createdAt < 0 || order.filledAt < order.createdAt) throw new Error("paper order accounting fields are invalid");
    if (order.requestFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(order.requestFingerprint)) throw new Error("paper order request fingerprint is invalid");
    if (order.lifecycle !== undefined) {
      const lifecycle = validatePaperOrderLifecycle(order.lifecycle);
      if (lifecycle.status !== order.status || lifecycle.filledQuantity !== order.quantity || lifecycle.lastTransitionAt !== order.filledAt) throw new Error("paper order lifecycle reconciliation mismatch");
      if (order.status === "FILLED" && (lifecycle.requestedQuantity !== order.quantity || lifecycle.remainingQuantity !== 0)) throw new Error("paper filled order lifecycle reconciliation mismatch");
    }
    if (order.executionProfile !== undefined) validateExecutionProfile(order.executionProfile);
  }
  const workingOrderIds = new Set<string>();
  const workingIdempotencyKeys = new Set<string>();
  for (const order of state.workingOrders ?? []) {
    if (!order.id.trim() || orderIds.has(order.id) || workingOrderIds.has(order.id) || !order.idempotencyKey.trim() || idempotencyKeys.has(order.idempotencyKey) || workingIdempotencyKeys.has(order.idempotencyKey) || !order.market.trim()) throw new Error("paper working order identity is invalid");
    if (order.orderType !== "MARKET" && order.orderType !== "LIMIT") throw new Error("paper working order type is invalid");
    if (!Number.isFinite(order.requestedQuantity) || order.requestedQuantity <= 0 || !Number.isSafeInteger(order.createdAt) || order.createdAt < 0 || !SHA256.test(order.requestFingerprint)) throw new Error("paper working order fields are invalid");
    if (order.orderType === "LIMIT" && (!Number.isFinite(order.limitPrice) || (order.limitPrice ?? 0) <= 0)) throw new Error("paper working limit price is invalid");
    const lifecycle = validatePaperOrderLifecycle(order.lifecycle);
    if (lifecycle.requestedQuantity !== order.requestedQuantity || lifecycle.status === "FILLED" || lifecycle.status === "CANCELLED" || lifecycle.status === "REJECTED") throw new Error("paper working order lifecycle is terminal or mismatched");
    if ((order.executionIntent == null) !== (order.candidateProvenance == null)) throw new Error("paper strategy working-order provenance is incomplete");
    if (order.executionIntent != null) {
      const intent = validatePaperExecutionIntent(order.executionIntent);
      const provenance = order.candidateProvenance!;
      const binding = validatePaperCandidateExecutionBinding(provenance.binding, provenance.decisionAt);
      if (order.orderType !== "MARKET" ||
          order.idempotencyKey !== paperExecutionIntentCommandId(intent) ||
          order.requestFingerprint !== intent.intentFingerprintSha256 ||
          order.market !== intent.market ||
          order.side !== intent.side ||
          order.requestedQuantity !== intent.quantity ||
          provenance.source !== "CIO_DECISION_BINDING" ||
          provenance.decisionAt !== intent.decisionDecidedAt ||
          binding.candidateId !== intent.candidateId ||
          binding.bindingFingerprintSha256 !== intent.candidateBindingFingerprintSha256) {
        throw new Error("paper strategy working-order identity is invalid");
      }
      const lastOrderBookObservedAt = order.lastOrderBookObservedAt ?? 0;
      if (!Number.isSafeInteger(lastOrderBookObservedAt) || lastOrderBookObservedAt < 0 || lastOrderBookObservedAt > state.updatedAt) {
        throw new Error("paper strategy working-order depth cursor is invalid");
      }
      if (intent.side === "BUY") {
        if (typeof order.remainingAllocationCapital !== "number" || !Number.isFinite(order.remainingAllocationCapital) || order.remainingAllocationCapital < 0 ||
            order.remainingAllocationCapital > intent.allocationCapital + 1e-8) {
          throw new Error("paper strategy working-order residual budget is invalid");
        }
      } else if (order.remainingAllocationCapital !== null) {
        throw new Error("paper strategy SELL working-order budget must be null");
      }
    } else if (order.remainingAllocationCapital !== undefined || order.lastOrderBookObservedAt !== undefined) {
      throw new Error("manual paper working order cannot carry strategy execution state");
    }
    workingOrderIds.add(order.id); workingIdempotencyKeys.add(order.idempotencyKey);
  }
  const fillIds = new Set<string>();
  const fillsByOrder = new Map<string, PaperFillRecord[]>();
  const workingById = new Map((state.workingOrders ?? []).map((order) => [order.id, order] as const));
  const terminalById = new Map(state.orders.map((order) => [order.id, order] as const));
  const knownOrderIds = new Set([...orderIds, ...workingOrderIds]);
  for (const fill of state.fills) {
    if (!fill.id.trim() || fillIds.has(fill.id) || !knownOrderIds.has(fill.orderId) || !fill.market.trim()) throw new Error("paper fill identity is invalid");
    fillIds.add(fill.id);
    const grouped = fillsByOrder.get(fill.orderId) ?? [];
    grouped.push(fill);
    fillsByOrder.set(fill.orderId, grouped);
    finiteNonNegative(fill.quantity, "paper fill quantity"); finiteNonNegative(fill.price, "paper fill price"); finiteNonNegative(fill.fee, "paper fill fee");
    if (fill.quantity <= 0 || fill.price <= 0 || !Number.isSafeInteger(fill.filledAt) || fill.filledAt < 0) throw new Error("paper fill accounting fields are invalid");
    if (fill.orderBookQuoteReceipt != null) {
      try { validatePaperOrderBookQuoteReceipt(fill.orderBookQuoteReceipt, fill.market, fill.filledAt, 5_000); }
      catch (error) { throw new Error(`paper fill order-book quote receipt is invalid: ${error instanceof Error ? error.message : "unknown error"}`); }
    }
    validateFillCandidateProvenance(fill);
    let intent: PaperExecutionIntent | undefined;
    if (fill.executionIntent != null) {
      intent = validatePaperExecutionIntent(fill.executionIntent);
      if (intent.market !== fill.market || intent.side !== fill.side) throw new Error("paper fill execution intent mismatch");
      if (fill.candidateProvenance == null ||
          intent.candidateId !== fill.candidateProvenance.binding.candidateId ||
          intent.candidateBindingFingerprintSha256 !== fill.candidateProvenance.binding.bindingFingerprintSha256) {
        throw new Error("paper fill execution intent provenance mismatch");
      }
    }
    const parent = workingById.get(fill.orderId) ?? terminalById.get(fill.orderId);
    if (fill.orderBookExecutionReceipt != null) {
      if (fill.orderBookQuoteReceipt == null) throw new Error("paper depth execution requires order-book quote receipt");
      const workingIntentMatch = intent != null && parent?.lifecycle?.requestedQuantity === intent.quantity;
      try {
        validatePaperOrderBookExecutionReceipt(fill.orderBookExecutionReceipt, {
          market: fill.market,
          side: fill.side,
          filledQuantity: fill.quantity,
          fillPrice: fill.price,
          quoteReceipt: fill.orderBookQuoteReceipt,
          ...(workingIntentMatch ? { allowPartial: true } : intent == null ? {} : { intentQuantity: intent.quantity }),
          ...(workingIntentMatch || intent?.side !== "BUY" ? {} : { allocationCapital: intent.allocationCapital }),
        });
      } catch (error) {
        throw new Error(`paper fill order-book execution receipt is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    } else if (intent != null && intent.quantity !== fill.quantity) {
      if (parent?.lifecycle?.requestedQuantity !== intent.quantity ||
          parent.executionProfile?.fingerprintSha256 !== fill.executionProfileFingerprintSha256 ||
          fill.executionEngineVersion !== parent.executionProfile?.engineVersion) {
        throw new Error("paper fill execution intent mismatch");
      }
    }
    validateRuntimeExecutionCostEvidence(fill);
    validateObservedExecutionCostAttribution(fill);
  }
  for (const order of state.orders) {
    const fills = fillsByOrder.get(order.id) ?? [];
    const quantity = round8(fills.reduce((sum, fill) => sum + fill.quantity, 0));
    const fee = round8(fills.reduce((sum, fill) => sum + fill.fee, 0));
    const notional = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
    const averagePrice = quantity > 0 ? round8(notional / quantity) : 0;
    const lastFilledAt = fills.reduce((latest, fill) => Math.max(latest, fill.filledAt), 0);
    const fillShapeMismatch = fills.some((fill) => fill.market !== order.market || fill.side !== order.side) || quantity !== order.quantity || fee !== order.fee;
    if (order.status === "FILLED") {
      if (fills.length === 0 || fillShapeMismatch || averagePrice !== order.price || lastFilledAt !== order.filledAt) throw new Error("paper order/fill reconciliation mismatch");
    } else if (fillShapeMismatch || (fills.length > 0 && (averagePrice !== order.price || lastFilledAt > order.filledAt))) {
      throw new Error("paper cancelled order/fill reconciliation mismatch");
    }
  }
  for (const order of state.workingOrders ?? []) {
    const fills = fillsByOrder.get(order.id) ?? [];
    const quantity = round8(fills.reduce((sum, fill) => sum + fill.quantity, 0));
    if (quantity !== order.lifecycle.filledQuantity || fills.some((fill) => fill.market !== order.market || fill.side !== order.side)) throw new Error("paper working order/fill reconciliation mismatch");
    if (order.executionIntent != null) {
      const intent = validatePaperExecutionIntent(order.executionIntent);
      if (intent.side === "BUY") {
        const cumulativeGross = round8(fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0));
        const expectedRemaining = round8(Math.max(0, intent.allocationCapital - cumulativeGross));
        if (order.remainingAllocationCapital !== expectedRemaining) throw new Error("paper strategy working-order residual budget mismatch");
      }
      const latestConsumedDepthAt = fills.reduce((latest, fill) => Math.max(latest, fill.orderBookQuoteReceipt?.observedAt ?? 0), 0);
      if ((order.lastOrderBookObservedAt ?? 0) < latestConsumedDepthAt) throw new Error("paper strategy working-order depth cursor mismatch");
    }
  }
  if (state.processedIdempotencyKeys.some((key) => !key.trim()) || new Set(state.processedIdempotencyKeys).size !== state.processedIdempotencyKeys.length || state.orders.some((order) => !state.processedIdempotencyKeys.includes(order.idempotencyKey)) || (state.workingOrders ?? []).some((order) => !state.processedIdempotencyKeys.includes(order.idempotencyKey))) throw new Error("paper idempotency ledger mismatch");
  // Strict accounting replay is valid only while the bounded order history still represents
  // every processed execution identity. Open/cancelled orders may legitimately have zero fills,
  // and one order may have multiple partial fills, so fill-count equality is not a valid gate.
  const representedIdempotencyKeys = new Set([
    ...state.orders.map((order) => order.idempotencyKey),
    ...(state.workingOrders ?? []).map((order) => order.idempotencyKey)
  ]);
  const completeExecutionHistory =
    state.processedIdempotencyKeys.length > 0
    && representedIdempotencyKeys.size === state.processedIdempotencyKeys.length
    && state.processedIdempotencyKeys.every((key) => representedIdempotencyKeys.has(key));
  if (completeExecutionHistory) {
    const accountingInput = {
      initialCapital: state.initialCapital,
      fills: state.fills,
      cash: state.cash,
      realizedPnL: state.realizedPnL,
      positions: state.positions
    };
    try {
      assertPaperAccountingReconciled(accountingInput);
    } catch (error) {
      if (accountingMode !== "canonical-or-recognized-legacy" ||
          !(error instanceof Error) ||
          error.message !== "PAPER_LEDGER_RECONCILIATION_REQUIRED") {
        throw error;
      }
      assertRecognizedLegacyPaperAccountingV1(accountingInput);
    }
  }
  const expectedEquity = round8(state.cash + state.positions.reduce((sum, position) => sum + position.quantity * position.markPrice, 0));
  const expectedUnrealized = round8(state.positions.reduce((sum, position) => sum + position.unrealizedPnL, 0));
  if (state.equity !== expectedEquity || state.unrealizedPnL !== expectedUnrealized) throw new Error("paper account projection mismatch");
}

function manualCommandFingerprint(command: PersonalPaperOrderCommand): string {
  const canonical = JSON.stringify({
    schemaVersion: command.schemaVersion,
    authority: command.authority,
    productionMutationAllowed: command.productionMutationAllowed,
    idempotencyKey: command.idempotencyKey,
    market: command.market.trim().toUpperCase(),
    side: command.side,
    orderType: command.orderType,
    quantity: command.quantity,
    limitPrice: command.limitPrice ?? null
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface PaperExecutionTick {
  readonly now: number;
  readonly market: string;
  readonly price: number;
  readonly quantity?: number;
  /** Planned portfolio state used by the canonical production boundary. */
  readonly portfolio?: PortfolioPlan;
  /** Immutable PortfolioPlan-derived execution intent. Raw simulator callers may omit it. */
  readonly executionIntent?: PaperExecutionIntent;
  readonly observedAt: number;
  readonly mode: MobileDashboardApiInput["mode"];
  readonly killSwitchActive: boolean;
  readonly tradingAllowed: boolean;
  readonly overallHealth: MobileDashboardApiInput["overallHealth"];
  readonly decisions: readonly CioDecision[];
  readonly investmentPercent?: number;
  readonly observedQuote?: PaperObservedExecutionQuote;
}
export interface PaperManualOrderContext {
  readonly now: number;
  readonly marketPrice: number;
  readonly observedAt: number;
  readonly mode: MobileDashboardApiInput["mode"];
  readonly killSwitchActive: boolean;
  readonly tradingAllowed: boolean;
  readonly overallHealth: MobileDashboardApiInput["overallHealth"];
}
export interface PaperExecutionResult {
  readonly status: "FILLED" | "WAIT" | "BLOCKED" | "REJECTED" | "DUPLICATE" | "FAILED";
  readonly reason?: string;
  readonly orders: readonly PaperOrderRecord[];
  readonly fills: readonly PaperFillRecord[];
  readonly state: PaperAccountState;
  readonly risk?: Readonly<{ readonly status: "ALLOW" | "REJECT" | "HALT"; readonly reasonCodes: readonly string[] }>;
}
export interface PaperExecutionSafetyState { readonly openP0: boolean; }
export interface PaperTradingExecutionLoopOptions {
  readonly initialCapital: number;
  readonly feeRate?: number;
  readonly slippageBps?: number;
  readonly spreadBps?: number;
  readonly maxFillRatio?: number;
  readonly latencyTicks?: number;
  readonly staleWindowMs?: number;
  readonly repository?: PaperAccountRepository;
  readonly restoredState?: PaperAccountState;
  readonly readP0State?: () => PaperExecutionSafetyState;
}

export class PaperTradingExecutionLoop {
  private state: PaperAccountState;
  private lastPersistenceFailure: string | null = null;

  /** Why the most recent PAPER account save failed (see describePersistenceFailure), or null when none has failed. Diagnostic only. */
  public persistenceFailureDetail(): string | null { return this.lastPersistenceFailure; }

  private readonly feeRate: number;
  private readonly executionProfile: PaperExecutionProfile;
  private readonly staleWindowMs: number;
  private readonly repository?: PaperAccountRepository;
  private readonly readP0State?: () => PaperExecutionSafetyState;

  public constructor(options: PaperTradingExecutionLoopOptions) {
    if (!Number.isFinite(options.initialCapital) || options.initialCapital <= 0) throw new Error("paper initial capital must be positive");
    this.feeRate = options.feeRate ?? 0.0005;
    this.executionProfile = buildExecutionProfile({ feeRate: this.feeRate, slippageBps: options.slippageBps ?? 0, spreadBps: options.spreadBps ?? 0, maxFillRatio: options.maxFillRatio ?? 1, latencyTicks: options.latencyTicks ?? 0 });
    this.staleWindowMs = options.staleWindowMs ?? 30_000;
    if (!Number.isFinite(this.feeRate) || this.feeRate < 0) throw new Error("paper fee rate must be non-negative");
    if (!Number.isSafeInteger(this.staleWindowMs) || this.staleWindowMs < 1_000) throw new Error("paper stale window is invalid");
    this.repository = options.repository;
    this.readP0State = options.readP0State;
    const restored = options.restoredState ?? this.repository?.loadLatest();
    this.state = restored == null ? initialState(options.initialCapital) : restored;
    if (Math.abs(this.state.initialCapital - options.initialCapital) > Number.EPSILON) throw new Error("paper initial capital mismatch");
    validateState(this.state);
  }

  public snapshot(): PaperAccountState { return this.state; }

  public openLimitOrder(command: PersonalPaperOrderCommand, context: PaperManualOrderContext): PaperExecutionResult {
    let validated: PersonalPaperOrderCommand;
    try { validated = validatePersonalPaperOrderCommand(command); } catch { return this.result("FAILED", "invalid PAPER order command"); }
    if (validated.orderType !== "LIMIT") return this.result("REJECTED", "PAPER_WORKING_ORDER_REQUIRES_LIMIT");
    const gate = this.executionGate(context);
    if (gate != null) return this.result("BLOCKED", gate);
    const fingerprint = manualCommandFingerprint(validated);
    const priorFilled = this.state.orders.find((order) => order.idempotencyKey === validated.idempotencyKey);
    const priorWorking = (this.state.workingOrders ?? []).find((order) => order.idempotencyKey === validated.idempotencyKey);
    if (priorFilled != null || priorWorking != null) {
      const priorFingerprint = priorFilled?.requestFingerprint ?? priorWorking?.requestFingerprint;
      return this.result(priorFingerprint === fingerprint ? "DUPLICATE" : "REJECTED", priorFingerprint === fingerprint ? validated.idempotencyKey : "PAPER_IDEMPOTENCY_CONFLICT");
    }
    const id = createHash("sha256").update(validated.idempotencyKey, "utf8").digest("hex").slice(0, 24);
    let lifecycle = createPaperOrderLifecycle(validated.quantity, context.now);
    lifecycle = transitionPaperOrderLifecycle(lifecycle, "ACCEPTED", context.now);
    lifecycle = transitionPaperOrderLifecycle(lifecycle, "OPEN", context.now);
    const order: PaperWorkingOrderRecord = Object.freeze({
      id, idempotencyKey: validated.idempotencyKey, market: validated.market, side: validated.side,
      orderType: "LIMIT", requestedQuantity: validated.quantity, limitPrice: validated.limitPrice,
      createdAt: context.now, requestFingerprint: fingerprint, lifecycle, executionProfile: this.executionProfile, observedTicks: 0,
    });
    const working = Object.freeze({ ...this.state, workingOrders: Object.freeze([order, ...(this.state.workingOrders ?? [])].slice(0, 1_000)), processedIdempotencyKeys: Object.freeze([validated.idempotencyKey, ...this.state.processedIdempotencyKeys]), updatedAt: context.now });
    try { this.repository?.save(working); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
    this.state = working;
    return Object.freeze({ status: "WAIT", reason: "PAPER_LIMIT_OPEN", orders: Object.freeze([]), fills: Object.freeze([]), state: this.state });
  }

  public fillWorkingOrder(orderId: string, fillQuantity: number, context: PaperManualOrderContext, fillEventId?: string): PaperExecutionResult {
    const gate = this.executionGate(context);
    if (gate != null) return this.result("BLOCKED", gate);
    if (!orderId.trim() || !Number.isFinite(fillQuantity) || fillQuantity <= 0 || (fillEventId !== undefined && !fillEventId.trim())) return this.result("FAILED", "invalid PAPER working fill request");
    const eventId = fillEventId?.trim();
    if (eventId != null) {
      const priorEventFill = this.state.fills.find((fill) => fill.id === `fill-event:${eventId}`);
      if (priorEventFill != null) return Object.freeze({ status: "DUPLICATE", reason: eventId, orders: Object.freeze([]), fills: Object.freeze([priorEventFill]), state: this.state });
    }
    const workingOrders = [...(this.state.workingOrders ?? [])];
    const index = workingOrders.findIndex((order) => order.id === orderId);
    if (index < 0) return this.result("REJECTED", "PAPER_WORKING_ORDER_NOT_FOUND");
    let current = workingOrders[index]!;
    if (current.executionIntent != null || current.candidateProvenance != null) return this.result("REJECTED", "PAPER_STRATEGY_WORKING_ORDER_AUTOMATIC_ONLY");
    const observedTicks = (current.observedTicks ?? 0) + 1;
    if (observedTicks <= current.executionProfile.latencyTicks) {
      current = Object.freeze({ ...current, observedTicks });
      workingOrders[index] = current;
      const next = Object.freeze({ ...this.state, workingOrders: Object.freeze(workingOrders), updatedAt: context.now });
      try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
      this.state = next;
      return this.result("WAIT", `PAPER_EXECUTION_LATENCY:${observedTicks}/${current.executionProfile.latencyTicks}`);
    }
    if (current.observedTicks !== observedTicks) {
      current = Object.freeze({ ...current, observedTicks });
      workingOrders[index] = current;
    }
    if (current.market !== current.market.trim().toUpperCase()) return this.result("REJECTED", "paper working order market is invalid");
    const marketable = current.side === "BUY" ? context.marketPrice <= (current.limitPrice ?? 0) : context.marketPrice >= (current.limitPrice ?? Number.POSITIVE_INFINITY);
    if (!marketable) return this.result("WAIT", "PAPER_LIMIT_NOT_MARKETABLE");
    if (fillQuantity > current.lifecycle.remainingQuantity) return this.result("REJECTED", "fill quantity exceeds remaining quantity");
    const modeled = deterministicFill(current.executionProfile, current.side, Math.min(fillQuantity, current.lifecycle.remainingQuantity), context.marketPrice, current.requestedQuantity);
    fillQuantity = modeled.quantity;
    const fillPrice = modeled.price;
    if (current.orderType === "LIMIT") {
      const limitPrice = current.limitPrice!;
      const modeledPriceBreachesLimit = current.side === "BUY" ? fillPrice > limitPrice : fillPrice < limitPrice;
      if (modeledPriceBreachesLimit) return this.result("WAIT", "PAPER_LIMIT_MODELED_PRICE_OUTSIDE_LIMIT");
    }

    const fee = round8(fillQuantity * fillPrice * current.executionProfile.feeRate);
    const positions = this.state.positions.map((item) => ({ ...item }));
    const positionIndex = positions.findIndex((item) => item.market === current.market);
    const previous = positionIndex < 0 ? { market: current.market, quantity: 0, averageEntryPrice: 0, realizedPnL: 0, unrealizedPnL: 0, markPrice: fillPrice } : positions[positionIndex]!;
    let cash = this.state.cash;
    let realizedPnL = this.state.realizedPnL;
    let position: PaperAccountPosition;
    const notional = round8(fillQuantity * fillPrice);
    if (current.side === "BUY") {
      if (notional + fee > cash) return this.result("REJECTED", "insufficient paper cash");
      const nextQuantity = round8(previous.quantity + fillQuantity);
      const costBasis = toScaledLedgerAmount(previous.averageEntryPrice * previous.quantity + notional + fee);
      position = { ...previous, quantity: nextQuantity, averageEntryPrice: divideRound8(costBasis * LEDGER_ROUND_SCALE, toScaledLedgerAmount(nextQuantity)), markPrice: fillPrice };
      cash = round8(cash - notional - fee);
    } else {
      if (fillQuantity > previous.quantity + Number.EPSILON) return this.result("REJECTED", "insufficient paper position");
      const realized = round8((fillPrice - previous.averageEntryPrice) * fillQuantity - fee);
      const nextQuantity = round8(previous.quantity - fillQuantity);
      position = { ...previous, quantity: nextQuantity, averageEntryPrice: nextQuantity === 0 ? 0 : previous.averageEntryPrice, realizedPnL: round8(previous.realizedPnL + realized), markPrice: fillPrice };
      realizedPnL = round8(realizedPnL + realized);
      cash = round8(cash + notional - fee);
    }
    if (positionIndex < 0) positions.push(position); else positions[positionIndex] = position;

    const terminal = Math.abs(fillQuantity - current.lifecycle.remainingQuantity) <= Number.EPSILON;
    let lifecycle: PaperOrderLifecycleState;
    try { lifecycle = transitionPaperOrderLifecycle(current.lifecycle, terminal ? "FILLED" : "PARTIALLY_FILLED", context.now, fillQuantity); }
    catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper working fill rejected"); }
    const priorFills = this.state.fills.filter((fill) => fill.orderId === current.id);
    const fill: PaperFillRecord = Object.freeze({ id: eventId == null ? `fill:${current.id}:${priorFills.length + 1}` : `fill-event:${eventId}`, orderId: current.id, market: current.market, side: current.side, quantity: fillQuantity, price: fillPrice, fee, filledAt: context.now, executionProfileFingerprintSha256: current.executionProfile.fingerprintSha256, executionEngineVersion: current.executionProfile.engineVersion });
    // Working-order fills are reconciliation state, not telemetry. Never truncate them independently of their order.
    const fills = Object.freeze([fill, ...this.state.fills]);

    let orders = this.state.orders;
    if (terminal) {
      workingOrders.splice(index, 1);
      const orderFills = [...priorFills, fill];
      const totalQuantity = round8(orderFills.reduce((sum, item) => sum + item.quantity, 0));
      const totalFee = round8(orderFills.reduce((sum, item) => sum + item.fee, 0));
      const averagePrice = round8(orderFills.reduce((sum, item) => sum + item.quantity * item.price, 0) / totalQuantity);
      const completed: PaperOrderRecord = Object.freeze({ id: current.id, idempotencyKey: current.idempotencyKey, market: current.market, side: current.side, quantity: totalQuantity, price: averagePrice, fee: totalFee, status: "FILLED", createdAt: current.createdAt, filledAt: context.now, requestFingerprint: current.requestFingerprint, lifecycle, executionProfile: current.executionProfile });
      orders = Object.freeze([completed, ...orders].slice(0, 1_000));
    } else {
      workingOrders[index] = Object.freeze({ ...current, lifecycle });
    }
    let next: PaperAccountState = Object.freeze({ ...this.state, cash, realizedPnL, positions: Object.freeze(positions), orders, fills, workingOrders: Object.freeze(workingOrders), updatedAt: context.now });
    next = markToMarket(next, current.market, context.marketPrice, context.now);
    try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
    this.state = next;
    return Object.freeze({ status: terminal ? "FILLED" : "WAIT", reason: terminal ? "PAPER_LIMIT_FILLED" : "PAPER_LIMIT_PARTIALLY_FILLED", orders: terminal ? Object.freeze([orders[0]!]) : Object.freeze([]), fills: Object.freeze([fill]), state: this.state });
  }

  public advanceStrategyWorkingOrder(orderId: string, tick: PaperExecutionTick): PaperExecutionResult {
    const gate = this.executionGate({ now: tick.now, marketPrice: tick.price, observedAt: tick.observedAt, mode: tick.mode, killSwitchActive: tick.killSwitchActive, tradingAllowed: tick.tradingAllowed, overallHealth: tick.overallHealth });
    if (gate != null) return this.result(gate === "invalid tick" ? "FAILED" : "BLOCKED", gate);
    const workingOrders = [...(this.state.workingOrders ?? [])];
    const index = workingOrders.findIndex((order) => order.id === orderId);
    if (index < 0) return this.result("REJECTED", "PAPER_WORKING_ORDER_NOT_FOUND");
    let current = workingOrders[index]!;
    if (current.orderType !== "MARKET" || current.executionIntent == null || current.candidateProvenance == null) return this.result("REJECTED", "PAPER_STRATEGY_WORKING_ORDER_REQUIRED");
    let intent: PaperExecutionIntent;
    try { intent = validatePaperExecutionIntent(current.executionIntent); }
    catch { return this.result("REJECTED", "PAPER_STRATEGY_WORKING_INTENT_INVALID"); }
    if (current.market !== tick.market.trim().toUpperCase() || intent.market !== current.market || intent.side !== current.side || current.requestedQuantity !== intent.quantity) {
      return this.result("REJECTED", "PAPER_STRATEGY_WORKING_ORDER_MISMATCH");
    }
    const lastOrderBookObservedAt = current.lastOrderBookObservedAt ?? 0;
    if (lastOrderBookObservedAt > 0) {
      if (tick.observedQuote?.depth == null || tick.observedQuote.depthFingerprintSha256 == null) {
        return this.result("WAIT", "PAPER_STRATEGY_WORKING_WAITING_FOR_DEPTH");
      }
      if (tick.observedQuote.observedAt <= lastOrderBookObservedAt) {
        return this.result("WAIT", "PAPER_STRATEGY_WORKING_WAITING_FOR_NEW_DEPTH");
      }
    }

    const observedTicks = (current.observedTicks ?? 0) + 1;
    if (observedTicks <= current.executionProfile.latencyTicks) {
      current = Object.freeze({ ...current, observedTicks });
      workingOrders[index] = current;
      const next = markToMarket(Object.freeze({ ...this.state, workingOrders: Object.freeze(workingOrders), updatedAt: tick.now }), current.market, tick.price, tick.now);
      try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
      this.state = next;
      return this.result("WAIT", `PAPER_STRATEGY_EXECUTION_LATENCY:${observedTicks}/${current.executionProfile.latencyTicks}`);
    }
    if (current.observedTicks !== observedTicks) {
      current = Object.freeze({ ...current, observedTicks });
      workingOrders[index] = current;
    }

    const priorFills = this.state.fills.filter((fill) => fill.orderId === current.id);
    const remainingQuantity = current.lifecycle.remainingQuantity;
    let canonicalObservedQuote: PaperObservedExecutionQuote | undefined;
    if (tick.observedQuote != null) {
      try { canonicalObservedQuote = validatePaperObservedExecutionQuote(tick.observedQuote, current.market, tick.now); }
      catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper strategy observed quote is invalid"); }
    }
    let fillQuantity: number;
    let fillPrice: number;
    let orderBookExecutionReceipt: PaperOrderBookExecutionReceipt | undefined;

    if (canonicalObservedQuote?.depth != null && canonicalObservedQuote.depthFingerprintSha256 != null) {
      const remainingNotional = intent.side === "BUY" ? current.remainingAllocationCapital ?? 0 : undefined;
      if (intent.side === "BUY" && (remainingNotional ?? 0) <= 1e-8) {
        let lifecycle: PaperOrderLifecycleState;
        try { lifecycle = transitionPaperOrderLifecycle(current.lifecycle, "CANCELLED", tick.now); }
        catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper strategy budget cancellation rejected"); }
        workingOrders.splice(index, 1);
        const totalQuantity = round8(priorFills.reduce((sum, fill) => sum + fill.quantity, 0));
        const totalFee = round8(priorFills.reduce((sum, fill) => sum + fill.fee, 0));
        const averagePrice = totalQuantity > 0 ? round8(priorFills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / totalQuantity) : tick.price;
        const cancelled: PaperOrderRecord = Object.freeze({ id: current.id, idempotencyKey: current.idempotencyKey, market: current.market, side: current.side, quantity: totalQuantity, price: averagePrice, fee: totalFee, status: "CANCELLED", createdAt: current.createdAt, filledAt: tick.now, requestFingerprint: current.requestFingerprint, lifecycle, executionProfile: current.executionProfile });
        const orders = Object.freeze([cancelled, ...this.state.orders.filter((order) => order.id !== current.id)].slice(0, 1_000));
        const next = markToMarket(Object.freeze({ ...this.state, orders, workingOrders: Object.freeze(workingOrders), updatedAt: tick.now }), current.market, tick.price, tick.now);
        try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
        this.state = next;
        return Object.freeze({ status: "WAIT", reason: "PAPER_STRATEGY_BUDGET_EXHAUSTED", orders: Object.freeze([cancelled]), fills: Object.freeze([]), state: this.state });
      }
      try {
        orderBookExecutionReceipt = buildPaperOrderBookExecutionReceipt({
          quote: canonicalObservedQuote,
          side: current.side,
          requestedQuantity: remainingQuantity,
          filledAt: tick.now,
          ...(remainingNotional === undefined ? {} : { maximumNotional: remainingNotional }),
          maximumFillRatio: current.executionProfile.maxFillRatio,
        });
      } catch (error) {
        if (error instanceof PaperOrderBookExecutionError && error.code === "PAPER_ORDERBOOK_LIQUIDITY_INSUFFICIENT") {
          workingOrders[index] = Object.freeze({ ...current, observedTicks, lastOrderBookObservedAt: canonicalObservedQuote.observedAt });
          const next = markToMarket(Object.freeze({ ...this.state, workingOrders: Object.freeze(workingOrders), updatedAt: tick.now }), current.market, tick.price, tick.now);
          try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
          this.state = next;
          return this.result("WAIT", "PAPER_STRATEGY_LIQUIDITY_WAIT");
        }
        if (error instanceof PaperOrderBookExecutionError && error.code === "PAPER_ORDERBOOK_BUDGET_UNEXECUTABLE") {
          let lifecycle: PaperOrderLifecycleState;
          try { lifecycle = transitionPaperOrderLifecycle(current.lifecycle, "CANCELLED", tick.now); }
          catch (transitionError) { return this.result("REJECTED", transitionError instanceof Error ? transitionError.message : "paper strategy budget cancellation rejected"); }
          workingOrders.splice(index, 1);
          const totalQuantity = round8(priorFills.reduce((sum, fill) => sum + fill.quantity, 0));
          const totalFee = round8(priorFills.reduce((sum, fill) => sum + fill.fee, 0));
          const averagePrice = totalQuantity > 0 ? round8(priorFills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / totalQuantity) : tick.price;
          const cancelled: PaperOrderRecord = Object.freeze({ id: current.id, idempotencyKey: current.idempotencyKey, market: current.market, side: current.side, quantity: totalQuantity, price: averagePrice, fee: totalFee, status: "CANCELLED", createdAt: current.createdAt, filledAt: tick.now, requestFingerprint: current.requestFingerprint, lifecycle, executionProfile: current.executionProfile });
          const orders = Object.freeze([cancelled, ...this.state.orders.filter((order) => order.id !== current.id)].slice(0, 1_000));
          const next = markToMarket(Object.freeze({ ...this.state, orders, workingOrders: Object.freeze(workingOrders), updatedAt: tick.now }), current.market, tick.price, tick.now);
          try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
          this.state = next;
          return Object.freeze({ status: "WAIT", reason: "PAPER_STRATEGY_BUDGET_UNEXECUTABLE", orders: Object.freeze([cancelled]), fills: Object.freeze([]), state: this.state });
        }
        return this.result("REJECTED", error instanceof Error ? error.message : "paper strategy depth execution rejected");
      }
      fillQuantity = orderBookExecutionReceipt.filledQuantity;
      fillPrice = orderBookExecutionReceipt.vwapPrice;
    } else {
      const modeled = deterministicFill(current.executionProfile, current.side, remainingQuantity, tick.price, current.requestedQuantity);
      fillQuantity = modeled.quantity;
      fillPrice = modeled.price;
      if (current.side === "BUY") {
        const remainingBudget = current.remainingAllocationCapital ?? 0;
        const affordableQuantity = floor8(remainingBudget / fillPrice);
        if (affordableQuantity <= 0) {
          let lifecycle: PaperOrderLifecycleState;
          try { lifecycle = transitionPaperOrderLifecycle(current.lifecycle, "CANCELLED", tick.now); }
          catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper strategy budget cancellation rejected"); }
          workingOrders.splice(index, 1);
          const totalQuantity = round8(priorFills.reduce((sum, fill) => sum + fill.quantity, 0));
          const totalFee = round8(priorFills.reduce((sum, fill) => sum + fill.fee, 0));
          const averagePrice = totalQuantity > 0 ? round8(priorFills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / totalQuantity) : tick.price;
          const cancelled: PaperOrderRecord = Object.freeze({ id: current.id, idempotencyKey: current.idempotencyKey, market: current.market, side: current.side, quantity: totalQuantity, price: averagePrice, fee: totalFee, status: "CANCELLED", createdAt: current.createdAt, filledAt: tick.now, requestFingerprint: current.requestFingerprint, lifecycle, executionProfile: current.executionProfile });
          const orders = Object.freeze([cancelled, ...this.state.orders.filter((order) => order.id !== current.id)].slice(0, 1_000));
          const next = markToMarket(Object.freeze({ ...this.state, orders, workingOrders: Object.freeze(workingOrders), updatedAt: tick.now }), current.market, tick.price, tick.now);
          try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
          this.state = next;
          return Object.freeze({ status: "WAIT", reason: "PAPER_STRATEGY_BUDGET_UNEXECUTABLE", orders: Object.freeze([cancelled]), fills: Object.freeze([]), state: this.state });
        }
        fillQuantity = Math.min(fillQuantity, affordableQuantity);
      }
    }

    const fee = round8(fillQuantity * fillPrice * current.executionProfile.feeRate);
    const positions = this.state.positions.map((item) => ({ ...item }));
    const positionIndex = positions.findIndex((item) => item.market === current.market);
    const previous = positionIndex < 0 ? { market: current.market, quantity: 0, averageEntryPrice: 0, realizedPnL: 0, unrealizedPnL: 0, markPrice: fillPrice } : positions[positionIndex]!;
    let cash = this.state.cash;
    let realizedPnL = this.state.realizedPnL;
    let position: PaperAccountPosition;
    const notional = round8(fillQuantity * fillPrice);
    if (current.side === "BUY") {
      if (notional + fee > cash) return this.result("REJECTED", "insufficient paper cash");
      const nextQuantity = round8(previous.quantity + fillQuantity);
      const costBasis = toScaledLedgerAmount(previous.averageEntryPrice * previous.quantity + notional + fee);
      position = { ...previous, quantity: nextQuantity, averageEntryPrice: divideRound8(costBasis * LEDGER_ROUND_SCALE, toScaledLedgerAmount(nextQuantity)), markPrice: fillPrice };
      cash = round8(cash - notional - fee);
    } else {
      if (fillQuantity > previous.quantity + Number.EPSILON) return this.result("REJECTED", "insufficient paper position");
      const realized = round8((fillPrice - previous.averageEntryPrice) * fillQuantity - fee);
      const nextQuantity = round8(previous.quantity - fillQuantity);
      position = { ...previous, quantity: nextQuantity, averageEntryPrice: nextQuantity === 0 ? 0 : previous.averageEntryPrice, realizedPnL: round8(previous.realizedPnL + realized), markPrice: fillPrice };
      realizedPnL = round8(realizedPnL + realized);
      cash = round8(cash + notional - fee);
    }
    if (positionIndex < 0) positions.push(position); else positions[positionIndex] = position;

    const terminalFill = Math.abs(fillQuantity - remainingQuantity) <= 1e-8;
    let lifecycle: PaperOrderLifecycleState;
    try { lifecycle = transitionPaperOrderLifecycle(current.lifecycle, terminalFill ? "FILLED" : "PARTIALLY_FILLED", tick.now, fillQuantity); }
    catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper strategy working fill rejected"); }
    const remainingAllocationCapital = current.side === "BUY"
      ? round8(Math.max(0, (current.remainingAllocationCapital ?? 0) - notional))
      : null;
    const fallbackBudgetLimited = current.side === "BUY" && orderBookExecutionReceipt == null && remainingAllocationCapital != null && remainingAllocationCapital <= 1e-8 && !terminalFill;
    const budgetExhausted = (orderBookExecutionReceipt?.budgetLimited === true || fallbackBudgetLimited) && !terminalFill;
    if (budgetExhausted) {
      try { lifecycle = transitionPaperOrderLifecycle(lifecycle, "CANCELLED", tick.now); }
      catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper strategy budget cancellation rejected"); }
    }

    const baseFill: PaperFillRecord = {
      id: `fill:${current.id}:${priorFills.length + 1}`,
      orderId: current.id,
      market: current.market,
      side: current.side,
      quantity: fillQuantity,
      price: fillPrice,
      fee,
      filledAt: tick.now,
      executionProfileFingerprintSha256: current.executionProfile.fingerprintSha256,
      executionEngineVersion: current.executionProfile.engineVersion,
      candidateProvenance: current.candidateProvenance,
      executionIntent: intent,
      ...(canonicalObservedQuote === undefined ? {} : { orderBookQuoteReceipt: canonicalObservedQuote.receipt }),
      ...(orderBookExecutionReceipt === undefined ? {} : { orderBookExecutionReceipt }),
    };
    const runtimeExecutionCostEvidence = buildPaperRuntimeExecutionCostEvidence(baseFill, tick.price);
    const executionCostAttribution = canonicalObservedQuote == null ? undefined : buildPaperObservedExecutionCostAttribution(baseFill, canonicalObservedQuote);
    const fill: PaperFillRecord = Object.freeze({
      ...baseFill,
      ...(executionCostAttribution === undefined ? { runtimeExecutionCostEvidence } : { executionCostAttribution }),
    });
    const fills = Object.freeze([fill, ...this.state.fills]);

    let orders = this.state.orders;
    if (terminalFill || budgetExhausted) {
      workingOrders.splice(index, 1);
      const orderFills = [...priorFills, fill];
      const totalQuantity = round8(orderFills.reduce((sum, item) => sum + item.quantity, 0));
      const totalFee = round8(orderFills.reduce((sum, item) => sum + item.fee, 0));
      const averagePrice = round8(orderFills.reduce((sum, item) => sum + item.quantity * item.price, 0) / totalQuantity);
      const status = budgetExhausted ? "CANCELLED" as const : "FILLED" as const;
      const completed: PaperOrderRecord = Object.freeze({ id: current.id, idempotencyKey: current.idempotencyKey, market: current.market, side: current.side, quantity: totalQuantity, price: averagePrice, fee: totalFee, status, createdAt: current.createdAt, filledAt: tick.now, requestFingerprint: current.requestFingerprint, lifecycle, executionProfile: current.executionProfile });
      orders = Object.freeze([completed, ...orders.filter((order) => order.id !== current.id)].slice(0, 1_000));
    } else {
      workingOrders[index] = Object.freeze({
        ...current,
        lifecycle,
        observedTicks,
        remainingAllocationCapital,
        lastOrderBookObservedAt: canonicalObservedQuote?.observedAt ?? lastOrderBookObservedAt,
      });
    }
    let next: PaperAccountState = Object.freeze({ ...this.state, cash, realizedPnL, positions: Object.freeze(positions), orders, fills, workingOrders: Object.freeze(workingOrders), updatedAt: tick.now });
    next = markToMarket(next, current.market, tick.price, tick.now);
    try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
    this.state = next;
    if (budgetExhausted) return Object.freeze({ status: "WAIT", reason: "PAPER_STRATEGY_BUDGET_EXHAUSTED", orders: Object.freeze([orders[0]!]), fills: Object.freeze([fill]), state: this.state });
    if (!terminalFill) return Object.freeze({ status: "WAIT", reason: "PAPER_STRATEGY_PARTIALLY_FILLED", orders: Object.freeze([]), fills: Object.freeze([fill]), state: this.state });
    return Object.freeze({ status: "FILLED", reason: "PAPER_STRATEGY_FILLED", orders: Object.freeze([orders[0]!]), fills: Object.freeze([fill]), state: this.state });
  }

  public cancelWorkingOrder(orderId: string, now: number): PaperExecutionResult {
    if (!orderId.trim() || !Number.isSafeInteger(now) || now < 0) return this.result("FAILED", "invalid PAPER cancel request");
    const workingOrders = [...(this.state.workingOrders ?? [])];
    const index = workingOrders.findIndex((order) => order.id === orderId);
    if (index < 0) return this.result("REJECTED", "PAPER_WORKING_ORDER_NOT_FOUND");
    const current = workingOrders[index]!;
    let lifecycle: PaperOrderLifecycleState;
    try { lifecycle = transitionPaperOrderLifecycle(current.lifecycle, "CANCELLED", now); }
    catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper cancel rejected"); }
    workingOrders.splice(index, 1);
    const priorFills = this.state.fills.filter((fill) => fill.orderId === current.id);
    const totalQuantity = round8(priorFills.reduce((sum, fill) => sum + fill.quantity, 0));
    const totalFee = round8(priorFills.reduce((sum, fill) => sum + fill.fee, 0));
    const averagePrice = totalQuantity > 0 ? priorFills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / totalQuantity : (current.limitPrice ?? 0);
    const cancelled: PaperOrderRecord = Object.freeze({ id: current.id, idempotencyKey: current.idempotencyKey, market: current.market, side: current.side, quantity: totalQuantity, price: averagePrice, fee: totalFee, status: "CANCELLED", createdAt: current.createdAt, filledAt: now, requestFingerprint: current.requestFingerprint, lifecycle, executionProfile: current.executionProfile });
    const orders = Object.freeze([cancelled, ...this.state.orders.filter((order) => order.id !== current.id)].slice(0, 1_000));
    const next = Object.freeze({ ...this.state, orders, workingOrders: Object.freeze(workingOrders), updatedAt: now });
    try { this.repository?.save(next); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
    this.state = next;
    return Object.freeze({ status: "WAIT", reason: `PAPER_ORDER_CANCELLED:${lifecycle.transitionSequence}`, orders: Object.freeze([cancelled]), fills: Object.freeze(priorFills), state: this.state });
  }

  public submitManualOrder(command: PersonalPaperOrderCommand, context: PaperManualOrderContext): PaperExecutionResult {
    let validatedCommand: PersonalPaperOrderCommand;
    try { validatedCommand = validatePersonalPaperOrderCommand(command); } catch { return this.result("FAILED", "invalid PAPER order command"); }
    command = validatedCommand;
    const requestFingerprint = manualCommandFingerprint(command);
    const prior = this.state.orders.find((order) => order.idempotencyKey === command.idempotencyKey);
    if (prior != null) {
      if (prior.requestFingerprint !== requestFingerprint) return this.result("REJECTED", "PAPER_IDEMPOTENCY_CONFLICT");
      const fills = this.state.fills.filter((fill) => fill.orderId === prior.id);
      return Object.freeze({ status: "DUPLICATE", reason: command.idempotencyKey, orders: Object.freeze([prior]), fills: Object.freeze(fills), state: this.state });
    }
    if (this.state.processedIdempotencyKeys.includes(command.idempotencyKey)) return this.result("REJECTED", "PAPER_IDEMPOTENCY_CONFLICT");
    const gate = this.executionGate(context);
    if (gate != null) return this.result("BLOCKED", gate);
    const market = command.market.trim().toUpperCase();
    if (command.orderType === "LIMIT") {
      const limit = command.limitPrice;
      if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return this.result("FAILED", "invalid PAPER limit price");
      const marketable = command.side === "BUY" ? context.marketPrice <= limit! : context.marketPrice >= limit!;
      if (!marketable) return this.result("REJECTED", "PAPER_LIMIT_NOT_MARKETABLE");
    }
    let executed: ReturnType<typeof executeOrder>;
    try { executed = executeOrder(this.state, command.idempotencyKey, market, command.side, command.quantity, context.marketPrice, context.now, this.executionProfile, requestFingerprint); }
    catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper order rejected"); }
    const working = markToMarket(executed.state, market, context.marketPrice, context.now);
    try { this.repository?.save(working); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
    this.state = working;
    return Object.freeze({ status: "FILLED", orders: Object.freeze([executed.order]), fills: Object.freeze([executed.fill]), state: this.state });
  }

  public processTick(tick: PaperExecutionTick): PaperExecutionResult {
    const gate = this.executionGate({ now: tick.now, marketPrice: tick.price, observedAt: tick.observedAt, mode: tick.mode, killSwitchActive: tick.killSwitchActive, tradingAllowed: tick.tradingAllowed, overallHealth: tick.overallHealth });
    if (gate != null) return this.result(gate === "invalid tick" ? "FAILED" : "BLOCKED", gate);
    if (tick.quantity !== undefined && (!Number.isFinite(tick.quantity) || tick.quantity <= 0)) return this.result("FAILED", "invalid order quantity");
    let canonicalExecutionIntent: PaperExecutionIntent | undefined;
    if (tick.executionIntent != null) {
      try { canonicalExecutionIntent = validatePaperExecutionIntent(tick.executionIntent); }
      catch { return this.result("FAILED", "invalid PAPER execution intent"); }
      if (canonicalExecutionIntent.market !== tick.market.trim().toUpperCase() || canonicalExecutionIntent.referencePrice !== tick.price) {
        return this.result("FAILED", "PAPER execution intent does not match tick");
      }
      if (tick.quantity !== undefined && round8(tick.quantity) !== canonicalExecutionIntent.quantity) {
        return this.result("REJECTED", "PAPER execution intent quantity mismatch");
      }
    }
    const actionable = tick.decisions.filter((decision) => decision.symbol === tick.market && (decision.action === "BUY" || decision.action === "SELL"));
    if (actionable.length === 0) return this.result("WAIT", "no actionable paper decision");
    if (canonicalExecutionIntent != null && actionable.length !== 1) return this.result("REJECTED", "PAPER execution intent requires exactly one actionable decision");
    const existingKeys = new Set(this.state.processedIdempotencyKeys);
    const nextOrders: PaperOrderRecord[] = [];
    const nextFills: PaperFillRecord[] = [];
    let working = cloneState(this.state);
    const investmentPercent = tick.investmentPercent ?? 100;
    if (!Number.isFinite(investmentPercent) || investmentPercent < 0 || investmentPercent > 100) return this.result("REJECTED", "invalid investment percentage");
    for (const decision of actionable.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.action.localeCompare(b.action))) {
      if (canonicalExecutionIntent != null) {
        const expectedSide = decision.action === "BUY" ? "BUY" : "SELL";
        if (canonicalExecutionIntent.side !== expectedSide ||
            canonicalExecutionIntent.decisionDecidedAt !== decision.decidedAt ||
            canonicalExecutionIntent.candidateId !== decision.paperCandidateBinding?.candidateId ||
            canonicalExecutionIntent.candidateBindingFingerprintSha256 !== decision.paperCandidateBinding?.bindingFingerprintSha256) {
          return this.result("REJECTED", "PAPER execution intent decision mismatch");
        }
      }
      const key = canonicalExecutionIntent == null
        ? `paper:${tick.market}:${tick.observedAt}:${decision.action}:${decision.decidedAt}`
        : paperExecutionIntentCommandId(canonicalExecutionIntent);
      if (existingKeys.has(key)) {
        const existingWorking = (this.state.workingOrders ?? []).find((order) => order.idempotencyKey === key && order.executionIntent != null);
        if (canonicalExecutionIntent != null && existingWorking?.executionIntent?.intentFingerprintSha256 === canonicalExecutionIntent.intentFingerprintSha256) {
          return this.advanceStrategyWorkingOrder(existingWorking.id, tick);
        }
        return this.result("DUPLICATE", key);
      }
      const position = working.positions.find((item) => item.market === tick.market);
      const quantity = round8(canonicalExecutionIntent?.quantity ?? tick.quantity ?? (decision.action === "SELL" ? position?.quantity ?? 0 : working.cash * (investmentPercent / 100) * decision.allocation / tick.price));
      if (quantity <= 0) return this.result("REJECTED", decision.action === "SELL" ? "insufficient paper position" : "decision allocation is zero");
      const side = decision.action === "BUY" ? "BUY" : "SELL";
      if (side === "BUY") {
        const treasury = { totalAssets: working.cash, tradingCapital: working.cash, reserveCapital: 0, pendingDepositCapital: 0, reservations: [], reservedWithdrawalCapital: 0, deployableCapital: working.cash, activeReservations: [] };
        const requestedAmount = quantity * tick.price * (1 + this.feeRate);
        try { guardCashInvestmentAllocation(treasury, [{ id: key, bucket: "SPOT", amount: requestedAmount }], investmentPercent); }
        catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "cash investment allocation exceeded"); }
      }
      const candidateProvenance: PaperFillCandidateProvenance | undefined = decision.paperCandidateBinding == null ? undefined : Object.freeze({
        schemaVersion: 1,
        source: "CIO_DECISION_BINDING",
        decisionAt: decision.decidedAt,
        binding: validatePaperCandidateExecutionBinding(decision.paperCandidateBinding, decision.decidedAt),
      });
      if (canonicalExecutionIntent != null) {
        if (candidateProvenance == null) return this.result("REJECTED", "PAPER_CANDIDATE_BINDING_REQUIRED");
        const id = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24);
        let lifecycle = createPaperOrderLifecycle(quantity, tick.now);
        lifecycle = transitionPaperOrderLifecycle(lifecycle, "ACCEPTED", tick.now);
        lifecycle = transitionPaperOrderLifecycle(lifecycle, "OPEN", tick.now);
        const strategyWorking: PaperWorkingOrderRecord = Object.freeze({
          id,
          idempotencyKey: key,
          market: tick.market.trim().toUpperCase(),
          side,
          orderType: "MARKET",
          requestedQuantity: quantity,
          createdAt: tick.now,
          requestFingerprint: canonicalExecutionIntent.intentFingerprintSha256,
          lifecycle,
          executionProfile: this.executionProfile,
          observedTicks: 0,
          candidateProvenance,
          executionIntent: canonicalExecutionIntent,
          remainingAllocationCapital: side === "BUY" ? canonicalExecutionIntent.allocationCapital : null,
          lastOrderBookObservedAt: 0,
        });
        let opened: PaperAccountState = Object.freeze({
          ...working,
          workingOrders: Object.freeze([strategyWorking, ...(working.workingOrders ?? [])].slice(0, 1_000)),
          processedIdempotencyKeys: Object.freeze([key, ...working.processedIdempotencyKeys]),
          updatedAt: tick.now,
        });
        opened = markToMarket(opened, tick.market, tick.price, tick.now);
        // OPEN and its first automatic fill are one logical strategy tick. Persist only the
        // resulting state so immutable account history never receives two different snapshots
        // with the same canonical updatedAt. advanceStrategyWorkingOrder persists every
        // successful WAIT/FILLED continuation itself.
        const durableStateBeforeOpen = this.state;
        this.state = opened;
        const advanced = this.advanceStrategyWorkingOrder(id, tick);
        if ((advanced.status === "FAILED" || advanced.status === "REJECTED" || advanced.status === "BLOCKED") && this.state === opened) {
          this.state = durableStateBeforeOpen;
          return Object.freeze({ ...advanced, state: this.state });
        }
        return advanced;
      }
      let order: ReturnType<typeof executeOrder>;
      try { order = executeOrder(working, key, tick.market, side, quantity, tick.price, tick.now, this.executionProfile, undefined, candidateProvenance, tick.price, tick.observedQuote, canonicalExecutionIntent); }
      catch (error) { return this.result("REJECTED", error instanceof Error ? error.message : "paper order rejected"); }
      working = order.state; nextOrders.push(order.order); nextFills.push(order.fill); existingKeys.add(key);
    }
    working = markToMarket(working, tick.market, tick.price, tick.now);
    try { this.repository?.save(working); } catch (error) { this.lastPersistenceFailure = describePersistenceFailure(error); return this.result("FAILED", "paper account persistence failed"); }
    this.state = working;
    return Object.freeze({ status: "FILLED", orders: Object.freeze(nextOrders), fills: Object.freeze(nextFills), state: this.state });
  }

  public applyToDashboard(base: MobileDashboardApiInput, now: number): MobileDashboardApiInput {
    const deployed = this.state.positions.reduce((sum, position) => sum + position.quantity * position.markPrice, 0);
    const allocations = this.state.positions.filter((position) => position.quantity > 0).map((position) => Object.freeze({ symbol: position.market, instrument: "SPOT" as const, action: "HOLD" as const, capital: round8(position.quantity * position.markPrice), share: this.state.equity > 0 ? round8(position.quantity * position.markPrice / this.state.equity) : 0, leverage: 1, confidence: 0, risk: "LOW" as const }));
    const portfolio: PortfolioPlan = Object.freeze({ allocations: Object.freeze(allocations), deployedCapital: round8(deployed), cashCapital: round8(this.state.cash), reservedCapital: 0, grossShare: this.state.equity > 0 ? round8(deployed / this.state.equity) : 0, futuresShare: 0, decidedAt: now });
    return Object.freeze({ ...base, now, portfolio, paper: Object.freeze({ cash: this.state.cash, equity: this.state.equity, realizedPnL: this.state.realizedPnL, unrealizedPnL: this.state.unrealizedPnL, orders: Object.freeze(this.state.orders.slice(0, 20)), fills: Object.freeze(this.state.fills.slice(0, 20)) }) });
  }

  private executionGate(context: PaperManualOrderContext): string | null {
    if (!Number.isSafeInteger(context.now) || context.now < 0 || !Number.isFinite(context.marketPrice) || context.marketPrice <= 0) return "invalid tick";
    if (context.mode === "PAPER" && this.readP0State != null) {
      try { if (this.readP0State().openP0) return "OPEN_P0_ALERT"; }
      catch { return "P0_STATE_UNVERIFIABLE"; }
    }
    if (context.mode !== "PAPER" || context.killSwitchActive || !context.tradingAllowed || context.overallHealth !== "HEALTHY") return "paper execution gate is closed";
    if (!Number.isSafeInteger(context.observedAt) || context.observedAt < 0 || context.observedAt > context.now || context.now - context.observedAt >= this.staleWindowMs) return "market data is stale";
    return null;
  }

  private result(status: PaperExecutionResult["status"], reason: string): PaperExecutionResult { return Object.freeze({ status, reason, orders: Object.freeze([]), fills: Object.freeze([]), state: this.state }); }
}

function initialState(initialCapital: number): PaperAccountState { return Object.freeze({ version: 1, initialCapital, cash: initialCapital, equity: initialCapital, realizedPnL: 0, unrealizedPnL: 0, positions: Object.freeze([]), orders: Object.freeze([]), fills: Object.freeze([]), processedIdempotencyKeys: Object.freeze([]), updatedAt: 0 }); }
function cloneState(state: PaperAccountState): PaperAccountState { return { ...state, positions: state.positions.map((item) => ({ ...item })), orders: [...state.orders], fills: [...state.fills], processedIdempotencyKeys: [...state.processedIdempotencyKeys], ...(state.workingOrders === undefined ? {} : { workingOrders: [...state.workingOrders] }) }; }

function executeOrder(state: PaperAccountState, key: string, market: string, side: "BUY" | "SELL", quantity: number, price: number, now: number, executionProfile: PaperExecutionProfile, requestFingerprint?: string, candidateProvenance?: PaperFillCandidateProvenance, quotePrice?: number, observedQuote?: PaperObservedExecutionQuote, executionIntent?: PaperExecutionIntent): { state: PaperAccountState; order: PaperOrderRecord; fill: PaperFillRecord } {
  const canonicalObservedQuote = observedQuote == null ? undefined : validatePaperObservedExecutionQuote(observedQuote, market, now);
  const requestedQuantity = quantity;
  let orderBookExecutionReceipt: PaperOrderBookExecutionReceipt | undefined;
  if (canonicalObservedQuote?.depth != null && canonicalObservedQuote.depthFingerprintSha256 != null) {
    orderBookExecutionReceipt = buildPaperOrderBookExecutionReceipt({
      quote: canonicalObservedQuote,
      side,
      requestedQuantity,
      filledAt: now,
      ...(executionIntent?.side === "BUY" ? { maximumNotional: executionIntent.allocationCapital } : {}),
      maximumFillRatio: executionProfile.maxFillRatio,
    });
    if (orderBookExecutionReceipt.liquidityLimited) throw new Error("PAPER_PARTIAL_FILL_REQUIRES_WORKING_ORDER");
    quantity = orderBookExecutionReceipt.filledQuantity;
    price = orderBookExecutionReceipt.vwapPrice;
  } else {
    const modeled = deterministicFill(executionProfile, side, requestedQuantity, price);
    if (modeled.quantity !== requestedQuantity) throw new Error("PAPER_PARTIAL_FILL_REQUIRES_WORKING_ORDER");
    quantity = modeled.quantity;
    price = modeled.price;
  }
  const positions = state.positions.map((item) => ({ ...item }));
  const index = positions.findIndex((item) => item.market === market);
  const previous = index < 0 ? { market, quantity: 0, averageEntryPrice: 0, realizedPnL: 0, unrealizedPnL: 0, markPrice: price } : positions[index]!;
  const notional = round8(quantity * price);
  const fee = round8(notional * executionProfile.feeRate);
  let cash = state.cash;
  let position: PaperAccountPosition;
  let realizedPnL = state.realizedPnL;
  if (side === "BUY") {
    if (notional + fee > cash) throw new Error("insufficient paper cash");
    const nextQuantity = round8(previous.quantity + quantity);
    const costBasis = toScaledLedgerAmount(previous.averageEntryPrice * previous.quantity + notional + fee);
    position = { ...previous, quantity: nextQuantity, averageEntryPrice: divideRound8(costBasis * LEDGER_ROUND_SCALE, toScaledLedgerAmount(nextQuantity)), markPrice: price };
    cash = round8(cash - notional - fee);
  } else {
    if (quantity > previous.quantity + Number.EPSILON) throw new Error("insufficient paper position");
    const realized = round8((price - previous.averageEntryPrice) * quantity - fee);
    const nextQuantity = round8(previous.quantity - quantity);
    position = { ...previous, quantity: nextQuantity, averageEntryPrice: nextQuantity === 0 ? 0 : previous.averageEntryPrice, realizedPnL: round8(previous.realizedPnL + realized), markPrice: price };
    realizedPnL = round8(realizedPnL + realized);
    cash = round8(cash + notional - fee);
  }
  if (index < 0) positions.push(position); else positions[index] = position;
  const id = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24);
  let lifecycle = createPaperOrderLifecycle(quantity, now);
  lifecycle = transitionPaperOrderLifecycle(lifecycle, "ACCEPTED", now);
  lifecycle = transitionPaperOrderLifecycle(lifecycle, "FILLED", now, quantity);
  const order: PaperOrderRecord = Object.freeze({ id, idempotencyKey: key, market, side, quantity, price, fee, status: "FILLED", createdAt: now, filledAt: now, ...(requestFingerprint === undefined ? {} : { requestFingerprint }), lifecycle, executionProfile });
  const baseFill: PaperFillRecord = { id: `fill:${id}`, orderId: id, market, side, quantity, price, fee, filledAt: now, ...(candidateProvenance === undefined ? {} : { candidateProvenance }), ...(executionIntent === undefined ? {} : { executionIntent: validatePaperExecutionIntent(executionIntent) }), ...(canonicalObservedQuote === undefined ? {} : { orderBookQuoteReceipt: canonicalObservedQuote.receipt }), ...(orderBookExecutionReceipt === undefined ? {} : { orderBookExecutionReceipt }) };
  const runtimeExecutionCostEvidence = candidateProvenance == null || quotePrice == null ? undefined : buildPaperRuntimeExecutionCostEvidence(baseFill, quotePrice);
  let executionCostAttribution: PaperExecutionCostAttribution | undefined;
  if (candidateProvenance != null && canonicalObservedQuote != null) {
    executionCostAttribution = buildPaperObservedExecutionCostAttribution({ ...baseFill, candidateProvenance }, canonicalObservedQuote);
  }
  const fill: PaperFillRecord = Object.freeze({
    ...baseFill,
    ...(executionCostAttribution === undefined ? {} : { executionCostAttribution }),
    ...(executionCostAttribution === undefined && runtimeExecutionCostEvidence !== undefined ? { runtimeExecutionCostEvidence } : {})
  });
  return { state: { ...state, cash, realizedPnL, positions, orders: [order, ...state.orders].slice(0, 1_000), fills: [fill, ...state.fills].slice(0, 1_000), processedIdempotencyKeys: [key, ...state.processedIdempotencyKeys], updatedAt: now }, order, fill };
}

function markToMarket(state: PaperAccountState, market: string, price: number, now: number): PaperAccountState {
  const positions = state.positions.map((position) => position.market === market ? { ...position, markPrice: price, unrealizedPnL: round8(position.quantity * (price - position.averageEntryPrice)) } : position);
  const unrealizedPnL = round8(positions.reduce((sum, position) => sum + position.unrealizedPnL, 0));
  const equity = round8(state.cash + positions.reduce((sum, position) => sum + position.quantity * position.markPrice, 0));
  return Object.freeze({ ...state, positions: Object.freeze(positions), equity, unrealizedPnL, updatedAt: now });
}
