/**
 * Display-only: where the PAPER learning pipeline first stops advancing, computed from the already-public /health runtime object.
 * It reads only fields that /health publishes (fixed codes and integers) and adds nothing new: no market, amount, identifier or text.
 * Two branches feed learning: trading (market -> decision -> order -> fill) and research (candles -> dataset -> experiment).
 * Counts are since the runtime process started, so right after a restart the trading branch honestly reads as not yet advanced.
 * A missing field reads UNKNOWN, never PASS. Nothing here is fed back into execution, risk or research.
 */

export const LEARNING_PIPELINE_MARKET_STALE_MS = 5 * 60_000;

export type LearningPipelineStageStatus = "PASS" | "UNKNOWN" | string;

export interface LearningPipelineBranch {
  /** The first stage that is not PASS, or "NONE" when every stage passes. */
  readonly firstBrokenStage: string;
  /** PASS when every stage passes, UNKNOWN when the first non-pass stage lacks evidence, otherwise that stage's fixed code. */
  readonly code: string;
  readonly stages: Readonly<Record<string, LearningPipelineStageStatus>>;
}

export interface LearningPipelineProjection {
  readonly trading: LearningPipelineBranch;
  readonly research: LearningPipelineBranch;
  /** The closed-learning evaluation that consumes both branches. */
  readonly learning: LearningPipelineStageStatus;
}

type Source = Readonly<Record<string, unknown>>;

const int = (value: unknown): number | undefined => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined);
const record = (value: unknown): Source | undefined => (value != null && typeof value === "object" && !Array.isArray(value) ? (value as Source) : undefined);

function branch(stages: ReadonlyArray<readonly [string, LearningPipelineStageStatus]>): LearningPipelineBranch {
  const broken = stages.find(([, status]) => status !== "PASS");
  return Object.freeze({
    firstBrokenStage: broken === undefined ? "NONE" : broken[0],
    code: broken === undefined ? "PASS" : broken[1],
    stages: Object.freeze(Object.fromEntries(stages)),
  });
}

function marketStage(runtime: Source, now: number): LearningPipelineStageStatus {
  const at = runtime.lastMarketEventAt;
  if (at === null) return "MARKET_NO_EVENT";
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return "UNKNOWN";
  return now - at > LEARNING_PIPELINE_MARKET_STALE_MS ? "MARKET_STALE" : "PASS";
}

function countStage(runtime: Source, key: string, code: string): LearningPipelineStageStatus {
  const value = int(runtime[key]);
  if (value === undefined) return "UNKNOWN";
  return value > 0 ? "PASS" : code;
}

function orderStage(runtime: Source): LearningPipelineStageStatus {
  const orders = int(runtime.paperOrderCount);
  if (orders === undefined) return "UNKNOWN";
  if (orders > 0) return "PASS";
  const failed = int(record(record(runtime.paperFunnel)?.counts)?.["ORDER_INTENT:FAIL"]) ?? 0;
  return failed > 0 ? "ORDER_INTENT_FAILING" : "ORDER_NONE";
}

function candleStage(runtime: Source): LearningPipelineStageStatus {
  const status = runtime.researchCollectionStatus;
  if (typeof status !== "string") return "UNKNOWN";
  if (status !== "COLLECTING") return `CANDLES_${status}`;
  const stale = int(record(runtime.dataIntegrity)?.candleStaleSeries);
  if (stale === undefined) return "UNKNOWN";
  return stale > 0 ? "CANDLES_STALE" : "PASS";
}

function datasetStage(runtime: Source): LearningPipelineStageStatus {
  const ticks = record(runtime.researchExperimentTicks);
  const counts = record(ticks?.counts);
  if (ticks === undefined || counts === undefined) return "UNKNOWN";
  const manifestMissing = Object.entries(counts).some(([key, value]) => key.includes("MANIFEST_NOT_FOUND") && (int(value) ?? 0) > 0);
  const sessions = int(ticks.sessionsStarted);
  if (sessions === undefined) return "UNKNOWN";
  if (sessions > 0) return "PASS";
  // A missing manifest always wins: results counted next to it do not prove the dataset is intact now.
  if (manifestMissing) return "DATASET_MANIFEST_MISSING";
  // sessionsStarted counts only sessions this process created; after a restart the stored sessions are resumed, so it stays 0 while
  // they run. Process-local proof of a loaded RUNNING session is a NOT_DUE (the orchestrator emits it only for a RUNNING session) or a
  // VALIDATION_* / HOLDOUT_* outcome. FAIL_* and REPEAT_* are recomputed from the durable ledger (all-time), so they prove nothing about this process.
  const runningSession = Object.entries(counts).some(([key, value]) => (key === "NOT_DUE" || key.startsWith("VALIDATION_") || key.startsWith("HOLDOUT_")) && (int(value) ?? 0) > 0);
  if (runningSession) return "PASS";
  return "DATASET_NO_SESSION";
}

function experimentStage(runtime: Source): LearningPipelineStageStatus {
  const status = record(runtime.researchExperimentTicks)?.lastStatus;
  if (typeof status !== "string") return "UNKNOWN";
  return status === "OK" ? "PASS" : `EXPERIMENT_${status}`;
}

function learningStage(runtime: Source): LearningPipelineStageStatus {
  const loop = record(runtime.closedLearningLoop);
  const evaluated = int(loop?.cyclesEvaluated);
  if (evaluated === undefined) return "UNKNOWN";
  return evaluated > 0 ? "PASS" : "LEARNING_NOT_EVALUATED";
}

/** Pure and deterministic for a given runtime object and clock reading. */
export function learningPipelineProjection(runtime: Source, now: number): LearningPipelineProjection {
  return Object.freeze({
    trading: branch([
      ["MARKET", marketStage(runtime, now)],
      ["DECISION", countStage(runtime, "decisionCount", "DECISION_NONE")],
      ["ORDER", orderStage(runtime)],
      ["FILL", countStage(runtime, "paperFillCount", "FILL_NONE")],
    ]),
    research: branch([
      ["CANDLES", candleStage(runtime)],
      ["DATASET", datasetStage(runtime)],
      ["EXPERIMENT", experimentStage(runtime)],
    ]),
    learning: learningStage(runtime),
  });
}
