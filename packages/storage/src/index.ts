import Module = require("node:module");
import { DatabaseSync } from "node:sqlite";

type SqliteIntegrityBoundary = Readonly<{
  open: (filename: string) => DatabaseSync;
  prepare: (connection: DatabaseSync, sql: string) => unknown;
  read: (statement: unknown) => Record<string, unknown> | undefined;
  resultIsOk: (result: Record<string, unknown> | undefined) => boolean;
}>;
const SQLITE_INTEGRITY_BOUNDARY_SLOT = "__nusaSqliteIntegrityBoundary" as const;
const preloadedSqliteIntegrityBoundary = (Module as typeof Module & {
  readonly __nusaSqliteIntegrityBoundary?: SqliteIntegrityBoundary;
})[SQLITE_INTEGRITY_BOUNDARY_SLOT];
// Production obtains the capability from the immutable preload slot and never resolves the
// bootstrap module again. Direct developer/test imports retain a fail-closed bootstrap fallback.
const sqliteIntegrityBoundary: SqliteIntegrityBoundary = preloadedSqliteIntegrityBoundary
  ?? (require("./sqliteIntegrityBootstrap") as { sqliteIntegrityBoundary: SqliteIntegrityBoundary }).sqliteIntegrityBoundary;

export * from "./researchMemorySemantics";
import {
  aiSha256,
  canonicalAiJson,
  isAiSha256,
  type AiCalibrationOutcome,
  type AiCalibrationPrediction
} from "../../contracts/src/aiInference";
import type {
  AiCalibrationDurableReplay,
  AiCalibrationDurableStore,
  AiCalibrationPendingExpiry
} from "../../contracts/src/aiCalibrationDurability";

import type {
  AiAttributionEpisode,
  AiLearningMemoryReplay,
  AiLearningMemoryStore,
  AiLessonProjection
} from "../../contracts/src/aiOutcomeAttribution";

import {
  LedgerSide, PositionScopeType, PositionStatus, type PositionLedgerEntry, type PositionSnapshot,
  type StrategyPositionSnapshot, type WalletPositionSnapshot,
  emptyStrategyPositionSnapshot, emptyWalletPositionSnapshot
} from "../../contracts/src/index";
import { runMigrations, type MigrationResult, type SqliteMigration } from "./migrationRunner";
import { cloudPaperAccountHistoryMigration } from "./cloudPaperAccountHistoryMigration";
import { cloudPaperFillLedgerMigration } from "./cloudPaperFillLedgerMigration";
import { cloudPaperLegacyReconciliationMigration } from "./cloudPaperLegacyReconciliationMigration";
import { researchFactoryDecisionHistoryMigration } from "./researchFactoryDecisionHistoryRepository";

export { runMigrations } from "./migrationRunner";
export type { MigrationResult, SqliteMigration } from "./migrationRunner";
export { SqliteResearchMemoryRepository } from "./researchMemory";
export { SqliteResearchIntelligenceMemoryRepository } from "./researchIntelligenceMemory";
export type { ResearchIntelligenceMemoryDatabase } from "./researchIntelligenceMemory";
export type { HypothesisStatus, ResearchExperimentRecord, ResearchHypothesis, ResearchMemoryDatabase } from "./researchMemory";
export { SqliteComplianceControlPlaneStore } from "./complianceControlPlaneStore";
export type { ComplianceDatabase } from "./complianceControlPlaneStore";
export { SqliteResilienceControlPlaneStore } from "./resilienceControlPlaneStore";
export { SqliteImprovementCandidateMemory } from "./improvementCandidateMemory";
export type { ImprovementCandidateMemoryDatabase, ImprovementCandidateMemoryRecord } from "./improvementCandidateMemory";
export { SqliteRulesControlPlaneStore } from "./rulesControlPlaneStore";
export type { RulesDatabase } from "./rulesControlPlaneStore";
export { SqliteMultiAgentGovernanceStore } from "./multiAgentGovernanceStore";
export type { MultiAgentGovernanceDatabase } from "./multiAgentGovernanceStore";
export { SqliteRiskSafetyPersistence } from "./risk-safety";
export { SqliteResearchEvaluationLedger } from "./researchEvaluationLedger";
export type { ResearchEvaluationDatabase } from "./researchEvaluationLedger";
export { SqliteResearchPrecommitRepository } from "./researchPrecommit";
export type { ResearchPrecommitDatabase } from "./researchPrecommit";
export { SqliteResearchHypothesisLifecycleRepository } from "./researchHypothesisLifecycle";
export type { ResearchHypothesisLifecycleDatabase } from "./researchHypothesisLifecycle";
export { SqliteCandidatePromotionRepository } from "./candidatePromotionRepository";
export type { CandidatePromotionDatabase, PromotionAtomicInput } from "./candidatePromotionRepository";
export { SqliteResearchSessionRepository } from "./researchAutomation";
export type { ResearchAutomationDatabase } from "./researchAutomation";
export { SqliteEvolutionLearningLedger, EvolutionLearningLedgerError } from "./evolutionLearningLedger";
export type { EvolutionLearningLedgerDatabase, EvolutionLearningLedgerReplay } from "./evolutionLearningLedger";
export { SqlitePersistedPaperPeriodStore, PersistedPaperPeriodStoreError } from "./persistedPaperPeriodStore";
export type { PersistedPaperCandidateProvenance, PersistedPaperPeriodEnvelope, PersistedPaperPeriodRecord, PaperPeriodCostEvidence, PaperPeriodCostEvidenceKind, PaperPeriodLifecycleStatus, PersistedPaperPendingPeriod } from "./persistedPaperPeriodStore";
export { SqlitePaperMarketObservationRepository, PaperMarketObservationStoreError, normalizePaperPublicMarketObservation } from "./paperMarketObservationRepository";
export type { PaperPublicMarketObservation, PaperPublicMarketObservationInput } from "./paperMarketObservationRepository";
export { SqliteResearchCandleStore, ResearchCandleStoreError } from "./researchCandleStore";
export { SqliteResearchDatasetManifestStore, ResearchDatasetManifestStoreError } from "./researchDatasetManifest";
export { SqliteResearchGapFillProgressStore, SqliteResearchManifestRetryStore, ResearchGapFillProgressError } from "./researchGapFillProgress";
export type { ResearchGapFillProgress, ResearchGapFillPassState, ResearchGapFillNextPass } from "./researchGapFillProgress";
export { SqliteFuturesPublicStore, type FuturesMarkRow, type FuturesFundingRow, type FuturesKlineRow } from "./futuresPublicStore";
export { SqliteMarketMicrostructureStore, MarketMicrostructureStoreError, type StoredOrderBookSample, type StoredTradeTick } from "./marketMicrostructureStore";
export { SqliteResearchHoldoutLedger, ResearchHoldoutLedgerError } from "./researchHoldoutLedger";
export type { HoldoutKey } from "./researchHoldoutLedger";
export type { StoredResearchCandle } from "./researchCandleStore";

type SqlRow = Record<string, string | number | bigint | null>;
type LedgerFilter = Pick<PositionLedgerEntry, "walletId" | "strategyId" | "symbol">;

export interface PositionLedgerRepository {
  append(entry: PositionLedgerEntry): PositionLedgerEntry;
  list(filter?: Partial<LedgerFilter>): readonly PositionLedgerEntry[];
  getById(id: string): PositionLedgerEntry | undefined;
}

export interface WalletPositionSnapshotRepository {
  get(walletId: string, symbol: string): WalletPositionSnapshot | undefined;
  save(snapshot: WalletPositionSnapshot): WalletPositionSnapshot;
  list(): readonly WalletPositionSnapshot[];
}

export interface StrategyPositionSnapshotRepository {
  get(walletId: string, strategyId: string, symbol: string): StrategyPositionSnapshot | undefined;
  save(snapshot: StrategyPositionSnapshot): StrategyPositionSnapshot;
  list(): readonly StrategyPositionSnapshot[];
}

export interface AppliedLedgerMarkerRepository {
  tryMarkApplied(scopeType: PositionScopeType, scopeId: string, entry: PositionLedgerEntry): boolean;
  clearScope(scopeType: PositionScopeType, scopeId: string): void;
  list(scopeType: PositionScopeType, scopeId: string): readonly { ledgerEntryId: string; ledgerOrderKey: string }[];
}

export interface TransactionRunner { transaction<T>(fn: () => T): T; }

export function ledgerKey(entry: PositionLedgerEntry): string { return `${entry.ts}|${entry.createdAt}|${entry.id}`; }
const walletScopeId = (walletId: string, symbol: string): string => `${walletId}|${symbol}`;
const strategyScopeId = (walletId: string, strategyId: string, symbol: string): string => `${walletId}|${strategyId}|${symbol}`;
const raw = (value: bigint | undefined): string | null => value == null ? null : value.toString();
const fromRaw = (value: string | number | bigint | null): bigint | undefined => value == null ? undefined : BigInt(value);
const asString = (value: string | number | bigint | null): string => String(value);

function decodeLedger(row: SqlRow): PositionLedgerEntry {
  return Object.freeze({ id: asString(row.id), walletId: asString(row.wallet_id), strategyId: row.strategy_id == null ? undefined : asString(row.strategy_id), symbol: asString(row.symbol), side: asString(row.side) as LedgerSide, baseQtyRaw: BigInt(asString(row.base_qty_raw)), quoteQtyRaw: fromRaw(row.quote_qty_raw), ts: asString(row.ts), createdAt: asString(row.created_at), sourceTradeId: row.source_trade_id == null ? undefined : asString(row.source_trade_id) });
}

