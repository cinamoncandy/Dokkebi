import type { ResearchRecoveryResult } from "../../../packages/contracts/src/researchRecovery";
import type { ResearchSessionRecord, ResearchStatusProjection } from "../../../packages/contracts/src/researchAutomation";
import type { ResearchComparisonEvidence, ResearchInputSnapshot } from "../../../packages/contracts/src/researchRuntime";
import type { GeneratedStrategy } from "../../../packages/core/src/optimizer/aiStrategyEngine";
import type { ResearchCandleSource } from "./backtestResearchEvaluator";
import { countRepeatedFailures, countResearchFailures, summarizeStrategyFailureHistory } from "./researchFailureMemory";
import { MAX_DAILY_RESEARCH_EXPERIMENTS, planResearchSession, researchSessionIdFor } from "./researchSessionPlanner";
import { runResearchExperiment, runRollingResearchExperiment, type ExperimentOutcome, type ExperimentRunnerPorts, type ExperimentSpec } from "./researchExperimentRunner";
import { ROLLING_FOLDS, type WalkForwardWindowConfig } from "./researchWalkForwardWindows";
import type { ResearchSessionStartInput } from "./researchAutomationRuntime";
import type { ResearchPrecommit } from "../../../packages/contracts/src/researchPrecommit";

/**
 * Drives the continuous research experiments one `tick` at a time. It owns no timer and no storage: the
 * composition root schedules `tick`, and everything else arrives through ports. It never trades, never changes a
 * risk or capital setting and never promotes anything; candidate registration stays inside the existing
 * automation runtime and candidate gate. It also satisfies the cloud runtime's research-automation interface
 * (recover / onMarketData / statusProjection) so the app's LEARNING line can show real state; per-tick market
 * data is deliberately ignored because experiments run on closed-candle windows (design D1).
 */
export interface VariantRuntime {
  startSession(input: ResearchSessionStartInput): ResearchSessionRecord;
  runExperiment(input: ResearchInputSnapshot): ResearchComparisonEvidence;
  resume(sessionId: string): ResearchSessionRecord;
  stop(sessionId: string): ResearchSessionRecord;
  recover(): ResearchRecoveryResult;
  status(sessionId: string): ResearchStatusProjection;
}

export interface ResearchVariant {
  /** lowercase letters, digits and underscore; used in the session id */
  readonly variantId: string;
  readonly champion: { readonly strategy: GeneratedStrategy; readonly config: unknown };
  readonly challenger: { readonly strategy: GeneratedStrategy; readonly config: unknown };
  readonly runtime: VariantRuntime;
  /** Experiment family for this variant's strategy family; defaults to the orchestrator's prefix (the original SMA identities). */
  readonly experimentFamilyPrefix?: string;
}

export interface OrchestratorOptions {
  readonly variants: readonly ResearchVariant[];
  readonly sessions: { list(): readonly ResearchSessionRecord[]; load(sessionId: string): ResearchSessionRecord | undefined };
  readonly markets: readonly string[];
  readonly intervalMs: number;
  readonly windows: WalkForwardWindowConfig;
  readonly dailyBudgetPerVariant: number;
  /** Pull ticks into closed candles; must not throw for ordinary data problems. */
  readonly collect: (nowMs: number) => void;
  readonly candles: ResearchCandleSource & { latestCloseTime(market: string, intervalMs: number): number | undefined; earliestCloseTime?(market: string, intervalMs: number): number | undefined; count?(market: string, intervalMs: number): number };
  readonly holdout: ExperimentRunnerPorts["holdout"];
  readonly now: () => number;
  readonly sourceCommitSha: string;
  readonly models: ExperimentSpec["models"];
  readonly evaluator: ExperimentSpec["evaluator"];
  readonly featurePipeline: ExperimentSpec["featurePipeline"];
  readonly experimentFamilyPrefix: string;
  /** Validation-role evaluation records of this orchestrator's bar length, read from the durable Research ledger (display only). */
  readonly failureEvidence?: () => readonly ResearchComparisonEvidence[];
  readonly precommitStore?: { create(precommit: ResearchPrecommit): ResearchPrecommit };
  readonly datasetManifest?: ExperimentRunnerPorts["datasetManifest"];
  readonly datasetIdForMarket?: (market: string) => string;
  /** K-of-N rolling holdout in SHADOW mode only (see docs/DESIGN_ROLLING_HOLDOUT_WIRING.md). Absent or OFF: nothing runs. */
  readonly rollingHoldout?: { readonly mode: "OFF" | "SHADOW" };
}

