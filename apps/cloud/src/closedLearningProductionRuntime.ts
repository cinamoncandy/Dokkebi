import { createLeaseStartupWindow } from "./paperLeaseStartupWindow";
import { buildMetaLearningStatus } from "./researchMetaLearningRuntime";
import { createHash } from "node:crypto";
import { canonicalResearchJson } from "../../../packages/contracts/src/researchRuntime";
import { RESEARCH_LEDGER_SNAPSHOT } from "./researchLedgerSnapshot";
import { readOrderBookStudyResult } from "./researchStudyResult";
import { MarketMicrostructureRecorder, microstructureRecorderEnabled } from "./marketMicrostructureRecorder";
import { SqliteMarketMicrostructureStore } from "../../../packages/storage/src/marketMicrostructureStore";
import { ResearchOrderBookCollector, researchOrderBookCollectorEnabled, researchOrderBookRetention } from "./researchOrderBookCollector";
import { ResearchFuturesCollector, researchFuturesCollectorEnabled } from "./researchFuturesCollector";
import { SqliteFuturesPublicStore } from "../../../packages/storage/src/futuresPublicStore";
import type { PersistedPaperPeriodEnvelope } from "../../../packages/contracts/src/persistedPaperPeriod";
import { replayPaperPeriodRule } from "./paperPeriodRuleReplay";
import { composeResearchExperiments } from "./researchExperimentComposition";
import { PaperChallengerPolicyApproval, paperChallengerPolicyEnabled } from "./paperChallengerPolicyApproval";
import type { CommitteeVote, StrategyIdentity, StrategyValidationSummary } from "../../../packages/contracts/src/strategyGovernance";
import { adaptPersistedPaperForwardEvidence } from "../../desktop/src/cloud/persistedPaperForwardEvidenceAdapter";
import { buildCanonicalPaperCandidatePerformance, PAPER_COVERED_DAY_SCORING_VERSION } from "./canonicalPaperCandidatePerformance";
import { evaluatePaperPerformanceGovernanceFeedback, type PaperPerformanceGovernanceFeedbackReceipt } from "./paperPerformanceGovernanceFeedback";
import { SqliteDatabase, SqliteEvolutionLearningLedger, SqlitePaperMarketObservationRepository } from "../../../packages/storage/src/index";
import { PaperMinuteBarSource } from "./paperMinuteBars";
import { ClosedLearningLoopStatusTracker, tickErrorClass } from "./closedLearningLoopStatus";
import { FileResearchRunReplaySnapshotStore } from "../../desktop/src/cloud/researchRunReplaySnapshotStore";
import { readCloudRuntimeConfig } from "./cloudRuntimeConfig";
import { readCanonicalPaperTickerBenchmark } from "./paperMarketBenchmark";
import { readClosedLearningBlocked, recordClosedLearningBlocked } from "./closedLearningBlockedRecord";
import { PaperBaselineShadow } from "./paperBaselineShadow";
import { readBaselineShadowRecord, writeBaselineShadowRecord } from "./paperBaselineShadowRecord";
import { PaperNullComparators } from "./paperNullComparators";
import { readNullComparatorsRecord, writeNullComparatorsRecord } from "./paperNullComparatorsRecord";
import { recordRuntimeFailure } from "./runtimeFailureRecord";
import { ResearchSnapshotRefresher } from "./researchSnapshotRefresher";
import { retiredPaperAccountIds, retirePaperAccounts } from "./paperAccountRetirement";
import { OWNER_BASELINE_CANDIDATE_ID, OwnerBaselinePaperBindingProvider, isOwnerBaselineSourceCommitSha, ownerBaselineStrategyEnabled, ownerBaselineStrategySpec } from "./ownerBaselinePaperStrategy";
import { buildOwnerBaselinePaperPeriodInput, isOwnerBaselinePeriodStartAt } from "./ownerBaselinePaperPeriod";
import { CloudRuntimeDashboardHydrator } from "./cloudRuntimeDashboardHydrator";
import { SqliteCloudDashboardSnapshotRepository } from "./cloudDashboardSnapshotRepository";
import { PaperChallengerBindingLedger } from "./paperChallengerBindingLedger";
import { PaperTradingExecutionLoop, SqliteCloudPaperAccountRepository, paperAccountIdForCapital, type PaperAccountState } from "./paperTradingExecutionLoop";
import { createCloudAiRuntime } from "./ai/runtime";
import { registerGracefulShutdown, startCloudRuntimeFromOptions, type CloudRuntimeHandle } from "./runtime";
import { readClosedLearningProductionConfig } from "./closedLearningProductionConfig";
import { ClosedLearningResearchWorkerClient } from "./closedLearningResearchWorkerClient";
import { ClosedLearningResearchDecisionHistory } from "./closedLearningResearchDecisionHistory";
import { FileQualifiedPaperChallengerArtifactStore } from "./qualifiedPaperChallengerArtifactStore";
import { ClosedLearningLineageReplayInputSource } from "./closedLearningLineageReplayInputSource";
import { ClosedLearningProductionResearchAdapter } from "./closedLearningProductionResearchAdapter";
import { ClosedLearningEvolutionLedgerRepository } from "./closedLearningEvolutionLedgerRepository";
import { ClosedLearningLoopCoordinator, closedLearningCycleId, isCompleteClosedLearningCycle, type ClosedLearningCycleResult, type ClosedLearningEvidenceIdentity } from "./closedLearningLoopCoordinator";
import { PaperChallengerDeploymentRuntime } from "./paperChallengerDeploymentRuntime";
import { ClosedLearningPendingPeriodReader } from "./closedLearningPendingPeriodReader";
import { ClosedLearningEvidenceIdentitySource } from "./closedLearningEvidenceIdentitySource";
import { CLOUD_PAPER_RISK_POLICY_FINGERPRINT, cloudPaperRiskPolicyFingerprint } from "./cloudPaperRiskPolicyIdentity";
import { cloudPaperRiskLimitsForCapital } from "./paperRiskLimitScaling";
import { ClosedLearningRolloverScheduler, type ClosedLearningRolloverResult } from "./closedLearningRolloverScheduler";
import { ClosedLearningInitialPaperBootstrap, type ClosedLearningInitialPaperBootstrapResult } from "./closedLearningInitialPaperBootstrap";
import { buildPaperPerformanceFromLedger, type PaperPerformanceFromLedgerResult } from "./paperPerformanceFromLedger";

