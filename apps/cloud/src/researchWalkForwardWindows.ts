import type { BacktestCandle } from "../../../packages/core/src/optimizer/aiBacktestEngine";

/**
 * Pure builder of the most recent Train / Validation / Holdout windows from stored closed candles.
 * Windows are contiguous in time, disjoint and ordered (train < validation < holdout), end at `endCloseMs`,
 * and each must be covered by candles up to `maxMissingRatio`. Anything uncertain returns a refusal with a
 * stable reason instead of a partial or shifted window; nothing is interpolated.
 */
export interface WalkForwardWindowConfig {
  readonly intervalMs: number;
  readonly trainMs: number;
  readonly validationMs: number;
  readonly holdoutMs: number;
  /** Largest tolerated share of missing candles inside one window (default 0.01). */
  readonly maxMissingRatio?: number;
}

export interface WalkForwardWindowsOk {
  readonly status: "OK";
  readonly train: readonly BacktestCandle[];
  readonly validation: readonly BacktestCandle[];
  readonly holdout: readonly BacktestCandle[];
  /** Close times of the first and last slot of each window (slots, not candles present). */
  readonly bounds: Readonly<Record<"train" | "validation" | "holdout", { readonly startCloseMs: number; readonly endCloseMs: number }>>;
  readonly missing: Readonly<Record<"train" | "validation" | "holdout", number>>;
}

export type WalkForwardRefusalReason = "INVALID_CONFIG" | "INVALID_CANDLES" | "NO_CANDLES" | "INSUFFICIENT_HISTORY" | "TOO_MANY_GAPS";

export interface WalkForwardRefusal {
  readonly status: "REFUSED";
  readonly reason: WalkForwardRefusalReason;
  readonly window?: "train" | "validation" | "holdout";
}

export const DEFAULT_MAX_MISSING_RATIO = 0.01;

export function buildWalkForwardWindows(input: {
  readonly candles: readonly BacktestCandle[];
  readonly endCloseMs: number;
  readonly config: WalkForwardWindowConfig;
}): WalkForwardWindowsOk | WalkForwardRefusal {
  const { intervalMs, trainMs, validationMs, holdoutMs } = input.config;
  const maxMissing = input.config.maxMissingRatio ?? DEFAULT_MAX_MISSING_RATIO;
  const multiples = [trainMs, validationMs, holdoutMs].every((ms) => Number.isSafeInteger(ms) && ms >= intervalMs && ms % intervalMs === 0);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || !multiples || !(maxMissing >= 0 && maxMissing <= 0.2)
    || !Number.isSafeInteger(input.endCloseMs) || input.endCloseMs <= 0 || input.endCloseMs % intervalMs !== 0) return Object.freeze({ status: "REFUSED", reason: "INVALID_CONFIG" });
  if (input.candles.length === 0) return Object.freeze({ status: "REFUSED", reason: "NO_CANDLES" });

  let previous = 0;
  for (const candle of input.candles) {
    if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= previous || candle.timestamp % intervalMs !== 0) return Object.freeze({ status: "REFUSED", reason: "INVALID_CANDLES" });
    previous = candle.timestamp;
  }

  const holdoutStart = input.endCloseMs - holdoutMs + intervalMs;
  const validationEnd = holdoutStart - intervalMs;
  const validationStart = validationEnd - validationMs + intervalMs;
  const trainEnd = validationStart - intervalMs;
  const trainStart = trainEnd - trainMs + intervalMs;
  if (trainStart <= 0 || input.candles[0]!.timestamp > trainStart + Math.floor((trainMs / intervalMs) * maxMissing) * intervalMs) return Object.freeze({ status: "REFUSED", reason: "INSUFFICIENT_HISTORY" });

  const slice = (from: number, to: number): BacktestCandle[] => input.candles.filter((c) => c.timestamp >= from && c.timestamp <= to);
  const parts = {
    train: { from: trainStart, to: trainEnd, ms: trainMs },
    validation: { from: validationStart, to: validationEnd, ms: validationMs },
    holdout: { from: holdoutStart, to: input.endCloseMs, ms: holdoutMs },
  } as const;
  const out: Record<"train" | "validation" | "holdout", BacktestCandle[]> = { train: [], validation: [], holdout: [] };
  const missing: Record<"train" | "validation" | "holdout", number> = { train: 0, validation: 0, holdout: 0 };
  for (const name of ["train", "validation", "holdout"] as const) {
    const part = parts[name];
    const slots = part.ms / intervalMs;
    const candles = slice(part.from, part.to);
    if (candles.length === 0) return Object.freeze({ status: "REFUSED", reason: "INSUFFICIENT_HISTORY", window: name });
    const gap = slots - candles.length;
    if (gap / slots > maxMissing) return Object.freeze({ status: "REFUSED", reason: "TOO_MANY_GAPS", window: name });
    out[name] = candles;
    missing[name] = gap;
  }
  return Object.freeze({
    status: "OK",
    train: Object.freeze(out.train), validation: Object.freeze(out.validation), holdout: Object.freeze(out.holdout),
    bounds: Object.freeze({
      train: Object.freeze({ startCloseMs: trainStart, endCloseMs: trainEnd }),
      validation: Object.freeze({ startCloseMs: validationStart, endCloseMs: validationEnd }),
      holdout: Object.freeze({ startCloseMs: holdoutStart, endCloseMs: input.endCloseMs }),
    }),
    missing: Object.freeze(missing),
  });
}

