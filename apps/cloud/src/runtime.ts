import { HEALTH_EXPORT_TIMEOUT_MS, healthExportConfig, startHealthExport } from "./healthExport";
import { buildMobileDashboardResponse } from "./mobileDashboardApi";
import { paperLedgerFingerprint } from "./paperLedgerFingerprint";
import { InMemoryCloudDashboardStateProvider, type CloudDashboardStateProvider } from "./cloudDashboardStateProvider";
import { readCloudRuntimeConfig, createSharedSecretTokenVerifier } from "./cloudRuntimeConfig";
import { evolutionLedgerRetentionGuard } from "./closedLearningEvolutionLedgerRepository";
import { SqliteDatabase, SqliteEvolutionLearningLedger } from "../../../packages/storage/src/index";
import { DurableCloudDashboardStateProvider } from "./durableCloudDashboardStateProvider";
import { SqliteCloudDashboardSnapshotRepository, type CloudDashboardSnapshotRepository } from "./cloudDashboardSnapshotRepository";
import { readResearchExperimentSettings } from "./researchExperimentComposition";
import { createEventLoopStallMonitor } from "./eventLoopStallMonitor";
import { PaperTradingExecutionLoop, SqliteCloudPaperAccountRepository, paperAccountIdForCapital, type PaperAccountRepository } from "./paperTradingExecutionLoop";
import { CloudPaperCanonicalRiskGateway } from "./cloudPaperCanonicalRiskGateway";
import { cloudPaperRiskLimitsForCapital } from "./paperRiskLimitScaling";
import { attributeTodayLosses, type PaperLossAttribution } from "./paperLossAttribution";
import { classifyPaperWait } from "./paperWaitReason";
import { CloudPaperExecutionBoundary } from "./cloudPaperExecutionBoundary";
import { SqliteP0AlertRepository } from "./p0AlertRepository";
import fs from "node:fs";
import path from "node:path";
import { createShutdownController, handleRuntimeFault, type ShutdownController } from "./cloudRuntimeShutdown";
import { readPreviousRuntimeFailure, recordRuntimeFailure } from "./runtimeFailureRecord";
import { paperExecutionObservedAt } from "./paperExecutionObservation";
import { startCloudDashboardServer, type CloudDashboardServerHandle, type CloudReadinessSnapshot } from "./server";
import { CloudRuntimeDashboardHydrator } from "./cloudRuntimeDashboardHydrator";
import { UpbitWebSocketClient, type UpbitOrderBook, type UpbitTicker, type UpbitTrade, type UpbitWebSocketOptions } from "./upbitWebSocket";
import type { MarketMicrostructureRecorder } from "./marketMicrostructureRecorder";
import type { ResearchOrderBookCollector } from "./researchOrderBookCollector";
import type { ResearchFuturesCollector } from "./researchFuturesCollector";
import { readDataIntegrityResult } from "./dataIntegrityResult";
import { classifyTickerRejectReason, upbitTickerToIntelligenceObservation } from "./upbitTickerObservation";
import type { IntelligenceObservation } from "./marketIntelligenceFusion";
import type { ResearchRuntimeMarketDataTick } from "./researchRuntimeCoordinator";
import { retainObservation } from "./observationRetention";
import type { ResearchRecoveryResult } from "../../../packages/contracts/src/researchRecovery";
import type { ResearchStatusProjection } from "../../../packages/contracts/src/researchAutomation";
import {
  buildPersonalPaperOperationsSnapshot,
  type PersonalPaperMarketProjection,
  type PersonalPaperOperationsSnapshot,
  type PersonalPaperOrderProjection,
  type PersonalPaperPortfolioProjection,
  type PersonalPaperRuntimeHaltReason,
  type PersonalPaperRuntimeHeartbeat,
  type PersonalPaperLossLimit,
  type PersonalPaperLearningFunnel,
  type PersonalPaperLearningLoop,
  type PersonalPaperOrderBookStudy,
  type PersonalPaperTodayRealized
} from "../../../packages/contracts/src/personalPaperOperations";
import type { PersonalPaperOrderCommand, PersonalPaperOrderCommandResult } from "../../../packages/contracts/src/personalPaperOrderCommand";
import type { DashboardPrincipal } from "./mobileDashboardHttp";
import { computeLimitReachedAt, computeTodayRealizedPnlKrw } from "./paperTodayRealized";
import { PaperDecisionTrace } from "./paperDecisionTrace";
import type { CloudAiRuntime } from "./ai/runtime";
import { AI_CALIBRATION_OUTCOME_DEFINITION_ID, attributionScope, createCloudAiRuntime } from "./ai/runtime";
import { projectAiReadOnly } from "./ai/projection";
import { buildCloudRuntimeAiEvidence, type CloudRuntimeAiP0State } from "./ai/cloudRuntimeEvidence";
import { InMemoryInvestmentAllocationSettingsRepository, SqliteInvestmentAllocationSettingsRepository, type InvestmentAllocationSettingsRepository } from "./cloudInvestmentAllocationSettings";
import { SqliteNusaUserAccessRepository } from "./operatorUserAccess";
import { DesktopSessionService } from "./desktopSessionService";
import { MobileSessionService } from "./mobileSessionService";
import { OwnerDeviceCredentialService } from "./ownerCredential/ownerDeviceCredentialService";
import { PaperLearningEventRecorder, paperLearningCycleId } from "./paperLearningObservability";
import { PaperFunnelCounters, mergeFunnelSnapshots, recordOrderIntentWithReasonCode } from "./paperFunnelCounters";
import { createJevMarketMicrostructureShadowObserverFromEnvironment } from "./ai/jevMarketMicrostructureShadow";
import { buildPaperLearningReadOnlyProjection, classifyPaperLearningRuntimeStatus } from "./paperLearningReadOnlyProjection";
import { readPaperRuntimeSupervisorProjection } from "./paperRuntimeSupervisorProjection";
import { projectPaperRuntimeHealth } from "./paperRuntimeHealth";
import { DEFAULT_UPBIT_TICKER_STALE_WINDOW_MS } from "./upbitTickerObservation";
import type { ShadowObservabilitySnapshot } from "../../../packages/contracts/src/shadowObservabilityReadOnly";
import { validateShadowObservabilitySnapshot } from "../../../packages/contracts/src/shadowObservabilityReadOnly";
import { createDormantLiveAuthority } from "./liveReadinessGate";
import {
  createLiveReadinessSourceProvider,
  type LiveReadinessProductionSourceSnapshot,
  type LiveReadinessSourceReaders,
} from "./liveReadinessSourceProvider";
import { RealReadOnlyEventRecorder } from "./realReadOnlyObservabilityPersistence";
import type { RealReadOnlyEvent, RealReadOnlyObservabilitySnapshot } from "../../../packages/contracts/src/realReadOnlyObservability";
import { readCloudRuntimeSafety, readPaperAutoLearningReadiness } from "./liveReadinessRuntimeReaders";
import { paperExecutionObservationId, PaperRealizedPeriodProducer, SqlitePaperRealizedPeriodRepository, type PaperRealizedPeriodCanonicalCloseInput, type PaperRealizedPeriodCloseInput, type PaperRealizedPeriodOpenInput, type PersistedPaperRealizedPeriodPlan } from "./paperRealizedPeriodProducer";
import { readCanonicalPaperTickerBenchmark } from "./paperMarketBenchmark";
import { buildPaperObservedExecutionQuote, type PaperObservedExecutionQuote } from "./paperRuntimeExecutionCostEvidence";
import { codePaperDecisionOutcome } from "./paperDecisionOutcome";
import { describeCanonicalDecision } from "./paperDecisionDetail";
import type { PersonalPaperDecisionDetail } from "../../../packages/contracts/src/personalPaperOperations";
import { PaperMarketObservationStoreError, SqlitePaperMarketObservationRepository } from "../../../packages/storage/src/paperMarketObservationRepository";
import { canonicalUpbitSourceFingerprint } from "../../../packages/core/src/canonicalMarketData";
import { UpbitOrderBookReconciler } from "./upbitOrderBookReconciliation";
import type { PersistedPaperPeriodEnvelope } from "../../../packages/contracts/src/persistedPaperPeriod";
import { buildEvolutionLearningSupervisorSnapshot } from "./evolutionLearningSupervisorProjection";
import {
  createNusaEngineeringOperatingReadModel,
  type NusaEngineeringOperatingReadModel,
  type NusaEngineeringOperatingSnapshot,
  type NusaEngineeringOperatingSource,
} from "./engineeringOperatingReadModel";
import { composeResearchExperiments } from "./researchExperimentComposition";
import { readOrderBookStudyDisplay } from "./researchStudyResult";
import { OrderBookCoverageWatch } from "./orderBookCoverage";

