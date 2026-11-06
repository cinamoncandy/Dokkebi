const test = require('node:test');
const assert = require('node:assert/strict');
const { replayFills, summarizeTradingDay, ledgerRound8 } = require('../dist/apps/cloud/src/paperFillReplay.js');
const { paperTradingDayKey } = require('../dist/apps/cloud/src/paperTradingDay.js');
const { computeTodayRealizedPnlKrw } = require('../dist/apps/cloud/src/paperTodayRealized.js');

// Stage 1 of the fill-replay unification (docs/DESIGN_IMPROVEMENT_20261106.md 4-1). The shared replay must equal the RISK gateway's
// realizedLossState (reference copy below, taken from cloudPaperCanonicalRiskGateway.ts after #2999) and follow the ledger's rounding.
const NOW = Date.parse('2026-11-04T12:00:00Z');
const T = NOW - 3_600_000;
const round8 = (v) => Number(v.toFixed(8));
const lcg = (seed) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };

function referenceGatewayState(storedFills, now) {
  const positions = new Map();
  const sells = [];
  const sellOrders = new Map();
  const day = paperTradingDayKey;
  for (const order of [...storedFills].reverse().sort((a, b) => a.filledAt - b.filledAt)) {
    const prior = positions.get(order.market) ?? { quantity: 0, averageEntryPrice: 0 };
    if (order.side === 'BUY') {
      const q = round8(prior.quantity + order.quantity);
      positions.set(order.market, { quantity: q, averageEntryPrice: q <= 0 ? 0 : (prior.averageEntryPrice * prior.quantity + order.quantity * order.price + order.fee) / q });
      continue;
    }
    if (order.quantity > prior.quantity + Number.EPSILON) return { dailyRealizedPnL: NaN, consecutiveLossCount: Number.MAX_SAFE_INTEGER, todayCompletedSells: 0, todayLosingSells: 0, lastIncrementAt: null };
    const pnl = (order.price - prior.averageEntryPrice) * order.quantity - order.fee;
    const q = round8(Math.max(0, prior.quantity - order.quantity));
    positions.set(order.market, { quantity: q, averageEntryPrice: q === 0 ? 0 : prior.averageEntryPrice });
    sells.push({ pnl, filledAt: order.filledAt });
    const prev = sellOrders.get(order.orderId);
    sellOrders.set(order.orderId, { pnl: (prev?.pnl ?? 0) + pnl, filledAt: order.filledAt });
  }
  const today = day(now);
  const dailyRealizedPnL = sells.filter((s) => day(s.filledAt) === today).reduce((a, s) => a + s.pnl, 0);
  let streak = 0;
  const completed = [...sellOrders.values()].filter((s) => day(s.filledAt) === today).sort((a, b) => a.filledAt - b.filledAt);
  for (let i = completed.length - 1; i >= 0; i -= 1) { if (completed[i].pnl >= 0) break; streak += 1; }
  return { dailyRealizedPnL, consecutiveLossCount: streak, todayCompletedSells: completed.length, todayLosingSells: completed.filter((s) => s.pnl < 0).length, lastIncrementAt: streak === 0 ? null : completed[completed.length - 1].filledAt };
}

// A ledger-consistent history: 8-decimal rounded quantities, a sell never exceeds the held quantity, sells split over several orders.
function history(next, scale) {
  const fills = [];
  let held = 0;
  let at = T;
  let n = 0;
  const steps = 3 + Math.floor(next() * 8);
  for (let i = 0; i < steps; i += 1) {
    at += 1_000 + Math.floor(next() * 5_000);
    n += 1;
    const price = 10 + Math.floor(next() * 40);
    if (held === 0 || next() < 0.35) {
      const quantity = round8(scale * (0.2 + next()) + next() * 1e-6);
      fills.push({ market: 'KRW-BMT', orderId: `o${n}`, side: 'BUY', quantity, price, fee: round8(next() * 5), filledAt: at });
      held = round8(held + quantity);
    } else {
      const quantity = next() < 0.4 ? held : round8(held * (0.1 + next() * 0.8));
      if (quantity <= 0) continue;
      fills.push({ market: 'KRW-BMT', orderId: `o${next() < 0.5 ? n : n - 1}`, side: 'SELL', quantity, price, fee: round8(next() * 5), filledAt: at });
      held = round8(held - quantity);
    }
  }
  return fills.reverse(); // stored newest first
}

