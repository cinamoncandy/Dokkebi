import type { IndependentRiskLimits } from "../../../packages/core/src/independentRiskGateway";
import { CLOUD_PAPER_RISK_LIMITS } from "./cloudPaperCanonicalRiskGateway";

/**
 * The canonical Cloud PAPER risk limits are fixed KRW amounts (CLOUD_PAPER_RISK_LIMITS). With a KRW 100,000 account a
 * KRW 2,000,000 order cap and a KRW 1,000,000 daily-loss cap never bind. Owner decision 2026-10-28: scale the KRW limits
 * with the PAPER initial capital. Every limit becomes min(fixed limit, ratio x capital), so this can only tighten a
 * limit, never loosen one; counts, ratios and the loss-limit policy are passed through unchanged. Owner decision 2026-11-04 raised the
 * daily buy and sell ratios from 1 to 3; they are still capped by min(fixed limit, ratio x capital), so they stay below the fixed canonical limit.
 */
export const PAPER_RISK_CAPITAL_RATIOS = Object.freeze({
  maxOrderNotional: 0.2,
  maxPositionNotional: 0.5,
  maxSymbolExposureNotional: 0.5,
  maxPortfolioExposureNotional: 1,
  // Owner decision 2026-11-04: 3x capital per day (KRW 300,000 at KRW 100,000). Still below the fixed canonical KRW 2,000,000 limit.
  maxDailyBuyNotional: 3,
  maxDailySellNotional: 3,
  maxDailyLoss: 0.1,
} as const);

export function scalePaperRiskLimitsToCapital(base: IndependentRiskLimits, initialCapital: number): IndependentRiskLimits {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error("cloud PAPER initial capital is invalid");
  const scaled: Record<string, number | boolean | undefined> = { ...base };
  for (const [name, ratio] of Object.entries(PAPER_RISK_CAPITAL_RATIOS)) {
    const fixed = base[name as keyof typeof PAPER_RISK_CAPITAL_RATIOS];
    scaled[name] = Math.min(fixed, Math.round(initialCapital * ratio));
  }
  return Object.freeze(scaled) as unknown as IndependentRiskLimits;
}

/**
 * The one source of the Cloud PAPER risk limits for a given initial capital. The canonical gateway enforces exactly this
 * object, and closed-learning evidence fingerprints exactly this object, so evidence names the policy that is enforced.
 */
export function cloudPaperRiskLimitsForCapital(initialCapital: number): IndependentRiskLimits {
  return scalePaperRiskLimitsToCapital(CLOUD_PAPER_RISK_LIMITS, initialCapital);
}