function decodeWalletSnapshot(row: SqlRow): WalletPositionSnapshot {
  return Object.freeze({ scopeType: PositionScopeType.WALLET, walletId: asString(row.wallet_id), symbol: asString(row.symbol), baseQtyRaw: BigInt(asString(row.base_qty_raw)), quoteCostRaw: BigInt(asString(row.quote_cost_raw)), avgEntryPriceRaw: fromRaw(row.avg_entry_price_raw), realizedPnlRaw: BigInt(asString(row.realized_pnl_raw)), status: asString(row.status) as PositionStatus, lastLedgerEntryId: row.last_ledger_entry_id == null ? undefined : asString(row.last_ledger_entry_id), lastLedgerOrderKey: row.last_ledger_order_key == null ? undefined : asString(row.last_ledger_order_key), version: Number(row.version) });
}

function decodeStrategySnapshot(row: SqlRow): StrategyPositionSnapshot {
  return Object.freeze({ ...decodeWalletSnapshot(row), scopeType: PositionScopeType.STRATEGY, strategyId: asString(row.strategy_id) });
}

export function applyLedgerEntryToSnapshot(snapshot: PositionSnapshot, entry: PositionLedgerEntry): PositionSnapshot {
  const entryOrder = ledgerKey(entry);
  if (snapshot.lastLedgerOrderKey != null && snapshot.lastLedgerOrderKey > entryOrder) throw new Error("ledger order regression rejected");
  if (snapshot.lastLedgerEntryId === entry.id) return snapshot;
  let baseQtyRaw = snapshot.baseQtyRaw;
  let quoteCostRaw = snapshot.quoteCostRaw;
  let realizedPnlRaw = snapshot.realizedPnlRaw;
  if (entry.side === LedgerSide.BUY) {
    baseQtyRaw += entry.baseQtyRaw;
    if (entry.quoteQtyRaw != null) quoteCostRaw += entry.quoteQtyRaw;
  } else {
    if (entry.baseQtyRaw > baseQtyRaw) throw new Error("oversell rejected");
    const soldCostRaw = baseQtyRaw === 0n ? 0n : quoteCostRaw * entry.baseQtyRaw / baseQtyRaw;
    if (entry.quoteQtyRaw != null) realizedPnlRaw += entry.quoteQtyRaw - soldCostRaw;
    baseQtyRaw -= entry.baseQtyRaw;
    quoteCostRaw -= soldCostRaw;
    if (baseQtyRaw === 0n) quoteCostRaw = 0n;
  }
  return Object.freeze({ ...snapshot, baseQtyRaw, quoteCostRaw, avgEntryPriceRaw: baseQtyRaw === 0n ? undefined : quoteCostRaw / baseQtyRaw, realizedPnlRaw, status: baseQtyRaw === 0n ? PositionStatus.CLOSED : PositionStatus.OPEN, lastLedgerEntryId: entry.id, lastLedgerOrderKey: entryOrder, version: snapshot.version + 1 });
}

// Integrity issuance and both AI-store admission checks live in this lexical module.
// Neither the registry nor its resolver is exported, so replacing any CommonJS cache
// entry cannot substitute a verifier used by these genuine constructors.
const fullyCheckedSqliteDatabaseConnections = new WeakMap<object, DatabaseSync>();
function resolveCheckedSharedConnection(database: unknown): DatabaseSync | null {
  if (database == null || (typeof database !== "object" && typeof database !== "function")) return null;
  const connection = fullyCheckedSqliteDatabaseConnections.get(database as object);
  return connection != null && (database as { connection?: unknown }).connection === connection ? connection : null;
}

export class SqliteDatabase implements TransactionRunner {
  public readonly connection: DatabaseSync;
  public readonly migrationResult: MigrationResult;
  private inTransaction = false;
  public constructor(filename = ":memory:") {
    this.connection = sqliteIntegrityBoundary.open(filename);
    try {
      this.connection.exec("PRAGMA foreign_keys = ON");
      this.connection.exec("PRAGMA busy_timeout = 5000");
      if (filename !== ":memory:") this.connection.exec("PRAGMA journal_mode = WAL");
      this.connection.exec("PRAGMA synchronous = FULL");
      this.migrationResult = runMigrations(this.connection, migrations);
      const check = sqliteIntegrityBoundary.read(sqliteIntegrityBoundary.prepare(this.connection, "PRAGMA quick_check")) as Record<string, unknown> | undefined;
      if (check == null || !sqliteIntegrityBoundary.resultIsOk(check)) throw new Error("sqlite quick_check failed");
      fullyCheckedSqliteDatabaseConnections.set(this, this.connection);
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }
  public transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    this.connection.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.connection.exec("COMMIT"); return result; }
    catch (error) { this.connection.exec("ROLLBACK"); throw error; }
    finally { this.inTransaction = false; }
  }
  public close(): void { this.connection.close(); }
}

function samePositionLedgerEntry(a: PositionLedgerEntry, b: PositionLedgerEntry): boolean {
  return a.id === b.id && a.walletId === b.walletId && (a.strategyId ?? null) === (b.strategyId ?? null) &&
    a.symbol === b.symbol && a.side === b.side && a.baseQtyRaw === b.baseQtyRaw &&
    (a.quoteQtyRaw ?? null) === (b.quoteQtyRaw ?? null) && a.ts === b.ts && a.createdAt === b.createdAt &&
    (a.sourceTradeId ?? null) === (b.sourceTradeId ?? null);
}

export class SqlitePositionLedgerRepository implements PositionLedgerRepository {
  public constructor(private readonly db: SqliteDatabase) {}
  public append(entry: PositionLedgerEntry): PositionLedgerEntry {
    return this.db.transaction(() => {
      this.db.connection.prepare("INSERT INTO position_ledger_entries (id, wallet_id, strategy_id, symbol, side, base_qty_raw, quote_qty_raw, ts, created_at, source_trade_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").run(entry.id, entry.walletId, entry.strategyId ?? null, entry.symbol, entry.side, raw(entry.baseQtyRaw), raw(entry.quoteQtyRaw), entry.ts, entry.createdAt, entry.sourceTradeId ?? null);
      const stored = this.getById(entry.id);
      if (stored == null) throw new Error("ledger append did not persist");
      // First-write-wins for replays, but a reused id with different content
      // must fail closed instead of silently returning someone else's entry.
      // Mirrors the execution-fill conflict rule (#1652) for ledger entries.
      if (!samePositionLedgerEntry(stored, entry)) throw new Error("ledger id conflict: entry id already exists with different content");
      return stored;
    });
  }
  public getById(id: string): PositionLedgerEntry | undefined {
    const row = this.db.connection.prepare("SELECT * FROM position_ledger_entries WHERE id = ?").get(id) as SqlRow | undefined;
    return row == null ? undefined : decodeLedger(row);
  }
  public list(filter: Partial<LedgerFilter> = {}): readonly PositionLedgerEntry[] {
    const clauses: string[] = []; const values: string[] = [];
    if (filter.walletId != null) { clauses.push("wallet_id = ?"); values.push(filter.walletId); }
    if (filter.strategyId != null) { clauses.push("strategy_id = ?"); values.push(filter.strategyId); }
    if (filter.symbol != null) { clauses.push("symbol = ?"); values.push(filter.symbol); }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    return (this.db.connection.prepare(`SELECT * FROM position_ledger_entries${where} ORDER BY ts ASC, created_at ASC, id ASC`).all(...values) as SqlRow[]).map(decodeLedger);
  }
}

export class SqliteWalletPositionSnapshotRepository implements WalletPositionSnapshotRepository {
  public constructor(private readonly db: SqliteDatabase) {}
  public get(walletId: string, symbol: string): WalletPositionSnapshot | undefined {
    const row = this.db.connection.prepare("SELECT * FROM wallet_position_snapshots WHERE wallet_id = ? AND symbol = ?").get(walletId, symbol) as SqlRow | undefined;
    return row == null ? undefined : decodeWalletSnapshot(row);
  }
  public save(snapshot: WalletPositionSnapshot): WalletPositionSnapshot {
    this.db.connection.prepare("INSERT INTO wallet_position_snapshots (wallet_id, symbol, base_qty_raw, quote_cost_raw, avg_entry_price_raw, realized_pnl_raw, status, last_ledger_entry_id, last_ledger_order_key, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wallet_id, symbol) DO UPDATE SET base_qty_raw=excluded.base_qty_raw, quote_cost_raw=excluded.quote_cost_raw, avg_entry_price_raw=excluded.avg_entry_price_raw, realized_pnl_raw=excluded.realized_pnl_raw, status=excluded.status, last_ledger_entry_id=excluded.last_ledger_entry_id, last_ledger_order_key=excluded.last_ledger_order_key, version=excluded.version").run(snapshot.walletId, snapshot.symbol, raw(snapshot.baseQtyRaw), raw(snapshot.quoteCostRaw), raw(snapshot.avgEntryPriceRaw), raw(snapshot.realizedPnlRaw), snapshot.status, snapshot.lastLedgerEntryId ?? null, snapshot.lastLedgerOrderKey ?? null, snapshot.version);
    return this.get(snapshot.walletId, snapshot.symbol)!;
  }
  public list(): readonly WalletPositionSnapshot[] { return (this.db.connection.prepare("SELECT * FROM wallet_position_snapshots ORDER BY wallet_id ASC, symbol ASC").all() as SqlRow[]).map(decodeWalletSnapshot); }
}