export interface ResearchExperimentTickSummary {
  readonly lastTickAt: number;
  readonly lastStatus: TickReport["status"];
  readonly ticks: number;
  readonly sessionsStarted: number;
  readonly counts: Readonly<Record<string, number>>;
}

export interface ResearchCollectionProgress {
  readonly market: string;
  readonly candleCount: number;
  readonly requiredCandles: number;
  readonly firstCloseMs?: number;
  readonly lastCloseMs?: number;
  readonly observedAt: number;
}

export interface TickReport {
  readonly status: "OK" | "RECOVERY_NOT_READY" | "ERROR";
  readonly started: number;
  readonly resumed: number;
  readonly stopped: number;
  readonly experiments: readonly { readonly variantId: string; readonly market: string; readonly outcome: ExperimentOutcome | { readonly status: "NOT_DUE" } }[];
}

const empty = (status: TickReport["status"]): TickReport => Object.freeze({ status, started: 0, resumed: 0, stopped: 0, experiments: Object.freeze([]) });
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Suffix of the research session that carries rolling-holdout checks, so its records can be told apart from the real experiments. */
export const ROLLING_SESSION_SUFFIX = "_rolling";
/** The rolling session never limits the real flow: each check runs up to 2 x folds experiments, and a candidate is checked once per day. */
const ROLLING_BUDGET_FACTOR = 2 * ROLLING_FOLDS;

/** Display only: fixed codes and integers; it is kept separate from `counts`, whose 40 published keys are full. */
export interface RollingHoldoutSummary {
  readonly mode: "SHADOW";
  readonly candidatesChecked: number;
  readonly pass: number;
  readonly fail: number;
  readonly insufficientEvidence: number;
  readonly errors: number;
  readonly refused: Readonly<Record<string, number>>;
  readonly folds: Readonly<{ challengerBetter: number; notBetter: number; insufficient: number }>;
  readonly lastCheckedAt?: number;
}

/** True for evaluation records written by a rolling check; the real experiments' failure counters never include them. */
export const isRollingRecord = (record: ResearchComparisonEvidence): boolean => typeof record.provenance?.sessionId === "string" && record.provenance.sessionId.endsWith(ROLLING_SESSION_SUFFIX);

/** Upper bound on challenger variants per bar length (SMA 4 + RSI 3 + Donchian 3 today); each runs at most its daily budget of experiments. */
export const MAX_VARIANTS = 12;

const isDerivedCountKey = (key: string): boolean => key.startsWith("FAIL_") || key.startsWith("REPEAT_");

/** /health publishes at most 40 count keys. Ordinary outcome keys stop at 30 so the derived FAIL_* (5 reasons) and REPEAT_* (5 reasons) always fit. */
export const MAX_ORDINARY_COUNT_KEYS = 30;

export function addOutcomeCount(counts: Record<string, number>, key: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,47}$/.test(key) || isDerivedCountKey(key)) return;
  if (!(key in counts) && Object.keys(counts).filter((existing) => !isDerivedCountKey(existing)).length >= MAX_ORDINARY_COUNT_KEYS) return;
  counts[key] = (counts[key] ?? 0) + 1;
}

const GAP_FILL_CODE = /^[A-Z][A-Z0-9_]{1,47}$/;

/** Wall-clock milliseconds of one hourly gap-fill run's three parts (integers; the read and the manifest build are synchronous on the event loop). */
export interface GapFillTimingsMs { readonly fillMs: number; readonly readMs: number; readonly materializeMs: number }
export interface GapFillTimingsSummaryMs {
  readonly lastFillMs: number; readonly lastReadMs: number; readonly lastMaterializeMs: number;
  readonly maxFillMs: number; readonly maxReadMs: number; readonly maxMaterializeMs: number;
}

