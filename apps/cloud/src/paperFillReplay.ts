import { paperTradingDayKey } from "./paperTradingDay";

/**
 * One fill replay for every reader of the PAPER fill history (stage 1 of docs/DESIGN_IMPROVEMENT_20261106.md, item 4-1).
 *
 * The ledger (PaperTradingExecutionLoop) keeps position quantities rounded to 8 decimals. Readers that replay the same fills in raw
 * floating point see different quantities and can call a normal history an oversell: that halted every BUY for a day in #2999 and
 * made two display figures unknown in #3003. This module replays like the ledger (same rounding, same step), exactly as the
 * RISK gateway's realizedLossState and the two display readers do after those fixes, and fails closed.
 *
 * Stage 1 only adds this module and its tests. No existing reader calls it yet: the RISK gateway is a pinned qualification module,
 * so switching it needs the formal requalification path (owner-approved start 2026-11-06); the display readers follow after #3003.
 */
export interface ReplayFill {
  readonly market: string;
  readonly orderId: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly price: number;
  readonly fee: number;
  readonly filledAt: number;
}

export interface ReplaySell {
  readonly market: string;
  readonly orderId: string;
  readonly filledAt: number;
  readonly pnl: number;
}

export interface ReplayPosition {
  readonly quantity: number;
  readonly averageEntryPrice: number;
}

export type FillReplayResult =
  | Readonly<{ ok: true; sells: readonly ReplaySell[]; positions: ReadonlyMap<string, ReplayPosition> }>
  | Readonly<{ ok: false; reason: "INVALID_FILL_VALUE" | "OVERSELL" }>;

/** Same function and same step as the ledger's round8. */
export const ledgerRound8 = (value: number): number => Number(value.toFixed(8));

/**
 * `fills` is the account's fill list as stored (newest first, like PaperAccountState.fills). It is replayed chronologically; ties keep the
 * oldest-first order of the stored list. A non-finite or non-positive quantity, a non-finite price, fee or time, or a sell larger than the
 * replayed position (comparison unchanged: quantity > held + Number.EPSILON) yields ok:false. Callers must treat ok:false as "unknown".
 */
export function replayFills(fills: readonly ReplayFill[]): FillReplayResult {
  const positions = new Map<string, ReplayPosition>();
  const sells: ReplaySell[] = [];
  for (const fill of [...fills].reverse().sort((a, b) => a.filledAt - b.filledAt)) {
    if (![fill.quantity, fill.price, fill.fee, fill.filledAt].every(Number.isFinite) || fill.quantity <= 0) return { ok: false, reason: "INVALID_FILL_VALUE" };
    const prior = positions.get(fill.market) ?? { quantity: 0, averageEntryPrice: 0 };
    if (fill.side === "BUY") {
      const quantity = ledgerRound8(prior.quantity + fill.quantity);
      const averageEntryPrice = quantity <= 0 ? 0 : (prior.averageEntryPrice * prior.quantity + fill.quantity * fill.price + fill.fee) / quantity;
      positions.set(fill.market, { quantity, averageEntryPrice });
      continue;
    }
    if (fill.quantity > prior.quantity + Number.EPSILON) return { ok: false, reason: "OVERSELL" };
    const pnl = (fill.price - prior.averageEntryPrice) * fill.quantity - fill.fee;
    const quantity = ledgerRound8(Math.max(0, prior.quantity - fill.quantity));
    positions.set(fill.market, { quantity, averageEntryPrice: quantity === 0 ? 0 : prior.averageEntryPrice });
    sells.push({ market: fill.market, orderId: fill.orderId, filledAt: fill.filledAt, pnl });
  }
  return { ok: true, sells, positions };
}

export interface DayLossSummary {
  readonly dailyRealizedPnL: number;
  readonly consecutiveLossCount: number;
  readonly todayCompletedSells: number;
  readonly todayLosingSells: number;
  readonly lastIncrementAt: number | null;
}

/**
 * Today's (Asia/Seoul) figures from a successful replay: realized PnL of today's sells, and the loss streak over today's completed sell
 * orders (a sell order's fills are summed, like the gateway groups them).
 */
export function summarizeTradingDay(sells: readonly ReplaySell[], now: number): DayLossSummary {
  const today = paperTradingDayKey(now);
  const dailyRealizedPnL = sells.filter((sell) => paperTradingDayKey(sell.filledAt) === today).reduce((sum, sell) => sum + sell.pnl, 0);
  const orders = new Map<string, { pnl: number; filledAt: number }>();
  for (const sell of sells) {
    const previous = orders.get(sell.orderId);
    orders.set(sell.orderId, { pnl: (previous?.pnl ?? 0) + sell.pnl, filledAt: sell.filledAt });
  }
  const completed = [...orders.values()].filter((sell) => paperTradingDayKey(sell.filledAt) === today).sort((a, b) => a.filledAt - b.filledAt);
  let consecutiveLossCount = 0;
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    if (completed[index]!.pnl >= 0) break;
    consecutiveLossCount += 1;
  }
  return {
    dailyRealizedPnL,
    consecutiveLossCount,
    todayCompletedSells: completed.length,
    todayLosingSells: completed.filter((sell) => sell.pnl < 0).length,
    lastIncrementAt: consecutiveLossCount === 0 ? null : completed[completed.length - 1]!.filledAt
  };
}