export class SqliteStrategyPositionSnapshotRepository implements StrategyPositionSnapshotRepository {
  public constructor(private readonly db: SqliteDatabase) {}
  public get(walletId: string, strategyId: string, symbol: string): StrategyPositionSnapshot | undefined {
    const row = this.db.connection.prepare("SELECT * FROM strategy_position_snapshots WHERE wallet_id = ? AND strategy_id = ? AND symbol = ?").get(walletId, strategyId, symbol) as SqlRow | undefined;
    return row == null ? undefined : decodeStrategySnapshot(row);
  }
  public save(snapshot: StrategyPositionSnapshot): StrategyPositionSnapshot {
    this.db.connection.prepare("INSERT INTO strategy_position_snapshots (wallet_id, strategy_id, symbol, base_qty_raw, quote_cost_raw, avg_entry_price_raw, realized_pnl_raw, status, last_ledger_entry_id, last_ledger_order_key, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wallet_id, strategy_id, symbol) DO UPDATE SET base_qty_raw=excluded.base_qty_raw, quote_cost_raw=excluded.quote_cost_raw, avg_entry_price_raw=excluded.avg_entry_price_raw, realized_pnl_raw=excluded.realized_pnl_raw, status=excluded.status, last_ledger_entry_id=excluded.last_ledger_entry_id, last_ledger_order_key=excluded.last_ledger_order_key, version=excluded.version").run(snapshot.walletId, snapshot.strategyId, snapshot.symbol, raw(snapshot.baseQtyRaw), raw(snapshot.quoteCostRaw), raw(snapshot.avgEntryPriceRaw), raw(snapshot.realizedPnlRaw), snapshot.status, snapshot.lastLedgerEntryId ?? null, snapshot.lastLedgerOrderKey ?? null, snapshot.version);
    return this.get(snapshot.walletId, snapshot.strategyId, snapshot.symbol)!;
  }
  public list(): readonly StrategyPositionSnapshot[] { return (this.db.connection.prepare("SELECT * FROM strategy_position_snapshots ORDER BY wallet_id ASC, strategy_id ASC, symbol ASC").all() as SqlRow[]).map(decodeStrategySnapshot); }
}

export class SqliteAppliedLedgerMarkerRepository implements AppliedLedgerMarkerRepository {
  public constructor(private readonly db: SqliteDatabase) {}
  public tryMarkApplied(scopeType: PositionScopeType, scopeId: string, entry: PositionLedgerEntry): boolean {
    const duplicate = this.db.connection.prepare("SELECT 1 FROM applied_ledger_markers WHERE scope_type = ? AND scope_id = ? AND ledger_entry_id = ?").get(scopeType, scopeId, entry.id);
    if (duplicate != null) return false;
    const previous = this.db.connection.prepare("SELECT ledger_order_key FROM applied_ledger_markers WHERE scope_type = ? AND scope_id = ? ORDER BY ledger_order_key DESC LIMIT 1").get(scopeType, scopeId) as SqlRow | undefined;
    const nextOrder = ledgerKey(entry);
    if (previous != null && asString(previous.ledger_order_key) > nextOrder) throw new Error("applied marker order regression rejected");
    this.db.connection.prepare("INSERT INTO applied_ledger_markers (scope_type, scope_id, ledger_entry_id, ledger_order_key) VALUES (?, ?, ?, ?)").run(scopeType, scopeId, entry.id, nextOrder);
    return true;
  }
  public clearScope(scopeType: PositionScopeType, scopeId: string): void { this.db.connection.prepare("DELETE FROM applied_ledger_markers WHERE scope_type = ? AND scope_id = ?").run(scopeType, scopeId); }
  public list(scopeType: PositionScopeType, scopeId: string): readonly { ledgerEntryId: string; ledgerOrderKey: string }[] {
    return (this.db.connection.prepare("SELECT ledger_entry_id, ledger_order_key FROM applied_ledger_markers WHERE scope_type = ? AND scope_id = ? ORDER BY ledger_order_key ASC").all(scopeType, scopeId) as SqlRow[]).map(row => Object.freeze({ ledgerEntryId: asString(row.ledger_entry_id), ledgerOrderKey: asString(row.ledger_order_key) }));
  }
}

export class WalletPositionSnapshotService {
  public constructor(private readonly ledger: PositionLedgerRepository, private readonly snapshots: WalletPositionSnapshotRepository, private readonly markers: AppliedLedgerMarkerRepository, private readonly transactions: TransactionRunner) {}
  public appendAndApply(entry: PositionLedgerEntry): WalletPositionSnapshot { return this.transactions.transaction(() => this.applyInTransaction(this.ledger.append(entry))); }
  public applyLedgerEntry(entry: PositionLedgerEntry): WalletPositionSnapshot { return this.transactions.transaction(() => this.applyInTransaction(entry)); }
  public rebuildFromLedger(walletId: string, symbol: string): WalletPositionSnapshot {
    return this.transactions.transaction(() => {
      const scopeId = walletScopeId(walletId, symbol); this.markers.clearScope(PositionScopeType.WALLET, scopeId);
      let snapshot = emptyWalletPositionSnapshot(walletId, symbol);
      for (const entry of this.ledger.list({ walletId, symbol })) { this.markers.tryMarkApplied(PositionScopeType.WALLET, scopeId, entry); snapshot = applyLedgerEntryToSnapshot(snapshot, entry) as WalletPositionSnapshot; }
      return this.snapshots.save(snapshot);
    });
  }
  private applyInTransaction(entry: PositionLedgerEntry): WalletPositionSnapshot {
    const scopeId = walletScopeId(entry.walletId, entry.symbol);
    if (!this.markers.tryMarkApplied(PositionScopeType.WALLET, scopeId, entry)) return this.snapshots.get(entry.walletId, entry.symbol) ?? emptyWalletPositionSnapshot(entry.walletId, entry.symbol);
    const current = this.snapshots.get(entry.walletId, entry.symbol) ?? emptyWalletPositionSnapshot(entry.walletId, entry.symbol);
    return this.snapshots.save(applyLedgerEntryToSnapshot(current, entry) as WalletPositionSnapshot);
  }
}

export class StrategyPositionSnapshotService {
  public constructor(private readonly ledger: PositionLedgerRepository, private readonly snapshots: StrategyPositionSnapshotRepository, private readonly markers: AppliedLedgerMarkerRepository, private readonly transactions: TransactionRunner) {}
  public appendAndApply(entry: PositionLedgerEntry): StrategyPositionSnapshot | undefined { return entry.strategyId == null ? undefined : this.transactions.transaction(() => this.applyInTransaction(this.ledger.append(entry))); }
  public applyLedgerEntry(entry: PositionLedgerEntry): StrategyPositionSnapshot | undefined { return entry.strategyId == null ? undefined : this.transactions.transaction(() => this.applyInTransaction(entry)); }
  public rebuildFromLedger(walletId: string, strategyId: string, symbol: string): StrategyPositionSnapshot {
    return this.transactions.transaction(() => {
      const scopeId = strategyScopeId(walletId, strategyId, symbol); this.markers.clearScope(PositionScopeType.STRATEGY, scopeId);
      let snapshot = emptyStrategyPositionSnapshot(walletId, strategyId, symbol);
      for (const entry of this.ledger.list({ walletId, strategyId, symbol })) { this.markers.tryMarkApplied(PositionScopeType.STRATEGY, scopeId, entry); snapshot = applyLedgerEntryToSnapshot(snapshot, entry) as StrategyPositionSnapshot; }
      return this.snapshots.save(snapshot);
    });
  }
  private applyInTransaction(entry: PositionLedgerEntry): StrategyPositionSnapshot {
    const strategyId = entry.strategyId!; const scopeId = strategyScopeId(entry.walletId, strategyId, entry.symbol);
    if (!this.markers.tryMarkApplied(PositionScopeType.STRATEGY, scopeId, entry)) return this.snapshots.get(entry.walletId, strategyId, entry.symbol) ?? emptyStrategyPositionSnapshot(entry.walletId, strategyId, entry.symbol);
    const current = this.snapshots.get(entry.walletId, strategyId, entry.symbol) ?? emptyStrategyPositionSnapshot(entry.walletId, strategyId, entry.symbol);
    return this.snapshots.save(applyLedgerEntryToSnapshot(current, entry) as StrategyPositionSnapshot);
  }
}

