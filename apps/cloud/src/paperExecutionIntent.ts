import { createHash } from "node:crypto";
import type { CioDecision } from "./cioDecisionEngine";
import type { PortfolioPlan } from "./portfolioOrchestrator";
import type { PaperAccountState } from "./paperTradingExecutionLoop";

const SHA256 = /^[a-f0-9]{64}$/;
const round8 = (value: number): number => Number(value.toFixed(8));
const canonicalHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/** Upbit KRW spot minimum order value. Owner decision 2026-09-30: PAPER must only place orders the exchange would accept. */
export const UPBIT_KRW_MINIMUM_ORDER_KRW = 5_000;
/** Headroom so a fill slightly below the reference price cannot dip the executed notional under the minimum. */
export const MINIMUM_ORDER_HEADROOM_RATIO = 1.01;
/** Hard ceiling on the share of account equity a minimum-order raise may commit to one order. */
export const MINIMUM_ORDER_MAX_EQUITY_RATIO = 0.6;
/** Cash must cover the raised order plus the exchange fee (0.05%) with margin. */
export const MINIMUM_ORDER_FEE_RESERVE_RATIO = 1.005;

/**
 * A portfolio-planned BUY below the exchange minimum is raised to the minimum (plus headroom) only when that
 * stays within the equity ceiling and the account can pay for it; otherwise it fails closed. A planned BUY that
 * already meets the minimum, and every non-KRW market, is returned unchanged. The raise never applies to a
 * zero or negative plan, so a zero investment percentage still means no order.
 */
export function applyExchangeMinimumOrder(input: { readonly market: string; readonly plannedCapital: number; readonly equity: number; readonly cash: number }): Readonly<{ allocationCapital: number; raised: boolean }> {
  const unchanged = Object.freeze({ allocationCapital: input.plannedCapital, raised: false });
  if (!input.market.trim().toUpperCase().startsWith("KRW-")) return unchanged;
  const target = round8(UPBIT_KRW_MINIMUM_ORDER_KRW * MINIMUM_ORDER_HEADROOM_RATIO);
  if (input.plannedCapital >= target) return unchanged;
  if (!Number.isFinite(input.equity) || input.equity <= 0 || target > input.equity * MINIMUM_ORDER_MAX_EQUITY_RATIO) {
    throw new Error("PAPER_EXECUTION_INTENT_MINIMUM_ORDER_EXCEEDS_EQUITY_CEILING");
  }
  if (!Number.isFinite(input.cash) || target * MINIMUM_ORDER_FEE_RESERVE_RATIO > input.cash) {
    throw new Error("PAPER_EXECUTION_INTENT_MINIMUM_ORDER_EXCEEDS_CASH");
  }
  return Object.freeze({ allocationCapital: target, raised: true });
}

export interface PaperExecutionIntent {
  readonly schemaVersion: 1;
  readonly source: "PORTFOLIO_PLAN";
  readonly authority: "PAPER_ONLY";
  readonly liveAuthority: "NONE";
  readonly productionMutationAllowed: false;
  readonly aiAuthority: "ZERO_AUTHORITY";
  readonly market: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly referencePrice: number;
  readonly portfolioDecidedAt: number;
  readonly decisionDecidedAt: number;
  readonly allocationCapital: number;
  readonly allocationShare: number;
  /** Owner-selected PAPER capital scaler applied after PortfolioPlan target construction. */
  readonly investmentPercent: number;
  readonly candidateId: string;
  readonly candidateBindingFingerprintSha256: string;
  readonly intentFingerprintSha256: string;
}

export interface PaperExecutionIntentInput {
  readonly now: number;
  readonly market: string;
  readonly referencePrice: number;
  readonly portfolio: PortfolioPlan;
  readonly decision: CioDecision;
  readonly state: PaperAccountState;
  readonly investmentPercent: number;
  /**
   * The enforced per-order notional cap (the risk gate's own `maxOrderNotional`). When set, a SELL exit is sized to at most
   * this notional per order, so a position larger than the cap leaves in several orders instead of being rejected whole.
   * It never raises a quantity and is not a risk limit of its own; absent means the whole position (previous behaviour).
   */
  readonly maxOrderNotional?: number;
}

const payload = (intent: Omit<PaperExecutionIntent, "intentFingerprintSha256">): Omit<PaperExecutionIntent, "intentFingerprintSha256"> => intent;

function requireFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
}

