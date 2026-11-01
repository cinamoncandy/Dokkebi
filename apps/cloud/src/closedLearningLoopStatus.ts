import type { PersistedPaperPendingDisposition } from "../../../packages/storage/src/persistedPaperPeriodStore";
import type { ClosedLearningInitialPaperBootstrapResult } from "./closedLearningInitialPaperBootstrap";
import type { ClosedLearningRolloverResult } from "./closedLearningRolloverScheduler";
import type { PersistedPaperPeriodEnvelope } from "../../../packages/contracts/src/persistedPaperPeriod";
import type { PersistedPaperRealizedPeriodPlan } from "./paperRealizedPeriodProducer";
import type { ClosedLearningCycleRecord } from "./closedLearningLoopCoordinator";
import type { ClosedLearningCycleFailureReceipt } from "./closedLearningEvolutionLedgerRepository";
import { tradingDayKey } from "../../../packages/contracts/src/risk-safety-integration";
import { OWNER_BASELINE_CANDIDATE_ID } from "./ownerBaselinePaperStrategy";
import type { NullComparatorSummary } from "./paperNullComparators";

/**
 * Display-only status of the production closed-learning loop (bootstrap -> PAPER period -> rollover -> Research
 * decision -> next PAPER deployment). It was only logged, so the step where Experience N -> Research N+1 stalls was
 * not observable. Steps are fixed codes and integers; `evidence` adds only canonical identifiers, fingerprints and
 * markets. No amounts, prices, returns or free text.
 */
export type ClosedLearningLoopStatus = {
  readonly lastTickAt: number;
  readonly ticks: number;
  readonly bootstrap: string;
  readonly rollover: string;
  readonly rolloverReason?: string;
  readonly currentBlockedReason?: string;
  /** Earliest KST boundary eligibility, not a promise of evaluation or a scheduler input. */
  readonly nextEvaluationEligibleAt?: number;
  readonly evaluationPeriodMs?: number;
  readonly cyclesEvaluated: number;
  readonly lastCycleStatus?: string;
  readonly lastCycleOutcome?: string;
  /**
   * The most recent BLOCKED/ERROR tick of THIS process, kept after later ticks succeed. A blocked cycle is retried or its period reopened
   * within one tick, so the reason used to be overwritten before anyone could read it. Fixed codes and one timestamp only.
   */
  readonly lastBlockedReason?: string;
  readonly lastBlockedAt?: number;
  /** Bounded class of the most recent TICK_ERROR of THIS process (never the message): a fixed code so a failed tick can be root-caused. */
  readonly lastErrorClass?: string;
  readonly deployments: number;
  /**
   * Correlation identities read from the canonical components (open PAPER period, latest realized period, latest
   * closed-learning cycle), so period -> fill -> realized outcome -> evidence -> Research decision -> next candidate
   * can be followed mechanically. Identifiers and fingerprints only; no amounts, prices, returns or free text.
   */
  readonly evidence?: ClosedLearningEvidenceCorrelation;
  /** Research meta-learning report (packages/contracts/src/researchMetaLearning.ts), including the tick steering it applies. */
  readonly metaLearning?: ClosedLearningMetaLearningStatus;
};

export type ClosedLearningMetaLearningStatus = Readonly<{
  experiments: number; configurations: number; discoveryPasses: number; holdoutPasses: number;
  /** Comma-separated dimension values, e.g. "dataType=CLOSE,methodClass=RULE"; empty when none. */
  overfitRatePercent?: number; validKnowledgePer100Configs: number; exhausted: string; recommended?: string;
  /** Comma-separated, e.g. "COLLECT_TRADES"; empty when the recommendation needs no collection. */
  recommendedPrerequisites: string; nextHoldoutBarMicros: number; runtimeEntries: number; liveForwardEntries: number;
  /** Runtime steering: longer-bar Research orchestrators tick every longBarTickEvery-th scheduled tick. */
  steeringMode: "NORMAL" | "DEPRIORITIZE_EXHAUSTED"; longBarTickEvery: number;
  /** Performance Evidence N consumed by meta-learning: realized canonical PAPER baseline periods and their identity. */
  paperPeriodsConsumed: number; paperNetBp?: number; paperExcessBp?: number; paperEvidenceFingerprint?: string;
}>;