export const migrations: readonly SqliteMigration[] = [{ id: "001_position_accounting", sql: `
CREATE TABLE IF NOT EXISTS position_ledger_entries (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, strategy_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, base_qty_raw TEXT NOT NULL, quote_qty_raw TEXT, ts TEXT NOT NULL, created_at TEXT NOT NULL, source_trade_id TEXT);
CREATE INDEX IF NOT EXISTS idx_position_ledger_order ON position_ledger_entries (wallet_id, symbol, ts, created_at, id);
CREATE TABLE IF NOT EXISTS wallet_position_snapshots (wallet_id TEXT NOT NULL, symbol TEXT NOT NULL, base_qty_raw TEXT NOT NULL, quote_cost_raw TEXT NOT NULL, avg_entry_price_raw TEXT, realized_pnl_raw TEXT NOT NULL, status TEXT NOT NULL, last_ledger_entry_id TEXT, last_ledger_order_key TEXT, version INTEGER NOT NULL, PRIMARY KEY (wallet_id, symbol));
CREATE TABLE IF NOT EXISTS strategy_position_snapshots (wallet_id TEXT NOT NULL, strategy_id TEXT NOT NULL, symbol TEXT NOT NULL, base_qty_raw TEXT NOT NULL, quote_cost_raw TEXT NOT NULL, avg_entry_price_raw TEXT, realized_pnl_raw TEXT NOT NULL, status TEXT NOT NULL, last_ledger_entry_id TEXT, last_ledger_order_key TEXT, version INTEGER NOT NULL, PRIMARY KEY (wallet_id, strategy_id, symbol));
CREATE TABLE IF NOT EXISTS applied_ledger_markers (scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, ledger_entry_id TEXT NOT NULL, ledger_order_key TEXT NOT NULL, PRIMARY KEY (scope_type, scope_id, ledger_entry_id));
` }, { id: "002_research_memory", sql: `
CREATE TABLE IF NOT EXISTS research_hypotheses (id TEXT PRIMARY KEY, title TEXT NOT NULL, statement TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_experiment_records (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, content_sha256 TEXT NOT NULL, manifest_schema_version INTEGER NOT NULL, market TEXT NOT NULL, interval TEXT NOT NULL, start_open_time INTEGER NOT NULL, end_close_time INTEGER NOT NULL, walk_forward_config_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, hypothesis_id TEXT);
CREATE INDEX IF NOT EXISTS idx_research_experiment_dataset ON research_experiment_records (dataset_id, created_at, id);
` }, { id: "003_governance_control", sql: `
CREATE TABLE IF NOT EXISTS strategy_registry (strategy_id TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(strategy_id, version));
CREATE TABLE IF NOT EXISTS strategy_governance_events (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, event_json TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS strategy_governance_state (id INTEGER PRIMARY KEY CHECK(id = 1), snapshot_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS champion_assignments (family TEXT PRIMARY KEY, strategy_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS strategy_governance_commands (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS investment_committee_events (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, decision_json TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS investment_committee_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), hash TEXT NOT NULL);
` }, { id: "004_compliance_control_plane", sql: `
CREATE TABLE IF NOT EXISTS compliance_events (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, event_json TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS compliance_state (id INTEGER PRIMARY KEY CHECK(id=1), ledger_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compliance_rules (rule_id TEXT NOT NULL, version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(rule_id, version));
CREATE TABLE IF NOT EXISTS compliance_decisions (decision_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS surveillance_alerts (alert_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compliance_cases (case_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS regulatory_reports (report_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence_packages (evidence_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compliance_certifications (certification_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
` }, { id: "005_resilience_control_plane", sql: `
CREATE TABLE IF NOT EXISTS resilience_events (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, event_json TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS resilience_state (id INTEGER PRIMARY KEY CHECK(id=1), ledger_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resilience_services (service_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS continuity_plans (plan_id TEXT NOT NULL, version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(plan_id,version));
CREATE TABLE IF NOT EXISTS resilience_evidence_packages (evidence_hash TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
` }, { id: "006_rules_control_plane", sql: `
CREATE TABLE IF NOT EXISTS rules_events (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, event_json TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS rules_state (id INTEGER PRIMARY KEY CHECK(id=1), ledger_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rules (rule_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rule_versions (rule_id TEXT NOT NULL, version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(rule_id, version));
CREATE TABLE IF NOT EXISTS policies (policy_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policy_versions (policy_id TEXT NOT NULL, version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(policy_id, version));
CREATE TABLE IF NOT EXISTS decision_tables (policy_id TEXT NOT NULL, version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(policy_id, version));
CREATE TABLE IF NOT EXISTS formulas (formula_id TEXT NOT NULL, version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(formula_id, version));
CREATE TABLE IF NOT EXISTS evaluations (evaluation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evaluation_traces (evaluation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS explanations (evaluation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS simulations (evaluation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decision_evidence (evidence_hash TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decision_certifications (certification_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
` }, { id: "007_multi_agent_governance", sql: `
CREATE TABLE IF NOT EXISTS multi_agent_governance_events (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, event_json TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS multi_agent_governance_state (id INTEGER PRIMARY KEY CHECK(id=1), ledger_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_definitions (agent_id TEXT NOT NULL, definition_version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(agent_id, definition_version));
CREATE TABLE IF NOT EXISTS agent_role_contracts (contract_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_evidence (evidence_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_context_snapshots (context_snapshot_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_runs (agent_run_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS multi_agent_orchestration_runs (orchestration_run_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS multi_agent_decisions (decision_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS multi_agent_incidents (incident_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS multi_agent_certifications (certification_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
` }, { id: "008_cloud_dashboard_snapshots", sql: `
CREATE TABLE IF NOT EXISTS cloud_dashboard_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  source_commit TEXT NOT NULL,
  source_version TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('VALID','CORRUPTED','INVALID'))
);
CREATE INDEX IF NOT EXISTS idx_cloud_dashboard_snapshots_latest ON cloud_dashboard_snapshots (status, saved_at DESC);
` }, { id: "009_cloud_paper_accounts", sql: `
CREATE TABLE IF NOT EXISTS cloud_paper_accounts (
  account_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('VALID','CORRUPTED','INVALID'))
);
` }, { id: "010_risk_safety_integration", sql: `
CREATE TABLE IF NOT EXISTS risk_paper_approvals (
  approval_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('VALID','REVOKED'))
);
CREATE TABLE IF NOT EXISTS risk_daily_loss_state (
  account_id TEXT PRIMARY KEY,
  trading_day TEXT NOT NULL,
  day_start_equity REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS risk_idempotency_records (
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, idempotency_key),
  UNIQUE (account_id, command_id),
  UNIQUE (account_id, signal_id),
  UNIQUE (account_id, client_order_id)
);
CREATE TABLE IF NOT EXISTS risk_order_state (
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','PENDING','FILLED','CANCELLED','REJECTED')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, order_id)
);
` }, { id: "011_research_evaluation_ledger", sql: `
CREATE TABLE IF NOT EXISTS research_evaluation_ledger (
  sequence INTEGER PRIMARY KEY,
  evaluation_id TEXT NOT NULL UNIQUE,
  previous_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
` }, { id: "012_candidate_promotion_runtime", sql: `
CREATE TABLE IF NOT EXISTS research_candidates (
  candidate_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_champion_pointer (id INTEGER PRIMARY KEY CHECK(id = 1), candidate_id TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS research_promotion_commands (command_id TEXT PRIMARY KEY, payload_fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS research_promotion_audit (sequence INTEGER PRIMARY KEY, command_id TEXT NOT NULL, previous_hash TEXT NOT NULL, record_json TEXT NOT NULL, current_hash TEXT NOT NULL UNIQUE);
` }, { id: "013_research_automation_sessions", sql: `
CREATE TABLE IF NOT EXISTS research_sessions (
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('IDLE','RUNNING','PAUSED','HALTED','COMPLETED','FAILED')),
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_sessions_state ON research_sessions (state, updated_at, session_id);
` }, { id: "014_research_hypothesis_events", sql: `
CREATE TABLE IF NOT EXISTS research_hypothesis_events (
  sequence INTEGER PRIMARY KEY,
  hypothesis_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('CREATED','ACTIVATED','SUPPORTED','REJECTED','RETIRED')),
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_research_hypothesis_events_id ON research_hypothesis_events (hypothesis_id, sequence);
` }, { id: "015_cloud_paper_writer_lease", sql: `
CREATE TABLE IF NOT EXISTS cloud_paper_writer_leases (
  account_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL
);
` }, { id: "016_improvement_candidate_memory", sql: `
CREATE TABLE IF NOT EXISTS improvement_candidate_memory (
  fingerprint TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  severity TEXT NOT NULL,
  score INTEGER NOT NULL,
  occurrences INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_improvement_candidate_memory_retention ON improvement_candidate_memory (score ASC, last_seen_at DESC, fingerprint DESC);
` }, { id: "017_paper_realized_periods", sql: `
CREATE TABLE IF NOT EXISTS paper_realized_periods (
  period_id TEXT PRIMARY KEY,
  period_index INTEGER NOT NULL UNIQUE,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('OPEN','REALIZED')),
  period_start_at INTEGER NOT NULL,
  period_end_at INTEGER,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_realized_periods_order
  ON paper_realized_periods (lifecycle_state, period_index ASC, period_id ASC);
` }, cloudPaperAccountHistoryMigration, { id: "019_paper_public_market_observations", sql: `
CREATE TABLE IF NOT EXISTS paper_public_market_observations (
  observation_id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_fingerprint_sha256 TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_paper_public_market_observations_window
  ON paper_public_market_observations (market, observed_at_ms ASC, observation_id ASC);
` }, { id: "020_evolution_learning_ledger", sql: `
CREATE TABLE IF NOT EXISTS evolution_learning_ledger_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  ledger_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evolution_learning_ledger_events (
  sequence INTEGER PRIMARY KEY,
  opportunity_id TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_evolution_learning_ledger_recorded_at
  ON evolution_learning_ledger_events (recorded_at ASC, opportunity_id ASC);
INSERT OR IGNORE INTO evolution_learning_ledger_meta (id, schema_version, event_count, ledger_hash)
  VALUES (1, 1, 0, '0000000000000000000000000000000000000000000000000000000000000000');
` }, researchFactoryDecisionHistoryMigration, { id: "022_research_memory_semantic_overlay", sql: `
CREATE TABLE IF NOT EXISTS research_memory_semantic_events (
  sequence INTEGER PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('SEMANTIC','RELATION')),
  identity TEXT NOT NULL UNIQUE,
  artifact_kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  semantic_identity TEXT,
  independence_group_id TEXT,
  previous_hash TEXT NOT NULL,
  event_json TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_research_memory_semantic_artifact
  ON research_memory_semantic_events (artifact_kind, artifact_id, artifact_sha256, sequence);
CREATE INDEX IF NOT EXISTS idx_research_memory_semantic_identity
  ON research_memory_semantic_events (semantic_identity, independence_group_id, sequence);
` }, cloudPaperFillLedgerMigration, { id: "024_research_intelligence_memory", sql: `
CREATE TABLE IF NOT EXISTS research_intelligence_records (
  record_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  hypothesis_semantic_fingerprint TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_intelligence_source
  ON research_intelligence_records (source_type, source_id, discovered_at, record_id);
CREATE INDEX IF NOT EXISTS idx_research_intelligence_hypothesis
  ON research_intelligence_records (hypothesis_semantic_fingerprint, discovered_at, record_id);
` }, cloudPaperLegacyReconciliationMigration, { id: "026_research_closed_candles", sql: `
CREATE TABLE IF NOT EXISTS research_closed_candles (
  market TEXT NOT NULL,
  interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
  close_time_ms INTEGER NOT NULL CHECK (close_time_ms > 0),
  open REAL NOT NULL CHECK (open > 0),
  high REAL NOT NULL CHECK (high > 0),
  low REAL NOT NULL CHECK (low > 0),
  close REAL NOT NULL CHECK (close > 0),
  checksum TEXT NOT NULL,
  PRIMARY KEY (market, interval_ms, close_time_ms)
);
` }, { id: "027_research_holdout_usage", sql: `
CREATE TABLE IF NOT EXISTS research_holdout_usage (
  strategy_config_hash TEXT NOT NULL,
  market TEXT NOT NULL,
  interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
  holdout_start_ms INTEGER NOT NULL CHECK (holdout_start_ms > 0),
  holdout_end_ms INTEGER NOT NULL CHECK (holdout_end_ms >= holdout_start_ms),
  evaluation_id TEXT NOT NULL,
  used_at_ms INTEGER NOT NULL CHECK (used_at_ms > 0),
  PRIMARY KEY (strategy_config_hash, market, interval_ms, holdout_start_ms, holdout_end_ms)
);
` }, { id: "028_research_market_microstructure", sql: `
CREATE TABLE IF NOT EXISTS research_orderbook_samples (
  market TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms > 0),
  best_bid REAL NOT NULL CHECK (best_bid > 0),
  best_ask REAL NOT NULL CHECK (best_ask > 0),
  bid_size_5 REAL NOT NULL CHECK (bid_size_5 >= 0),
  ask_size_5 REAL NOT NULL CHECK (ask_size_5 >= 0),
  total_bid_size REAL NOT NULL CHECK (total_bid_size >= 0),
  total_ask_size REAL NOT NULL CHECK (total_ask_size >= 0),
  PRIMARY KEY (market, captured_at_ms)
);
CREATE TABLE IF NOT EXISTS research_trade_ticks (
  market TEXT NOT NULL,
  sequential_id INTEGER NOT NULL,
  traded_at_ms INTEGER NOT NULL CHECK (traded_at_ms > 0),
  price REAL NOT NULL CHECK (price > 0),
  volume REAL NOT NULL CHECK (volume > 0),
  side TEXT NOT NULL CHECK (side IN ('ASK', 'BID')),
  PRIMARY KEY (market, sequential_id)
);
CREATE INDEX IF NOT EXISTS research_trade_ticks_time ON research_trade_ticks (market, traded_at_ms);
` }, { id: "029_research_trade_ticks_by_content", sql: `
CREATE TABLE IF NOT EXISTS research_trade_ticks_v2 (
  market TEXT NOT NULL,
  traded_at_ms INTEGER NOT NULL CHECK (traded_at_ms > 0),
  price REAL NOT NULL CHECK (price > 0),
  volume REAL NOT NULL CHECK (volume > 0),
  side TEXT NOT NULL CHECK (side IN ('ASK', 'BID')),
  PRIMARY KEY (market, traded_at_ms, price, volume, side)
);
` }, { id: "030_research_futures_public", sql: `
CREATE TABLE IF NOT EXISTS research_futures_marks (
  symbol TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms > 0),
  mark_price REAL NOT NULL CHECK (mark_price > 0),
  index_price REAL NOT NULL CHECK (index_price > 0),
  last_funding_rate REAL NOT NULL,
  next_funding_time_ms INTEGER NOT NULL CHECK (next_funding_time_ms > 0),
  PRIMARY KEY (symbol, captured_at_ms)
);
CREATE TABLE IF NOT EXISTS research_futures_funding (
  symbol TEXT NOT NULL,
  funding_time_ms INTEGER NOT NULL CHECK (funding_time_ms > 0),
  funding_rate REAL NOT NULL,
  PRIMARY KEY (symbol, funding_time_ms)
);
CREATE TABLE IF NOT EXISTS research_futures_klines (
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time_ms INTEGER NOT NULL CHECK (open_time_ms > 0),
  close_time_ms INTEGER NOT NULL CHECK (close_time_ms > open_time_ms),
  open REAL NOT NULL CHECK (open > 0),
  high REAL NOT NULL CHECK (high > 0),
  low REAL NOT NULL CHECK (low > 0),
  close REAL NOT NULL CHECK (close > 0),
  volume REAL NOT NULL CHECK (volume >= 0),
  PRIMARY KEY (symbol, interval, open_time_ms)
);
` }, { id: "031_research_closed_candles_volume", sql: `
ALTER TABLE research_closed_candles ADD COLUMN volume REAL CHECK (volume IS NULL OR volume >= 0);
` }, { id: "032_research_orderbook_study_rows", sql: `
CREATE TABLE IF NOT EXISTS research_orderbook_study_rows (
  market TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms > 0),
  best_bid REAL NOT NULL CHECK (best_bid > 0),
  best_ask REAL NOT NULL CHECK (best_ask > 0),
  bid_size_5 REAL NOT NULL CHECK (bid_size_5 >= 0),
  ask_size_5 REAL NOT NULL CHECK (ask_size_5 >= 0),
  total_bid_size REAL NOT NULL CHECK (total_bid_size >= 0),
  total_ask_size REAL NOT NULL CHECK (total_ask_size >= 0),
  PRIMARY KEY (market, captured_at_ms)
) WITHOUT ROWID;
` }];

