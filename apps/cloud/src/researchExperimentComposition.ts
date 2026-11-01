import { SqliteCandidatePromotionRepository, SqliteResearchCandleStore, SqliteResearchDatasetManifestStore, SqliteResearchEvaluationLedger, SqliteResearchHoldoutLedger, SqliteResearchMemoryRepository, SqliteResearchSessionRepository, SqliteResearchPrecommitRepository, type SqliteDatabase } from "../../../packages/storage/src/index";
import { BacktestResearchEvaluator, buildDonchianResearchStrategy, buildRsiResearchStrategy, buildSmaResearchStrategy } from "./backtestResearchEvaluator";
import { ResearchAutomationRuntime } from "./researchAutomationRuntime";
import { ResearchExperimentOrchestrator, type ResearchVariant, type TickReport } from "./researchExperimentOrchestrator";
import { ResearchRecoveryCoordinator } from "./researchRecoveryCoordinator";
import { ResearchRuntimeCoordinator } from "./researchRuntimeCoordinator";
import { backfillMarket, createUpbitMinuteCandleFetcher, fillRecentGaps, type BackfillResult, type GapFillResult } from "./researchCandleBackfill";
import { AggregatedResearchCandleSource } from "./researchCandleAggregation";
import { materializeResearchDatasetManifest } from "./researchDatasetManifestMaterializer";
import type { ResearchRecoveryResult } from "../../../packages/contracts/src/researchRecovery";

/**
 * Composition of the continuous research experiments. DISABLED unless NUSA_CLOUD_RESEARCH_EXPERIMENTS is exactly
 * "1". Any invalid setting, or a missing 40-character build commit, leaves it disabled and says why in one log
 * line (fail closed). Research evidence only: LIVE NONE, no orders, no capital/risk/execution change, no paid AI,
 * and nothing is promoted or registered here: when the existing candidate gate calls the registration port the event is
 * only logged, because new registrations require a canonical family binding that this research path never holds.
 */
const M = 60_000;
/** Keep the REST-backed candle head inside the read-only probe's 10-minute freshness window. */
export const RESEARCH_GAP_FILL_INTERVAL_MS = 5 * M;
/** Periodic repairs make bounded progress; the existing timer revisits older gaps on later passes. */
export const RESEARCH_GAP_FILL_MAX_PAGES_PER_RUN = 1;
const DAY_MS = 86_400_000;
export const RESEARCH_FLAG = "NUSA_CLOUD_RESEARCH_EXPERIMENTS";
// Upbit KRW market fee is 0.05%; slippage is a fixed conservative 5 bps. Both are explicit by design.
export const RESEARCH_BACKTEST_COST = Object.freeze({ initialCash: 1_000_000, feeRate: 0.0005, slippageBps: 5 });
const CHAMPION_PROXY = Object.freeze({ fast: 5, slow: 20 }); // matches the owner-approved PAPER baseline parameters
const CHALLENGER_GRID: readonly (readonly [number, number])[] = Object.freeze([[3, 10], [5, 30], [10, 40], [8, 20]]);
// RSI mean-reversion grid [period, oversold threshold], fixed before any result was seen (no tuning on validation or holdout).
const RSI_CHALLENGER_GRID: readonly (readonly [number, number])[] = Object.freeze([[14, 30], [14, 25], [7, 20]]);
// RSI positions close after this many bars of the experiment's bar length if neither take-profit nor stop-loss hit. It must fit
// inside the shortest evaluation window after the RSI warm-up: 2-day validation/holdout at 60m is 48 bars, minus up to 14 warm-up bars.
export const RSI_TIMEOUT_BARS = 12;
// Donchian breakout grid (previous N bars' highest high), fixed before any result was seen. The longest period plus the time limit must
// fit in the shortest evaluation window after warm-up: 2-day validation/holdout at 60m is 48 bars, so 30 + 12 = 42 fits.
export const DONCHIAN_GRID: readonly number[] = Object.freeze([10, 20, 30]);
export const DONCHIAN_TIMEOUT_BARS = 12;
/** Bar lengths research may compare (docs/PROPOSAL_RESEARCH_LONGER_TIMEFRAMES.md). Longer bars are built from stored 1m candles. */
export const RESEARCH_INTERVAL_MINUTES: readonly number[] = Object.freeze([1, 15, 60, 240]);