export interface CloudRuntimeDashboardHydratorLike { hydrate(provider: CloudDashboardStateProvider, observations?: readonly IntelligenceObservation[]): void; }
export interface CloudRuntimeMarketDataClientLike { subscribe(markets: readonly string[]): void; start(): void; stop(): void; }
export interface CloudRuntimeResearchRuntimeLike { onMarketData(tick: ResearchRuntimeMarketDataTick): void; }
export interface CloudRuntimeResearchRecoveryLike { recover(): ResearchRecoveryResult; }
export interface CloudRuntimeResearchAutomationLike { recover?(): ResearchRecoveryResult; gapFill?(): { readonly lastRunAt?: number; readonly runs: number; readonly deferred: number; readonly counts: Readonly<Record<string, number>>; readonly lastErrorCode?: string } | null; onMarketData(tick: ResearchRuntimeMarketDataTick): void; statusProjection?(): ResearchStatusProjection | null; collectionProgress?(): { readonly market: string; readonly candleCount: number; readonly requiredCandles: number; readonly firstCloseMs?: number; readonly lastCloseMs?: number; readonly observedAt: number } | null; experimentTicks?(): { readonly lastTickAt: number; readonly lastStatus: string; readonly ticks: number; readonly sessionsStarted: number; readonly counts: Readonly<Record<string, number>> } | null; }
export type CloudRuntimeMarketDataClientFactory = (markets: readonly string[], onTicker: (ticker: UpbitTicker) => void, onConnectionState: (state: string) => void, onOrderBook?: (orderBook: UpbitOrderBook) => void, onTrade?: (trade: UpbitTrade) => void) => CloudRuntimeMarketDataClientLike;
export type CloudRuntimeShadowObservabilityProvider = (principal: DashboardPrincipal) => ShadowObservabilitySnapshot;
export type CloudRuntimeRealReadOnlyObservabilityProvider = (principal: DashboardPrincipal, events: readonly RealReadOnlyEvent[]) => RealReadOnlyObservabilitySnapshot;
export interface CloudRuntimeHandle extends CloudDashboardServerHandle {
  readonly getLiveReadinessSourceSnapshot: () => LiveReadinessProductionSourceSnapshot;
  readonly getEngineeringOperatingSnapshot: () => NusaEngineeringOperatingSnapshot;
  readonly recordRealReadOnlyEvent: (event: RealReadOnlyEvent) => RealReadOnlyEvent;
  readonly openPaperRealizedPeriod: (input: PaperRealizedPeriodOpenInput) => PersistedPaperRealizedPeriodPlan;
  readonly observePaperRealizedExecution: (observation: { readonly observationId: string; readonly observedAt: number; readonly status: "FILLED" | "WAIT" | "BLOCKED" | "REJECTED" | "FAILED" | "DUPLICATE" }) => "RECORDED" | "DUPLICATE" | "NO_ACTIVE_PERIOD";
  readonly closePaperRealizedPeriod: (input: PaperRealizedPeriodCloseInput) => PersistedPaperPeriodEnvelope;
  /** Canonical account-boundary path; no caller-supplied outcome metrics are accepted. */
  readonly openPaperRealizedPeriodFromCanonicalAccount: (input: PaperRealizedPeriodOpenInput) => PersistedPaperRealizedPeriodPlan;
  readonly closePaperRealizedPeriodFromCanonicalAccount: (input: PaperRealizedPeriodCanonicalCloseInput) => PersistedPaperPeriodEnvelope;
  /** Retires only an owner-baseline period at qualified-challenger handoff. */
  readonly retirePaperRealizedPeriodForReplacement: (periodId: string, reason: string) => PersistedPaperRealizedPeriodPlan;
  readonly retirePaperRealizedPeriodForAccountChange: (periodId: string) => PersistedPaperRealizedPeriodPlan;
  readonly retirePaperRealizedPeriodForUnstreamedMarket: (periodId: string, streamedMarkets: readonly string[]) => PersistedPaperRealizedPeriodPlan;
  readonly retirePaperRealizedPeriodForMixedBinding: (periodId: string) => PersistedPaperRealizedPeriodPlan;
  readonly inspectPaperRealizedPeriodForMixedBinding: (periodId: string) => { readonly evidenceFingerprintSha256: string } | null;
  /** Canonical chronology allocator; includes realized, active pending and terminal disposition indexes. */
  readonly nextPaperRealizedPeriodIndex: () => number;
  readonly listPaperRealizedPeriods: () => readonly PersistedPaperPeriodEnvelope[];
}

function createSnapshotRepository(pathname: string): SqliteCloudDashboardSnapshotRepository {
  if (pathname !== ":memory:") {
    const absolute = path.resolve(pathname);
    const sourceTree = path.resolve(process.cwd()) + path.sep;
    if (absolute === path.resolve(process.cwd()) || absolute.startsWith(sourceTree)) throw new Error("cloud state database must not be inside the source tree");
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
  }
  return new SqliteCloudDashboardSnapshotRepository(new SqliteDatabase(pathname));
}

function buildReadOnlyPortfolio(paperSnapshot: ReturnType<PaperTradingExecutionLoop["snapshot"]> | undefined, fallbackMarket: PersonalPaperMarketProjection | undefined): PersonalPaperPortfolioProjection | null {
  if (paperSnapshot == null) return null;
  const positions = [...paperSnapshot.positions].sort((left, right) => left.market.localeCompare(right.market));
  const position = positions.find((item) => item.quantity > 0) ?? positions[0];
  const market = position?.market ?? fallbackMarket?.market ?? "";
  const markPrice = position?.markPrice ?? fallbackMarket?.price ?? 0;
  const assetValue = paperSnapshot.positions.reduce((sum, item) => sum + item.quantity * item.markPrice, 0);
  if (position != null && (!market || !Number.isFinite(markPrice) || markPrice <= 0)) return null;
  return { observedAt: new Date(paperSnapshot.updatedAt).toISOString(), mode: "PAPER", account: { available: true, cash: paperSnapshot.cash, equity: paperSnapshot.equity, unrealizedPnl: paperSnapshot.unrealizedPnL, assetValue, realizedPnl: paperSnapshot.realizedPnL, markPrice, position: position == null ? { market, quantity: 0, averagePrice: 0, realizedPnl: paperSnapshot.realizedPnL, unrealizedPnl: 0 } : { market: position.market, quantity: position.quantity, averagePrice: position.averageEntryPrice, realizedPnl: position.realizedPnL, unrealizedPnl: position.unrealizedPnL } }, openOrderCount: 0 };
}

function buildReadOnlyOrders(paperSnapshot: ReturnType<PaperTradingExecutionLoop["snapshot"]> | undefined): readonly PersonalPaperOrderProjection[] {
  if (paperSnapshot == null) return [];
  return paperSnapshot.orders.map((order) => ({ id: order.id, market: order.market, side: order.side, quantity: order.quantity, price: order.price, fee: order.fee, filledAt: new Date(order.filledAt).toISOString(), status: "FILLED" as const, fills: paperSnapshot.fills.filter((fill) => fill.orderId === order.id).map((fill) => ({ id: fill.id, quantity: fill.quantity, price: fill.price, filledAt: new Date(fill.filledAt).toISOString() })) }));
}

function buildCloudRuntimeReadiness(durableRepository: CloudDashboardSnapshotRepository | undefined, effectiveProvider: CloudDashboardStateProvider): CloudReadinessSnapshot {
  const failed = (): CloudReadinessSnapshot => Object.freeze({ ok: false, checks: Object.freeze({ database: false, migrations: false, dashboardPersistence: false, runtimeRecovery: false }) });
  if (!(durableRepository instanceof SqliteCloudDashboardSnapshotRepository)) return failed();
  try {
    const db = durableRepository.database();
    // Readiness runs on the HTTP event loop. A full-file PRAGMA quick_check can take
    // seconds on the production ledger and starve even the O(1) /health endpoint.
    // Probe the already-open canonical connection here; migration/persistence/recovery
    // checks below still fail closed on an unreadable or inconsistent runtime store.
    const databaseProbe = db.connection.prepare("SELECT 1 AS ready").get() as Record<string, unknown> | undefined;
    const database = Number(databaseProbe?.ready ?? 0) === 1;
    const latestMigration = db.connection.prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const migrations = db.migrationResult.currentVersion !== undefined && String(latestMigration?.id ?? "") === db.migrationResult.currentVersion;
    const dashboardState = effectiveProvider.read({ userId: "operator", scopes: ["dashboard:read"] });
    const persistedSnapshot = durableRepository.loadLatest();
    const dashboardPersistence = dashboardState != null && persistedSnapshot != null;
    const corrupted = db.connection.prepare("SELECT COUNT(*) AS count FROM cloud_dashboard_snapshots WHERE status = 'CORRUPTED'").get() as Record<string, unknown> | undefined;
    const runtimeRecovery = persistedSnapshot != null && Number(corrupted?.count ?? 0) === 0;
    const checks = Object.freeze({ database, migrations, dashboardPersistence, runtimeRecovery });
    return Object.freeze({ ok: Object.values(checks).every(Boolean), checks });
  } catch { return failed(); }
}

/** Named form of the startCloudRuntime parameters, so a caller cannot shift an argument into the wrong slot. */
export interface CloudRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stateProvider?: CloudDashboardStateProvider;
  readonly dashboardHydrator?: CloudRuntimeDashboardHydratorLike;
  readonly marketDataClientFactory?: CloudRuntimeMarketDataClientFactory;
  readonly snapshotRepository?: CloudDashboardSnapshotRepository;
  readonly paperAccountRepository?: PaperAccountRepository;
  readonly paperExecutionLoop?: PaperTradingExecutionLoop;
  readonly researchRuntime?: CloudRuntimeResearchRuntimeLike;
  readonly researchRecoveryCoordinator?: CloudRuntimeResearchRecoveryLike;
  readonly researchAutomation?: CloudRuntimeResearchAutomationLike;
  readonly aiRuntime?: CloudAiRuntime;
  readonly shadowObservabilityProvider?: CloudRuntimeShadowObservabilityProvider;
  readonly liveReadinessSourceReaders?: LiveReadinessSourceReaders;
  readonly realReadOnlyObservabilityProvider?: CloudRuntimeRealReadOnlyObservabilityProvider;
  readonly engineeringOperatingSource?: NusaEngineeringOperatingSource;
  readonly closedLearningStatus?: Parameters<typeof startCloudRuntime>[15];
  readonly researchIntervalTicks?: Parameters<typeof startCloudRuntime>[16];
  readonly microstructureRecorder?: MarketMicrostructureRecorder;
  readonly orderBookCollector?: ResearchOrderBookCollector;
  readonly futuresCollector?: ResearchFuturesCollector;
}

/** Same runtime as startCloudRuntime; undefined options take the same defaults. */
export function startCloudRuntimeFromOptions(options: CloudRuntimeOptions): CloudRuntimeHandle {
  return startCloudRuntime(
    options.env,
    options.stateProvider,
    options.dashboardHydrator,
    options.marketDataClientFactory,
    options.snapshotRepository,
    options.paperAccountRepository,
    options.paperExecutionLoop,
    options.researchRuntime,
    options.researchRecoveryCoordinator,
    options.researchAutomation,
    options.aiRuntime,
    options.shadowObservabilityProvider,
    options.liveReadinessSourceReaders,
    options.realReadOnlyObservabilityProvider,
    options.engineeringOperatingSource,
    options.closedLearningStatus,
    options.researchIntervalTicks,
    options.microstructureRecorder,
    options.orderBookCollector,
    options.futuresCollector,
  );
}