// Kept in the SqliteDatabase lexical module: no imported issuer or verifier can be rebound.
namespace CalibrationDurabilityStorage {
const SCHEMA_VERSION = 1 as const;
const GENESIS_HASH = "0".repeat(64);
type EventType = "PREDICTION" | "OUTCOME_RESOLVED" | "PENDING_EXPIRED";

type SqlRow = Record<string, string | number | bigint | null>;

interface EventRow extends SqlRow {
  sequence: number | bigint;
  event_type: string;
  prediction_id: string;
  prediction_content_hash: string;
  payload_json: string;
  recorded_at: number | bigint;
  previous_hash: string;
  event_hash: string;
}

interface MetaRow extends SqlRow {
  schema_version: number | bigint;
  event_count: number | bigint;
  ledger_hash: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_calibration_durability_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  schema_version INTEGER NOT NULL,
  event_count INTEGER NOT NULL CHECK(event_count >= 0),
  ledger_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_calibration_durability_events (
  sequence INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('PREDICTION','OUTCOME_RESOLVED','PENDING_EXPIRED')),
  prediction_id TEXT NOT NULL,
  prediction_content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_calibration_prediction_once
  ON ai_calibration_durability_events(prediction_id)
  WHERE event_type = 'PREDICTION';
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_calibration_terminal_once
  ON ai_calibration_durability_events(prediction_id)
  WHERE event_type IN ('OUTCOME_RESOLVED','PENDING_EXPIRED');
`;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function asSafeInteger(value: string | number | bigint | null, field: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return converted;
}

function asHash(value: unknown, field: string): string {
  if (!isAiSha256(value)) throw new Error(`${field} must be sha256`);
  return value.toLowerCase();
}

function parseCanonicalJson(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") throw new Error("durable calibration payload must be text");
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("durable calibration payload JSON is invalid"); }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("durable calibration payload must be an object");
  if (canonicalAiJson(parsed) !== value) throw new Error("durable calibration payload is not canonical");
  return parsed as Readonly<Record<string, unknown>>;
}

function predictionPayload(prediction: AiCalibrationPrediction): AiCalibrationPrediction {
  return Object.freeze({
    predictionId: requiredText(prediction.predictionId, "predictionId"),
    orchestrationRunId: requiredText(prediction.orchestrationRunId, "orchestrationRunId"),
    proposalId: requiredText(prediction.proposalId, "proposalId"),
    agentId: requiredText(prediction.agentId, "agentId"),
    role: prediction.role,
    providerId: requiredText(prediction.providerId, "providerId"),
    modelVersionId: requiredText(prediction.modelVersionId, "modelVersionId"),
    promptArtifactId: requiredText(prediction.promptArtifactId, "promptArtifactId"),
    promptArtifactVersion: requiredText(prediction.promptArtifactVersion, "promptArtifactVersion"),
    promptArtifactDigest: asHash(prediction.promptArtifactDigest, "promptArtifactDigest"),
    outcomeDefinitionId: requiredText(prediction.outcomeDefinitionId, "outcomeDefinitionId"),
    outcomeDefinitionVersion: requiredText(prediction.outcomeDefinitionVersion, "outcomeDefinitionVersion"),
    targetId: requiredText(prediction.targetId, "targetId"),
    anchorValue: prediction.anchorValue,
    anchorObservedAt: prediction.anchorObservedAt,
    anchorEvidenceReference: requiredText(prediction.anchorEvidenceReference, "anchorEvidenceReference"),
    rawProbability: prediction.rawProbability,
    predictedAt: prediction.predictedAt,
    horizonMs: prediction.horizonMs,
    provenance: prediction.provenance,
    contentHash: asHash(prediction.contentHash, "prediction.contentHash")
  });
}

function outcomePayload(outcome: AiCalibrationOutcome): AiCalibrationOutcome {
  return Object.freeze({
    predictionId: requiredText(outcome.predictionId, "predictionId"),
    predictionContentHash: asHash(outcome.predictionContentHash, "predictionContentHash"),
    outcomeDefinitionId: requiredText(outcome.outcomeDefinitionId, "outcomeDefinitionId"),
    outcomeDefinitionVersion: requiredText(outcome.outcomeDefinitionVersion, "outcomeDefinitionVersion"),
    outcome: outcome.outcome,
    resolvedValue: outcome.resolvedValue,
    resolvedAt: outcome.resolvedAt,
    evidenceReferences: Object.freeze(outcome.evidenceReferences.map((reference) => requiredText(reference, "evidenceReference"))),
    provenance: outcome.provenance,
    contentHash: asHash(outcome.contentHash, "outcome.contentHash")
  });
}

function expiryPayload(expiry: AiCalibrationPendingExpiry): AiCalibrationPendingExpiry {
  return Object.freeze({
    predictionId: requiredText(expiry.predictionId, "predictionId"),
    predictionContentHash: asHash(expiry.predictionContentHash, "predictionContentHash"),
    expiredAt: nonNegativeSafeInteger(expiry.expiredAt, "expiredAt")
  });
}

function eventIdentity(
  sequence: number,
  eventType: EventType,
  predictionId: string,
  predictionContentHash: string,
  payload: Readonly<Record<string, unknown>>,
  recordedAt: number,
  previousHash: string
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    sequence,
    eventType,
    predictionId,
    predictionContentHash,
    payload,
    recordedAt,
    previousHash
  });
}

export class SqliteAiCalibrationDurableStore implements AiCalibrationDurableStore {
  private readonly connection: DatabaseSync;
  private readonly ownsConnection: boolean;
  private closed = false;
  /**
   * In-memory mirror of the verified chain, refreshed in full by replay() (still a genuine full
   * disk read + hash-chain re-verification) and extended incrementally after each successful
   * appendEvent() commit. appendPrediction/appendOutcomeAndResolve/expirePending previously each
   * called this.replay() themselves -- an O(n) re-walk-and-reverify of the entire table on every
   * single write to an append-only, ever-growing ledger. ensureCache() lazily warms the cache via
   * a real replay() the first time it's needed, so correctness never depends on caller order.
   */
  private cacheWarmed = false;
  private cachedPredictions = new Map<string, AiCalibrationPrediction>();
  private cachedOutcomes = new Map<string, AiCalibrationOutcome>();
  private cachedExpired = new Map<string, AiCalibrationPendingExpiry>();

  public constructor(filename = ":memory:", verifiedSharedDatabase?: SqliteDatabase) {
    const sharedConnection = verifiedSharedDatabase == null ? null : resolveCheckedSharedConnection(verifiedSharedDatabase);
    if (verifiedSharedDatabase != null && sharedConnection == null) throw new Error("shared AI calibration database has not passed canonical full-file quick_check");
    this.connection = sharedConnection ?? sqliteIntegrityBoundary.open(filename);
    this.ownsConnection = sharedConnection == null;
    try {
      if (this.ownsConnection) {
        this.connection.exec("PRAGMA foreign_keys = ON");
        this.connection.exec("PRAGMA busy_timeout = 5000");
        if (filename !== ":memory:") this.connection.exec("PRAGMA journal_mode = WAL");
        this.connection.exec("PRAGMA synchronous = FULL");
      }
      this.ensureSchema();
      if (this.ownsConnection) {
        const check = sqliteIntegrityBoundary.read(sqliteIntegrityBoundary.prepare(this.connection, "PRAGMA quick_check")) as Record<string, unknown> | undefined;
        if (check == null || !sqliteIntegrityBoundary.resultIsOk(check)) throw new Error("AI calibration sqlite quick_check failed");
      } else {
        for (const table of ["ai_calibration_durability_meta", "ai_calibration_durability_events"] as const) {
          const check = sqliteIntegrityBoundary.read(sqliteIntegrityBoundary.prepare(this.connection, `PRAGMA quick_check('${table}')`)) as Record<string, unknown> | undefined;
          if (check == null || !sqliteIntegrityBoundary.resultIsOk(check)) throw new Error("AI calibration sqlite quick_check failed");
        }
      }
    } catch (error) {
      if (this.ownsConnection) this.connection.close();
      this.closed = true;
      throw error;
    }
  }

  public replay(): AiCalibrationDurableReplay {
    this.assertOpen();
    const meta = this.readMeta();
    const rows = this.connection.prepare(
      "SELECT sequence, event_type, prediction_id, prediction_content_hash, payload_json, recorded_at, previous_hash, event_hash FROM ai_calibration_durability_events ORDER BY sequence ASC"
    ).all() as unknown as EventRow[];
    if (rows.length !== meta.eventCount) throw new Error("durable calibration event count mismatch");

    const predictions = new Map<string, AiCalibrationPrediction>();
    const outcomes = new Map<string, AiCalibrationOutcome>();
    const expired = new Map<string, AiCalibrationPendingExpiry>();
    let previousHash = GENESIS_HASH;

    rows.forEach((row, index) => {
      const sequence = asSafeInteger(row.sequence, "sequence");
      if (sequence !== index + 1) throw new Error("durable calibration sequence is not contiguous");
      const eventType = requiredText(row.event_type, "eventType") as EventType;
      if (eventType !== "PREDICTION" && eventType !== "OUTCOME_RESOLVED" && eventType !== "PENDING_EXPIRED") throw new Error("unsupported durable calibration event type");
      const predictionId = requiredText(row.prediction_id, "predictionId");
      const predictionContentHash = asHash(row.prediction_content_hash, "predictionContentHash");
      const recordedAt = asSafeInteger(row.recorded_at, "recordedAt");
      const storedPreviousHash = asHash(row.previous_hash, "previousHash");
      const storedEventHash = asHash(row.event_hash, "eventHash");
      if (storedPreviousHash !== previousHash) throw new Error("durable calibration hash chain mismatch");
      const payload = parseCanonicalJson(row.payload_json);
      const expectedHash = aiSha256(eventIdentity(sequence, eventType, predictionId, predictionContentHash, payload, recordedAt, storedPreviousHash));
      if (expectedHash !== storedEventHash) throw new Error("durable calibration event hash mismatch");

      if (eventType === "PREDICTION") {
        if (predictions.has(predictionId)) throw new Error("duplicate durable calibration prediction event");
        const prediction = payload as unknown as AiCalibrationPrediction;
        if (requiredText(prediction.predictionId, "prediction.predictionId") !== predictionId) throw new Error("durable calibration prediction identity mismatch");
        if (asHash(prediction.contentHash, "prediction.contentHash") !== predictionContentHash) throw new Error("durable calibration prediction content hash mismatch");
        predictions.set(predictionId, predictionPayload(prediction));
      } else if (eventType === "OUTCOME_RESOLVED") {
        const prediction = predictions.get(predictionId);
        if (prediction == null) throw new Error("durable calibration outcome precedes prediction");
        if (prediction.contentHash.toLowerCase() !== predictionContentHash) throw new Error("durable calibration outcome linkage mismatch");
        if (expired.has(predictionId)) throw new Error("durable calibration outcome follows expiry");
        if (outcomes.has(predictionId)) throw new Error("duplicate durable calibration outcome event");
        const outcome = payload as unknown as AiCalibrationOutcome;
        if (requiredText(outcome.predictionId, "outcome.predictionId") !== predictionId) throw new Error("durable calibration outcome identity mismatch");
        if (asHash(outcome.predictionContentHash, "outcome.predictionContentHash") !== predictionContentHash) throw new Error("durable calibration outcome prediction hash mismatch");
        outcomes.set(predictionId, outcomePayload(outcome));
      } else {
        const prediction = predictions.get(predictionId);
        if (prediction == null) throw new Error("durable calibration expiry precedes prediction");
        if (prediction.contentHash.toLowerCase() !== predictionContentHash) throw new Error("durable calibration expiry linkage mismatch");
        if (outcomes.has(predictionId)) throw new Error("durable calibration expiry follows outcome");
        if (expired.has(predictionId)) throw new Error("duplicate durable calibration expiry event");
        const item = payload as unknown as AiCalibrationPendingExpiry;
        const normalized = expiryPayload(item);
        if (normalized.predictionId !== predictionId || normalized.predictionContentHash !== predictionContentHash) throw new Error("durable calibration expiry identity mismatch");
        expired.set(predictionId, normalized);
      }
      previousHash = storedEventHash;
    });

    if (previousHash !== meta.ledgerHash) throw new Error("durable calibration ledger head mismatch");
    this.cachedPredictions = predictions;
    this.cachedOutcomes = outcomes;
    this.cachedExpired = expired;
    this.cacheWarmed = true;
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      predictions: Object.freeze([...predictions.values()]),
      outcomes: Object.freeze([...outcomes.values()]),
      expiredPending: Object.freeze([...expired.values()]),
      eventCount: rows.length,
      headHash: previousHash
    });
  }

  /** Lazily warms the cache via a real replay() the first time it's needed. */
  private ensureCache(): void {
    if (!this.cacheWarmed) this.replay();
  }

  public appendPrediction(prediction: AiCalibrationPrediction, recordedAt: number): void {
    const normalized = predictionPayload(prediction);
    this.ensureCache();
    const prior = this.cachedPredictions.get(normalized.predictionId);
    if (prior != null) {
      if (prior.contentHash.toLowerCase() !== normalized.contentHash.toLowerCase()) throw new Error("conflicting durable calibration prediction replay");
      return;
    }
    this.appendEvent("PREDICTION", normalized.predictionId, normalized.contentHash, normalized as unknown as Readonly<Record<string, unknown>>, recordedAt);
    this.cachedPredictions.set(normalized.predictionId, normalized);
  }

  public appendOutcomeAndResolve(outcome: AiCalibrationOutcome, recordedAt: number): void {
    const normalized = outcomePayload(outcome);
    this.ensureCache();
    const prediction = this.cachedPredictions.get(normalized.predictionId);
    if (prediction == null) throw new Error("durable calibration prediction is missing");
    if (prediction.contentHash.toLowerCase() !== normalized.predictionContentHash.toLowerCase()) throw new Error("durable calibration outcome prediction hash mismatch");
    const priorOutcome = this.cachedOutcomes.get(normalized.predictionId);
    if (priorOutcome != null) {
      if (priorOutcome.contentHash.toLowerCase() !== normalized.contentHash.toLowerCase()) throw new Error("conflicting durable calibration outcome replay");
      return;
    }
    if (this.cachedExpired.has(normalized.predictionId)) throw new Error("durable calibration prediction is already expired");
    this.appendEvent("OUTCOME_RESOLVED", normalized.predictionId, normalized.predictionContentHash, normalized as unknown as Readonly<Record<string, unknown>>, recordedAt);
    this.cachedOutcomes.set(normalized.predictionId, normalized);
  }

  public expirePending(expiry: AiCalibrationPendingExpiry): void {
    const normalized = expiryPayload(expiry);
    this.ensureCache();
    const prediction = this.cachedPredictions.get(normalized.predictionId);
    if (prediction == null) throw new Error("durable calibration prediction is missing");
    if (prediction.contentHash.toLowerCase() !== normalized.predictionContentHash.toLowerCase()) throw new Error("durable calibration expiry prediction hash mismatch");
    if (this.cachedOutcomes.has(normalized.predictionId)) throw new Error("durable calibration prediction is already resolved");
    const prior = this.cachedExpired.get(normalized.predictionId);
    if (prior != null) {
      if (prior.predictionContentHash !== normalized.predictionContentHash || prior.expiredAt !== normalized.expiredAt) throw new Error("conflicting durable calibration expiry replay");
      return;
    }
    this.appendEvent("PENDING_EXPIRED", normalized.predictionId, normalized.predictionContentHash, normalized as unknown as Readonly<Record<string, unknown>>, normalized.expiredAt);
    this.cachedExpired.set(normalized.predictionId, normalized);
  }

  public close(): void {
    if (this.closed) return;
    if (this.ownsConnection) this.connection.close();
    this.closed = true;
  }

  private appendEvent(
    eventType: EventType,
    predictionId: string,
    predictionContentHash: string,
    payload: Readonly<Record<string, unknown>>,
    recordedAtValue: number
  ): void {
    this.assertOpen();
    const recordedAt = nonNegativeSafeInteger(recordedAtValue, "recordedAt");
    const payloadJson = canonicalAiJson(payload);
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const meta = this.readMeta();
      const sequence = meta.eventCount + 1;
      const eventHash = aiSha256(eventIdentity(sequence, eventType, predictionId, predictionContentHash, payload, recordedAt, meta.ledgerHash));
      this.connection.prepare(
        "INSERT INTO ai_calibration_durability_events (sequence, event_type, prediction_id, prediction_content_hash, payload_json, recorded_at, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(sequence, eventType, predictionId, predictionContentHash, payloadJson, recordedAt, meta.ledgerHash, eventHash);
      this.connection.prepare(
        "UPDATE ai_calibration_durability_meta SET event_count = ?, ledger_hash = ? WHERE id = 1 AND schema_version = ?"
      ).run(sequence, eventHash, SCHEMA_VERSION);
      this.connection.exec("COMMIT");
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  private ensureSchema(): void {
    this.connection.exec(SCHEMA_SQL);
    const row = this.connection.prepare(
      "SELECT schema_version, event_count, ledger_hash FROM ai_calibration_durability_meta WHERE id = 1"
    ).get() as unknown as MetaRow | undefined;
    if (row == null) {
      this.connection.prepare(
        "INSERT INTO ai_calibration_durability_meta (id, schema_version, event_count, ledger_hash) VALUES (1, ?, 0, ?)"
      ).run(SCHEMA_VERSION, GENESIS_HASH);
      return;
    }
    const version = asSafeInteger(row.schema_version, "schemaVersion");
    if (version !== SCHEMA_VERSION) throw new Error(`unsupported AI calibration durability schema version: ${version}`);
    asSafeInteger(row.event_count, "eventCount");
    asHash(row.ledger_hash, "ledgerHash");
  }

  private readMeta(): { readonly eventCount: number; readonly ledgerHash: string } {
    const row = this.connection.prepare(
      "SELECT schema_version, event_count, ledger_hash FROM ai_calibration_durability_meta WHERE id = 1"
    ).get() as unknown as MetaRow | undefined;
    if (row == null) throw new Error("AI calibration durability metadata is missing");
    const version = asSafeInteger(row.schema_version, "schemaVersion");
    if (version !== SCHEMA_VERSION) throw new Error(`unsupported AI calibration durability schema version: ${version}`);
    return Object.freeze({ eventCount: asSafeInteger(row.event_count, "eventCount"), ledgerHash: asHash(row.ledger_hash, "ledgerHash") });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("AI calibration durable store is closed");
  }
}

}
export import SqliteAiCalibrationDurableStore = CalibrationDurabilityStorage.SqliteAiCalibrationDurableStore;

// Kept in the SqliteDatabase lexical module: no imported issuer or verifier can be rebound.
namespace OutcomeAttributionStorage {
const SCHEMA_VERSION = 1 as const;
const GENESIS_HASH = "0".repeat(64);
type SqlRow = Record<string, string | number | bigint | null>;

interface EventRow extends SqlRow {
  sequence: number | bigint;
  episode_id: string;
  content_hash: string;
  payload_json: string;
  recorded_at: number | bigint;
  previous_hash: string;
  event_hash: string;
}

interface MetaRow extends SqlRow {
  schema_version: number | bigint;
  event_count: number | bigint;
  ledger_hash: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_outcome_attribution_memory_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  schema_version INTEGER NOT NULL,
  event_count INTEGER NOT NULL CHECK(event_count >= 0),
  ledger_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_outcome_attribution_memory_events (
  sequence INTEGER PRIMARY KEY,
  episode_id TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE
);
`;

const forbiddenMemoryText = /(authorization|bearer\s|api[_-]?key|credential|private[_-]?key|access[_-]?key|secret[_-]?key)/i;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function safeInteger(value: unknown, field: string): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (typeof converted !== "number" || !Number.isSafeInteger(converted) || converted < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return converted;
}

function hash(value: unknown, field: string): string {
  if (!isAiSha256(value)) throw new Error(`${field} must be sha256`);
  return value.toLowerCase();
}

function parseCanonicalJson(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") throw new Error("learning memory payload must be text");
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("learning memory payload JSON is invalid"); }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("learning memory payload must be an object");
  if (canonicalAiJson(parsed) !== value) throw new Error("learning memory payload is not canonical");
  return parsed as Readonly<Record<string, unknown>>;
}

function verifyEpisode(episode: AiAttributionEpisode): AiAttributionEpisode {
  const episodeId = requiredText(episode.episodeId, "episodeId");
  const contentHash = hash(episode.contentHash, "contentHash");
  if (forbiddenMemoryText.test(JSON.stringify(episode))) throw new Error("learning memory contains forbidden secret-like material");
  const { contentHash: _stored, ...withoutHash } = episode;
  if (aiSha256(withoutHash) !== contentHash) throw new Error("learning memory episode content hash mismatch");
  if (episode.liveAuthority !== "NONE" || episode.productionMutationAllowed !== false || episode.realOrderAuthority !== false || episode.realTransferAuthority !== false) {
    throw new Error("learning memory authority invariant violated");
  }
  if (!Number.isSafeInteger(episode.createdAt) || !Number.isSafeInteger(episode.expiresAt) || episode.createdAt < 0 || episode.expiresAt <= episode.createdAt) {
    throw new Error("learning memory chronology is invalid");
  }
  if (episode.supersedesEpisodeId != null && requiredText(episode.supersedesEpisodeId, "supersedesEpisodeId") === episodeId) {
    throw new Error("learning memory episode cannot supersede itself");
  }
  return Object.freeze({ ...episode, episodeId, contentHash });
}

function eventIdentity(sequence: number, episode: AiAttributionEpisode, previousHash: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    sequence,
    episodeId: episode.episodeId,
    contentHash: episode.contentHash,
    payload: episode,
    recordedAt: episode.createdAt,
    previousHash
  });
}