export interface ResearchExperimentSettings {
  readonly markets: readonly string[];
  readonly windows: { readonly intervalMs: number; readonly trainMs: number; readonly validationMs: number; readonly holdoutMs: number; readonly maxMissingRatio: number };
  readonly tickMs: number;
  readonly dailyBudgetPerVariant: number;
  readonly sourceCommitSha: string;
  /** Bar lengths to run the same experiment grid on, in minutes. Default [1] (unchanged behaviour). */
  readonly intervalsMinutes: readonly number[];
  /** Fill history from Upbit's public 1-minute candles at start. On unless NUSA_RESEARCH_BACKFILL is set to anything but ENABLED. */
  readonly backfill: boolean;
}

export type ResearchExperimentSettingsResult =
  | { readonly status: "DISABLED" }
  | { readonly status: "INVALID"; readonly reason: string }
  | { readonly status: "ENABLED"; readonly settings: ResearchExperimentSettings };

function intIn(raw: string | undefined, fallback: number, min: number, max: number): number | undefined {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

export function readResearchExperimentSettings(env: NodeJS.ProcessEnv): ResearchExperimentSettingsResult {
  if (env[RESEARCH_FLAG] !== "1") return Object.freeze({ status: "DISABLED" });
  const commit = (env.NUSA_SOURCE_COMMIT_SHA ?? env.NUSA_SOURCE_COMMIT ?? "").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) return Object.freeze({ status: "INVALID", reason: "SOURCE_COMMIT_MISSING_OR_MALFORMED" });
  const markets = (env.NUSA_RESEARCH_MARKETS ?? "KRW-BTC").split(",").map((m) => m.trim().toUpperCase()).filter((m) => m !== "");
  if (markets.length === 0 || markets.length > 5 || markets.some((m) => !/^KRW-[A-Z0-9-]+$/.test(m)) || new Set(markets).size !== markets.length) return Object.freeze({ status: "INVALID", reason: "MARKETS_INVALID" });
  const train = intIn(env.NUSA_RESEARCH_TRAIN_DAYS, 7, 1, 30);
  const validation = intIn(env.NUSA_RESEARCH_VALIDATION_DAYS, 2, 1, 14);
  const holdout = intIn(env.NUSA_RESEARCH_HOLDOUT_DAYS, 2, 1, 14);
  const tickMinutes = intIn(env.NUSA_RESEARCH_TICK_MINUTES, 30, 5, 360);
  const budget = intIn(env.NUSA_RESEARCH_DAILY_BUDGET, 48, 1, 288);
  if (train == null || validation == null || holdout == null || tickMinutes == null || budget == null) return Object.freeze({ status: "INVALID", reason: "NUMERIC_SETTING_INVALID" });
  const intervalsRaw = (env.NUSA_RESEARCH_INTERVAL_MINUTES ?? "1").split(",").map((value) => value.trim()).filter((value) => value !== "");
  const intervalsMinutes = intervalsRaw.map(Number);
  if (intervalsMinutes.length === 0 || intervalsMinutes.some((value) => !RESEARCH_INTERVAL_MINUTES.includes(value)) || new Set(intervalsMinutes).size !== intervalsMinutes.length) {
    return Object.freeze({ status: "INVALID", reason: "INTERVALS_INVALID" });
  }
  return Object.freeze({
    status: "ENABLED",
    settings: Object.freeze({
      markets: Object.freeze(markets),
      windows: Object.freeze({ intervalMs: M, trainMs: train * DAY_MS, validationMs: validation * DAY_MS, holdoutMs: holdout * DAY_MS, maxMissingRatio: 0.05 }),
      tickMs: tickMinutes * M,
      dailyBudgetPerVariant: budget,
      sourceCommitSha: commit,
      intervalsMinutes: Object.freeze(intervalsMinutes),
      backfill: env.NUSA_RESEARCH_BACKFILL === undefined || env.NUSA_RESEARCH_BACKFILL === "ENABLED",
    }),
  });
}