export type ClosedLearningEvidenceCorrelation = Readonly<Partial<{
  openPeriodId: string; openMarket: string; openCandidateId: string; openPeriodStartAt: number; openObservations: number; openFilledObservations: number;
  realizedPeriods: number;
  ineligiblePeriods: number; latestIneligiblePeriodId: string; latestIneligibleFingerprint: string; latestIneligibleReason: string; latestIneligibleRuntimeSha: string;
  /** Realized owner-baseline periods: durable self-observations without Research lineage, never counted as learning cycles. */
  baselineObservations: number;
  realizedPeriodId: string; realizedPeriodEndAt: number; realizedOutcomeFingerprint: string; realizedCostEvidenceFingerprint: string;
  cycleId: string; cycleEvidenceId: string; cycleEvidenceFingerprint: string; decisionId: string; decisionReference: string; decisionCandidateId: string; deploymentId: string;
  /** Durable (survives restarts): how many cycles the ledger holds, and when the latest was recorded. */
  cyclesRecorded: number; lastCycleRecordedAt: number;
  /** The ledger's cycle count the first time THIS process read it: above 0 means records written by an earlier process were found after a restart. */
  cyclesRecordedAtBoot: number;
  failuresRecorded: number; latestFailureId: string; latestFailurePeriodId: string; latestFailureEvidenceId: string; latestFailureEvidenceFingerprint: string;
  latestFailureSourceCommitSha: string; latestFailureRuntimeSourceCommitSha: string; latestFailureStage: string; latestFailureCode: string; latestFailureRecordedAt: number;
  /**
   * Baseline SHADOW totals (hypothetical round trips of the baseline rule, whether or not Risk allowed a real order). Non-negative
   * integers in basis points and counts only; NOT PAPER evidence and never a promotion input (see paperBaselineShadow.ts).
   */
  /**
   * Parity check of the latest realized owner-baseline period: the period's realized PAPER return (account equity, after sizing,
   * Risk and fees) next to a replay of the same rule on the same completed minute closes (one full hypothetical position). Signed
   * basis points and counts; measurement only, never a Risk, qualification or Research input.
   */
  replayPeriodId: string; replayBars: number; replayTrades: number; replayClosedNetBp: number; replayOpenMarkBp: number; replayPaperNetBp: number;
  shadowSince: number; shadowTrades: number; shadowWins: number; shadowGrossGainBp: number; shadowGrossLossBp: number; shadowFeeBp: number;
  /**
   * Null comparators of the baseline shadow (buy-and-hold and fixed-seed random entry, same bars and fee model). Counts and signed basis
   * points only; a comparison, NOT PAPER evidence and never a promotion input (see paperNullComparators.ts).
   */
  nullSince: number; nullSeed: number; nullBaseTrades: number; nullBaseNetBp: number; nullHoldMarkets: number; nullHoldNetBp: number;
  nullRandTrades: number; nullRandWins: number; nullRandNetBp: number; nullRandSkipped: number;
}>>;

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const code = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const head = value.split(":")[0]!;
  return CODE.test(head) ? head : undefined;
};

export class ClosedLearningLoopStatusTracker {
  public constructor(private readonly evaluationPeriodMs?: number) {
    if (evaluationPeriodMs !== undefined && ![3_600_000, 86_400_000].includes(evaluationPeriodMs)) throw new Error("CLOSED_LEARNING_EVALUATION_PERIOD_INVALID");
  }
  private status: ClosedLearningLoopStatus | null = null;
  private bootstrap = "NOT_RUN";
  private periods: ClosedLearningEvidenceCorrelation = {};
  private cycle: ClosedLearningEvidenceCorrelation = {};
  private durable: { cyclesRecorded: number; lastCycleRecordedAt?: number } | null = null;
  private durableAtBoot: number | undefined;
  /** Set by the first ledger read (or failure) in this process, so a later read can never be mistaken for the boot read. */
  private bootReadDone = false;
  private durableOutcome: string | undefined;
  /** The outcome of a cycle evaluated by THIS process (wins over the durable copy). */
  private processCycleOutcome: string | undefined;
  private lastBlocked: { reason: string; at: number } | undefined;
  private lastErrorClass: string | undefined;
  private durableCycleIdentity: ClosedLearningEvidenceCorrelation = {};
  private durableFailure: ClosedLearningEvidenceCorrelation = {};
  private shadow: ClosedLearningEvidenceCorrelation = {};
  private nulls: ClosedLearningEvidenceCorrelation = {};
  private replay: ClosedLearningEvidenceCorrelation = {};
  private metaLearning: ClosedLearningMetaLearningStatus | undefined;