test('shared replay and day summary equal the RISK gateway reference on ledger-consistent histories (1,800 histories, six quantity scales)', () => {
  const next = lcg(20261106);
  for (const scale of [0.0004, 0.05, 3, 120, 4_000, 90_000]) {
    for (let i = 0; i < 300; i += 1) {
      const stored = history(next, scale);
      const replay = replayFills(stored);
      const reference = referenceGatewayState(stored, NOW);
      assert.equal(replay.ok, !Number.isNaN(reference.dailyRealizedPnL), `scale ${scale} case ${i}`);
      if (!replay.ok) continue;
      assert.deepEqual(summarizeTradingDay(replay.sells, NOW), reference, `scale ${scale} case ${i}`);
    }
  }
});

test('an oversell of one ledger step (1e-8) or more is not ok; the held quantity is ok', () => {
  const total = 3213.68761509;
  const buy = { market: 'KRW-BMT', orderId: 'b', side: 'BUY', quantity: total, price: 30, fee: 0, filledAt: T };
  const sell = (q) => ({ market: 'KRW-BMT', orderId: 's', side: 'SELL', quantity: q, price: 31, fee: 0, filledAt: T + 1000 });
  assert.equal(replayFills([sell(total), buy]).ok, true);
  assert.deepEqual(replayFills([sell(round8(total + 1e-8)), buy]), { ok: false, reason: 'OVERSELL' });
  assert.deepEqual(replayFills([sell(round8(total + 0.5)), buy]), { ok: false, reason: 'OVERSELL' });
});

test('non-finite, zero or negative values are never ok (fail-closed)', () => {
  const base = { market: 'KRW-BMT', orderId: 'b', side: 'BUY', quantity: 1, price: 30, fee: 0, filledAt: T };
  for (const patch of [{ quantity: NaN }, { quantity: Infinity }, { quantity: 0 }, { quantity: -1 }, { price: NaN }, { fee: Infinity }, { filledAt: NaN }]) {
    assert.deepEqual(replayFills([{ ...base, ...patch }]), { ok: false, reason: 'INVALID_FILL_VALUE' }, JSON.stringify(patch));
  }
});

test('fills stored out of order replay chronologically and a sell before its buy is not ok', () => {
  const buy = { market: 'KRW-BMT', orderId: 'b', side: 'BUY', quantity: 5, price: 30, fee: 0, filledAt: T + 5000 };
  const sell = { market: 'KRW-BMT', orderId: 's', side: 'SELL', quantity: 5, price: 31, fee: 0, filledAt: T + 1000 };
  assert.deepEqual(replayFills([buy, sell]), { ok: false, reason: 'OVERSELL' });
  const early = { ...buy, filledAt: T };
  assert.equal(replayFills([sell, early]).ok, true);
});

test('the display figure computeTodayRealizedPnlKrw equals the shared summary for consistent histories', () => {
  const next = lcg(555);
  for (let i = 0; i < 300; i += 1) {
    const stored = history(next, [0.05, 3, 4_000][i % 3]);
    const replay = replayFills(stored);
    assert.equal(replay.ok, true);
    const positions = [...replay.positions].filter(([, p]) => p.quantity > 0).map(([market, p]) => ({ market, quantity: p.quantity }));
    const figure = computeTodayRealizedPnlKrw(stored, positions, NOW);
    assert.notEqual(figure, null, `case ${i}`);
    assert.equal(figure, summarizeTradingDay(replay.sells, NOW).dailyRealizedPnL, `case ${i}`);
  }
});