export const CLOSED_LEARNING_ROLLOVER_POLL_INTERVAL_MS = 30_000;

export interface ClosedLearningProductionComposition {
  readonly handle: CloudRuntimeHandle;
  readonly challengerBindings: PaperChallengerBindingLedger;
  /**
   * Read-only view of the exact canonical PAPER loop owned by this production process.
   * Closed-learning evidence consumers use this instead of opening a second account repository
   * or acquiring a competing writer lease.
   */
  readonly readCanonicalPaperAccount: () => PaperAccountState | undefined;
  /** Executes one replay-safe closed-learning cycle over an explicit immutable evidence identity. */
  readonly runClosedLearningCycle: (input: ClosedLearningEvidenceIdentity) => ClosedLearningCycleResult;
  readonly runClosedLearningCycleAsync: (input: ClosedLearningEvidenceIdentity) => Promise<ClosedLearningCycleResult>;
  /** Attempts initial canonical Research→PAPER deployment when no PAPER period has ever existed. */
  readonly runClosedLearningBootstrap: () => ClosedLearningInitialPaperBootstrapResult;
  readonly runClosedLearningBootstrapAsync: () => Promise<ClosedLearningInitialPaperBootstrapResult>;
  /** Executes one production rollover decision against the canonical pending/realized ledgers. */
  readonly runClosedLearningRollover: () => ClosedLearningRolloverResult;
  readonly runClosedLearningRolloverAsync: () => Promise<ClosedLearningRolloverResult>;
  /** Read-only deterministic Performance Evidence from this process' canonical PAPER history. */
  readonly readPaperPerformanceEvidence: (periodId: string) => PaperPerformanceFromLedgerResult;
}

/**
 * Production composition root for autonomous PAPER + closed-learning candidate attribution.
 *
 * One process owns the canonical SQLite database, PAPER account loop, realized-period producer,
 * Research replay worker boundary, complete denominator history, immutable challenger artifacts,
 * replay-safe cycle ledger, initial PAPER bootstrap, and next-PAPER deployment. No second PAPER
 * writer, Research scoring engine, LIVE route, or production champion mutation is introduced here.
 */