  /** Reads the identities of the current open period and the latest realized period. */
  public observePeriods(open: PersistedPaperRealizedPeriodPlan | undefined, realized: readonly PersistedPaperPeriodEnvelope[], dispositions?: readonly PersistedPaperPendingDisposition[]): void {
    const latest = [...realized].sort((left, right) => right.record.periodIndex - left.record.periodIndex || right.record.periodEndAt - left.record.periodEndAt)[0];
    const terminal = dispositions == null ? undefined : [...dispositions].sort((a, b) => b.original.periodIndex - a.original.periodIndex)[0];
    this.periods = Object.freeze({
      ...(dispositions == null ? {} : { ineligiblePeriods: dispositions.length }),
      ...(terminal == null ? {} : { latestIneligiblePeriodId: terminal.original.periodId, latestIneligibleFingerprint: terminal.evidenceFingerprintSha256, latestIneligibleReason: terminal.reason.code, ...(terminal.reason.sourceRuntimeSha == null ? {} : { latestIneligibleRuntimeSha: terminal.reason.sourceRuntimeSha }) }),
      ...(open == null ? {} : {
        openPeriodId: open.periodId,
        ...(open.market == null ? {} : { openMarket: open.market }),
        ...(open.candidateProvenance[0] == null ? {} : { openCandidateId: open.candidateProvenance[0].candidateId }),
        openPeriodStartAt: open.periodStartAt,
        openObservations: open.observations.length,
        openFilledObservations: open.observations.filter((item) => item.status === "FILLED").length,
      }),
      realizedPeriods: realized.length,
      baselineObservations: realized.filter((item) => item.candidateProvenance?.length === 1 && item.candidateProvenance[0]?.candidateId === OWNER_BASELINE_CANDIDATE_ID).length,
      ...(latest == null ? {} : {
        realizedPeriodId: latest.record.recordId,
        realizedPeriodEndAt: latest.record.periodEndAt,
        ...(latest.record.canonicalOutcomeReceiptFingerprint == null ? {} : { realizedOutcomeFingerprint: latest.record.canonicalOutcomeReceiptFingerprint }),
        realizedCostEvidenceFingerprint: latest.record.costEvidence.evidenceFingerprintSha256,
      }),
    });
    this.publish();
  }

  /**
   * Seeds the cycle identities from the durable ledger so a restart does not erase the evidence of the last lap. The counters
   * (cyclesEvaluated, lastCycle*) stay per process; what a cycle in this process observed always wins over the durable copy.
   */
  public observeDurableCycles(summary: { readonly cyclesRecorded: number; readonly latest?: ClosedLearningCycleRecord }): void {
    if (!this.bootReadDone) {
      this.bootReadDone = true;
      if (Number.isSafeInteger(summary.cyclesRecorded) && summary.cyclesRecorded >= 0) this.durableAtBoot = summary.cyclesRecorded;
    }
    this.durable = Object.freeze({ cyclesRecorded: summary.cyclesRecorded, ...(summary.latest == null ? {} : { lastCycleRecordedAt: summary.latest.recordedAt }) });
    const latest = summary.latest;
    this.durableOutcome = code(latest?.decision?.outcome);
    this.durableCycleIdentity = latest == null ? {} : Object.freeze(Object.fromEntries(Object.entries({
      cycleId: latest.cycleId,
      cycleEvidenceId: latest.evidenceId,
      cycleEvidenceFingerprint: latest.evidenceFingerprintSha256,
      decisionId: latest.decision?.decisionId,
      decisionReference: latest.decision?.decisionReference,
      decisionCandidateId: latest.decision?.candidateId,
      deploymentId: latest.paperDeployment?.deploymentId,
    }).filter(([, value]) => typeof value === "string" && value.length > 0)));
    this.publish();
  }

  /** Advisory meta-learning report; undefined withdraws it. */
  public observeMetaLearning(report: ClosedLearningMetaLearningStatus | undefined): void {
    this.metaLearning = report;
    this.publish();
  }