function requireUnit(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be between 0 and 1`);
}

export function buildPaperExecutionIntent(input: PaperExecutionIntentInput): PaperExecutionIntent {
  const market = input.market.trim().toUpperCase();
  if (!market || input.decision.symbol.trim().toUpperCase() !== market) throw new Error("PAPER_EXECUTION_INTENT_MARKET_MISMATCH");
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("PAPER_EXECUTION_INTENT_TIME_INVALID");
  requireFinitePositive(input.referencePrice, "referencePrice");
  if (input.decision.action !== "BUY" && input.decision.action !== "SELL") throw new Error("PAPER_EXECUTION_INTENT_ACTION_INVALID");
  if (!Number.isSafeInteger(input.decision.decidedAt) || input.decision.decidedAt < 0 || input.decision.decidedAt > input.now) throw new Error("PAPER_EXECUTION_INTENT_DECISION_TIME_INVALID");
  if (!Number.isSafeInteger(input.portfolio.decidedAt) || input.portfolio.decidedAt !== input.decision.decidedAt) throw new Error("PAPER_EXECUTION_INTENT_PORTFOLIO_DECISION_MISMATCH");

  const binding = input.decision.paperCandidateBinding;
  if (binding == null || !binding.candidateId.trim() || !SHA256.test(binding.bindingFingerprintSha256)) {
    throw new Error("PAPER_EXECUTION_INTENT_CANDIDATE_BINDING_REQUIRED");
  }

  const portfolioCapital = input.portfolio.deployedCapital + input.portfolio.cashCapital + input.portfolio.reservedCapital;
  const tolerance = Math.max(0.01, Math.abs(input.state.equity) * 1e-8);
  if (!Number.isFinite(portfolioCapital) || Math.abs(portfolioCapital - input.state.equity) > tolerance) {
    throw new Error("PAPER_EXECUTION_INTENT_ACCOUNT_PORTFOLIO_MISMATCH");
  }

  const allocations = input.portfolio.allocations.filter((allocation) =>
    allocation.symbol.trim().toUpperCase() === market && allocation.instrument === "SPOT"
  );
  if (allocations.length > 1) throw new Error("PAPER_EXECUTION_INTENT_PORTFOLIO_AMBIGUOUS");

  const side = input.decision.action === "BUY" ? "BUY" as const : "SELL" as const;
  if (!Number.isFinite(input.investmentPercent) || input.investmentPercent < 0 || input.investmentPercent > 100) {
    throw new Error("PAPER_EXECUTION_INTENT_INVESTMENT_PERCENT_INVALID");
  }

  let allocationCapital = 0;
  let allocationShare = 0;
  let quantity = 0;

  if (side === "BUY") {
    const allocation = allocations[0];
    if (allocation == null) throw new Error("PAPER_EXECUTION_INTENT_PORTFOLIO_ALLOCATION_REQUIRED");
    if (allocation.action !== "BUY" || allocation.leverage !== 1 || allocation.risk !== input.decision.risk || allocation.confidence !== input.decision.confidence) {
      throw new Error("PAPER_EXECUTION_INTENT_PORTFOLIO_ALLOCATION_MISMATCH");
    }
    requireUnit(allocation.share, "allocationShare");
    requireFinitePositive(allocation.capital, "allocationCapital");
    if (allocation.share > input.decision.allocation + 1e-8) throw new Error("PAPER_EXECUTION_INTENT_ALLOCATION_EXCEEDS_DECISION");
    const plannedCapital = Number((allocation.capital * (input.investmentPercent / 100)).toFixed(8));
    const plannedShare = Number((allocation.share * (input.investmentPercent / 100)).toFixed(8));
    if (plannedCapital <= 0 || plannedShare <= 0 || round8(plannedCapital / input.referencePrice) <= 0) throw new Error("PAPER_EXECUTION_INTENT_ALLOCATION_ZERO");
    // Cash already promised to open BUY working orders cannot pay for a second raised order.
    const committedCash = (input.state.workingOrders ?? [])
      .filter((order) => order.side === "BUY")
      .reduce((sum, order) => sum + (order.remainingAllocationCapital ?? order.lifecycle.remainingQuantity * (order.limitPrice ?? input.referencePrice)), 0);
    const minimumOrder = applyExchangeMinimumOrder({ market, plannedCapital, equity: input.state.equity, cash: input.state.cash - committedCash });
    allocationCapital = minimumOrder.allocationCapital;
    allocationShare = minimumOrder.raised ? Number((allocationCapital / input.state.equity).toFixed(8)) : plannedShare;
    quantity = round8(allocationCapital / input.referencePrice);
    if (allocationCapital <= 0 || allocationShare <= 0 || quantity <= 0) throw new Error("PAPER_EXECUTION_INTENT_ALLOCATION_ZERO");
  } else {
    if (allocations.length !== 0) throw new Error("PAPER_EXECUTION_INTENT_EXIT_TARGET_NOT_ZERO");
    const position = input.state.positions.find((item) => item.market === market);
    quantity = round8(position?.quantity ?? 0);
    if (quantity <= 0) throw new Error("PAPER_EXECUTION_INTENT_POSITION_REQUIRED");
    const cap = input.maxOrderNotional;
    if (cap !== undefined && Number.isFinite(cap) && cap > 0 && quantity * input.referencePrice > cap) {
      // Round down so the capped order can never exceed the cap; the strategy keeps emitting SELL for the remainder.
      const chunk = Math.floor((cap / input.referencePrice) * 1e8) / 1e8;
      if (chunk > 0 && chunk < quantity) quantity = round8(chunk);
    }
  }

  requireFinitePositive(quantity, "quantity");
  const canonical: Omit<PaperExecutionIntent, "intentFingerprintSha256"> = Object.freeze({
    schemaVersion: 1,
    source: "PORTFOLIO_PLAN",
    authority: "PAPER_ONLY",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
    market,
    side,
    quantity,
    referencePrice: input.referencePrice,
    portfolioDecidedAt: input.portfolio.decidedAt,
    decisionDecidedAt: input.decision.decidedAt,
    allocationCapital,
    allocationShare,
    investmentPercent: input.investmentPercent,
    candidateId: binding.candidateId.trim(),
    candidateBindingFingerprintSha256: binding.bindingFingerprintSha256,
  });
  return Object.freeze({ ...canonical, intentFingerprintSha256: canonicalHash(payload(canonical)) });
}

export function validatePaperExecutionIntent(intent: PaperExecutionIntent): PaperExecutionIntent {
  if (intent.schemaVersion !== 1 || intent.source !== "PORTFOLIO_PLAN" || intent.authority !== "PAPER_ONLY" ||
      intent.liveAuthority !== "NONE" || intent.productionMutationAllowed !== false || intent.aiAuthority !== "ZERO_AUTHORITY") {
    throw new Error("PAPER_EXECUTION_INTENT_AUTHORITY_INVALID");
  }
  if (!intent.market.trim() || (intent.side !== "BUY" && intent.side !== "SELL")) throw new Error("PAPER_EXECUTION_INTENT_IDENTITY_INVALID");
  requireFinitePositive(intent.quantity, "quantity");
  requireFinitePositive(intent.referencePrice, "referencePrice");
  if (!Number.isSafeInteger(intent.portfolioDecidedAt) || !Number.isSafeInteger(intent.decisionDecidedAt) ||
      intent.portfolioDecidedAt < 0 || intent.decisionDecidedAt < 0 || intent.portfolioDecidedAt !== intent.decisionDecidedAt) {
    throw new Error("PAPER_EXECUTION_INTENT_TIME_INVALID");
  }
  if (!Number.isFinite(intent.allocationCapital) || intent.allocationCapital < 0) throw new Error("PAPER_EXECUTION_INTENT_CAPITAL_INVALID");
  requireUnit(intent.allocationShare, "allocationShare");
  if (!Number.isFinite(intent.investmentPercent) || intent.investmentPercent < 0 || intent.investmentPercent > 100) throw new Error("PAPER_EXECUTION_INTENT_INVESTMENT_PERCENT_INVALID");
  if (intent.side === "BUY" && (intent.allocationCapital <= 0 || intent.allocationShare <= 0)) throw new Error("PAPER_EXECUTION_INTENT_BUY_ALLOCATION_INVALID");
  if (intent.side === "SELL" && (intent.allocationCapital !== 0 || intent.allocationShare !== 0)) throw new Error("PAPER_EXECUTION_INTENT_SELL_ALLOCATION_INVALID");
  if (!intent.candidateId.trim() || !SHA256.test(intent.candidateBindingFingerprintSha256) || !SHA256.test(intent.intentFingerprintSha256)) {
    throw new Error("PAPER_EXECUTION_INTENT_PROVENANCE_INVALID");
  }
  const expected = canonicalHash(payload({
    schemaVersion: intent.schemaVersion,
    source: intent.source,
    authority: intent.authority,
    liveAuthority: intent.liveAuthority,
    productionMutationAllowed: intent.productionMutationAllowed,
    aiAuthority: intent.aiAuthority,
    market: intent.market.trim().toUpperCase(),
    side: intent.side,
    quantity: intent.quantity,
    referencePrice: intent.referencePrice,
    portfolioDecidedAt: intent.portfolioDecidedAt,
    decisionDecidedAt: intent.decisionDecidedAt,
    allocationCapital: intent.allocationCapital,
    allocationShare: intent.allocationShare,
    investmentPercent: intent.investmentPercent,
    candidateId: intent.candidateId.trim(),
    candidateBindingFingerprintSha256: intent.candidateBindingFingerprintSha256,
  }));
  if (intent.intentFingerprintSha256 !== expected) throw new Error("PAPER_EXECUTION_INTENT_FINGERPRINT_MISMATCH");
  return intent;
}

export function paperExecutionIntentCommandId(intent: PaperExecutionIntent): string {
  const validated = validatePaperExecutionIntent(intent);
  return `paper-intent:${validated.intentFingerprintSha256}`;
}