export interface ResearchGapFillSummary {
  readonly lastRunAt?: number;
  readonly runs: number;
  readonly deferred: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly lastErrorCode?: string;
  /** Display only: how long the last hourly run spent in each part, and the largest seen since start, to find what blocks the event loop. */
  readonly timingsMs?: GapFillTimingsSummaryMs;
}

export class ResearchExperimentOrchestrator {
  private recoveryReady = false;

  public constructor(private readonly options: OrchestratorOptions) {
    if (options.variants.length === 0 || options.variants.length > MAX_VARIANTS) throw new Error(`research orchestrator needs 1 to ${MAX_VARIANTS} variants`);
    if (new Set(options.variants.map((v) => v.variantId)).size !== options.variants.length) throw new Error("research variant ids must be unique");
    if (options.markets.length === 0 || options.markets.length > 20) throw new Error("research orchestrator needs 1 to 20 markets");
    if (!Number.isSafeInteger(options.dailyBudgetPerVariant) || options.dailyBudgetPerVariant < 1) throw new Error("daily research budget is invalid");
  }

  /** CloudRuntimeResearchAutomationLike.recover: ready only when every variant runtime recovers READY. */
  public recover(): ResearchRecoveryResult {
    let last: ResearchRecoveryResult | undefined;
    this.recoveryReady = true;
    for (const variant of this.options.variants) {
      const result = variant.runtime.recover();
      last = result;
      if (result.status !== "READY") { this.recoveryReady = false; return result; }
    }
    return last as ResearchRecoveryResult;
  }

  /** Experiments run on closed-candle windows (design D1); ticks are intentionally ignored. */
  public onMarketData(): void { /* no-op by design */ }

  /** Display only: how much candle history exists for the first research market versus what the first experiment needs. */
  public collectionProgress(): ResearchCollectionProgress | null {
    const market = this.options.markets[0];
    const count = this.options.candles.count;
    if (market == null || count == null) return null;
    const nowMs = this.options.now();
    if (this.progressCache != null && nowMs - this.progressCache.at < 30_000) return this.progressCache.value;
    let value: ResearchCollectionProgress | null = null;
    try {
      const w = this.options.windows;
      const first = this.options.candles.earliestCloseTime?.(market, this.options.intervalMs);
      const last = this.options.candles.latestCloseTime(market, this.options.intervalMs);
      value = Object.freeze({
        market,
        candleCount: count.call(this.options.candles, market, this.options.intervalMs),
        requiredCandles: Math.ceil((w.trainMs + w.validationMs + w.holdoutMs) / this.options.intervalMs),
        ...(first === undefined ? {} : { firstCloseMs: first }),
        ...(last === undefined ? {} : { lastCloseMs: last }),
        observedAt: nowMs,
      });
    } catch { value = null; }
    this.progressCache = { at: nowMs, value };
    return value;
  }

  private progressCache: { readonly at: number; readonly value: ResearchCollectionProgress | null } | undefined;

  public statusProjection(): ResearchStatusProjection | null {
    const nowMs = this.options.now();
    let best: ResearchStatusProjection | null = null;
    for (const variant of this.options.variants) {
      const id = researchSessionIdFor(nowMs, variant.variantId);
      if (this.options.sessions.load(id) == null) continue;
      try {
        const status = variant.runtime.status(id);
        if (best == null || status.experimentCount > best.experimentCount) best = status;
      } catch { /* a broken session must not hide the others */ }
    }
    return best;
  }

  /**
   * Display only: cumulative experiment outcome counts since this process started, plus the latest tick's status,
   * keyed by fixed codes (outcome status, validation/holdout comparison result, SKIPPED/ERROR reason code). Integers only.
   */
  public experimentTicks(): ResearchExperimentTickSummary | null {
    return this.tickSummary;
  }