  /** Display-only rule-replay parity of one realized baseline period; undefined or malformed withdraws the keys. */
  public observeRuleReplay(replay: { readonly periodId: string; readonly bars: number; readonly trades: number; readonly closedNetReturn: number; readonly openMarkReturn: number; readonly paperNetReturn: number } | undefined): void {
    const bp = (value: number) => Math.round(value * 10_000);
    const ok = replay != null && typeof replay.periodId === "string" && replay.periodId.length > 0
      && [replay.bars, replay.trades].every((value) => Number.isSafeInteger(value) && value >= 0)
      && [replay.closedNetReturn, replay.openMarkReturn, replay.paperNetReturn].every((value) => Number.isFinite(value) && Math.abs(value) < 100);
    this.replay = !ok || replay == null ? {} : Object.freeze({
      replayPeriodId: replay.periodId, replayBars: replay.bars, replayTrades: replay.trades,
      replayClosedNetBp: bp(replay.closedNetReturn), replayOpenMarkBp: bp(replay.openMarkReturn), replayPaperNetBp: bp(replay.paperNetReturn),
    });
    this.publish();
  }

  /** Display-only baseline shadow totals; a malformed value withdraws the shadow keys. */
  public observeShadow(totals: { readonly since: number; readonly trades: number; readonly wins: number; readonly grossGainBp: number; readonly grossLossBp: number; readonly feeBp: number } | undefined): void {
    const ok = totals != null && [totals.since, totals.trades, totals.wins, totals.grossGainBp, totals.grossLossBp, totals.feeBp].every((value) => Number.isSafeInteger(value) && value >= 0) && totals.wins <= totals.trades;
    this.shadow = !ok || totals == null || totals.since === 0 ? {} : Object.freeze({ shadowSince: totals.since, shadowTrades: totals.trades, shadowWins: totals.wins, shadowGrossGainBp: totals.grossGainBp, shadowGrossLossBp: totals.grossLossBp, shadowFeeBp: totals.feeBp });
    this.publish();
  }

  /** Display-only null comparator figures; a malformed value withdraws the null keys. Absent optional fields stay absent (never zero). */
  public observeNullComparators(summary: NullComparatorSummary | undefined): void {
    const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    const signed = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(Number(value)) <= 10_000_000;
    const ok = summary != null && count(summary.since) && summary.since > 0 && count(summary.seed)
      && count(summary.randomTrades) && count(summary.randomWins) && summary.randomWins <= summary.randomTrades && signed(summary.randomNetBp) && count(summary.randomSkipped)
      && (summary.baselineTrades === undefined) === (summary.baselineNetBp === undefined) && (summary.baselineTrades === undefined || (count(summary.baselineTrades) && signed(summary.baselineNetBp)))
      && (summary.holdMarkets === undefined) === (summary.holdNetBp === undefined) && (summary.holdMarkets === undefined || (count(summary.holdMarkets) && summary.holdMarkets > 0 && signed(summary.holdNetBp)));
    this.nulls = !ok || summary == null ? {} : Object.freeze({
      nullSince: summary.since, nullSeed: summary.seed,
      ...(summary.baselineTrades === undefined || summary.baselineNetBp === undefined ? {} : { nullBaseTrades: summary.baselineTrades, nullBaseNetBp: summary.baselineNetBp }),
      ...(summary.holdMarkets === undefined || summary.holdNetBp === undefined ? {} : { nullHoldMarkets: summary.holdMarkets, nullHoldNetBp: summary.holdNetBp }),
      nullRandTrades: summary.randomTrades, nullRandWins: summary.randomWins, nullRandNetBp: summary.randomNetBp, nullRandSkipped: summary.randomSkipped,
    });
    this.publish();
  }

  /** The durable ledger could not be read: withdraw everything published from it, so /health never presents stale durable evidence as current. */
  public clearDurableCycles(): void {
    this.durable = null;
    this.durableAtBoot = undefined;
    this.bootReadDone = true;
    this.durableOutcome = undefined;
    this.durableCycleIdentity = {};
    this.publish();
  }