export interface ResearchExperimentComposition {
  readonly datasetManifests: SqliteResearchDatasetManifestStore;
  /** Synchronous startup only: validate evidence without changing Research session state. */
  readonly prepareRecovery: () => void;
  readonly finishPreparedRecovery: () => void;
  readonly orchestrator: ResearchExperimentOrchestrator;
  /** One orchestrator per configured bar length, in settings order; `orchestrator` is the first. */
  readonly orchestrators: readonly ResearchExperimentOrchestrator[];
  /** Display only: each bar length's experiment tick summary, keyed "1m", "15m", ... */
  readonly experimentTicksByInterval: () => Readonly<Record<string, ReturnType<ResearchExperimentOrchestrator["experimentTicks"]>>>;
  readonly tickOnce: () => TickReport;
  /** Cooperative production path: same deterministic tick, yielding between bounded experiment steps. */
  readonly tickOnceAsync: () => Promise<TickReport>;
  readonly backfill: () => Promise<readonly BackfillResult[]>;
  /** Refills missing closed minutes inside the recent history from the public candle endpoint. */
  readonly fillGaps: () => Promise<readonly GapFillResult[]>;
  readonly start: () => void;
  readonly stop: () => void;
}

export function composeResearchExperiments(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly database: SqliteDatabase;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Meta-learning steering: the longer bar lengths tick every N-th scheduled tick (1 = every tick). Read on every tick. */
  readonly longBarTickEvery?: () => number;
}): ResearchExperimentComposition | undefined {
  const log = input.log ?? (() => undefined);
  const parsed = readResearchExperimentSettings(input.env);
  if (parsed.status === "DISABLED") return undefined;
  if (parsed.status === "INVALID") { log(`[research-experiments] disabled: ${parsed.reason}`); return undefined; }
  const settings = parsed.settings;
  const now = input.now ?? Date.now;
  const db = input.database;

  const store = new SqliteResearchCandleStore(db);
  const datasetManifests = new SqliteResearchDatasetManifestStore(db);
  const holdout = new SqliteResearchHoldoutLedger(db);
  const ledger = new SqliteResearchEvaluationLedger(db);
  const precommits = new SqliteResearchPrecommitRepository(db);
  const candidates = new SqliteCandidatePromotionRepository(db);
  const memory = new SqliteResearchMemoryRepository(db);
  const sessions = new SqliteResearchSessionRepository(db);
  const recovery = new ResearchRecoveryCoordinator({ repository: candidates, evaluationLedger: ledger, now });
  let preparationActive = false;
  type EvidenceSession = ReturnType<typeof db.connection.createSession>;
  let preparedRecovery: { readonly version: number; readonly schema: number; readonly sessions: readonly EvidenceSession[]; readonly result: ResearchRecoveryResult } | undefined;
  // Exact read set of ResearchRecoveryCoordinator and its two repositories. PAPER lease,
  // account and Research session-state writes are not inputs to evidence validation.
  const recoveryEvidenceTables = ["research_evaluation_ledger", "research_candidates", "research_champion_pointer", "research_promotion_commands", "research_promotion_audit"] as const;
  const dataVersion = (): number => Number((db.connection.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
  const schemaVersion = (): number => Number((db.connection.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
  const clearPreparedRecovery = (): void => {
    const previous = preparedRecovery;
    preparedRecovery = undefined;
    for (const session of previous?.sessions ?? []) session.close();
  };
  const hasNullEvidenceKey = (): boolean => {
    // SQLite changesets omit rows with NULL primary keys; the legacy TEXT PRIMARY KEY
    // schema permits them. Never reuse READY over such malformed evidence.
    return db.connection.prepare("SELECT 1 FROM research_candidates WHERE candidate_id IS NULL LIMIT 1").get() != null ||
      db.connection.prepare("SELECT 1 FROM research_promotion_commands WHERE command_id IS NULL LIMIT 1").get() != null;
  };
  const evidenceUnchanged = (prepared: NonNullable<typeof preparedRecovery>): boolean => {
    if (dataVersion() !== prepared.version || schemaVersion() !== prepared.schema || hasNullEvidenceKey()) return false;
    const unchanged = prepared.sessions.every((session) => session.changeset().byteLength === 0);
    // External commits can occur while the change trackers are inspected.
    return unchanged && dataVersion() === prepared.version && schemaVersion() === prepared.schema;
  };
  const recoveryValidationAttempts = 3;
  const validateRecovery = (): ResearchRecoveryResult => {
    clearPreparedRecovery();
    for (let attempt = 0; attempt < recoveryValidationAttempts; attempt++) {
      const sessions: EvidenceSession[] = [];
      let retained = false;
      try {
        for (const table of recoveryEvidenceTables) sessions.push(db.connection.createSession({ table }));
        const version = dataVersion();
        const schema = schemaVersion();
        const result = recovery.recover();
        const prepared = { version, schema, sessions, result };
        if (evidenceUnchanged(prepared)) {
          preparedRecovery = prepared;
          retained = true;
          return result;
        }
      } finally {
        if (!retained) for (const session of sessions) session.close();
      }
    }
    return Object.freeze({
      status: "FAIL_CLOSED",
      snapshot: null,
      reasons: Object.freeze(["RECOVERY_EVIDENCE_UNSTABLE"]),
    });
  };
  const prepareRecovery = (): void => {
    preparationActive = true;
    validateRecovery();
  };
  const startupRecovery = {
    recover: (): ResearchRecoveryResult => {
      if (!preparationActive) return recovery.recover();
      if (preparedRecovery != null && evidenceUnchanged(preparedRecovery)) return preparedRecovery.result;
      return validateRecovery();
    },
  };

  const market = settings.markets[0]!;
  const bars = new AggregatedResearchCandleSource(store, M);
  const proxy = (id: string, fast: number, slow: number) => buildSmaResearchStrategy({ strategyId: id, version: "1.0.0", market, fastPeriod: fast, slowPeriod: slow, takeProfitPercent: 3, stopLossPercent: 2, positionPercent: 50, maxPositionNotional: 500_000 });
  // One orchestrator per bar length. The 1m set keeps its original identities; longer bars carry the length in
  // every strategy id and experiment family so their evidence, sessions and holdouts never mix with 1m evidence.
  const buildOrchestrator = (minutes: number): { orchestrator: ResearchExperimentOrchestrator; variantCount: number } => {
    const intervalMs = minutes * M;
    const tag = minutes === 1 ? "" : `-${minutes}m`;
    const champion = proxy(`research-champion-sma${tag}`, CHAMPION_PROXY.fast, CHAMPION_PROXY.slow);
    const evaluatorFor = <A extends "PAPER_ONLY" | "ZERO_AUTHORITY">(strategy: ReturnType<typeof proxy>, authority: A) => new BacktestResearchEvaluator<A>({
      strategyId: strategy.strategyId, strategyVersion: strategy.version, authority, evaluatorVersion: "backtest-eval-v1",
      strategy, candles: bars, intervalMs, backtest: RESEARCH_BACKTEST_COST,
    });
    const variantFor = (variantId: string, challenger: ReturnType<typeof proxy>, config: unknown, experimentFamilyPrefix?: string): ResearchVariant => {
      const coordinator = new ResearchRuntimeCoordinator({ champion: evaluatorFor(champion, "PAPER_ONLY"), challenger: evaluatorFor(challenger, "ZERO_AUTHORITY"), ledger, precommitStore: precommits });
      const runtime = new ResearchAutomationRuntime({
        coordinator, sessions, memory, registerCandidate: (identity) => { log(`[research-experiments] candidate gate eligible (not registered, governed promotion paths unchanged): ${identity.strategyId}@${identity.strategyVersion}`); return Object.freeze({ identity, lifecycle: "RESEARCHING" as const }); }, listCandidates: () => candidates.listCandidates(),
        recovery: startupRecovery, now, maxEvidenceAgeMs: 14 * DAY_MS,
      });
      return { variantId, champion: { strategy: champion, config: CHAMPION_PROXY }, challenger: { strategy: challenger, config }, runtime, ...(experimentFamilyPrefix == null ? {} : { experimentFamilyPrefix }) };
    };
    const smaVariants = CHALLENGER_GRID.map(([fast, slow]) => {
      const variantId = `sma_${fast}_${slow}${tag.replace("-", "_")}`;
      return variantFor(variantId, proxy(`research-challenger-${variantId}`, fast, slow), { fast, slow });
    });
    const rsiVariants = RSI_CHALLENGER_GRID.map(([period, threshold]) => {
      const variantId = `rsi_${period}_${threshold}${tag.replace("-", "_")}`;
      const challenger = buildRsiResearchStrategy({ strategyId: `research-challenger-${variantId}`, version: "1.0.0", market, period, threshold, takeProfitPercent: 3, stopLossPercent: 2, timeoutMinutes: RSI_TIMEOUT_BARS * minutes, positionPercent: 50, maxPositionNotional: 500_000 });
      return variantFor(variantId, challenger, { family: "rsi", period, threshold, timeoutBars: RSI_TIMEOUT_BARS }, `rsi-research${tag}`);
    });
    const donchianVariants = DONCHIAN_GRID.map((period) => {
      const variantId = `donchian_${period}${tag.replace("-", "_")}`;
      const challenger = buildDonchianResearchStrategy({ strategyId: `research-challenger-${variantId}`, version: "1.0.0", market, period, takeProfitPercent: 3, stopLossPercent: 2, timeoutMinutes: DONCHIAN_TIMEOUT_BARS * minutes, positionPercent: 50, maxPositionNotional: 500_000 });
      return variantFor(variantId, challenger, { family: "donchian", period, timeoutBars: DONCHIAN_TIMEOUT_BARS }, `donchian-research${tag}`);
    });
    const variants: ResearchVariant[] = [...smaVariants, ...rsiVariants, ...donchianVariants];
    const orchestrator = new ResearchExperimentOrchestrator({
      variants, sessions, markets: settings.markets, intervalMs, windows: Object.freeze({ ...settings.windows, intervalMs }), dailyBudgetPerVariant: settings.dailyBudgetPerVariant, precommitStore: precommits,
      // The canonical 1m series is fed only by Upbit REST candles with raw-source receipts (backfill + gap fill, which now
      // reaches the newest closed minute). Ticker-aggregated candles carry no receipt or volume, so writing them here blocked
      // every dataset manifest; since 2026-10-17 they also failed silently. Collection is therefore off by design.
      collect: () => undefined,
      candles: bars, holdout, now, sourceCommitSha: settings.sourceCommitSha,
      models: { fill: "fill-close-v1", fee: `fee-${RESEARCH_BACKTEST_COST.feeRate}-v1`, slippage: `slip-${RESEARCH_BACKTEST_COST.slippageBps}bps-v1` },
      evaluator: { version: "backtest-eval-v1", modelVersion: "dsl-backtest-v1" },
      featurePipeline: { version: "closed-candle-agg-v1", config: { intervalMs, maxInternalGapMs: 30_000, volume: 0 } },
      experimentFamilyPrefix: `sma-research${tag}`,
      datasetManifest: { read: (datasetId: string) => datasetManifests.read(datasetId) },
      datasetIdForMarket: (targetMarket: string) => datasetManifests.latest(targetMarket, `${intervalMs / 60_000}m`)?.datasetId ?? "missing-dataset-manifest",
      failureEvidence: () => ledger.list().filter((record) => record.provenance?.windowRole === "VALIDATION" && record.provenance.interval === `${minutes}m`),
    });
    return { orchestrator, variantCount: variants.length };
  };
  const built = settings.intervalsMinutes.map(buildOrchestrator);
  const orchestrators = Object.freeze(built.map((entry) => entry.orchestrator));
  const orchestrator = orchestrators[0]!;
  const variantCount = built.reduce((sum, entry) => sum + entry.variantCount, 0);

  const fetchPage = createUpbitMinuteCandleFetcher(input.fetchImpl ?? fetch);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let backfillTimer: ReturnType<typeof setTimeout> | undefined;
  let backfilling = false;
  let researchTickActive = false;
  const w = settings.windows;
  const targetSpanMs = w.trainMs + w.validationMs + w.holdoutMs + DAY_MS;
  const backfill = async (): Promise<readonly BackfillResult[]> => {
    if (backfilling || researchTickActive || stopped) return Object.freeze([]);
    backfilling = true;
    const results: BackfillResult[] = [];
    try {
      for (const market of settings.markets) {
        if (stopped) break;
        const result = await backfillMarket({ market, targetSpanMs, nowMs: now(), store, fetchPage, sleep, yieldControl: () => new Promise((resolve) => setImmediate(resolve)) });
        results.push(result);
        if (result.status === "COMPLETE") {
          const firstClose = store.earliestCloseTime(market, M);
          const lastClose = store.latestCloseTime(market, M);
          if (firstClose != null && lastClose != null) {
            try {
              materializeResearchDatasetManifest({ store: datasetManifests, candleStore: store, market, intervalMs: M, candles: store.read(market, M, Math.max(firstClose, lastClose - targetSpanMs + M), lastClose), source: `upbit-1m-closed:${market}:${M}`, createdAt: new Date(now()).toISOString(), sourceCommitSha: settings.sourceCommitSha });
              log(`[research-manifest] ${market} materialized dataset manifest`);
            } catch (error) { log(`[research-manifest] ${market} blocked: ${error instanceof Error ? error.message : "unknown"}`); }
          }
        }
        log(`[research-backfill] ${market} ${result.status} recorded=${result.recorded} rejected=${result.rejected} pages=${result.pages}${result.errorCode === undefined ? "" : ` error=${result.errorCode}`}`);
      }
    } catch (error) {
      log(`[research-backfill] failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      backfilling = false;
    }
    return Object.freeze(results);
  };
  let gapFilling = false;
  let gapTimer: ReturnType<typeof setInterval> | undefined;
  let gapRetry: ReturnType<typeof setTimeout> | undefined;
  const fillGaps = async (): Promise<readonly GapFillResult[]> => {
    if (gapFilling || researchTickActive || stopped) return Object.freeze([]);
    gapFilling = true;
    const results: GapFillResult[] = [];
    try {
      for (const market of settings.markets) {
        if (stopped) break;
        const result = await fillRecentGaps({ market, windowMs: targetSpanMs, nowMs: now(), store, fetchPage, sleep, maxPages: RESEARCH_GAP_FILL_MAX_PAGES_PER_RUN });
        results.push(result);
        if (result.status === "NO_GAPS" || result.status === "FILLED") {
          const firstClose = store.earliestCloseTime(market, M);
          const lastClose = store.latestCloseTime(market, M);
          if (firstClose != null && lastClose != null) {
            try {
              materializeResearchDatasetManifest({ store: datasetManifests, candleStore: store, market, intervalMs: M, candles: store.read(market, M, Math.max(firstClose, lastClose - targetSpanMs + M), lastClose), source: `upbit-1m-closed:${market}:${M}`, createdAt: new Date(now()).toISOString(), sourceCommitSha: settings.sourceCommitSha });
              log(`[research-manifest] ${market} materialized dataset manifest after gap fill`);
            } catch (error) { log(`[research-manifest] ${market} blocked after gap fill: ${error instanceof Error ? error.message : "unknown"}`); }
          }
        }
        log(`[research-gap-fill] ${market} ${result.status} missing=${result.missing} recorded=${result.recorded} rejected=${result.rejected} pages=${result.pages}${result.errorCode === undefined ? "" : ` error=${result.errorCode}`}`);
      }
    } catch (error) {
      log(`[research-gap-fill] failed: ${error instanceof Error ? error.message : "unknown"}`);
      results.push({ market: "", status: "ERROR", missing: 0, recorded: 0, rejected: 0, pages: 0, errorCode: "GAP_FILL_FAILED" } as GapFillResult);
    } finally {
      gapFilling = false;
      try { orchestrator.recordGapFill(results, now()); } catch { /* display only */ }
    }
    return Object.freeze(results);
  };
  const scheduleGapFill = (retry = false): void => {
    if (stopped || gapRetry != null) return;
    if (researchTickActive || backfilling || gapFilling) {
      // Counted once per scheduled attempt, not once per one-second retry.
      if (!retry) { try { orchestrator.noteGapFillDeferred(); } catch { /* display only */ } }
      gapRetry = setTimeout(() => { gapRetry = undefined; scheduleGapFill(true); }, 1_000);
      gapRetry.unref?.();
      return;
    }
    void fillGaps();
  };
  const scheduleBackfill = (attempt: number, delayMs: number): void => {
    if (stopped || !settings.backfill) return;
    backfillTimer = setTimeout(() => {
      void backfill().then((results) => {
        const done = results.length === settings.markets.length && results.every((r) => r.status === "COMPLETE");
        if (!done && attempt < 3) scheduleBackfill(attempt + 1, 10 * M);
        else scheduleGapFill();
      });
    }, delayMs);
    backfillTimer.unref?.();
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  let tickRetry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let tickNumber = 0;
  let scheduledTick: Promise<void> | undefined;

  const nextTickPlan = (): { readonly every: number; readonly tickLongBars: boolean } => {
    let every = 1;
    try { const n = input.longBarTickEvery?.() ?? 1; every = Number.isSafeInteger(n) && n >= 1 && n <= 24 ? n : 1; } catch { every = 1; }
    const tickLongBars = tickNumber % every === 0;
    tickNumber += 1;
    return Object.freeze({ every, tickLongBars });
  };
  const logTickReport = (minutes: number, report: TickReport): void => {
    const completed = report.experiments.filter((e) => e.outcome.status === "COMPLETED").length;
    log(`[research-experiments] tick ${minutes === 1 ? "" : `${minutes}m `}${report.status} started=${report.started} resumed=${report.resumed} stopped=${report.stopped} experiments=${report.experiments.length} completed=${completed}`);
  };
  const tickOnce = (): TickReport => {
    let firstReport: TickReport | undefined;
    const { every, tickLongBars } = nextTickPlan();
    settings.intervalsMinutes.forEach((minutes, index) => {
      if (index > 0 && !tickLongBars) { log(`[research-experiments] tick ${minutes}m deferred by meta-learning steering (every ${every})`); return; }
      try {
        const report = orchestrators[index]!.tick();
        if (index === 0) firstReport = report;
        logTickReport(minutes, report);
      } catch (error) {
        if (index === 0) throw error;
        log(`[research-experiments] tick ${minutes}m failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
    });
    return firstReport!;
  };
  const yieldProductionTurn = (): Promise<void> => new Promise((resolve, reject) => {
    setImmediate(() => stopped ? reject(new Error("research experiment composition stopped")) : resolve());
  });
  const tickOnceAsync = async (): Promise<TickReport> => {
    if (researchTickActive) throw new Error("research experiment tick already active");
    if (backfilling || gapFilling) throw new Error("research evidence writer active");
    researchTickActive = true;
    try {
      let firstReport: TickReport | undefined;
      const { every, tickLongBars } = nextTickPlan();
      for (let index = 0; index < settings.intervalsMinutes.length; index += 1) {
        const minutes = settings.intervalsMinutes[index]!;
        if (index > 0 && !tickLongBars) { log(`[research-experiments] tick ${minutes}m deferred by meta-learning steering (every ${every})`); continue; }
        try {
          const report = await orchestrators[index]!.tickAsync(yieldProductionTurn);
          if (index === 0) firstReport = report;
          if (stopped) return firstReport ?? report;
          logTickReport(minutes, report);
        } catch (error) {
          if (index === 0) throw error;
          log(`[research-experiments] tick ${minutes}m failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }
      return firstReport!;
    } finally {
      researchTickActive = false;
    }
  };
  const scheduleTick = (): void => {
    if (stopped || scheduledTick != null || tickRetry != null) return;
    if (backfilling || gapFilling) {
      tickRetry = setTimeout(() => { tickRetry = undefined; scheduleTick(); }, 1_000);
      tickRetry.unref?.();
      return;
    }
    const task = tickOnceAsync().then(() => undefined, () => undefined);
    scheduledTick = task;
    void task.finally(() => { if (scheduledTick === task) scheduledTick = undefined; });
  };
  return Object.freeze({
    datasetManifests,
    prepareRecovery,
    finishPreparedRecovery: () => { preparationActive = false; clearPreparedRecovery(); },
    orchestrator,
    orchestrators,
    experimentTicksByInterval: () => {
      const byInterval: Record<string, ReturnType<ResearchExperimentOrchestrator["experimentTicks"]>> = {};
      settings.intervalsMinutes.forEach((minutes, index) => { byInterval[`${minutes}m`] = orchestrators[index]!.experimentTicks(); });
      return Object.freeze(byInterval);
    },
    tickOnce,
    tickOnceAsync,
    backfill,
    fillGaps,
    start: () => {
      if (stopped || timer != null) return;
      orchestrators.slice(1).forEach((other, index) => {
        let status = "FAIL_CLOSED";
        try { status = other.recover().status; } catch { status = "FAIL_CLOSED"; }
        log(`[research-experiments] recover ${settings.intervalsMinutes[index + 1]}m ${status}`);
      });
      preparationActive = false;
      clearPreparedRecovery();
      scheduleBackfill(1, 20_000);
      first = setTimeout(scheduleTick, 60_000);
      first.unref?.();
      timer = setInterval(scheduleTick, settings.tickMs);
      timer.unref?.();
      if (settings.backfill) { gapTimer = setInterval(() => scheduleGapFill(), RESEARCH_GAP_FILL_INTERVAL_MS); gapTimer.unref?.(); }
      log(`[research-experiments] enabled: markets=${settings.markets.join(",")} variants=${variantCount} intervals=${settings.intervalsMinutes.join(",")}m tickMinutes=${settings.tickMs / M} backfill=${settings.backfill ? "ENABLED" : "DISABLED"}`);
    },
    stop: () => { preparationActive = false; clearPreparedRecovery(); stopped = true; if (gapTimer != null) clearInterval(gapTimer); if (gapRetry != null) clearTimeout(gapRetry); if (backfillTimer != null) clearTimeout(backfillTimer); if (tickRetry != null) clearTimeout(tickRetry); if (first != null) clearTimeout(first); if (timer != null) clearInterval(timer); },
  });
}