  private tickSummary: ResearchExperimentTickSummary | null = null;

  private gapFillSummary: ResearchGapFillSummary | null = null;

  private rollingState = { checked: 0, pass: 0, fail: 0, insufficient: 0, errors: 0, refused: {} as Record<string, number>, folds: { challengerBetter: 0, notBetter: 0, insufficient: 0 }, lastCheckedAt: undefined as number | undefined };

  /** Display only: the SHADOW rolling-holdout summary since this process started, or null when the mode is not SHADOW. */
  public rollingHoldout(): RollingHoldoutSummary | null {
    if (this.options.rollingHoldout?.mode !== "SHADOW") return null;
    const r = this.rollingState;
    return Object.freeze({
      mode: "SHADOW" as const, candidatesChecked: r.checked, pass: r.pass, fail: r.fail, insufficientEvidence: r.insufficient, errors: r.errors,
      refused: Object.freeze({ ...r.refused }), folds: Object.freeze({ ...r.folds }), ...(r.lastCheckedAt === undefined ? {} : { lastCheckedAt: r.lastCheckedAt }),
    });
  }

  private rollingRefused(reason: string): void {
    const code = reason.replace(/[^A-Z0-9_]/g, "_").slice(0, 47);
    if (!/^[A-Z][A-Z0-9_]{1,47}$/.test(code)) return;
    if (!(code in this.rollingState.refused) && Object.keys(this.rollingState.refused).length >= 12) return;
    this.rollingState.refused[code] = (this.rollingState.refused[code] ?? 0) + 1;
  }

  /**
   * SHADOW only: after the real experiment found validation favourable, check the same challenger on the K-of-N folds in its own
   * `<variant>_rolling` session. Nothing here feeds the real counters, the holdout counters, the meta-learning input or any candidate
   * registration; every failure is swallowed and counted. The real flow has already finished when this runs.
   */
  private shadowRolling(variant: ResearchVariant, outcome: ExperimentOutcome, nowMs: number, spec: ExperimentSpec): void {
    if (this.options.rollingHoldout?.mode !== "SHADOW") return;
    if (outcome.status !== "COMPLETED" || outcome.validation.result !== "CHALLENGER_BETTER") return;
    try {
      const rollingVariantId = `${variant.variantId}${ROLLING_SESSION_SUFFIX}`;
      const rollingSessionId = researchSessionIdFor(nowMs, rollingVariantId);
      let session = this.options.sessions.load(rollingSessionId);
      if (session == null) {
        const dailyBudget = Math.min(this.options.dailyBudgetPerVariant * ROLLING_BUDGET_FACTOR, MAX_DAILY_RESEARCH_EXPERIMENTS);
        let plan = planResearchSession({ nowMs, sessions: this.options.sessions.list(), dailyBudget, recoveryReady: this.recoveryReady, variantId: rollingVariantId });
        // Like the real flow: an earlier day's rolling session of this variant is stopped, or it would block every later day.
        if (plan.action === "NONE" && plan.reason === "PREVIOUS_SESSION_STILL_RUNNING") {
          for (const old of this.options.sessions.list().filter((item) => item.state === "RUNNING" && item.sessionId.endsWith(`-${rollingVariantId}`) && item.sessionId !== rollingSessionId)) variant.runtime.stop(old.sessionId);
          plan = planResearchSession({ nowMs, sessions: this.options.sessions.list(), dailyBudget, recoveryReady: this.recoveryReady, variantId: rollingVariantId });
        }
        if (plan.action !== "START") { this.rollingRefused(`PLAN_${plan.reason}`); return; }
        variant.runtime.startSession({
          sessionId: plan.sessionId,
          datasetId: `upbit-1m-closed:${this.options.markets.join(",")}:${this.options.intervalMs}`,
          interval: `${this.options.intervalMs / 60_000}m`,
          championStrategyId: variant.champion.strategy.strategyId,
          championStrategyVersion: variant.champion.strategy.version,
          challengerStrategyId: variant.challenger.strategy.strategyId,
          challengerStrategyVersion: variant.challenger.strategy.version,
          deterministicConfig: { windows: this.options.windows, markets: this.options.markets, challenger: variant.challenger.config, champion: variant.champion.config, rolling: true },
          maxExperiments: plan.maxExperiments,
        });
        session = this.options.sessions.load(rollingSessionId);
      }
      if (session?.state === "PAUSED") session = variant.runtime.resume(rollingSessionId);
      if (session == null || session.state !== "RUNNING") { this.rollingRefused("SESSION_NOT_RUNNING"); return; }
      const result = runRollingResearchExperiment(this.portsFor(variant), { ...spec, sessionId: rollingSessionId, attempt: (session.experimentCount ?? 0) + 1 }, ROLLING_FOLDS, outcome);
      const r = this.rollingState;
      r.checked += 1; r.lastCheckedAt = nowMs;
      if (result.refusal !== undefined) { this.rollingRefused(result.refusal); r.insufficient += 1; return; }
      if (result.decision.decision === "PASS") r.pass += 1; else if (result.decision.decision === "FAIL") r.fail += 1; else r.insufficient += 1;
      for (const fold of result.folds) {
        if (fold.outcome === "CHALLENGER_BETTER") r.folds.challengerBetter += 1; else if (fold.outcome === "NOT_BETTER") r.folds.notBetter += 1; else r.folds.insufficient += 1;
      }
    } catch {
      this.rollingState.errors += 1;
    }
  }