export function startCloudRuntime(
  env: NodeJS.ProcessEnv = process.env,
  stateProvider: CloudDashboardStateProvider = new InMemoryCloudDashboardStateProvider(),
  dashboardHydrator: CloudRuntimeDashboardHydratorLike = new CloudRuntimeDashboardHydrator(),
  marketDataClientFactory: CloudRuntimeMarketDataClientFactory = (markets, onTicker, onConnectionState, onOrderBook, onTrade) => new UpbitWebSocketClient(markets, onTicker, undefined, undefined, undefined, { onConnectionState: (diagnostics) => onConnectionState(diagnostics.marketConnectionState), onOrderBook, onTrade } satisfies UpbitWebSocketOptions),
  snapshotRepository?: CloudDashboardSnapshotRepository,
  paperAccountRepository?: PaperAccountRepository,
  paperExecutionLoop?: PaperTradingExecutionLoop,
  researchRuntime?: CloudRuntimeResearchRuntimeLike,
  researchRecoveryCoordinator?: CloudRuntimeResearchRecoveryLike,
  researchAutomation?: CloudRuntimeResearchAutomationLike,
  aiRuntime?: CloudAiRuntime,
  shadowObservabilityProvider?: CloudRuntimeShadowObservabilityProvider,
  liveReadinessSourceReaders?: LiveReadinessSourceReaders,
  realReadOnlyObservabilityProvider?: CloudRuntimeRealReadOnlyObservabilityProvider,
  engineeringOperatingSource?: NusaEngineeringOperatingSource,
  /** Display-only status of the production closed-learning loop (see closedLearningLoopStatus.ts). */
  closedLearningStatus?: () => Readonly<Record<string, string | number | undefined | Readonly<Record<string, string | number | undefined>>>> | null,
  /** Display-only research experiment tick summaries keyed by bar length ("1m", "15m", ...). */
  researchIntervalTicks?: () => Readonly<Record<string, { readonly lastTickAt: number; readonly lastStatus: string; readonly ticks: number; readonly sessionsStarted: number; readonly counts: Readonly<Record<string, number>> } | null>> | null,
  /** Research-only recorder of the public order book and trades this runtime already receives (see marketMicrostructureRecorder.ts). */
  microstructureRecorder?: MarketMicrostructureRecorder,
  /** Research-only all-KRW order-book collector (see researchOrderBookCollector.ts). */
  orderBookCollector?: ResearchOrderBookCollector,
  /** Research-only public Binance futures collector (see researchFuturesCollector.ts). */
  futuresCollector?: ResearchFuturesCollector
): CloudRuntimeHandle {
  const config = readCloudRuntimeConfig(env);
  const paperSupervisor = readPaperRuntimeSupervisorProjection(env);
  const runtimeStartedAt = Date.now();
  const heartbeat: {
    startedAt: number;
    lastHeartbeatAt: number;
    lastMarketEventAt: number | null;
    lastAcceptedMarketReceiptAt: number | null;
    lastFailureAt: number | null;
    lastPaperDecisionAt: number | null;
    lastPaperOrderAt: number | null;
    lastPaperFillAt: number | null;
    eventCount: number;
    decisionCount: number;
    paperOrderCount: number;
    paperFillCount: number;
    lastPaperDecisionOutcome: string | null;
    lastError: string | null;
  } = {
    startedAt: runtimeStartedAt,
    lastHeartbeatAt: runtimeStartedAt,
    lastMarketEventAt: null,
    lastAcceptedMarketReceiptAt: null,
    lastFailureAt: null,
    lastPaperDecisionAt: null,
    lastPaperOrderAt: null,
    lastPaperFillAt: null,
    eventCount: 0,
    decisionCount: 0,
    paperOrderCount: 0,
    paperFillCount: 0,
    lastPaperDecisionOutcome: null,
    lastError: null
  };
  const recordFailure = (code: string): void => { heartbeat.lastError = code; heartbeat.lastFailureAt = Date.now(); };
  // Why the previous process stopped, kept apart from lastError so market start-up cannot overwrite it
  // and a supervisor restart loop stays diagnosable from /health.
  const previousStop = env.NUSA_CLOUD_STATE_DB_PATH === undefined ? undefined : readPreviousRuntimeFailure(config.cloudStateDbPath);
  // Display-only counters (BUY signals, decisions, orders) for the current 09:00 KST window (= 00:00 UTC), kept in memory. They are reported only when the
  // canonical PAPER boundary is active; without it nothing measures BUY outcomes and 0/0 would be a false statement.
  const BUY_WINDOW_MS = 86_400_000;
  const buyWindow = { key: Math.floor(runtimeStartedAt / BUY_WINDOW_MS), signals: 0, blocked: 0, decisions: 0, orders: 0, feedDisconnects: 0, feedStaleGaps: 0, feedMaxGapMs: 0 };
  // Display only: the same window's decisions and orders per 5 minutes, for the app's decision terrain.
  const decisionTrace = new PaperDecisionTrace(BUY_WINDOW_MS, runtimeStartedAt);
  let lastTickerArrivalMs: number | null = null;
  const rollBuyWindow = (nowMs: number): void => {
    const key = Math.floor(nowMs / BUY_WINDOW_MS);
    if (key !== buyWindow.key) { buyWindow.key = key; buyWindow.signals = 0; buyWindow.blocked = 0; buyWindow.decisions = 0; buyWindow.orders = 0; buyWindow.feedDisconnects = 0; buyWindow.feedStaleGaps = 0; buyWindow.feedMaxGapMs = 0; }
  };
  // Display-only: the numbers and the strategy reason behind the latest canonical decision, so the app can say why nothing was traded.
  let lastDecisionDetail: PersonalPaperDecisionDetail | undefined;
  // Display only: when today's streak reached the limit, rebuilt from the PAPER account's fills outside the pinned RISK gateway.
  const limitReachedAtFor = (session: { readonly evaluatedAt: number; readonly consecutiveLossCount: number; readonly maxConsecutiveLosses: number }): number | null => {
    try {
      const account = effectivePaperLoop?.snapshot();
      return account == null ? null : computeLimitReachedAt(account.fills, session.evaluatedAt, session.consecutiveLossCount, session.maxConsecutiveLosses);
    } catch { return null; }
  };
  // Display only: the consecutive-loss limit state the canonical risk gateway last evaluated. A failing read must never affect the heartbeat.
  const lossLimitHeartbeat = (): { lossLimit?: PersonalPaperLossLimit } => {
    let session: ReturnType<NonNullable<typeof productionPaperRiskGate>["lossSession"]> = null;
    try { session = productionPaperRiskGate?.lossSession() ?? null; } catch { session = null; }
    if (session == null) return {};
    const limitReachedAt = limitReachedAtFor(session);
    return { lossLimit: Object.freeze({ consecutiveLossCount: session.consecutiveLossCount, maxConsecutiveLosses: session.maxConsecutiveLosses, evaluatedAt: session.evaluatedAt, periodStartedAt: session.periodStartedAt, ...(limitReachedAt == null ? {} : { limitReachedAt }), ...(session.consecutiveLossLimitEnabled === undefined ? {} : { consecutiveLossLimitEnabled: session.consecutiveLossLimitEnabled }) }) };
  };
  // Display only: today's realized P&L from the PAPER loop's own fills, outside the RISK gateway. A failing read is ignored.
  const todayRealizedHeartbeat = (): { todayRealized?: PersonalPaperTodayRealized } => {
    try {
      const now = Date.now();
      const account = effectivePaperLoop?.snapshot();
      const realizedPnlKrw = account == null ? null : computeTodayRealizedPnlKrw(account.fills, account.positions, now);
      return realizedPnlKrw == null ? {} : { todayRealized: Object.freeze({ realizedPnlKrw, evaluatedAt: now }) };
    } catch { return {}; }
  };
  // Display only: the Research funnel from the closed-learning loop status (meta-learning ledger). Integers only; a failing read is ignored.
  const learningFunnelHeartbeat = (): { learningFunnel?: PersonalPaperLearningFunnel } => {
    try {
      const status = closedLearningStatus?.() as Record<string, unknown> | null | undefined;
      const meta = status?.metaLearning as Record<string, unknown> | undefined;
      const values = [meta?.configurations, meta?.discoveryPasses, meta?.holdoutPasses, status?.cyclesEvaluated];
      if (!values.every((v) => Number.isSafeInteger(v) && (v as number) >= 0)) return {};
      const [configurations, discoveryPasses, holdoutPasses, cyclesEvaluated] = values as number[];
      // The ledger sums the two separately; a holdout count above discovery cannot be drawn as a funnel, so nothing is sent.
      if (discoveryPasses > configurations || holdoutPasses > discoveryPasses) return {};
      return { learningFunnel: Object.freeze({ configurations, discoveryPasses, holdoutPasses, cyclesEvaluated, evaluatedAt: Date.now() }) };
    } catch { return {}; }
  };
  // Display only: measured learning-loop numbers for the app. Each value is copied only when it is a safe integer in range and consistent with its
  // partners; otherwise that field is left out. Never an input to Risk, qualification or Research.
  const learningLoopHeartbeat = (): { learningLoop?: PersonalPaperLearningLoop } => {
    try {
      const status = closedLearningStatus?.() as Record<string, unknown> | null | undefined;
      const meta = status?.metaLearning as Record<string, unknown> | undefined;
      const evidence = status?.evidence as Record<string, unknown> | undefined;
      const nonNeg = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
      const signed = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= 10_000_000 ? v : undefined);
      const pct = (v: unknown): number | undefined => { const n = nonNeg(v); return n != null && n <= 100 ? n : undefined; };
      const out: Record<string, number> = {};
      const put = (key: string, value: number | undefined) => { if (value !== undefined) out[key] = value; };
      put("experiments", nonNeg(meta?.experiments)); put("configurations", nonNeg(meta?.configurations));
      put("discoveryPasses", nonNeg(meta?.discoveryPasses)); put("holdoutPasses", nonNeg(meta?.holdoutPasses));
      put("overfitRatePercent", pct(meta?.overfitRatePercent)); put("paperPeriodsConsumed", nonNeg(meta?.paperPeriodsConsumed));
      put("paperNetBp", signed(meta?.paperNetBp)); put("paperExcessBp", signed(meta?.paperExcessBp));
      put("shadowSince", nonNeg(evidence?.shadowSince)); put("shadowTrades", nonNeg(evidence?.shadowTrades)); put("shadowWins", nonNeg(evidence?.shadowWins));
      put("shadowGrossGainBp", nonNeg(evidence?.shadowGrossGainBp)); put("shadowGrossLossBp", nonNeg(evidence?.shadowGrossLossBp)); put("shadowFeeBp", nonNeg(evidence?.shadowFeeBp));
      for (const key of ["nullSince", "nullSeed", "nullBaseTrades", "nullHoldMarkets", "nullRandTrades", "nullRandWins", "nullRandSkipped"] as const) put(key, nonNeg(evidence?.[key]));
      for (const key of ["nullBaseNetBp", "nullHoldNetBp", "nullRandNetBp"] as const) put(key, signed(evidence?.[key]));
      // Consistency: a part cannot exceed its whole. An inconsistent pair is dropped rather than drawn.
      if (out.discoveryPasses != null && out.configurations != null && out.discoveryPasses > out.configurations) { delete out.discoveryPasses; delete out.holdoutPasses; }
      if (out.holdoutPasses != null && out.discoveryPasses != null && out.holdoutPasses > out.discoveryPasses) delete out.holdoutPasses;
      if (out.shadowWins != null && out.shadowTrades != null && out.shadowWins > out.shadowTrades) { delete out.shadowWins; }
      if (out.nullRandWins != null && out.nullRandTrades != null && out.nullRandWins > out.nullRandTrades) { delete out.nullRandWins; }
      if (Object.keys(out).length === 0) return {};
      return { learningLoop: Object.freeze({ ...out, evaluatedAt: Date.now() }) as PersonalPaperLearningLoop };
    } catch { return {}; }
  };
  // Display only: the pre-registered ORDERBOOK study result the host wrote next to the state DB. Absent or malformed => nothing is sent.
  const orderBookStudyHeartbeat = (): { orderBookStudy?: PersonalPaperOrderBookStudy } => {
    try {
      if (env.NUSA_CLOUD_STATE_DB_PATH === undefined) return {};
      const study = readOrderBookStudyDisplay(config.cloudStateDbPath);
      return study == null ? {} : { orderBookStudy: study };
    } catch { return {}; }
  };
  const readHeartbeat = (): PersonalPaperRuntimeHeartbeat => {
    if (productionPaperBoundary == null && !config.upbitPublicDataEnabled) return Object.freeze({ ...heartbeat });
    rollBuyWindow(Date.now());
    const countsSince = Math.max(runtimeStartedAt, buyWindow.key * BUY_WINDOW_MS);
    // Feed diagnostics need only the public feed; the BUY, decision and order counters need the canonical PAPER boundary.
    const feed = config.upbitPublicDataEnabled ? { feedDisconnectCount: buyWindow.feedDisconnects, feedStaleGapCount: buyWindow.feedStaleGaps, feedMaxGapMs: buyWindow.feedMaxGapMs, feedCountsSince: countsSince } : {};
    const paper = productionPaperBoundary == null ? {} : { buySignalCount: buyWindow.signals, buyBlockedCount: buyWindow.blocked, windowDecisionCount: buyWindow.decisions, windowOrderCount: buyWindow.orders, buyCountsSince: countsSince, decisionTrace: decisionTrace.snapshot(Date.now()), ...(lastDecisionDetail === undefined ? {} : { lastDecisionDetail }), tradedMarkets: Object.freeze([...config.upbitMarkets]), ...lossLimitHeartbeat(), ...todayRealizedHeartbeat() };
    // Display only; a failing provider must never affect the heartbeat.
    let researchProgress: ReturnType<NonNullable<CloudRuntimeResearchAutomationLike["collectionProgress"]>> = null;
    try { researchProgress = researchAutomation?.collectionProgress?.() ?? null; } catch { researchProgress = null; }
    // When there is no progress, say why (display only): off, rejected settings, or enabled but unreadable.
    const researchSettings = researchProgress == null ? readResearchExperimentSettings(env) : undefined;
    const research = researchProgress != null
      ? { researchCollection: researchProgress }
      : { researchCollectionState: researchSettings?.status === "DISABLED" ? "DISABLED" as const : researchSettings?.status === "INVALID" ? "INVALID" as const : "UNAVAILABLE" as const };
    return Object.freeze({ ...heartbeat, ...paper, ...feed, ...research, ...learningFunnelHeartbeat(), ...learningLoopHeartbeat(), ...orderBookStudyHeartbeat() });
  };
  const tokenVerifier = createSharedSecretTokenVerifier(config.dashboardToken, env);
  const durableRepository = snapshotRepository ?? (env.NUSA_CLOUD_STATE_DB_PATH === undefined ? undefined : createSnapshotRepository(config.cloudStateDbPath));
  // This recorder observes the canonical PAPER boundary below. It is deliberately
  // downstream-only: it never submits orders or mutates runtime state.
  const jevMarketMicrostructureObserver = createJevMarketMicrostructureShadowObserverFromEnvironment(env);
  const jevMarketMicrostructureLastObservedAt = new Map<string, number>();
  const JEV_MARKET_MICROSTRUCTURE_SAMPLE_INTERVAL_MS = 30_000;

  const orderIntentReasonCounters = new PaperFunnelCounters();
  const paperLearningRecorder = new PaperLearningEventRecorder(
    durableRepository instanceof SqliteCloudDashboardSnapshotRepository
      ? { persistencePath: config.cloudStateDbPath }
      : {}
  );
  const realReadOnlyEventRecorder = new RealReadOnlyEventRecorder(
    durableRepository instanceof SqliteCloudDashboardSnapshotRepository ? { persistencePath: config.cloudStateDbPath } : {}
  );
  const paperMarketObservationRepository = durableRepository instanceof SqliteCloudDashboardSnapshotRepository
    ? new SqlitePaperMarketObservationRepository(durableRepository.database())
    : undefined;
  const effectivePaperRepository = paperAccountRepository ?? (config.paperInitialCapitalKrw !== undefined && durableRepository instanceof SqliteCloudDashboardSnapshotRepository ? new SqliteCloudPaperAccountRepository(durableRepository.database(), { accountId: paperAccountIdForCapital(config.paperInitialCapitalKrw) }) : undefined);
  let effectivePaperLoop: PaperTradingExecutionLoop | undefined;
  const paperRealizedPeriodProducer = durableRepository instanceof SqliteCloudDashboardSnapshotRepository
    ? new PaperRealizedPeriodProducer(new SqlitePaperRealizedPeriodRepository(durableRepository.database()), {
      // Thirty nominal hourly days need 720 records; the independent covered-day gate is unchanged.
      // Keep the same bounded budget after cadence changes instead of shrinking hourly history to 100.
      maximumPeriods: 1_000,
      // Retention may never delete a realized period a surviving ledger record cites (v2 M1/A7).
      retentionGuard: evolutionLedgerRetentionGuard(new SqliteEvolutionLearningLedger(durableRepository.database())),
      sourceRuntimeSha: (env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "").trim() || undefined,
      onLifecycleEvent: (event) => paperLearningRecorder.record({
        cycleId: `paper-period:${event.periodId}`,
        stage: event.type,
        occurredAt: event.occurredAt,
        market: "PAPER_PERIOD",
        status: event.type === "PERIOD_REJECTED" ? "FAIL" : "PASS",
        ...(event.type === "PERIOD_REJECTED" ? { reason: event.reasonCode } : {}),
      }),
      readCanonicalPaperAccount: () => {
        const loop = effectivePaperLoop;
        if (loop == null) throw new Error("canonical PAPER account source is unavailable");
        return loop.snapshot();
      },
      readCanonicalPaperFills: () => {
        if (effectivePaperRepository?.loadFills == null) throw new Error("canonical PAPER fill ledger is unavailable");
        return effectivePaperRepository.loadFills();
      },
      ...(paperMarketObservationRepository == null ? {} : { readCanonicalBenchmarkEvidence: (periodStartAt: number, periodEndAt: number, market?: string) => readCanonicalPaperTickerBenchmark(paperMarketObservationRepository, market, periodStartAt, periodEndAt) }),
    })
    : undefined;
  const effectiveProvider = durableRepository == null ? stateProvider : new DurableCloudDashboardStateProvider(stateProvider, durableRepository, env.NUSA_SOURCE_COMMIT?.trim() || "unknown", env.NUSA_CLOUD_SOURCE_VERSION?.trim() || "unknown");
  const recovered = durableRepository != null && effectiveProvider instanceof DurableCloudDashboardStateProvider && effectiveProvider.recover();
  const durableAuthDatabase = durableRepository instanceof SqliteCloudDashboardSnapshotRepository ? durableRepository.database() : undefined;
  const loadEvolutionLearning = durableAuthDatabase == null
    ? undefined
    : () => buildEvolutionLearningSupervisorSnapshot(new SqliteEvolutionLearningLedger(durableAuthDatabase).replay());
  const userAccessRepository = durableAuthDatabase == null ? undefined : new SqliteNusaUserAccessRepository(durableAuthDatabase);
  const desktopSessionService = durableAuthDatabase == null || userAccessRepository == null ? undefined : new DesktopSessionService(durableAuthDatabase, userAccessRepository);
  const mobileSessionService = durableAuthDatabase == null || userAccessRepository == null ? undefined : new MobileSessionService(durableAuthDatabase, userAccessRepository);
  const ownerDeviceCredentialService = durableAuthDatabase == null || userAccessRepository == null || mobileSessionService == null
    ? undefined
    : new OwnerDeviceCredentialService(durableAuthDatabase, userAccessRepository, mobileSessionService);
  const effectiveP0Repository = durableRepository instanceof SqliteCloudDashboardSnapshotRepository ? new SqliteP0AlertRepository(durableRepository.database()) : undefined;
  const investmentAllocationSettings: InvestmentAllocationSettingsRepository = durableRepository instanceof SqliteCloudDashboardSnapshotRepository
    ? new SqliteInvestmentAllocationSettingsRepository(durableRepository.database())
    : new InMemoryInvestmentAllocationSettingsRepository();
  const readPaperP0State = () => { if (effectiveP0Repository == null) throw new Error("P0 safety repository unavailable"); return effectiveP0Repository.readState(); };
  const readAiP0State = (): CloudRuntimeAiP0State => { if (effectiveP0Repository == null) return "UNAVAILABLE"; try { return effectiveP0Repository.readState().openP0 ? "OPEN" : "CLOSED"; } catch { return "UNVERIFIABLE"; } };
  const productionPaperRiskGate = config.paperInitialCapitalKrw !== undefined && durableRepository instanceof SqliteCloudDashboardSnapshotRepository
    ? new CloudPaperCanonicalRiskGateway({ database: durableRepository.database(), initialCapital: config.paperInitialCapitalKrw, limits: cloudPaperRiskLimitsForCapital(config.paperInitialCapitalKrw), accountId: paperAccountIdForCapital(config.paperInitialCapitalKrw), sourceCommitSha: env.NUSA_SOURCE_COMMIT?.trim() || env.GITHUB_SHA?.trim() || "local-paper-build" })
    : undefined;
  effectivePaperLoop = paperExecutionLoop ?? (config.paperInitialCapitalKrw === undefined || effectivePaperRepository === undefined ? undefined : new PaperTradingExecutionLoop({ initialCapital: config.paperInitialCapitalKrw, repository: effectivePaperRepository, readP0State: readPaperP0State }));
  const productionPaperBoundary = effectivePaperLoop != null && productionPaperRiskGate != null
    ? new CloudPaperExecutionBoundary({ loop: effectivePaperLoop, riskGate: productionPaperRiskGate, readP0State: readPaperP0State })
    : undefined;
  const operatorPrincipal = Object.freeze({ userId: "operator", scopes: Object.freeze(["dashboard:read"]) });
  const sourceCommit = env.NUSA_SOURCE_COMMIT?.trim() || env.GITHUB_SHA?.trim() || "";
  const sourceVersion = env.NUSA_CLOUD_SOURCE_VERSION?.trim() || "unknown";
  const engineeringOperatingReadModel: NusaEngineeringOperatingReadModel = createNusaEngineeringOperatingReadModel(engineeringOperatingSource);
  let marketConnectionState = config.upbitPublicDataEnabled ? "DISCONNECTED" : "DISABLED";
  const defaultLiveReadinessReaders: LiveReadinessSourceReaders = {
    ...liveReadinessSourceReaders,
    currentHeadSha: liveReadinessSourceReaders?.currentHeadSha ?? (() => sourceCommit),
    authority: liveReadinessSourceReaders?.authority ?? (() => Object.freeze({ value: createDormantLiveAuthority(), freshness: "FRESH" as const, fingerprint: "dormant-authority-v1" })),
    paperAutoLearning: liveReadinessSourceReaders?.paperAutoLearning ?? (() => readPaperAutoLearningReadiness({
      configured: effectivePaperLoop != null,
      publicMarketDataEnabled: config.upbitPublicDataEnabled,
      connectionState: marketConnectionState,
      state: effectiveProvider.read(operatorPrincipal),
      heartbeat: readHeartbeat(),
    }, Date.now())),
    runtimeSafety: liveReadinessSourceReaders?.runtimeSafety ?? (() => readCloudRuntimeSafety({
      state: effectiveProvider.read(operatorPrincipal),
      connectionState: marketConnectionState,
    })),
    shadowReplay: liveReadinessSourceReaders?.shadowReplay ?? (shadowObservabilityProvider == null ? undefined : (() => {
      try {
        const snapshot = validateShadowObservabilitySnapshot(shadowObservabilityProvider(operatorPrincipal));
        const value = snapshot.events.length === 0 ? "MISSING" as const : snapshot.blockers.length > 0 || ["HALTED", "FAILED", "INVALIDATED"].includes(snapshot.runtimeStatus) ? "INVALID" as const : "VALID" as const;
        return Object.freeze({ value, freshness: snapshot.marketFreshness, observedAt: new Date(snapshot.generatedAt).toISOString() });
      } catch {
        return Object.freeze({ value: "MISSING" as const, freshness: "UNKNOWN" as const });
      }
    })),
  };
  const liveReadinessSourceProvider = createLiveReadinessSourceProvider({ now: () => new Date().toISOString(), sourceVersion, readers: defaultLiveReadinessReaders });
  const effectiveResearchRuntime: CloudRuntimeResearchRuntimeLike | undefined = researchAutomation ?? researchRuntime;
  // researchAutomation gates itself: a non-READY recover() halts its own RUNNING sessions, so its
  // onMarketData sees none left and no-ops. The plain researchRuntime path has no such self-gate --
  // without this flag a FAIL_CLOSED researchRecoveryCoordinator result (corrupted candidate/audit
  // state) was silently discarded here and the market-data loop kept calling onMarketData on
  // unverified research state below.
  let researchRecoveryFailClosed = false;
  try {
    const recovery = researchAutomation?.recover?.() ?? researchRecoveryCoordinator?.recover();
    if (recovery != null && recovery.status !== "READY") researchRecoveryFailClosed = true;
  } catch { researchRecoveryFailClosed = true; }
  // Fail closed by withholding the dashboard projection only. This used to also call
  // effectivePaperRepository.clear(), which deletes the durable PAPER account, its history and the
  // canonical fill ledger. It ran whenever the dashboard had no state on a tick (stale or missing
  // market data closes the kill switch and clears the provider), when a projection threw, or when
  // one execution result FAILED -- so an ordinary data gap destroyed canonical PAPER truth, and the
  // next restart loaded no account and reset NAV to initial capital. A projection problem is never
  // a reason to erase the ledger; an explicit reset still goes through the repository itself.
  const clearPaperProjection = (): void => { effectiveProvider.clear(); };
  const projectPaperAccount = (): void => {
    if (effectivePaperLoop == null) return;
    const state = effectiveProvider.read({ userId: "operator", scopes: ["dashboard:read"] });
    if (state == null) { clearPaperProjection(); return; }
    try { effectiveProvider.set(effectivePaperLoop.applyToDashboard(state, Date.now())); } catch { clearPaperProjection(); }
  };
  try { if (!recovered) dashboardHydrator.hydrate(effectiveProvider); projectPaperAccount(); } catch { clearPaperProjection(); }
  const observations = new Map<string, IntelligenceObservation>();
  const latestTickers = new Map<string, PersonalPaperMarketProjection>();
  const latestExecutionQuotes = new Map<string, PaperObservedExecutionQuote>();
  const orderBookReconciler = new UpbitOrderBookReconciler();
  let marketConnectionGeneration = 0;
  const safeHydrate = (next: readonly IntelligenceObservation[]): void => { try { dashboardHydrator.hydrate(effectiveProvider, next); } catch { effectiveProvider.clear(); } };
  // Market whose rejected tick set the current PUBLIC_MARKET_EVENT_REJECTED diagnostic, if any.
  let rejectedTickerMarket: string | undefined;
  const marketDataClient = config.upbitPublicDataEnabled ? marketDataClientFactory(config.upbitMarkets, (ticker) => {
    heartbeat.lastHeartbeatAt = Date.now();
    heartbeat.lastMarketEventAt = ticker.trade_timestamp;
    heartbeat.eventCount += 1;
    // Display-only feed diagnostics: the gap between consecutive ticker arrivals, measured on arrival time so a late trade timestamp cannot hide it.
    {
      const arrivedAt = Date.now();
      rollBuyWindow(arrivedAt);
      if (lastTickerArrivalMs != null && arrivedAt >= lastTickerArrivalMs) {
        const gap = arrivedAt - lastTickerArrivalMs;
        if (gap > DEFAULT_UPBIT_TICKER_STALE_WINDOW_MS) buyWindow.feedStaleGaps += 1;
        if (gap > buyWindow.feedMaxGapMs) buyWindow.feedMaxGapMs = gap;
      }
      lastTickerArrivalMs = arrivedAt;
    }
    const now = Date.now();
    const observation = upbitTickerToIntelligenceObservation(ticker, { now });
    if (!observation) {
      // P2 diagnostic suffix only: an operator can now tell a silent feed
      // (FEED_STALE / FUTURE_MARKET_TIMESTAMP, e.g. host clock skew) from a
      // malformed tick. Acceptance thresholds are unchanged; a rejected tick never enters trusted observations.
      recordFailure(`PUBLIC_MARKET_EVENT_REJECTED:${classifyTickerRejectReason(ticker, { now })}`);
      rejectedTickerMarket = ticker.code;
      // Reject only the untrusted tick. Previously one stale/invalid market event cleared every
      // already-accepted market observation, so a quiet market (for example a >30s DOGE last-trade
      // timestamp) could latch the whole multi-market PAPER dashboard into NO_MARKET_DATA even while
      // BTC/ETH/etc. remained fresh. The hydrator re-checks every cached observation's expiresAt, so
      // retaining the accepted set preserves per-market fail-closed freshness without widening any
      // timestamp gate; if no accepted observation is still fresh, it still closes the kill switch.
      safeHydrate([...observations.values()]);
      return;
    }
    heartbeat.lastAcceptedMarketReceiptAt = now;
    // A per-tick rejection is a diagnostic about that market's feed. Once the same market delivers an accepted
    // tick again the condition has recovered, so it must not keep /health DEGRADED forever. Any other error
    // (durable evidence, connection, reconciliation) is left untouched.
    if (rejectedTickerMarket === ticker.code && heartbeat.lastError?.startsWith("PUBLIC_MARKET_EVENT_REJECTED:")) {
      heartbeat.lastError = null;
      rejectedTickerMarket = undefined;
    }
    // Only accepted public-market events may become durable PAPER evidence.
    // This keeps stale/future/malformed transport input out of the canonical observation store.
    latestTickers.set(ticker.code, { market: ticker.code, price: ticker.trade_price, changeRate: ticker.signed_change_rate ?? null, volume: ticker.acc_trade_volume ?? null, observedAt: new Date(ticker.trade_timestamp).toISOString(), source: "UPBIT_PUBLIC_TICKER" });
    try { paperMarketObservationRepository?.append({ market: ticker.code, observedAt: ticker.trade_timestamp, price: ticker.trade_price, signedChangeRate: ticker.signed_change_rate, accumulatedVolume: ticker.acc_trade_volume, accumulatedPrice: ticker.acc_trade_price_24h, sourceFingerprint: canonicalUpbitSourceFingerprint(ticker) }); }
    catch (error) { recordFailure(`PAPER_MARKET_OBSERVATION_REJECTED:${error instanceof PaperMarketObservationStoreError ? error.code : "UNKNOWN"}`); }
    retainObservation(observations, observation); safeHydrate([...observations.values()]);
    const researchTick = { market: ticker.code, price: ticker.trade_price, observedAt: ticker.trade_timestamp, now };
    if (!researchRecoveryFailClosed) { try { effectiveResearchRuntime?.onMarketData(researchTick); } catch { /* isolated */ } }
    const state = effectiveProvider.read({ userId: "operator", scopes: ["dashboard:read"] });
    if (state != null) {
      // Hydration samples its own clock while producing decision.decidedAt. Re-sample only after
      // hydration so PAPER fills cannot predate the exact challenger decision they persist. Any
      // actual clock regression remains fail-closed in the canonical decision/fill validators.
      const executionNow = Date.now();
      const dashboard = buildMobileDashboardResponse(state);
      try {
        const p0State = readAiP0State();
        const lessons = aiRuntime?.applicableLessons(attributionScope({ outcomeDefinitionId: AI_CALIBRATION_OUTCOME_DEFINITION_ID, targetId: ticker.code }), now) ?? [];
        const grounded = buildCloudRuntimeAiEvidence(ticker, { mode: dashboard.mode, killSwitchActive: dashboard.killSwitchActive, tradingAllowed: dashboard.tradingAllowed, overallHealth: dashboard.overallHealth, p0State, observedAt: now }, lessons);
        const orchestrationRunId = `cloud-ai:${ticker.code}:${ticker.trade_timestamp}:${grounded.identityHash.slice(0, 20)}`;
        aiRuntime?.schedule({ orchestrationRunId, decisionId: `${orchestrationRunId}:decision`, evaluatedAt: now, evidence: grounded.evidence, evidenceMaterializations: grounded.evidenceMaterializations, policyVersionIds: ["AI_ZERO_AUTHORITY_POLICY_V1", "NUSA_DETERMINISTIC_SAFETY_V1"], certificationIds: [], controlPlaneStateId: `cloud:${dashboard.mode}:${dashboard.killSwitchActive ? "KILL" : "ACTIVE"}:${p0State}`, contextValidForMs: 120_000, learningProvenance: "AUTO_BACKGROUND" });
      } catch { /* advisory AI only */ }
      if (effectivePaperLoop != null) {
        const investmentPercent = investmentAllocationSettings.get(config.ownerId)?.investmentPercent ?? config.paperInvestmentPercent;
        const tick = { now: executionNow, market: ticker.code, price: ticker.trade_price, observedAt: paperExecutionObservedAt(ticker.trade_timestamp, executionNow), mode: state.mode, killSwitchActive: state.killSwitchActive, tradingAllowed: dashboard.tradingAllowed, overallHealth: state.overallHealth, portfolio: state.portfolio, decisions: state.decisions, investmentPercent, observedQuote: latestExecutionQuotes.get(ticker.code) };
        heartbeat.lastPaperDecisionAt = now;
        heartbeat.decisionCount += state.decisions.length;
        rollBuyWindow(Date.now());
        buyWindow.decisions += state.decisions.length;
        decisionTrace.record("decision", state.decisions.length, Date.now());
        // A supplied loop is a read/recovery fixture unless it is composed behind the
        // canonical Cloud PAPER risk boundary. Never let dependency injection create a
        // second mutation path for strategy ticks.
        const result = productionPaperBoundary?.processTick(tick);
          if (result != null) {
          try { paperRealizedPeriodProducer?.observeExecution({ observationId: paperExecutionObservationId(ticker.code, ticker.trade_timestamp, result.status), observedAt: now, status: result.status }); } catch { recordFailure("PAPER_PERIOD_EVIDENCE_REJECTED"); }
          }
        const cycleId = paperLearningCycleId(ticker.code, ticker.trade_timestamp);
        const canonicalDecision = state.decisions.find((decision) => decision.symbol === ticker.code) ?? state.decisions[0];
        if (canonicalDecision != null) lastDecisionDetail = describeCanonicalDecision(canonicalDecision, now);
        paperLearningRecorder.record({ cycleId, stage: "MARKET_DATA", occurredAt: ticker.trade_timestamp, market: ticker.code, status: "PASS", reason: `source=UPBIT_PUBLIC_TICKER;observedAt=${ticker.trade_timestamp}` });
        const decisionSupported = canonicalDecision != null && ["BUY", "SELL", "HOLD", "REDUCE", "INCREASE"].includes(canonicalDecision.action);
        paperLearningRecorder.record({ cycleId, stage: "DECISION", occurredAt: now, market: ticker.code, status: canonicalDecision == null ? "SKIP" : "PASS", reason: canonicalDecision == null ? "NO_CANONICAL_DECISION" : decisionSupported ? undefined : canonicalDecision.action === "WAIT" ? `NO_ACTIONABLE_PAPER_DECISION:WAIT:${classifyPaperWait(canonicalDecision) ?? "NO_SIGNAL"}` : `UNSUPPORTED_ACTION:${canonicalDecision.action}`, ...(canonicalDecision == null ? {} : { decision: canonicalDecision }) });
        paperLearningRecorder.record({ cycleId, stage: "PERMISSION", occurredAt: now, market: ticker.code, status: "SKIP", reason: "NO_CANONICAL_TRADE_PERMISSION_EVIDENCE" });
        if (result != null) {
          heartbeat.lastPaperDecisionOutcome = codePaperDecisionOutcome(result);
          if (result.orders.length > 0) heartbeat.lastPaperOrderAt = now;
          if (result.fills.length > 0) heartbeat.lastPaperFillAt = now;
          heartbeat.paperOrderCount += result.orders.length;
          rollBuyWindow(Date.now());
          buyWindow.orders += result.orders.length;
          decisionTrace.record("order", result.orders.length, Date.now());
          heartbeat.paperFillCount += result.fills.length;
          // Display-only: a BUY decision, and a BUY the boundary explicitly refused (BLOCKED or REJECTED). WAIT, DUPLICATE and FAILED are not counted as refusals.
          if (canonicalDecision?.action === "BUY") { rollBuyWindow(Date.now()); buyWindow.signals += 1; if (result.status === "BLOCKED" || result.status === "REJECTED") buyWindow.blocked += 1; }
          if (result.status === "FAILED") {
            // The reason stays the stable code; the underlying cause (lease lost, ledger mismatch, read-only database ...) is appended for the advanced diagnostic line.
            const detail = result.reason === "paper account persistence failed" ? effectivePaperLoop?.persistenceFailureDetail() ?? null : null;
            recordFailure(detail == null ? (result.reason ?? "PAPER_EXECUTION_FAILED") : `${result.reason}: ${detail}`);
          }
          const intentStatus = result.status === "FILLED" ? "PASS" : result.status === "WAIT" ? "SKIP" : "FAIL";
          if (result.risk != null) paperLearningRecorder.record({ cycleId, stage: "RISK", occurredAt: now, market: ticker.code, status: result.risk.status === "ALLOW" ? "PASS" : "FAIL", reason: result.risk.reasonCodes.join(",") || result.risk.status });
          recordOrderIntentWithReasonCode(
            paperLearningRecorder,
            () => paperLearningRecorder.record({ cycleId, stage: "ORDER_INTENT", occurredAt: now, market: ticker.code, status: intentStatus, reason: result.reason ?? result.status }),
            orderIntentReasonCounters,
            intentStatus,
            result.status,
            result.reason ?? result.status
          );
          if (result.status === "DUPLICATE") paperLearningRecorder.record({ cycleId, stage: "IDEMPOTENCY", occurredAt: now, market: ticker.code, status: "SKIP", reason: result.reason ?? "PAPER_DUPLICATE" });
          for (const fill of result.fills) paperLearningRecorder.record({ cycleId, stage: "FILL", occurredAt: fill.filledAt, market: ticker.code, status: "PASS", fill, idSuffix: fill.id });
          paperLearningRecorder.record({ cycleId, stage: "PNL", occurredAt: now, market: ticker.code, status: "PASS", account: result.state, reason: `cash:${result.state.cash};equity:${result.state.equity};realizedPnL:${result.state.realizedPnL};unrealizedPnL:${result.state.unrealizedPnL}` });
          if (result.status === "FILLED") paperLearningRecorder.record({ cycleId, stage: "LEARNING", occurredAt: now, market: ticker.code, status: "PASS", reason: "PAPER_OUTCOME_AVAILABLE" });
        }
        // Missing boundary means no strategy mutation; retain a verified read projection so
        // recovery/fixtures remain observable without turning the loop into a writer.
        if (result != null && result.status === "FAILED") clearPaperProjection(); else projectPaperAccount();
      }
    } else if (effectivePaperLoop != null) clearPaperProjection();
  }, (state) => {
    heartbeat.lastHeartbeatAt = Date.now();
    if (state !== "CONNECTED" && marketConnectionState === "CONNECTED") { rollBuyWindow(Date.now()); buyWindow.feedDisconnects += 1; }
    marketConnectionState = state;
    if (state === "CONNECTED") heartbeat.lastError = null; else recordFailure(`PUBLIC_MARKET_${state}`);
    marketConnectionGeneration += 1;
    const generation = marketConnectionGeneration;
    orderBookReconciler.reset();
    latestExecutionQuotes.clear();
    if (state !== "CONNECTED") { observations.clear(); latestTickers.clear(); safeHydrate([]); return; }
    // A transport connection is not execution-grade market data. Every connection/reconnect
    // generation must acquire a fresh public REST snapshot before any WebSocket orderbook quote
    // can enter PAPER execution. Stream events retry expired or failed snapshots with bounded backoff.
    void Promise.all(config.upbitMarkets.map(async (market) => {
      try {
        await orderBookReconciler.refreshSnapshot(market);
      } catch {
        if (generation === marketConnectionGeneration) recordFailure("PUBLIC_ORDERBOOK_SNAPSHOT_UNAVAILABLE");
      }
    }));
    if (state !== "CONNECTED") { observations.clear(); latestTickers.clear(); safeHydrate([]); }
  }, (orderBook) => {
    heartbeat.lastHeartbeatAt = Date.now();
    try {
      const receivedAt = Date.now();
      const reconciled = orderBookReconciler.reconcile(orderBook, receivedAt);
      if (reconciled == null) {
        latestExecutionQuotes.delete(orderBook.code);
        recordFailure("PAPER_ORDERBOOK_UNRECONCILED");
        if (marketConnectionState === "CONNECTED") {
          const generation = marketConnectionGeneration;
          void orderBookReconciler.refreshSnapshot(orderBook.code).catch(() => {
            if (generation === marketConnectionGeneration) recordFailure("PUBLIC_ORDERBOOK_SNAPSHOT_UNAVAILABLE");
          });
        }
        return;
      }
      // Renew the REST snapshot before it expires (it is only valid for 30 s) so a steady feed never reaches the failure path
      // below. A failed renewal is silent here: the old snapshot keeps working until it expires, and only then does the
      // unreconciled path above record the failure exactly as before.
      if (marketConnectionState === "CONNECTED" && orderBookReconciler.needsRefresh(orderBook.code, receivedAt)) void orderBookReconciler.refreshSnapshot(orderBook.code).catch(() => undefined);
      const quote = buildPaperObservedExecutionQuote({ market: orderBook.code, observedAt: receivedAt, totalAskSize: orderBook.total_ask_size, totalBidSize: orderBook.total_bid_size, units: orderBook.orderbook_units.map((unit) => ({ askPrice: unit.ask_price, bidPrice: unit.bid_price, askSize: unit.ask_size, bidSize: unit.bid_size })) });
      latestExecutionQuotes.set(quote.market, quote);
      microstructureRecorder?.recordOrderBook(orderBook, receivedAt);
      // Only observed, validated quotes recover this diagnostic; never clear other failures
      // or the failure timestamp used by the post-failure market receipt health gate.
      if ((heartbeat.lastError === "PAPER_ORDERBOOK_UNRECONCILED" || heartbeat.lastError === "PUBLIC_ORDERBOOK_SNAPSHOT_UNAVAILABLE")
        && config.upbitMarkets.every((market) => {
          const latest = latestExecutionQuotes.get(market);
          return latest != null && latest.observedAt <= receivedAt && receivedAt - latest.observedAt <= 30_000;
        })) heartbeat.lastError = null;
      if (jevMarketMicrostructureObserver != null) {
        const previousObservedAt = jevMarketMicrostructureLastObservedAt.get(quote.market) ?? 0;
        if (quote.observedAt - previousObservedAt >= JEV_MARKET_MICROSTRUCTURE_SAMPLE_INTERVAL_MS) {
          jevMarketMicrostructureLastObservedAt.set(quote.market, quote.observedAt);
          void jevMarketMicrostructureObserver.observe(quote, env).then((receipt) => {
            console.log(JSON.stringify({
              event: "NUSA_JEV_MARKET_MICROSTRUCTURE_SHADOW",
              market: receipt.market,
              observedAt: receipt.observedAt,
              state: receipt.selectedState,
              action: receipt.selectedAction,
              confidence: receipt.confidence,
              reasonCode: receipt.reasonCode,
              fallbackApplied: receipt.fallbackApplied,
              usableForRouting: receipt.usableForRouting,
              aiAuthority: receipt.aiAuthority,
              liveAuthority: receipt.liveAuthority,
            }));
          }).catch(() => { /* SHADOW telemetry must never affect PAPER execution */ });
        }
      }
    } catch { recordFailure("PAPER_ORDERBOOK_OBSERVATION_REJECTED"); }
  }, microstructureRecorder == null ? undefined : (trade) => microstructureRecorder.recordTrade(trade)) : undefined;
  if (marketDataClient) { marketDataClient.subscribe(config.upbitMarkets); marketDataClient.start(); }
  const microstructureFlushTimer = microstructureRecorder == null ? undefined : setInterval(() => microstructureRecorder.flush(), 5_000);
  microstructureFlushTimer?.unref?.();
  orderBookCollector?.start();
  futuresCollector?.start();
  const heartbeatTimer = setInterval(() => { heartbeat.lastHeartbeatAt = Date.now(); }, 2_000);
  // Display only: how long this process was blocked. A stall over the 30 s PAPER writer lease explains a lost lease.
  const stallMonitor = createEventLoopStallMonitor();
  stallMonitor.start();
  // Display only: the same research collection status the app reads, as a code and two counts for /health.
  // Today's losing sells per strategy family, recomputed at most every 30 s so /health stays cheap. Display only.
  let lossAttributionCache: PaperLossAttribution | null = null;
  const lossAttributionLiveness = () => {
    const now = Date.now();
    if (lossAttributionCache == null || now - lossAttributionCache.evaluatedAt >= 30_000) {
      try { lossAttributionCache = effectivePaperLoop == null ? null : attributeTodayLosses(effectivePaperLoop.snapshot().fills, now); } catch { lossAttributionCache = null; }
    }
    return lossAttributionCache == null ? {} : { paperLossAttribution: lossAttributionCache };
  };
  const researchIntervalLiveness = () => { let byInterval: Record<string, { readonly lastTickAt: number; readonly lastStatus: string; readonly ticks: number; readonly sessionsStarted: number; readonly counts: Readonly<Record<string, number>> }> | null = null; try { const raw = researchIntervalTicks?.() ?? null; if (raw != null) { byInterval = {}; for (const [key, value] of Object.entries(raw)) if (value != null) byInterval[key] = value; } } catch { byInterval = null; } return byInterval == null || Object.keys(byInterval).length === 0 ? {} : { researchExperimentTicksByInterval: byInterval }; };
  const paperLedgerLiveness = () => { try { const state = effectivePaperLoop?.snapshot(); return state == null ? {} : { paperLedger: paperLedgerFingerprint(state) }; } catch { return {}; } };
  const microstructureLiveness = () => { try { return microstructureRecorder == null ? {} : { microstructureRecorder: microstructureRecorder.status() }; } catch { return {}; } };
  // Daily stored-data integrity probe result written by the host Research service (display only; read each /health).
  const dataIntegrityLiveness = () => { try { const value = env.NUSA_CLOUD_STATE_DB_PATH === undefined ? undefined : readDataIntegrityResult(config.cloudStateDbPath); return value == null ? {} : { dataIntegrity: value }; } catch { return {}; } };
  // Display only: order-book hour coverage over the last 192 hours (the study's own definition), so a gap shows while it can still be repaired.
  const orderBookCoverageWatch = env.NUSA_CLOUD_STATE_DB_PATH === undefined ? undefined : new OrderBookCoverageWatch(config.cloudStateDbPath, (env.NUSA_RESEARCH_MARKETS ?? "KRW-BTC").split(",").map((m) => m.trim()).find((m) => m !== "") ?? "KRW-BTC");
  const orderBookCoverageLiveness = () => { try { const value = orderBookCoverageWatch?.snapshot(); return value == null ? {} : { orderBookCoverage: value }; } catch { return {}; } };
  const futuresCollectorLiveness = () => { try { return futuresCollector == null ? {} : { futuresCollector: futuresCollector.status() }; } catch { return {}; } };
  const orderBookCollectorLiveness = () => { try { return orderBookCollector == null ? {} : { orderBookCollector: orderBookCollector.status() }; } catch { return {}; } };
  const closedLearningLiveness = () => { let status = null; try { status = closedLearningStatus?.() ?? null; } catch { status = null; } return status == null ? {} : { closedLearningLoop: status }; };
  // Display only: the hourly REST gap fill, the only writer of the research candle series head.
  const researchGapFillLiveness = () => { let gap = null; try { gap = researchAutomation?.gapFill?.() ?? null; } catch { gap = null; } return gap == null ? {} : { researchGapFill: gap }; };
  const researchExperimentLiveness = () => { let ticks = null; try { ticks = researchAutomation?.experimentTicks?.() ?? null; } catch { ticks = null; } return ticks == null ? {} : { researchExperimentTicks: ticks }; };
  const lossSessionLiveness = () => { const session = productionPaperRiskGate?.lossSession() ?? null; return session == null ? {} : { paperLossSession: session }; };
  const researchLiveness = (): { researchCollectionStatus: "COLLECTING" | "DISABLED" | "INVALID" | "UNAVAILABLE"; researchCandleCount?: number; researchRequiredCandles?: number } => {
    let progress: ReturnType<NonNullable<CloudRuntimeResearchAutomationLike["collectionProgress"]>> = null;
    try { progress = researchAutomation?.collectionProgress?.() ?? null; } catch { progress = null; }
    if (progress != null) return { researchCollectionStatus: "COLLECTING", researchCandleCount: progress.candleCount, researchRequiredCandles: progress.requiredCandles };
    const settings = readResearchExperimentSettings(env);
    return { researchCollectionStatus: settings.status === "DISABLED" ? "DISABLED" : settings.status === "INVALID" ? "INVALID" : "UNAVAILABLE" };
  };
  heartbeatTimer.unref?.();

  const loadPaperOperations = (principal: DashboardPrincipal): PersonalPaperOperationsSnapshot => {
    const input = effectiveProvider.read(principal);
    if (input === undefined) throw new Error("dashboard state is not ready");
    const dashboard = buildMobileDashboardResponse(input);
    const paperSnapshot = effectivePaperLoop?.snapshot();
    const transport = marketConnectionState === "CONNECTED" ? "ONLINE" as const : "OFFLINE" as const;
    const p0State = readAiP0State();
    const p0Halted = p0State === "OPEN" || p0State === "UNVERIFIABLE";
    const autoRunning = effectivePaperLoop != null && config.upbitPublicDataEnabled;
    // The reasons and the state come from one evaluation on purpose. Computing HALTED from these
    // three inputs and then separately describing why would let the two drift, which is exactly the
    // gap that left a HALTED soak observation unattributable (#1855).
    const runtimeHaltReasons: PersonalPaperRuntimeHaltReason[] = [];
    if (dashboard.mode === "FAULTED") runtimeHaltReasons.push("DASHBOARD_FAULTED");
    if (dashboard.killSwitchActive) runtimeHaltReasons.push("KILL_SWITCH_ACTIVE");
    if (p0State === "OPEN") runtimeHaltReasons.push("AI_P0_OPEN");
    if (p0State === "UNVERIFIABLE") runtimeHaltReasons.push("AI_P0_UNVERIFIABLE");
    const runtimeState = runtimeHaltReasons.length > 0 ? "HALTED" as const : dashboard.mode === "STOPPED" ? "STOPPED" as const : !autoRunning ? "STOPPED" as const : transport === "ONLINE" ? "RUNNING" as const : "DEGRADED" as const;
    const learningRuntimeStatus = classifyPaperLearningRuntimeStatus({ hasRuntimeHaltReason: runtimeHaltReasons.length > 0, lastError: heartbeat.lastError, autoRunning, transport });
    const primaryMarket = latestTickers.get(config.upbitMarkets[0] ?? "");
    const generatedAt = Math.max(dashboard.generatedAt, heartbeat.lastHeartbeatAt);
    const paperLearning = { schemaVersion: 1 as const, mode: "PAPER" as const, readOnly: true as const, liveAuthority: "NONE" as const, productionMutationAllowed: false as const, runtimeStatus: learningRuntimeStatus, generatedAt, events: buildPaperLearningReadOnlyProjection(paperLearningRecorder.replay(), 250) };
    return buildPersonalPaperOperationsSnapshot({ dashboard, research: researchAutomation?.statusProjection?.() ?? null, ai: aiRuntime == null ? null : projectAiReadOnly(aiRuntime.latest(Date.now())), paperLearning, operations: { runtimeState, schedulerRunning: autoRunning, schedulerMode: autoRunning ? "ACTIVE" : "OFF", pipelineStage: effectivePaperLoop == null ? "READ_ONLY_DASHBOARD" : "PAPER_EXECUTION_LOOP", transport, killSwitchActive: dashboard.killSwitchActive, accountHalted: dashboard.mode === "FAULTED" || p0Halted, ...(runtimeHaltReasons.length > 0 ? { runtimeHaltReasons: Object.freeze([...runtimeHaltReasons]) } : {}), pendingWrites: 0, ...(paperSnapshot != null && paperSnapshot.updatedAt > 0 ? { lastEventAt: paperSnapshot.updatedAt } : {}), updatedAt: generatedAt, heartbeat: readHeartbeat(), ...(paperSupervisor == null ? {} : { supervisor: paperSupervisor }) }, portfolio: buildReadOnlyPortfolio(paperSnapshot, primaryMarket), orders: buildReadOnlyOrders(paperSnapshot), markets: [...latestTickers.values()].sort((left, right) => left.market.localeCompare(right.market)) }, generatedAt);
  };

  const submitPaperOrder = (principal: DashboardPrincipal, command: PersonalPaperOrderCommand): PersonalPaperOrderCommandResult => {
    const input = effectiveProvider.read(principal);
    if (input === undefined || effectivePaperLoop == null) return Object.freeze({ schemaVersion: 1, status: "BLOCKED", reason: "PAPER_RUNTIME_UNAVAILABLE", liveAuthority: "NONE", productionMutationAllowed: false });
    const dashboard = buildMobileDashboardResponse(input);
    const market = latestTickers.get(command.market);
    if (market == null || marketConnectionState !== "CONNECTED") return Object.freeze({ schemaVersion: 1, status: "BLOCKED", reason: "PAPER_MARKET_DATA_UNAVAILABLE", liveAuthority: "NONE", productionMutationAllowed: false });
    const observedAt = Date.parse(market.observedAt);
    const now = Date.now();
    const investmentPercent = investmentAllocationSettings.get(principal.userId)?.investmentPercent ?? 100;
    const context = { now, marketPrice: market.price, observedAt, mode: dashboard.mode, killSwitchActive: dashboard.killSwitchActive, tradingAllowed: dashboard.tradingAllowed, overallHealth: dashboard.overallHealth, investmentPercent };
    // Manual mutation is available only through the canonical Cloud PAPER boundary. A
    // caller-supplied execution loop must not become an implicit risk-gate bypass.
    const result = productionPaperBoundary?.submitManualOrder(principal.userId, command, context);
    if (result == null) return Object.freeze({ schemaVersion: 1, status: "BLOCKED", reason: "PAPER_RISK_BOUNDARY_UNAVAILABLE", liveAuthority: "NONE", productionMutationAllowed: false });
    try { paperRealizedPeriodProducer?.observeExecution({ observationId: paperExecutionObservationId(command.market, observedAt, result.status), observedAt: now, status: result.status }); } catch { /* producer emitted a structured rejection; PAPER execution remains canonical */ }
    if (result.status === "FILLED") projectPaperAccount();
    const snapshot = loadPaperOperations(principal);
    const order = result.orders[0] == null ? undefined : buildReadOnlyOrders(result.state).find((item) => item.id === result.orders[0]!.id);
    const status: PersonalPaperOrderCommandResult["status"] = result.status === "FILLED" ? "FILLED" : result.status === "DUPLICATE" ? "DUPLICATE" : result.status === "REJECTED" ? "REJECTED" : "BLOCKED";
    return Object.freeze({ schemaVersion: 1, status, ...(result.reason ? { reason: result.reason } : {}), ...(order ? { order } : {}), ...(status === "FILLED" ? { snapshot } : {}), liveAuthority: "NONE", productionMutationAllowed: false });
  };

  const handle = startCloudDashboardServer({
    port: config.port,
    // The PAPER loop runs off a persistent ticker subscription, so its liveness is only visible
    // from these counters. Publishing them makes 24-hour operation something that can be checked
    // rather than assumed from the process being up.
    runtimeLiveness: () => Object.freeze({
      // The exact commit this process was built from, so main = deployed = running can be read directly.
      sourceCommitSha: (env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "").trim(),
      startedAt: heartbeat.startedAt,
      lastHeartbeatAt: heartbeat.lastHeartbeatAt,
      lastMarketEventAt: heartbeat.lastMarketEventAt,
      lastPaperDecisionAt: heartbeat.lastPaperDecisionAt,
      lastPaperOrderAt: heartbeat.lastPaperOrderAt,
      lastPaperFillAt: heartbeat.lastPaperFillAt,
      eventCount: heartbeat.eventCount,
      decisionCount: heartbeat.decisionCount,
      paperOrderCount: heartbeat.paperOrderCount,
      paperFillCount: heartbeat.paperFillCount,
      ...(heartbeat.lastPaperDecisionOutcome === null ? {} : { lastPaperDecisionOutcome: heartbeat.lastPaperDecisionOutcome }),
      lastError: heartbeat.lastError,
      ...(previousStop === undefined ? {} : { previousStop }),
      ...stallMonitor.snapshot(),
      ...researchLiveness(),
      paperFunnel: mergeFunnelSnapshots(paperLearningRecorder.funnelSnapshot(), orderIntentReasonCounters.snapshot()),
      ...lossSessionLiveness(),
      ...lossAttributionLiveness(),
      ...researchExperimentLiveness(),
      ...researchGapFillLiveness(),
      ...microstructureLiveness(),
      ...orderBookCollectorLiveness(),
      ...orderBookCoverageLiveness(),
      ...futuresCollectorLiveness(),
      ...dataIntegrityLiveness(),
      ...paperLedgerLiveness(),
      ...researchIntervalLiveness(),
      ...closedLearningLiveness()
    }),
    runtimeHealth: () => projectPaperRuntimeHealth(
      Object.freeze({ ...heartbeat }),
      Date.now(),
      { heartbeatStaleAfterMs: 6_000, marketEventStaleAfterMs: DEFAULT_UPBIT_TICKER_STALE_WINDOW_MS },
    ),
    ...(config.host ? { host: config.host } : {}),
    tokenVerifier,
    ...(userAccessRepository == null ? {} : { userAccessRepository }),
    ...(desktopSessionService == null ? {} : { desktopSessionService }),
    ...(mobileSessionService == null ? {} : { mobileSessionService }),
    ...(ownerDeviceCredentialService == null ? {} : { ownerDeviceCredentialService }),
    readiness: () => buildCloudRuntimeReadiness(durableRepository, effectiveProvider),
    loadDashboard: (principal) => { const input = effectiveProvider.read(principal); if (input === undefined) throw new Error("dashboard state is not ready"); return buildMobileDashboardResponse(input); },
    loadPaperOperations,
    ...(shadowObservabilityProvider == null ? {} : { loadShadowOperations: shadowObservabilityProvider }),
    ...(realReadOnlyObservabilityProvider == null ? {} : { loadRealReadOnlyOperations: (principal: DashboardPrincipal) => realReadOnlyObservabilityProvider(principal, realReadOnlyEventRecorder.replay()) }),
    loadLiveReadiness: () => liveReadinessSourceProvider.getSnapshot(),
    loadEngineeringOperations: () => engineeringOperatingReadModel.getSnapshot(),
    ...(loadEvolutionLearning == null ? {} : { loadEvolutionLearning }),
    submitPaperOrder,
    investmentAllocationSettings
  });
  process.stdout.write(`[cloud-runtime] listening on ${handle.host}:${handle.port}\n`);
  // Display only: evaluate the learning-pipeline alarm once a minute even when nobody reads /health.
  const pipelineAlarmTimer = setInterval(() => { handle.observeLearningPipeline(); }, 60_000);
  pipelineAlarmTimer.unref?.();
  // Display only, off unless the server owner sets NUSA_HEALTH_EXPORT_URL and a write-only NUSA_HEALTH_EXPORT_TOKEN:
  // appends this process's own public /health (nothing more) to an external append-only store. Never read back.
  const healthExport = healthExportConfig(env);
  const stopHealthExport = healthExport == null ? undefined : startHealthExport(healthExport, {
    readLocalHealth: async () => {
      const localHost = handle.host === "0.0.0.0" || handle.host === "::" ? "127.0.0.1" : handle.host;
      const response = await fetch(`http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${handle.port}/health`, { signal: AbortSignal.timeout(HEALTH_EXPORT_TIMEOUT_MS) });
      return response.ok ? response.json() : null;
    },
    post: (url, init) => fetch(url, init),
  });
  const requirePaperRealizedPeriodProducer = (): PaperRealizedPeriodProducer => {
    if (paperRealizedPeriodProducer == null) throw new Error("PAPER_REALIZED_PERIOD_PERSISTENCE_UNAVAILABLE");
    return paperRealizedPeriodProducer;
  };
  return {
    ...handle,
    getLiveReadinessSourceSnapshot: () => liveReadinessSourceProvider.getSnapshot(),
    getEngineeringOperatingSnapshot: () => engineeringOperatingReadModel.getSnapshot(),
    recordRealReadOnlyEvent: (event) => realReadOnlyEventRecorder.record(event),
    openPaperRealizedPeriod: (input) => requirePaperRealizedPeriodProducer().openPeriod(input),
    observePaperRealizedExecution: (observation) => requirePaperRealizedPeriodProducer().observeExecution(observation),
    closePaperRealizedPeriod: (input) => requirePaperRealizedPeriodProducer().closePeriod(input),
    openPaperRealizedPeriodFromCanonicalAccount: (input) => requirePaperRealizedPeriodProducer().openPeriodFromCanonicalAccount(input),
    closePaperRealizedPeriodFromCanonicalAccount: (input) => requirePaperRealizedPeriodProducer().closePeriodFromCanonicalAccount(input),
    retirePaperRealizedPeriodForReplacement: (periodId, reason) => requirePaperRealizedPeriodProducer().retireOpenPeriodForReplacement(periodId, reason),
    retirePaperRealizedPeriodForAccountChange: (periodId) => requirePaperRealizedPeriodProducer().retireOpenPeriodForAccountChange(periodId),
    retirePaperRealizedPeriodForUnstreamedMarket: (periodId, streamedMarkets) => requirePaperRealizedPeriodProducer().retireOpenPeriodForUnstreamedMarket(periodId, streamedMarkets),
    retirePaperRealizedPeriodForMixedBinding: (periodId) => requirePaperRealizedPeriodProducer().retireOpenPeriodForMixedBinding(periodId),
    inspectPaperRealizedPeriodForMixedBinding: (periodId) => requirePaperRealizedPeriodProducer().inspectOpenPeriodForMixedBinding(periodId),
    nextPaperRealizedPeriodIndex: () => requirePaperRealizedPeriodProducer().nextPeriodIndex(),
    listPaperRealizedPeriods: () => requirePaperRealizedPeriodProducer().listRealizedPeriods(),
    stop: async () => { try { clearInterval(pipelineAlarmTimer); stopHealthExport?.(); clearInterval(heartbeatTimer); stallMonitor.stop(); marketDataClient?.stop(); if (microstructureFlushTimer != null) clearInterval(microstructureFlushTimer); orderBookCollector?.stop(); futuresCollector?.stop(); microstructureRecorder?.flush(); await handle.stop(); } finally { paperLearningRecorder.close(); realReadOnlyEventRecorder.close(); effectivePaperRepository?.close?.(); if (durableRepository != null) effectiveProvider instanceof DurableCloudDashboardStateProvider ? effectiveProvider.close() : durableRepository.close(); } }
  };
}