export function startClosedLearningProductionRuntime(env: NodeJS.ProcessEnv = process.env, requestFatalShutdown?: () => void): ClosedLearningProductionComposition {
  const config = readCloudRuntimeConfig(env);
  const closedLearningConfig = readClosedLearningProductionConfig(env, config.cloudStateDbPath);
  const database = new SqliteDatabase(config.cloudStateDbPath);
  if (config.paperInitialCapitalKrw !== undefined) {
    const retired = retiredPaperAccountIds(env);
    if (retired.length > 0) {
      const receipts = retirePaperAccounts(database, retired, paperAccountIdForCapital(config.paperInitialCapitalKrw), { stateDbPath: config.cloudStateDbPath });
      for (const receipt of receipts) console.log(`[paper-account] retired ${receipt.accountId}: ${JSON.stringify(receipt.deletedRows)}`);
    }
  }
  const snapshots = new SqliteCloudDashboardSnapshotRepository(database);
  const learningLedger = new SqliteEvolutionLearningLedger(database);
  const challengerBindings = new PaperChallengerBindingLedger(learningLedger);
  // A qualified challenger always wins; until one exists the owner-approved PAPER baseline trades.
  const paperCandidateBindingProvider = new OwnerBaselinePaperBindingProvider({
    challenger: challengerBindings,
    sourceCommitSha: env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "",
    enabled: ownerBaselineStrategyEnabled(env),
    baselineMarkets: config.upbitMarkets,
  });
  // The candidate strategy reads completed 1-minute closes from the persisted public-ticker store (owner decision 2026-10-06).
  const minuteObservationReader = new SqlitePaperMarketObservationRepository(database);
  const minuteBars = new PaperMinuteBarSource((market, startAt, endAt) => minuteObservationReader.readWindow(market, startAt, endAt));
  // Uncensored shadow of the baseline rule on the same completed minute bars (display/analysis only; no order, ledger or Risk input).
  const shadowSourceCommit = env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "";
  const restoredShadow = readBaselineShadowRecord(config.cloudStateDbPath);
  // 0.0005 is the PAPER execution loop's default fee per side, the rate its own fills are charged.
  // Null comparators (buy-and-hold, fixed-seed random entry) on the same bars and the same fee rate; display/analysis only.
  let nullComparators: PaperNullComparators | undefined;
  const baselineShadow = ownerBaselineStrategyEnabled(env) && isOwnerBaselineSourceCommitSha(shadowSourceCommit)
    ? new PaperBaselineShadow({ spec: ownerBaselineStrategySpec(shadowSourceCommit), feeRate: 0.0005, now: Date.now, onRoundTrip: (trip) => nullComparators?.onBaselineRoundTrip(trip), ...(restoredShadow === undefined ? {} : { restore: restoredShadow }) })
    : undefined;
  if (baselineShadow != null) {
    const restoredNulls = readNullComparatorsRecord(config.cloudStateDbPath);
    nullComparators = new PaperNullComparators({ feeRate: 0.0005, now: Date.now, baselineTotals: () => baselineShadow.summary(), ...(restoredNulls === undefined ? {} : { restore: restoredNulls }) });
  }
  const dashboardHydrator = new CloudRuntimeDashboardHydrator({
    paperCandidateBindingProvider,
    paperCandidateMinuteCloses: (market, now) => {
      const bars = minuteBars.read(market, now);
      nullComparators?.observe(market, bars); // before the baseline shadow, so a round trip it completes is matched on bars already seen
      baselineShadow?.observe(market, bars);
      return bars;
    },
  });

  // Evidence validation is read-only and can be expensive. Do it before owning the renewable
  // PAPER lease; actual session pause/halt recovery still runs after exclusive acquisition.
  let researchExperiments: ReturnType<typeof composeResearchExperiments>;
  try {
  // Cloud AI durability uses the exact canonical SQLite connection that already completed the
  // full-file startup quick_check. This avoids reopening and rescanning the same production-sized
  // file while preserving each AI store's table-scoped quick_check and hash-chain replay. Keep this
  // before research recovery preparation and the renewable PAPER writer lease: its schema
  // initialization must not invalidate prepared SQLite change-tracking evidence, and its startup
  // I/O must not starve the lease heartbeat.
  const cloudAiRuntime = createCloudAiRuntime(env, undefined, { verifiedSharedSqliteDatabase: database });

  let longBarTickEvery = 1;
  researchExperiments = composeResearchExperiments({ env, database, log: (line) => console.log(line), longBarTickEvery: () => longBarTickEvery });
  researchExperiments?.prepareRecovery();

  // Own the canonical PAPER repository/loop at this composition root so the same process can
  // supply restart-safe candidate performance evidence without opening a second writer lease.
  // Timing only: the writer lease is owned from the repository constructor on, and its heartbeat cannot renew until
  // the event loop turns, so everything composed synchronously below counts against the lease TTL.
  const leaseWindow = createLeaseStartupWindow(30_000, (line) => console.log(line));
  const repositoryStartedAt = performance.now();
  const paperRepository = config.paperInitialCapitalKrw === undefined
    ? undefined
    : new SqliteCloudPaperAccountRepository(database, { accountId: paperAccountIdForCapital(config.paperInitialCapitalKrw) });
  if (paperRepository != null) {
    leaseWindow.leaseOwned(performance.now() - repositoryStartedAt);
    setImmediate(() => leaseWindow.firstLoopTurn());
  }
  const paperLoop = config.paperInitialCapitalKrw === undefined || paperRepository == null
    ? undefined
    : new PaperTradingExecutionLoop({ initialCapital: config.paperInitialCapitalKrw, repository: paperRepository });

  // Continuous research experiments: disabled unless NUSA_CLOUD_RESEARCH_EXPERIMENTS=1 (see researchExperimentComposition.ts).
  // Meta-learning steering (researchMetaLearning.ts): starts NORMAL and follows the latest meta-learning evaluation.
  // Research-only recording of the public order book and trades already streamed (Upbit keeps no history of either).
  const microstructureRecorder = microstructureRecorderEnabled(env) ? new MarketMicrostructureRecorder(new SqliteMarketMicrostructureStore(database)) : undefined;
  // Research-only all-KRW order book, once a minute; markets the WebSocket recorder samples are left to it.
  const orderBookRetention = researchOrderBookRetention(env);
  if (orderBookRetention.warning != null) console.warn(orderBookRetention.warning);
  const orderBookCollector = researchOrderBookCollectorEnabled(env)
    ? new ResearchOrderBookCollector(new SqliteMarketMicrostructureStore(database), { skipMarkets: () => microstructureRecorder?.recordedMarkets() ?? new Set<string>(), retentionMs: orderBookRetention.retentionMs })
    : undefined;
  // Research-only public Binance futures data (BTCUSDT, ETHUSDT); never an order path.
  const futuresCollector = researchFuturesCollectorEnabled(env) ? new ResearchFuturesCollector(new SqliteFuturesPublicStore(database)) : undefined;
  const loopStatus = new ClosedLearningLoopStatusTracker(closedLearningConfig.evaluationPeriodMs);
  // The last BLOCKED/ERROR reason survives a restart (display only; a reason seen by this process always wins).
  loopStatus.seedLastBlocked(readClosedLearningBlocked(config.cloudStateDbPath));
  let persistedBlockedAt = loopStatus.lastBlockedRecord()?.at;
  const persistLastBlocked = (): void => {
    const current = loopStatus.lastBlockedRecord();
    if (current == null || current.at === persistedBlockedAt) return;
    // Advance the marker only after a successful write, so a transient failure is retried on a later tick.
    if (recordClosedLearningBlocked(config.cloudStateDbPath, current)) persistedBlockedAt = current.at;
  };
  const baseHandle = startCloudRuntimeFromOptions({
    env,
    dashboardHydrator,
    snapshotRepository: snapshots,
    paperAccountRepository: paperRepository,
    paperExecutionLoop: paperLoop,
    researchAutomation: researchExperiments?.orchestrator,
    aiRuntime: cloudAiRuntime,
    closedLearningStatus: () => loopStatus.snapshot(),
    researchIntervalTicks: () => researchExperiments?.experimentTicksByInterval() ?? null,
    microstructureRecorder,
    orderBookCollector,
    futuresCollector,
  });
  // startCloudRuntime performs the last large synchronous composition step before the event loop
  // can service the repository's interval heartbeat. Re-verify/renew the existing lease at this
  // handoff so a valid lease that survived composition gets a fresh full TTL for the remaining
  // bounded startup work. This never revives an expired lease: verifyWriterLease() uses the same
  // conditional owner/expiry update and fails closed if composition already exceeded the TTL.
  try {
    paperRepository?.verifyWriterLease();
  } catch (error) {
    // startCloudRuntime has already opened the listener and started repository-owned timers.
    // If the bounded lease handoff cannot renew a still-valid lease, tear down that partial
    // runtime before propagating the original fail-closed error to the supervisor.
    void baseHandle.stop().catch((stopError) => {
      const detail = stopError instanceof Error ? stopError.message.trim().slice(0, 300) : "UNKNOWN_STOP_ERROR";
      console.error(`[closed-learning] runtime cleanup after writer lease handoff failure failed: ${detail || "UNKNOWN_STOP_ERROR"}`);
    });
    throw error;
  }

  const readCanonicalPaperAccount = (): PaperAccountState | undefined => paperLoop?.snapshot();
  const requireCanonicalPaperAccount = (): PaperAccountState => {
    const account = readCanonicalPaperAccount();
    if (account == null) throw new Error("closed learning canonical PAPER account is unavailable");
    return account;
  };

  // Read pending plans from the exact persisted ledger owned by startCloudRuntime. This is a
  // checksum-bound read-only view, not a second PaperRealizedPeriodProducer or writer path.
  const pendingPeriods = new ClosedLearningPendingPeriodReader(database);
  const periods = Object.freeze({
    listOpenPeriods: () => pendingPeriods.list(),
    listRealizedPeriods: () => baseHandle.listPaperRealizedPeriods(),
    nextPeriodIndex: () => baseHandle.nextPaperRealizedPeriodIndex(),
    openPeriodFromCanonicalAccount: (input: Parameters<CloudRuntimeHandle["openPaperRealizedPeriodFromCanonicalAccount"]>[0]) => baseHandle.openPaperRealizedPeriodFromCanonicalAccount(input),
    closePeriodFromCanonicalAccount: (input: Parameters<CloudRuntimeHandle["closePaperRealizedPeriodFromCanonicalAccount"]>[0]) => baseHandle.closePaperRealizedPeriodFromCanonicalAccount(input),
    retireOpenPeriodForReplacement: (periodId: string, reason: string) => baseHandle.retirePaperRealizedPeriodForReplacement(periodId, reason),
    retireOpenPeriodForAccountChange: (periodId: string) => baseHandle.retirePaperRealizedPeriodForAccountChange(periodId),
    retireOpenPeriodForUnstreamedMarket: (periodId: string, streamedMarkets: readonly string[]) => baseHandle.retirePaperRealizedPeriodForUnstreamedMarket(periodId, streamedMarkets),
    retireOpenPeriodForMixedBinding: (periodId: string) => baseHandle.retirePaperRealizedPeriodForMixedBinding(periodId),
    inspectOpenPeriodForMixedBinding: (periodId: string) => baseHandle.inspectPaperRealizedPeriodForMixedBinding(periodId),
  });

  const replaySnapshots = new FileResearchRunReplaySnapshotStore(closedLearningConfig.researchReplaySnapshotPath);
  const replayInput = new ClosedLearningLineageReplayInputSource({
    requireIndependentDays: true,
    periods,
    bindings: challengerBindings,
    readCanonicalPaperAccount,
    executionQualityPolicy: closedLearningConfig.executionQualityPolicy,
  });
  const worker = new ClosedLearningResearchWorkerClient({ snapshotPath: closedLearningConfig.researchReplaySnapshotPath });
  const history = new ClosedLearningResearchDecisionHistory(database);
  const artifacts = new FileQualifiedPaperChallengerArtifactStore(closedLearningConfig.qualifiedArtifactPath);
  const researchFactory = new ClosedLearningProductionResearchAdapter({ replayInput, worker, history, artifacts });
  const cycleRepository = new ClosedLearningEvolutionLedgerRepository(learningLedger);
  const paperDeployment = new PaperChallengerDeploymentRuntime({
    artifacts,
    bindings: challengerBindings,
    periods,
    readCanonicalPaperAccount: requireCanonicalPaperAccount,
    // Canonical Strategy Governance approval for PAPER challengers (ADR-0018, amended): on by
    // default on the PAPER host; NUSA_PAPER_CHALLENGER_POLICY_APPROVAL=DISABLED makes candidates wait.
    governance: new PaperChallengerPolicyApproval({ artifacts, enabled: paperChallengerPolicyEnabled(env) }),
  });
  const coordinator = new ClosedLearningLoopCoordinator(cycleRepository, researchFactory, paperDeployment);
  const runClosedLearningCycle = (input: ClosedLearningEvidenceIdentity): ClosedLearningCycleResult => coordinator.run(input);
  const runClosedLearningCycleAsync = (input: ClosedLearningEvidenceIdentity): Promise<ClosedLearningCycleResult> => coordinator.runAsync(input);

  const bootstrap = new ClosedLearningInitialPaperBootstrap({
    snapshots: replaySnapshots,
    worker,
    history,
    artifacts,
    deployment: paperDeployment,
    listOpenPeriods: periods.listOpenPeriods,
    listRealizedPeriods: periods.listRealizedPeriods,
  });
  const runClosedLearningBootstrap = (): ClosedLearningInitialPaperBootstrapResult => bootstrap.runOnce();
  const runClosedLearningBootstrapAsync = (): Promise<ClosedLearningInitialPaperBootstrapResult> => bootstrap.runOnceAsync();

  const evidenceIdentity = new ClosedLearningEvidenceIdentitySource({
    paperEvidenceTransformationVersion: PAPER_COVERED_DAY_SCORING_VERSION,
    bindings: challengerBindings,
    replaySnapshots,
    // The same capital-scaled limits the canonical risk gateway enforces (runtime.ts), so evidence names the enforced policy.
    readRiskConfigHash: () => config.paperInitialCapitalKrw === undefined ? CLOUD_PAPER_RISK_POLICY_FINGERPRINT : cloudPaperRiskPolicyFingerprint(cloudPaperRiskLimitsForCapital(config.paperInitialCapitalKrw)),
    readCanonicalBenchmarkEvidence: (market, periodStartAt, periodEndAt) => readCanonicalPaperTickerBenchmark(minuteObservationReader, market, periodStartAt, periodEndAt),
  });
  const rollover = new ClosedLearningRolloverScheduler({
    listOpenPeriods: periods.listOpenPeriods,
    listRealizedPeriods: periods.listRealizedPeriods,
    nextPeriodIndex: periods.nextPeriodIndex,
    readCanonicalPaperAccount,
    now: () => Date.now(),
    evaluationPeriodMs: closedLearningConfig.evaluationPeriodMs,
    closePeriodFromCanonicalAccount: periods.closePeriodFromCanonicalAccount,
    openPeriodFromCanonicalAccount: periods.openPeriodFromCanonicalAccount,
    retireOpenPeriodForAccountChange: periods.retireOpenPeriodForAccountChange,
    retireOpenPeriodForReplacement: periods.retireOpenPeriodForReplacement,
    retireOpenPeriodForUnstreamedMarket: periods.retireOpenPeriodForUnstreamedMarket,
    retireOpenPeriodForMixedBinding: periods.retireOpenPeriodForMixedBinding,
    inspectOpenPeriodForMixedBinding: periods.inspectOpenPeriodForMixedBinding,
    streamedMarkets: () => config.upbitMarkets,
    buildOwnerBaselinePeriod: ({ periodIndex, periodStartAt }) => {
      const sourceCommitSha = env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "";
      const market = config.upbitMarkets[0];
      if (!ownerBaselineStrategyEnabled(env) || market == null || !isOwnerBaselineSourceCommitSha(sourceCommitSha) || !isOwnerBaselinePeriodStartAt(periodStartAt)) return undefined;
      return buildOwnerBaselinePaperPeriodInput({ market, periodIndex, periodStartAt, sourceCommitSha });
    },
    buildEvidenceIdentity: (window) => evidenceIdentity.build(window),
    recordIdentityFailure: ({ closedPeriod, code }) => {
      const runtimeSourceCommitSha = (env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "").trim().toLowerCase();
      cycleRepository.appendFailure({
        closedPeriodId: closedPeriod.record.recordId,
        evidenceId: `closed-paper-period:${closedPeriod.record.recordId}`,
        evidenceFingerprintSha256: createHash("sha256").update(canonicalResearchJson(closedPeriod), "utf8").digest("hex"),
        sourceCommitSha: runtimeSourceCommitSha,
        runtimeSourceCommitSha,
        stage: "IDENTITY",
        code,
      });
    },
    // "Recorded" means complete: a qualified decision without its deployment receipt is resumed by running the coordinator again.
    isCycleRecorded: (identity) => isCompleteClosedLearningCycle(cycleRepository.get(closedLearningCycleId(identity))),
    recordCycleFailure: ({ closedPeriodId, identity, stage, code }) => cycleRepository.appendFailure({
      closedPeriodId,
      evidenceId: identity.evidenceId,
      evidenceFingerprintSha256: identity.evidenceFingerprintSha256,
      sourceCommitSha: identity.sourceCommitSha,
      runtimeSourceCommitSha: (env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "").trim().toLowerCase(),
      stage,
      code,
    }),
    runClosedLearningCycle,
    runClosedLearningCycleAsync,
  });
  const runClosedLearningRollover = (): ClosedLearningRolloverResult => rollover.runOnce();
  const runClosedLearningRolloverAsync = (): Promise<ClosedLearningRolloverResult> => rollover.runOnceAsync();

  const readPaperPerformanceEvidence = (periodId: string): PaperPerformanceFromLedgerResult => {
    const normalized = periodId.trim();
    if (!normalized) throw new Error("PAPER_PERFORMANCE_PERIOD_ID_REQUIRED");
    if (paperRepository?.loadHistory == null) throw new Error("PAPER_PERFORMANCE_DURABLE_HISTORY_UNAVAILABLE");
    if (paperRepository.loadFills == null) throw new Error("PAPER_PERFORMANCE_DURABLE_FILL_LEDGER_UNAVAILABLE");
    const matches = baseHandle.listPaperRealizedPeriods().filter((period) => period.record.recordId === normalized);
    if (matches.length !== 1) throw new Error(matches.length === 0 ? "PAPER_PERFORMANCE_PERIOD_NOT_FOUND" : "PAPER_PERFORMANCE_PERIOD_ID_CONFLICT");
    return buildPaperPerformanceFromLedger({
      period: matches[0]!,
      accountHistory: paperRepository.loadHistory(),
      durableFills: paperRepository.loadFills(),
    });
  };

  const evaluatePaperGovernanceFeedback = (input: Readonly<{
    periodId: string;
    now: number;
    identity: StrategyIdentity;
    validation?: StrategyValidationSummary;
    votes: readonly CommitteeVote[];
  }>): PaperPerformanceGovernanceFeedbackReceipt => {
    const ledgerPerformance = readPaperPerformanceEvidence(input.periodId);
    const adapted = adaptPersistedPaperForwardEvidence(baseHandle.listPaperRealizedPeriods());
    const candidate = adapted.candidates.find((item) => item.candidateId === ledgerPerformance.evidence.candidateId);
    const candidatePeriods = candidate?.periods.filter((period) => period.periodEndAt <= ledgerPerformance.evidence.periodEndAt) ?? [];
    const paper = candidatePeriods.length === 0 ? undefined : buildCanonicalPaperCandidatePerformance({
      candidateId: ledgerPerformance.evidence.candidateId,
      periods: candidatePeriods,
      account: requireCanonicalPaperAccount(),
      executionQualityPolicy: closedLearningConfig.executionQualityPolicy,
      requireIndependentDays: true,
    });
    return evaluatePaperPerformanceGovernanceFeedback({
      now: input.now,
      identity: input.identity,
      validation: input.validation,
      paper,
      votes: input.votes,
      ledgerPerformance,
    });
  };

  // Closed learning is serialized and asynchronous. Research/League can be CPU-heavy on the
  // Oracle host, but it must never block the Node HTTP loop that serves /health, /ready, or the
  // monitoring UI. The async child-process boundary preserves all existing mutation ordering.
  let stopping = false;
  let closedLearningTick: Promise<void> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let rolloverTimer: ReturnType<typeof setInterval> | undefined;
  let stopPromise: Promise<void> | undefined;

  const researchRefresh = new ResearchSnapshotRefresher({
    cloudStateDbPath: config.cloudStateDbPath,
    env,
    log: (line) => console.log(line),
  });

  const ensureOwnerBaselinePeriod = (): void => {
    if (!ownerBaselineStrategyEnabled(env) || periods.listOpenPeriods().length > 0 || periods.listRealizedPeriods().length > 0) return;
    const account = readCanonicalPaperAccount();
    if (account == null || !isOwnerBaselinePeriodStartAt(account.updatedAt)) return;
    const sourceCommitSha = env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "";
    if (!isOwnerBaselineSourceCommitSha(sourceCommitSha)) return;
    const market = config.upbitMarkets[0];
    if (market == null) return;
    const periodIndex = periods.nextPeriodIndex();
    const input = buildOwnerBaselinePaperPeriodInput({
      market,
      periodIndex,
      periodStartAt: account.updatedAt,
      sourceCommitSha,
    });
    periods.openPeriodFromCanonicalAccount(input);
  };

  // Rule-replay parity of the latest realized owner-baseline period (measurement only), computed once per closed period.
  let ruleReplayCache: { readonly recordId: string; readonly value: Parameters<ClosedLearningLoopStatusTracker["observeRuleReplay"]>[0] } | undefined;
  const latestBaselineRuleReplay = (realized: readonly PersistedPaperPeriodEnvelope[]): Parameters<ClosedLearningLoopStatusTracker["observeRuleReplay"]>[0] => {
    if (!ownerBaselineStrategyEnabled(env) || !isOwnerBaselineSourceCommitSha(shadowSourceCommit)) return undefined;
    const latest = [...realized]
      .filter((item) => item.candidateProvenance.length === 1 && item.candidateProvenance[0]!.candidateId === OWNER_BASELINE_CANDIDATE_ID && item.record.market != null)
      .sort((left, right) => right.record.periodIndex - left.record.periodIndex || right.record.periodEndAt - left.record.periodEndAt)[0];
    if (latest == null) return undefined;
    if (ruleReplayCache != null && ruleReplayCache.recordId === latest.record.recordId) return ruleReplayCache.value;
    const paperNetReturn = latest.record.realizedReturns[OWNER_BASELINE_CANDIDATE_ID];
    if (paperNetReturn === undefined) return undefined;
    const replay = replayPaperPeriodRule({
      spec: ownerBaselineStrategySpec(shadowSourceCommit), market: latest.record.market!, periodStartAt: latest.record.periodStartAt, periodEndAt: latest.record.periodEndAt,
      feeRate: 0.0005, readWindow: (market, startAt, endAt) => minuteObservationReader.readWindow(market, startAt, endAt),
    });
    const value = Object.freeze({ periodId: latest.record.recordId, ...replay, paperNetReturn });
    ruleReplayCache = { recordId: latest.record.recordId, value };
    return value;
  };

  const runClosedLearningTick = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (closedLearningTick != null) return closedLearningTick;
    // Durable cycle history is read first, so /health still shows the last lap while the bootstrap or rollover below is failing,
    // and withdrawn whole if the ledger cannot be read (never stale evidence presented as current).
    const refreshDurableCycles = (): void => {
      try { loopStatus.observeDurableCycles(cycleRepository.summary()); } catch { loopStatus.clearDurableCycles(); }
      try { loopStatus.observeDurableFailures(cycleRepository.failureSummary()); } catch { loopStatus.clearDurableFailures(); }
    };
    const task = (async () => {
      // A lost lease is terminal for this repository instance. Let the existing fail-closed
      // shutdown/supervisor recover it instead of treating every ledger read as a polling wait.
      paperRepository?.verifyWriterLease();
      refreshDurableCycles();
      const bootstrap = await runClosedLearningBootstrapAsync();
      loopStatus.observeBootstrap(bootstrap);
      // If Research has no deployable snapshot, preserve the canonical PAPER loop by opening one
      // truthful market-bound owner-baseline period. The period uses the same account boundary and
      // provenance as the executable baseline binding; it never fabricates fills or benchmark data.
      if (bootstrap.status === "WAITING_RESEARCH_SNAPSHOT" || bootstrap.status === "RESEARCH_NOT_DEPLOYABLE" || bootstrap.status === "WAITING_GOVERNANCE_APPROVAL") {
        if (bootstrap.status === "WAITING_RESEARCH_SNAPSHOT") researchRefresh.requestIfDue();
        ensureOwnerBaselinePeriod();
      }
      loopStatus.observeRollover(await runClosedLearningRolloverAsync(), Date.now());
      persistLastBlocked();
      try {
        const meta = buildMetaLearningStatus({
          // A finished pre-registered study written by the host Research service joins the reviewed ledger automatically.
          ledger: (() => { const study = readOrderBookStudyResult(config.cloudStateDbPath); return study == null || RESEARCH_LEDGER_SNAPSHOT.some((e) => e.id === study.id) ? RESEARCH_LEDGER_SNAPSHOT : [...RESEARCH_LEDGER_SNAPSHOT, study]; })(),
          runtimeTicksByInterval: researchExperiments?.experimentTicksByInterval() ?? null,
          researchMarkets: (env.NUSA_RESEARCH_MARKETS ?? "KRW-BTC").split(",").filter((m) => m.trim() !== "").length,
          ...(baselineShadow == null ? {} : { shadow: baselineShadow.summary() }),
          // Performance Evidence N -> Research N+1: realized canonical PAPER baseline periods feed meta-learning.
          paperPeriods: periods.listRealizedPeriods()
            .filter((item) => item.candidateProvenance.length === 1 && item.candidateProvenance[0]!.candidateId === OWNER_BASELINE_CANDIDATE_ID)
            .map((item) => ({ recordId: item.record.recordId, netReturn: item.record.realizedReturns[OWNER_BASELINE_CANDIDATE_ID] ?? Number.NaN, benchmarkReturn: item.record.benchmarkReturn, ...(item.record.canonicalOutcomeReceiptFingerprint == null ? {} : { outcomeFingerprint: item.record.canonicalOutcomeReceiptFingerprint }) })),
        });
        longBarTickEvery = meta.longBarTickEvery;
        loopStatus.observeMetaLearning(meta);
      } catch { longBarTickEvery = 1; loopStatus.observeMetaLearning(undefined); }
      if (baselineShadow != null) {
        loopStatus.observeShadow(baselineShadow.summary());
        const persistable = baselineShadow.takePersistable();
        if (persistable != null && !writeBaselineShadowRecord(config.cloudStateDbPath, persistable)) baselineShadow.markUnpersisted();
      }
      if (nullComparators != null) {
        loopStatus.observeNullComparators(nullComparators.summary());
        const persistableNulls = nullComparators.takePersistable();
        if (persistableNulls != null && !writeNullComparatorsRecord(config.cloudStateDbPath, persistableNulls)) nullComparators.markUnpersisted();
      }
      refreshDurableCycles();
      try { loopStatus.observePeriods(periods.listOpenPeriods()[0], periods.listRealizedPeriods(), pendingPeriods.dispositions()); } catch { /* display only */ }
      try { loopStatus.observeRuleReplay(latestBaselineRuleReplay(periods.listRealizedPeriods())); } catch { loopStatus.observeRuleReplay(undefined); }
    })().catch((error: unknown) => { loopStatus.observeError(Date.now(), tickErrorClass(error)); persistLastBlocked(); throw error; });
    closedLearningTick = task;
    task.then(
      () => { if (closedLearningTick === task) closedLearningTick = undefined; },
      () => { if (closedLearningTick === task) closedLearningTick = undefined; },
    );
    return task;
  };

  const handle: CloudRuntimeHandle = Object.freeze({
    ...baseHandle,
    stop: () => {
      if (stopPromise != null) return stopPromise;
      stopping = true;
      researchRefresh.stop();
      researchExperiments?.stop();
      if (initialTimer != null) clearTimeout(initialTimer);
      if (rolloverTimer != null) clearInterval(rolloverTimer);
      const pending = closedLearningTick;
      stopPromise = (async () => {
        if (pending != null) {
          try { await pending; } catch { /* fail-closed shutdown continues */ }
        }
        await baseHandle.stop();
      })();
      return stopPromise;
    },
  });

  const failClosedScheduler = (error: unknown): void => {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 500) : "CLOSED_LEARNING_SCHEDULER_FAILED";
    console.error(`[closed-learning] scheduler failed closed: ${detail}`);
    recordRuntimeFailure(config.cloudStateDbPath, "CLOSED_LEARNING_SCHEDULER", error);
    process.exitCode = 1;
    // The daemon owner uses the existing bounded controller; embedded callers own their process.
    if (requestFatalShutdown != null) requestFatalShutdown();
    else void handle.stop();
  };
  const scheduleTick = (): void => { void runClosedLearningTick().catch(failClosedScheduler); };

  // Recovery/bootstrap must not wait for a human or app launch. Defer the first async tick just
  // enough for the HTTP listener to become serviceable, then keep one serialized rollover poll.
  initialTimer = setTimeout(scheduleTick, 0);
  initialTimer.unref?.();
  rolloverTimer = setInterval(scheduleTick, CLOSED_LEARNING_ROLLOVER_POLL_INTERVAL_MS);
  rolloverTimer.unref?.();
  try { researchExperiments?.start(); }
  finally { researchExperiments?.finishPreparedRecovery(); }

  return Object.freeze({
    handle,
    challengerBindings,
    readCanonicalPaperAccount,
    runClosedLearningCycle,
    runClosedLearningCycleAsync,
    runClosedLearningBootstrap,
    runClosedLearningBootstrapAsync,
    runClosedLearningRollover,
    runClosedLearningRolloverAsync,
    readPaperPerformanceEvidence,
    evaluatePaperGovernanceFeedback,
  });
  } catch (error) {
    // Preparation begins before lease acquisition. Any synchronous startup failure must release
    // the native SQLite change trackers, including an active competing writer or runtime fault.
    researchExperiments?.finishPreparedRecovery();
    throw error;
  }
}

function main(): void {
  const stateDbPath = process.env.NUSA_CLOUD_STATE_DB_PATH;
  let shutdown!: ReturnType<typeof registerGracefulShutdown>;
  let schedulerFailed = false;
  let composition: ReturnType<typeof startClosedLearningProductionRuntime>;
  try {
    // Scheduler ticks are deferred until after this synchronous registration completes.
    composition = startClosedLearningProductionRuntime(process.env, () => {
      schedulerFailed = true;
      shutdown.trigger("CLOSED_LEARNING_SCHEDULER");
    });
  } catch (error) {
    // Start-up faults happen before the fatal handlers exist; record them so the loop is visible.
    if (stateDbPath !== undefined) recordRuntimeFailure(stateDbPath, "STARTUP", error);
    throw error;
  }
  shutdown = registerGracefulShutdown(composition.handle, (code) => process.exit(schedulerFailed ? 1 : code), stateDbPath);
}

if (require.main === module) main();