export class SqliteAiOutcomeAttributionMemory implements AiLearningMemoryStore {
  private readonly connection: DatabaseSync;
  private readonly ownsConnection: boolean;
  private closed = false;
  /**
   * In-memory mirror of the verified chain, keyed by episodeId, refreshed by replay() (which
   * still always does a genuine full disk read + hash-chain re-verification) and extended
   * incrementally by appendEpisode() right after each successful commit. appendEpisode() and
   * applicableLessons() read from this cache instead of re-walking and re-verifying the entire
   * table on every call -- on this append-only, ever-growing ledger that was an O(n)-per-call
   * cost paid on every single market tick (applicableLessons is called once per tick from
   * apps/cloud/src/runtime.ts). Single-writer-per-process is already this store's existing trust
   * boundary (same as every other SQLite store in this codebase), so this introduces no new
   * assumption -- it only avoids re-proving what this same process already proved.
   */
  private cachedEpisodes = new Map<string, AiAttributionEpisode>();

  public constructor(filename = ":memory:", verifiedSharedDatabase?: SqliteDatabase) {
    const sharedConnection = verifiedSharedDatabase == null ? null : resolveCheckedSharedConnection(verifiedSharedDatabase);
    if (verifiedSharedDatabase != null && sharedConnection == null) throw new Error("shared AI attribution database has not passed canonical full-file quick_check");
    this.connection = sharedConnection ?? sqliteIntegrityBoundary.open(filename);
    this.ownsConnection = sharedConnection == null;
    try {
      if (this.ownsConnection) {
        this.connection.exec("PRAGMA foreign_keys = ON");
        this.connection.exec("PRAGMA busy_timeout = 5000");
        if (filename !== ":memory:") this.connection.exec("PRAGMA journal_mode = WAL");
        this.connection.exec("PRAGMA synchronous = FULL");
      }
      this.connection.exec(SCHEMA_SQL);
      this.connection.prepare(
        "INSERT OR IGNORE INTO ai_outcome_attribution_memory_meta (id, schema_version, event_count, ledger_hash) VALUES (1, ?, 0, ?)"
      ).run(SCHEMA_VERSION, GENESIS_HASH);
      if (this.ownsConnection) {
        const check = sqliteIntegrityBoundary.read(sqliteIntegrityBoundary.prepare(this.connection, "PRAGMA quick_check")) as Record<string, unknown> | undefined;
        if (check == null || !sqliteIntegrityBoundary.resultIsOk(check)) throw new Error("learning memory sqlite quick_check failed");
      } else {
        for (const table of ["ai_outcome_attribution_memory_meta", "ai_outcome_attribution_memory_events"] as const) {
          const check = sqliteIntegrityBoundary.read(sqliteIntegrityBoundary.prepare(this.connection, `PRAGMA quick_check('${table}')`)) as Record<string, unknown> | undefined;
          if (check == null || !sqliteIntegrityBoundary.resultIsOk(check)) throw new Error("learning memory sqlite quick_check failed");
        }
      }
      this.replay();
    } catch (error) {
      if (this.ownsConnection) this.connection.close();
      this.closed = true;
      throw error;
    }
  }