export function registerGracefulShutdown(handle: CloudDashboardServerHandle, exit: (code: number) => void = process.exit, cloudStateDbPath?: string): ShutdownController {
  const controller = createShutdownController({ stop: () => handle.stop(), exit });
  process.on("SIGTERM", () => controller.trigger("SIGTERM")); process.on("SIGINT", () => controller.trigger("SIGINT"));

  // Unrecoverable runtime faults must terminate the process so supervisors can restart
  // from a fail-closed state instead of serving potentially stale mutation paths.
  process.on("uncaughtException", (error) => {
    if (cloudStateDbPath !== undefined) recordRuntimeFailure(cloudStateDbPath, "UNCAUGHT_EXCEPTION", error);
    handleRuntimeFault(controller, "uncaught exception", error, exit);
  });
  process.on("unhandledRejection", (reason) => {
    if (cloudStateDbPath !== undefined) recordRuntimeFailure(cloudStateDbPath, "UNHANDLED_REJECTION", reason);
    handleRuntimeFault(controller, "unhandled rejection", reason, exit);
  });

  return controller;
}
function main(): void { const config = readCloudRuntimeConfig(process.env); const snapshot = createSnapshotRepository(config.cloudStateDbPath); const research = composeResearchExperiments({ env: process.env, database: snapshot.database() }); research?.start(); const handle = startCloudRuntime(process.env, undefined, undefined, undefined, snapshot, undefined, undefined, undefined, undefined, research?.orchestrator, createCloudAiRuntime(process.env)); registerGracefulShutdown(handle); }
if (require.main === module) main();