  public observeDurableFailures(summary: { readonly failuresRecorded: number; readonly latest?: ClosedLearningCycleFailureReceipt }): void {
    const latest = summary.latest;
    this.durableFailure = Object.freeze({ failuresRecorded: summary.failuresRecorded, ...(latest == null ? {} : {
      latestFailureId: latest.failureId, latestFailurePeriodId: latest.closedPeriodId, latestFailureEvidenceId: latest.evidenceId,
      latestFailureEvidenceFingerprint: latest.evidenceFingerprintSha256, latestFailureSourceCommitSha: latest.sourceCommitSha,
      latestFailureRuntimeSourceCommitSha: latest.runtimeSourceCommitSha, latestFailureStage: latest.stage,
      latestFailureCode: latest.code, latestFailureRecordedAt: latest.recordedAt,
    }) });
    this.publish();
  }

  public clearDurableFailures(): void { this.durableFailure = {}; this.publish(); }

  private publish(): void {
    if (this.status == null) return;
    const evidence = Object.freeze({
      ...this.durableCycleIdentity,
      ...this.durableFailure,
      ...(this.durableAtBoot === undefined ? {} : { cyclesRecordedAtBoot: this.durableAtBoot }),
      ...(this.durable == null ? {} : { cyclesRecorded: this.durable.cyclesRecorded, ...(this.durable.lastCycleRecordedAt === undefined || !Number.isSafeInteger(this.durable.lastCycleRecordedAt) ? {} : { lastCycleRecordedAt: this.durable.lastCycleRecordedAt }) }),
      ...this.periods,
      ...this.cycle,
      ...this.shadow,
      ...this.nulls,
      ...this.replay,
    });
    // lastCycleOutcome and evidence are always rebuilt here from their sources (this process first, then the durable copy), never carried
    // over from the previous status, so withdrawing the durable copy really withdraws what was published from it.
    const { evidence: _previousEvidence, metaLearning: _previousMeta, lastCycleOutcome: _previousOutcome, lastBlockedReason: _previousReason, lastBlockedAt: _previousAt, lastErrorClass: _previousErrorClass, currentBlockedReason: _previousCurrent, nextEvaluationEligibleAt: _previousEligibility, ...rest } = this.status;
    let eligibleAt: number | undefined;
    const start = this.periods.openPeriodStartAt;
    if (["WAITING_FOR_KST_DAY_ROLLOVER", "WAITING_FOR_EVALUATION_WINDOW"].includes(rest.rollover) && start !== undefined && Number.isSafeInteger(start) && start >= 0 && start <= rest.lastTickAt && start <= 8_640_000_000_000_000) {
      const dayBoundary = Date.parse(`${tradingDayKey(start)}T15:00:00.000Z`);
      const boundary = this.evaluationPeriodMs === undefined ? dayBoundary : Math.min(dayBoundary, start + this.evaluationPeriodMs);
      if (Number.isSafeInteger(boundary) && boundary > rest.lastTickAt) eligibleAt = boundary;
    }
    const processOutcome = this.processCycleOutcome;
    const outcome = processOutcome ?? this.durableOutcome;
    this.status = Object.freeze({
      ...rest,
      ...(this.evaluationPeriodMs === undefined ? {} : { evaluationPeriodMs: this.evaluationPeriodMs }),
      ...(rest.rollover === "BLOCKED" || rest.rollover === "ERROR" ? { currentBlockedReason: rest.rollover === "ERROR" ? "TICK_ERROR" : rest.rolloverReason ?? "BLOCKED_WITHOUT_CODE" } : {}),
      ...(eligibleAt === undefined ? {} : { nextEvaluationEligibleAt: eligibleAt }),
      ...(outcome === undefined ? {} : { lastCycleOutcome: outcome }),
      ...(this.lastBlocked === undefined ? {} : { lastBlockedReason: this.lastBlocked.reason, lastBlockedAt: this.lastBlocked.at }),
      ...(this.lastErrorClass === undefined ? {} : { lastErrorClass: this.lastErrorClass }),
      ...(Object.keys(evidence).length === 0 ? {} : { evidence }),
      ...(this.metaLearning === undefined ? {} : { metaLearning: this.metaLearning }),
    }) as ClosedLearningLoopStatus;
  }

  public observeBootstrap(result: Pick<ClosedLearningInitialPaperBootstrapResult, "status">): void {
    this.bootstrap = code(result.status) ?? "UNKNOWN";
  }