  public replay(): AiLearningMemoryReplay {
    this.assertOpen();
    const meta = this.readMeta();
    const rows = this.connection.prepare(
      "SELECT sequence, episode_id, content_hash, payload_json, recorded_at, previous_hash, event_hash FROM ai_outcome_attribution_memory_events ORDER BY sequence ASC"
    ).all() as unknown as EventRow[];
    if (rows.length !== meta.eventCount) throw new Error("learning memory event count mismatch");
    const episodes: AiAttributionEpisode[] = [];
    const seen = new Set<string>();
    let previousHash = GENESIS_HASH;
    rows.forEach((row, index) => {
      const sequence = safeInteger(row.sequence, "sequence");
      if (sequence !== index + 1) throw new Error("learning memory sequence is not contiguous");
      const episodeId = requiredText(row.episode_id, "episodeId");
      if (seen.has(episodeId)) throw new Error("duplicate learning memory episode");
      const contentHash = hash(row.content_hash, "contentHash");
      const recordedAt = safeInteger(row.recorded_at, "recordedAt");
      const storedPreviousHash = hash(row.previous_hash, "previousHash");
      const storedEventHash = hash(row.event_hash, "eventHash");
      if (storedPreviousHash !== previousHash) throw new Error("learning memory hash chain mismatch");
      const payload = parseCanonicalJson(row.payload_json) as unknown as AiAttributionEpisode;
      const episode = verifyEpisode(payload);
      if (episode.episodeId !== episodeId || episode.contentHash !== contentHash || episode.createdAt !== recordedAt) throw new Error("learning memory row identity mismatch");
      if (episode.supersedesEpisodeId != null && !seen.has(episode.supersedesEpisodeId)) throw new Error("learning memory supersession target must precede replacement");
      const expectedEventHash = aiSha256(eventIdentity(sequence, episode, storedPreviousHash));
      if (expectedEventHash !== storedEventHash) throw new Error("learning memory event hash mismatch");
      episodes.push(episode);
      seen.add(episodeId);
      previousHash = storedEventHash;
    });
    if (previousHash !== meta.ledgerHash) throw new Error("learning memory ledger head mismatch");
    this.cachedEpisodes = new Map(episodes.map((episode) => [episode.episodeId, episode]));
    return Object.freeze({ schemaVersion: 1, episodes: Object.freeze(episodes), eventCount: episodes.length, headHash: previousHash });
  }