  /**
   * Display only: the outcome of the hourly REST gap fill, the only writer of the candle series head. Fixed status and
   * error codes with integer counts; nothing from the request or the data is kept.
   */
  public recordGapFill(results: readonly { readonly status: string; readonly errorCode?: string }[], at: number, timings?: GapFillTimingsMs): void {
    const previous = this.gapFillSummary;
    const counts: Record<string, number> = { ...(previous?.counts ?? {}) };
    let lastErrorCode = previous?.lastErrorCode;
    for (const result of results) {
      if (!GAP_FILL_CODE.test(result.status)) continue;
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.errorCode !== undefined && GAP_FILL_CODE.test(result.errorCode)) lastErrorCode = result.errorCode;
    }
    const whole = (value: number): number => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
    const timingsMs: GapFillTimingsSummaryMs | undefined = timings === undefined ? previous?.timingsMs : Object.freeze({
      lastFillMs: whole(timings.fillMs), lastReadMs: whole(timings.readMs), lastMaterializeMs: whole(timings.materializeMs),
      maxFillMs: Math.max(previous?.timingsMs?.maxFillMs ?? 0, whole(timings.fillMs)),
      maxReadMs: Math.max(previous?.timingsMs?.maxReadMs ?? 0, whole(timings.readMs)),
      maxMaterializeMs: Math.max(previous?.timingsMs?.maxMaterializeMs ?? 0, whole(timings.materializeMs)),
    });
    this.gapFillSummary = Object.freeze({
      lastRunAt: at,
      runs: (previous?.runs ?? 0) + 1,
      deferred: previous?.deferred ?? 0,
      counts: Object.freeze(counts),
      ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
      ...(timingsMs === undefined ? {} : { timingsMs }),
    });
  }

  /** Display only: an hourly gap fill was postponed because a backfill, gap fill or research tick was still running. */
  public noteGapFillDeferred(): void {
    const previous = this.gapFillSummary;
    this.gapFillSummary = Object.freeze({ ...(previous ?? { runs: 0, counts: Object.freeze({}) }), deferred: (previous?.deferred ?? 0) + 1 });
  }

  public gapFill(): ResearchGapFillSummary | null {
    return this.gapFillSummary;
  }

  private recordTick(report: TickReport): TickReport {
    const counts: Record<string, number> = { ...(this.tickSummary?.counts ?? {}) };
    const add = (key: string): void => addOutcomeCount(counts, key);
    for (const item of report.experiments) {
      const outcome = item.outcome;
      add(outcome.status);
      if (outcome.status === "COMPLETED") {
        add(`VALIDATION_${outcome.validation.result}`);
        if (outcome.holdout != null) add(`HOLDOUT_${outcome.holdout.result}`);
        else if (outcome.holdoutNote != null) add(outcome.holdoutNote);
      } else if (outcome.status === "SKIPPED" || outcome.status === "ERROR") add(`${outcome.status}_${outcome.reason.split(":")[0]}`);
    }
    // Failure reasons are recomputed from the durable evaluation ledger (all-time for this bar length), never counted in memory,
    // so a restart or a crash between a ledger append and a count cannot lose or double count one. Display only; a read failure omits them.
    for (const key of Object.keys(counts)) if (key.startsWith("FAIL_")) delete counts[key];
    for (const key of Object.keys(counts)) if (key.startsWith("REPEAT_")) delete counts[key];
    try {
      const failureRecords = (this.options.failureEvidence?.() ?? []).filter((record) => !isRollingRecord(record));
      // REPEAT_<reason>: how many challengers keep failing for the same bounded reason (Research N+1 bookkeeping; changes no schedule).
      const merged = { ...countResearchFailures(failureRecords), ...countRepeatedFailures(summarizeStrategyFailureHistory(failureRecords)) };
      for (const [key, value] of Object.entries(merged)) if (/^[A-Z][A-Z0-9_]{1,47}$/.test(key) && Number.isSafeInteger(value)) counts[key] = value;
    } catch { /* display only */ }
    this.tickSummary = Object.freeze({
      lastTickAt: this.options.now(),
      lastStatus: report.status,
      ticks: (this.tickSummary?.ticks ?? 0) + 1,
      sessionsStarted: (this.tickSummary?.sessionsStarted ?? 0) + report.started,
      counts: Object.freeze(counts),
    });
    return report;
  }

  public tick(): TickReport {
    return this.recordTick(this.tickInner());
  }

  /**
   * Production-safe equivalent of tick(). It preserves the same deterministic experiment order and durable stores,
   * but yields after each bounded variant/market step so HTTP readiness and the PAPER writer lease stay serviceable.
   */
  public async tickAsync(yieldControl: () => Promise<void> = yieldToEventLoop): Promise<TickReport> {
    try { return this.recordTick(await this.tickInnerAsync(yieldControl)); }
    catch { return this.recordTick(empty("ERROR")); }
  }

  private tickInner(): TickReport {
    const steps = this.tickSteps();
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
  }

  private async tickInnerAsync(yieldControl: () => Promise<void>): Promise<TickReport> {
    const steps = this.tickSteps();
    let next = steps.next();
    while (!next.done) {
      await yieldControl();
      next = steps.next();
    }
    return next.value;
  }

  /** One canonical implementation feeds both synchronous/manual and cooperative production execution. */
  private *tickSteps(): Generator<void, TickReport, void> {
    if (!this.recoveryReady) return empty("RECOVERY_NOT_READY");
    try {
      const nowMs = this.options.now();
      this.options.collect(nowMs);
      // Collection may touch a bounded amount of durable data. Give HTTP one turn before the experiment grid starts.
      yield;
      let started = 0; let resumed = 0; let stopped = 0;
      const experiments: Array<TickReport["experiments"][number]> = [];

      for (const variant of this.options.variants) {
        const sessionId = researchSessionIdFor(nowMs, variant.variantId);
        const all = this.options.sessions.list();
        let plan = planResearchSession({ nowMs, sessions: all, dailyBudget: this.options.dailyBudgetPerVariant, recoveryReady: this.recoveryReady, variantId: variant.variantId });
        if (plan.action === "NONE" && plan.reason === "PREVIOUS_SESSION_STILL_RUNNING") {
          for (const old of all.filter((s) => s.state === "RUNNING" && s.sessionId.endsWith(`-${variant.variantId}`) && s.sessionId !== sessionId)) { variant.runtime.stop(old.sessionId); stopped += 1; }
          plan = planResearchSession({ nowMs, sessions: this.options.sessions.list(), dailyBudget: this.options.dailyBudgetPerVariant, recoveryReady: this.recoveryReady, variantId: variant.variantId });
        }
        if (plan.action === "START") {
          variant.runtime.startSession({
            sessionId: plan.sessionId,
            datasetId: `upbit-1m-closed:${this.options.markets.join(",")}:${this.options.intervalMs}`,
            interval: `${this.options.intervalMs / 60_000}m`,
            championStrategyId: variant.champion.strategy.strategyId,
            championStrategyVersion: variant.champion.strategy.version,
            challengerStrategyId: variant.challenger.strategy.strategyId,
            challengerStrategyVersion: variant.challenger.strategy.version,
            deterministicConfig: { windows: this.options.windows, markets: this.options.markets, challenger: variant.challenger.config, champion: variant.champion.config },
            maxExperiments: plan.maxExperiments,
          });
          started += 1;
        }
        let session = this.options.sessions.load(sessionId);
        if (session?.state === "PAUSED") { session = variant.runtime.resume(sessionId); resumed += 1; }
        if (session == null || session.state !== "RUNNING") { yield; continue; }

        for (const market of this.options.markets) {
          const endCloseMs = this.options.candles.latestCloseTime(market, this.options.intervalMs);
          if (endCloseMs == null) { experiments.push({ variantId: variant.variantId, market, outcome: { status: "NOT_DUE" } }); yield; continue; }
          const validationEnd = endCloseMs - this.options.windows.holdoutMs;
          const last = session.lastEvidenceAt;
          if (last != null && validationEnd < last + this.options.windows.validationMs) { experiments.push({ variantId: variant.variantId, market, outcome: { status: "NOT_DUE" } }); yield; continue; }
          const spec: ExperimentSpec = {
            sessionId, market, intervalMs: this.options.intervalMs, endCloseMs, windows: this.options.windows,
            datasetId: this.options.datasetIdForMarket?.(market),
            champion: variant.champion, challenger: variant.challenger,
            featurePipeline: this.options.featurePipeline, evaluator: this.options.evaluator, models: this.options.models,
            sourceCommitSha: this.options.sourceCommitSha,
            experimentFamilyId: `${variant.experimentFamilyPrefix ?? this.options.experimentFamilyPrefix}:${market}`,
            attempt: (this.options.sessions.load(sessionId)?.experimentCount ?? 0) + 1,
            hypothesisLineage: `${variant.experimentFamilyPrefix ?? this.options.experimentFamilyPrefix}:${variant.variantId}`,
            split: { identity: `wf-${this.options.windows.trainMs / 60_000}-${this.options.windows.validationMs / 60_000}-${this.options.windows.holdoutMs / 60_000}m` },
            walkForwardConfig: { windows: this.options.windows, challenger: variant.challenger.config },
            candidateCohort: this.options.variants.map((item) => ({ id: item.variantId, strategyId: item.challenger.strategy.strategyId, strategyVersion: item.challenger.strategy.version, parameters: item.challenger.config as Readonly<Record<string, unknown>> })),
            searchUniverse: { variantIds: this.options.variants.map((item) => item.variantId), selectionRule: "PREDECLARED_VARIANTS", trialCount: this.options.variants.length, intervalMs: this.options.intervalMs },
          };
          const outcome = runResearchExperiment(this.portsFor(variant), spec);
          experiments.push({ variantId: variant.variantId, market, outcome });
          this.shadowRolling(variant, outcome, nowMs, spec);
          session = this.options.sessions.load(sessionId) ?? session;
          yield;
          if (session.state !== "RUNNING") break;
        }
      }
      return Object.freeze({ status: "OK" as const, started, resumed, stopped, experiments: Object.freeze(experiments) });
    } catch {
      return empty("ERROR");
    }
  }

  private portsFor(variant: ResearchVariant): ExperimentRunnerPorts {
    return { runExperiment: (input) => variant.runtime.runExperiment(input), candles: this.options.candles, holdout: this.options.holdout, now: this.options.now, precommitStore: this.options.precommitStore, datasetManifest: this.options.datasetManifest };
  }
}