  public observeRollover(result: Pick<ClosedLearningRolloverResult, "status" | "reason" | "cycle">, now: number): void {
    const previous = this.status;
    const evaluated = result.status === "CLOSED_AND_EVALUATED";
    const cycleStatus = code(result.cycle?.status);
    const cycleOutcome = code(result.cycle?.record?.decision?.outcome);
    if (cycleOutcome !== undefined) this.processCycleOutcome = cycleOutcome;
    if (result.status === "BLOCKED") { this.lastBlocked = { reason: code(result.reason) ?? "BLOCKED_WITHOUT_CODE", at: now }; this.lastErrorClass = undefined; }
    const deployed = evaluated && (result.cycle?.status === "EXECUTED" || result.cycle?.status === "RESUMED") && result.cycle.record.paperDeployment != null;
    const reason = code(result.reason);
    this.status = Object.freeze({
      lastTickAt: now,
      ticks: (previous?.ticks ?? 0) + 1,
      bootstrap: this.bootstrap,
      rollover: code(result.status) ?? "UNKNOWN",
      ...(reason === undefined ? {} : { rolloverReason: reason }),
      cyclesEvaluated: (previous?.cyclesEvaluated ?? 0) + (evaluated ? 1 : 0),
      ...(cycleStatus === undefined ? (previous?.lastCycleStatus === undefined ? {} : { lastCycleStatus: previous.lastCycleStatus }) : { lastCycleStatus: cycleStatus }),
      deployments: (previous?.deployments ?? 0) + (deployed ? 1 : 0),
    });
    const record = result.cycle?.record;
    if (record != null) {
      const entries = Object.entries({
        cycleId: record.cycleId,
        cycleEvidenceId: record.evidenceId,
        cycleEvidenceFingerprint: record.evidenceFingerprintSha256,
        decisionId: record.decision?.decisionId,
        decisionReference: record.decision?.decisionReference,
        decisionCandidateId: record.decision?.candidateId,
        deploymentId: record.paperDeployment?.deploymentId,
      }).filter(([, value]) => typeof value === "string" && value.length > 0);
      this.cycle = Object.freeze(Object.fromEntries(entries));
    }
    this.publish();
  }

  /**
   * Seeds the last BLOCKED/ERROR reason from the restart-surviving record. A reason observed by THIS process always wins, so the
   * seed only fills the gap after a restart; its own timestamp shows readers that it is older than this process.
   */
  public seedLastBlocked(record: { readonly reason: string; readonly at: number } | undefined): void {
    if (record == null || this.lastBlocked !== undefined || !CODE.test(record.reason) || !Number.isSafeInteger(record.at) || record.at < 0) return;
    this.lastBlocked = { reason: record.reason, at: record.at };
    this.lastErrorClass = undefined;
    this.publish();
  }

  /** The most recent BLOCKED/ERROR reason, for persistence by the runtime. */
  public lastBlockedRecord(): { readonly reason: string; readonly at: number } | undefined {
    return this.lastBlocked === undefined ? undefined : { reason: this.lastBlocked.reason, at: this.lastBlocked.at };
  }

  /** A tick that threw before a rollover result: recorded as ERROR without changing the counts. */
  public observeError(now: number, errorClass?: string): void {
    this.lastBlocked = { reason: "TICK_ERROR", at: now };
    this.lastErrorClass = errorClass !== undefined && CODE.test(errorClass) ? errorClass : undefined;
    const previous = this.status;
    this.status = Object.freeze({ ...(previous ?? { cyclesEvaluated: 0, deployments: 0 }), lastTickAt: now, ticks: (previous?.ticks ?? 0) + 1, bootstrap: this.bootstrap, rollover: "ERROR" }) as ClosedLearningLoopStatus;
    this.publish();
  }

  public snapshot(): ClosedLearningLoopStatus | null {
    return this.status;
  }
}

/**
 * Bounded, message-free class of a thrown value. It can never throw (a hostile getter or Proxy yields UNKNOWN_ERROR) and a custom
 * `code` is accepted only in the ERR_/E<UPPER> convention of Node and errno codes, so an arbitrary string is never published.
 */
export function tickErrorClass(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "UNKNOWN_ERROR";
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === "string" ? rawCode.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase().slice(0, 64) : "";
    if (/^(ERR_[A-Z0-9_]{1,56}|E[A-Z0-9]{2,20})$/.test(code)) return code;
    const name = typeof error.name === "string" ? error.name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase().slice(0, 64) : "";
    return CODE.test(name) ? name : "UNKNOWN_ERROR";
  } catch { return "UNKNOWN_ERROR"; }
}