/**
 * Pure building blocks for K-of-N independent holdouts. They live beside the existing
 * walk-forward window builder so adding research helpers does not create unreachable
 * production modules. These exports are not wired into the experiment orchestrator.
 */
export const ROLLING_FOLDS = 3;
export const ROLLING_FOLDS_REQUIRED = 2;

export interface RollingFold extends WalkForwardWindowsOk {
  /** 0 = the oldest fold. */
  readonly index: number;
}

export type RollingFoldsResult =
  | { readonly status: "OK"; readonly folds: readonly RollingFold[] }
  | { readonly status: "REFUSED"; readonly reason: WalkForwardRefusalReason | "INVALID_FOLD_COUNT"; readonly foldIndex?: number };

/** One fold's total length: the three windows back to back. */
export const foldSpanMs = (config: WalkForwardWindowConfig): number => config.trainMs + config.validationMs + config.holdoutMs;

/** The history a rolling check needs: N folds back to back. */
export const requiredHistoryMs = (config: WalkForwardWindowConfig, folds: number = ROLLING_FOLDS): number => foldSpanMs(config) * folds;

/**
 * Folds are laid back to back and end at `endCloseMs`. Any refusal refuses the whole
 * set: a partial rolling check is never returned, and nothing is shifted or shortened.
 */
export function buildRollingFolds(input: {
  readonly candles: readonly BacktestCandle[];
  readonly endCloseMs: number;
  readonly config: WalkForwardWindowConfig;
  readonly folds?: number;
}): RollingFoldsResult {
  const count = input.folds ?? ROLLING_FOLDS;
  if (!Number.isSafeInteger(count) || count < 2 || count > 6) return Object.freeze({ status: "REFUSED", reason: "INVALID_FOLD_COUNT" });
  const span = foldSpanMs(input.config);
  if (!Number.isSafeInteger(span) || span <= 0) return Object.freeze({ status: "REFUSED", reason: "INVALID_CONFIG" });
  const folds: RollingFold[] = [];
  for (let index = 0; index < count; index += 1) {
    const endCloseMs = input.endCloseMs - (count - 1 - index) * span;
    const built = buildWalkForwardWindows({ candles: input.candles, endCloseMs, config: input.config });
    if (built.status === "REFUSED") return Object.freeze({ status: "REFUSED", reason: built.reason, foldIndex: index });
    folds.push(Object.freeze({ ...built, index }));
  }
  return Object.freeze({ status: "OK", folds: Object.freeze(folds) });
}

/** One fold's own holdout outcome. INSUFFICIENT never counts as a pass. */
export type FoldOutcome = "CHALLENGER_BETTER" | "NOT_BETTER" | "INSUFFICIENT";

export interface RollingHoldoutDecision {
  readonly decision: "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE";
  readonly passed: number;
  readonly failed: number;
  readonly insufficient: number;
  readonly required: number;
  readonly total: number;
}

/** PASS only when at least K of exactly N folds favour the challenger. */
export function decideRollingHoldout(outcomes: readonly FoldOutcome[], required: number = ROLLING_FOLDS_REQUIRED, total: number = ROLLING_FOLDS): RollingHoldoutDecision {
  const valid = Number.isSafeInteger(required) && Number.isSafeInteger(total) && required >= 2 && required <= total && outcomes.length === total
    && outcomes.every((outcome) => outcome === "CHALLENGER_BETTER" || outcome === "NOT_BETTER" || outcome === "INSUFFICIENT");
  const passed = valid ? outcomes.filter((o) => o === "CHALLENGER_BETTER").length : 0;
  const failed = valid ? outcomes.filter((o) => o === "NOT_BETTER").length : 0;
  const insufficient = valid ? outcomes.filter((o) => o === "INSUFFICIENT").length : 0;
  const base = { passed, failed, insufficient, required, total } as const;
  if (!valid) return Object.freeze({ decision: "INSUFFICIENT_EVIDENCE", ...base });
  if (passed >= required) return Object.freeze({ decision: "PASS", ...base });
  return Object.freeze({ decision: passed + insufficient >= required ? "INSUFFICIENT_EVIDENCE" : "FAIL", ...base });
}