  public appendEpisode(value: AiAttributionEpisode): void {
    this.assertOpen();
    const episode = verifyEpisode(value);
    const prior = this.cachedEpisodes.get(episode.episodeId);
    if (prior != null) {
      if (prior.contentHash !== episode.contentHash) throw new Error("conflicting learning memory replay");
      return;
    }
    if (episode.supersedesEpisodeId != null) {
      const target = this.cachedEpisodes.get(episode.supersedesEpisodeId);
      if (target == null) throw new Error("learning memory supersession target is missing");
      if (target.scope !== episode.scope) throw new Error("learning memory supersession scope mismatch");
      if (episode.createdAt <= target.createdAt) throw new Error("learning memory supersession chronology is invalid");
    }
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const meta = this.readMeta();
      const sequence = meta.eventCount + 1;
      const eventHash = aiSha256(eventIdentity(sequence, episode, meta.ledgerHash));
      this.connection.prepare(
        "INSERT INTO ai_outcome_attribution_memory_events (sequence, episode_id, content_hash, payload_json, recorded_at, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(sequence, episode.episodeId, episode.contentHash, canonicalAiJson(episode), episode.createdAt, meta.ledgerHash, eventHash);
      this.connection.prepare(
        "UPDATE ai_outcome_attribution_memory_meta SET event_count = ?, ledger_hash = ? WHERE id = 1"
      ).run(sequence, eventHash);
      this.connection.exec("COMMIT");
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch { /* ignore rollback failure */ }
      throw error;
    }
    this.cachedEpisodes.set(episode.episodeId, episode);
  }

  public applicableLessons(scopeValue: string, nowValue: number): readonly AiLessonProjection[] {
    const scope = requiredText(scopeValue, "scope");
    const now = safeInteger(nowValue, "now");
    const episodes = [...this.cachedEpisodes.values()];
    const superseded = new Set(episodes.flatMap((episode) => episode.supersedesEpisodeId == null ? [] : [episode.supersedesEpisodeId]));
    return Object.freeze(episodes
      .filter((episode) => episode.scope === scope && episode.createdAt <= now && now < episode.expiresAt && !superseded.has(episode.episodeId))
      .map((episode): AiLessonProjection => Object.freeze({
        episodeId: episode.episodeId,
        strength: episode.strength,
        primaryCause: episode.primaryCause,
        reasonCodes: episode.reasonCodes,
        scope: episode.scope,
        createdAt: episode.createdAt,
        expiresAt: episode.expiresAt,
        realizedLearningCreditAllowed: episode.realizedLearningCreditAllowed,
        advisoryOnly: true,
        liveAuthority: "NONE",
        productionMutationAllowed: false
      })));
  }

  public close(): void {
    if (this.closed) return;
    if (this.ownsConnection) this.connection.close();
    this.closed = true;
  }

  private readMeta(): { readonly eventCount: number; readonly ledgerHash: string } {
    const row = this.connection.prepare(
      "SELECT schema_version, event_count, ledger_hash FROM ai_outcome_attribution_memory_meta WHERE id = 1"
    ).get() as unknown as MetaRow | undefined;
    if (row == null) throw new Error("learning memory metadata is missing");
    if (safeInteger(row.schema_version, "schemaVersion") !== SCHEMA_VERSION) throw new Error("learning memory schema version mismatch");
    return Object.freeze({ eventCount: safeInteger(row.event_count, "eventCount"), ledgerHash: hash(row.ledger_hash, "ledgerHash") });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("learning memory store is closed");
  }
}

}
export import SqliteAiOutcomeAttributionMemory = OutcomeAttributionStorage.SqliteAiOutcomeAttributionMemory;
