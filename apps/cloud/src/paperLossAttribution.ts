import type { PaperFillRecord } from "./paperTradingExecutionLoop";
import { paperTradingDayKey } from "./paperTradingDay";

// The ledger keeps quantities rounded to 8 decimals; replay the same way so a fully sold position ends at exactly 0.
const ledgerRound8 = (value: number): number => Number(value.toFixed(8));

/**
 * Display-only attribution of today's (Asia/Seoul trading day, the same one the risk loss session uses) completed sell orders to the strategy family that opened the position.
 * Each sell is attributed to the family bound to the most recent BUY fill that built the position in that market.
 * Families are published only as fixed codes; anything else is OTHER_FAMILY, and a position opened without a
 * candidate binding is UNATTRIBUTED. Integers only: no money, market, price or identifier leaves this module.
 */
export const LOSS_ATTRIBUTION_FAMILIES = Object.freeze({
  "sma-crossover": "SMA_CROSSOVER",
  "rsi-mean-reversion": "RSI_MEAN_REVERSION",
  "donchian-breakout": "DONCHIAN_BREAKOUT",
} as const);
export type LossAttributionCode = (typeof LOSS_ATTRIBUTION_FAMILIES)[keyof typeof LOSS_ATTRIBUTION_FAMILIES] | "OTHER_FAMILY" | "UNATTRIBUTED";

export interface PaperLossAttribution {
  readonly evaluatedAt: number;
  readonly byFamily: Readonly<Partial<Record<LossAttributionCode, { readonly completedSells: number; readonly losingSells: number }>>>;
}

const dayOf = (timestamp: number): string => paperTradingDayKey(timestamp);

function familyCode(fill: PaperFillRecord): LossAttributionCode {
  const familyId = fill.candidateProvenance?.binding?.candidateStrategy?.familyId;
  if (typeof familyId !== "string") return "UNATTRIBUTED";
  return (LOSS_ATTRIBUTION_FAMILIES as Record<string, LossAttributionCode>)[familyId] ?? "OTHER_FAMILY";
}

export function attributeTodayLosses(fills: readonly PaperFillRecord[], now: number): PaperLossAttribution {
  const positions = new Map<string, { quantity: number; averageEntryPrice: number; family: LossAttributionCode }>();
  const sellOrders = new Map<string, { pnl: number; filledAt: number; family: LossAttributionCode }>();
  for (const fill of [...fills].sort((a, b) => a.filledAt - b.filledAt || a.id.localeCompare(b.id))) {
    const prior = positions.get(fill.market) ?? { quantity: 0, averageEntryPrice: 0, family: "UNATTRIBUTED" as LossAttributionCode };
    if (fill.side === "BUY") {
      const quantity = ledgerRound8(prior.quantity + fill.quantity);
      const averageEntryPrice = quantity <= 0 ? 0 : (prior.averageEntryPrice * prior.quantity + fill.quantity * fill.price + fill.fee) / quantity;
      positions.set(fill.market, { quantity, averageEntryPrice, family: familyCode(fill) });
      continue;
    }
    const pnl = (fill.price - prior.averageEntryPrice) * fill.quantity - fill.fee;
    const quantity = ledgerRound8(Math.max(0, prior.quantity - fill.quantity));
    positions.set(fill.market, { quantity, averageEntryPrice: quantity === 0 ? 0 : prior.averageEntryPrice, family: prior.family });
    const previous = sellOrders.get(fill.orderId);
    sellOrders.set(fill.orderId, { pnl: (previous?.pnl ?? 0) + pnl, filledAt: fill.filledAt, family: previous?.family ?? prior.family });
  }
  const today = dayOf(now);
  const byFamily: Partial<Record<LossAttributionCode, { completedSells: number; losingSells: number }>> = {};
  for (const sell of sellOrders.values()) {
    if (dayOf(sell.filledAt) !== today) continue;
    const entry = byFamily[sell.family] ?? { completedSells: 0, losingSells: 0 };
    entry.completedSells += 1;
    if (sell.pnl < 0) entry.losingSells += 1;
    byFamily[sell.family] = entry;
  }
  return Object.freeze({ evaluatedAt: now, byFamily: Object.freeze(Object.fromEntries(Object.entries(byFamily).map(([key, value]) => [key, Object.freeze({ ...value })]))) });
}
