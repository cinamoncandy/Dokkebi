import { paperTradingDayKey } from "./paperTradingDay";
import { replayFills } from "./paperFillReplay";
import type { PaperAccountPosition, PaperFillRecord } from "./paperTradingExecutionLoop";

/**
 * Display only: today's (Asia/Seoul) realized PAPER P&L in KRW, computed from the account's own fills for the owner's
 * app. It lives outside the RISK gateway on purpose (that source is pinned by requalification evidence) and uses the
 * same accounting the gateway uses for its daily figure: average entry price including buy fees, sell fee deducted,
 * only sells filled today count. It never feeds a decision. An inconsistent ledger (a sell larger than the position)
 * yields null rather than a guess.
 *
 * The PAPER state keeps only the newest fills. When older buys of a still-open position have been dropped, the average
 * entry would be rebuilt from the remaining buys only and the figure would be silently wrong. So the quantity rebuilt
 * from the retained fills must equal the account's own position quantity for every market; any mismatch yields null.
 */
const QUANTITY_TOLERANCE = 1e-9;

export function computeTodayRealizedPnlKrw(fills: readonly PaperFillRecord[], positions: readonly PaperAccountPosition[], now: number): number | null {
  if (!Number.isFinite(now)) return null;
  const replay = replayFills(fills);
  if (!replay.ok) return null;
  const today = paperTradingDayKey(now);
  const realized = replay.sells.filter((sell) => sell.filledAt <= now && paperTradingDayKey(sell.filledAt) === today).reduce((sum, sell) => sum + sell.pnl, 0);
  const held = new Map(positions.map((position) => [position.market, position.quantity]));
  for (const market of new Set([...held.keys(), ...replay.positions.keys()])) {
    const expected = held.get(market) ?? 0;
    const actual = replay.positions.get(market)?.quantity ?? 0;
    if (!Number.isFinite(expected) || Math.abs(expected - actual) > QUANTITY_TOLERANCE * Math.max(1, Math.abs(expected))) return null;
  }
  return Number.isFinite(realized) ? realized : null;
}

/**
 * Display only: the fill time of the losing sell that made today's (Asia/Seoul) consecutive-loss streak reach `max`, for the
 * owner's 24-hour ruler. Like the figure above it lives outside the pinned RISK gateway and never feeds a decision. It takes the
 * gateway's own streak count and only answers when the account's fills agree with it: sells are grouped per order exactly like
 * the gateway does, and the last `streak` of today's completed sells must all be losses. Anything inconsistent yields null.
 */
export function computeLimitReachedAt(fills: readonly PaperFillRecord[], now: number, streak: number, max: number): number | null {
  if (!Number.isFinite(now) || !Number.isSafeInteger(streak) || !Number.isSafeInteger(max) || max < 1 || streak < max) return null;
  const replay = replayFills(fills);
  if (!replay.ok) return null;
  const sellOrders = new Map<string, { pnl: number; filledAt: number }>();
  for (const sell of replay.sells) {
    const previous = sellOrders.get(sell.orderId);
    sellOrders.set(sell.orderId, { pnl: (previous?.pnl ?? 0) + sell.pnl, filledAt: sell.filledAt });
  }
  const today = paperTradingDayKey(now);
  const completed = [...sellOrders.values()].filter((sell) => sell.filledAt <= now && paperTradingDayKey(sell.filledAt) === today).sort((a, b) => a.filledAt - b.filledAt);
  if (completed.length < streak) return null;
  const tail = completed.slice(completed.length - streak);
  if (!tail.every((sell) => sell.pnl < 0)) return null;
  if (completed.length > streak && completed[completed.length - streak - 1]!.pnl < 0) return null;
  return tail[max - 1]!.filledAt;
}
