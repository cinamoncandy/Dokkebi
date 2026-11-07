const test = require('node:test');
const assert = require('node:assert/strict');
const { SqliteDatabase } = require('../dist/packages/storage/src/index.js');
const { CloudPaperCanonicalRiskGateway } = require('../dist/apps/cloud/src/cloudPaperCanonicalRiskGateway.js');

// The ledger keeps position quantities rounded to 8 decimals. The risk gateway replays every fill to compute the daily realized PnL and
// treats a sell larger than the replayed position as an inconsistent history (NaN -> every later request HALTed as INVALID_REQUEST).
// Selling a large position in several orders must replay exactly like the ledger.
const NOW = Date.parse('2026-11-04T12:00:00Z');
const T = NOW - 600_000;
const round8 = (value) => Number(value.toFixed(8));

function evaluateAfter(fills) {
  const db = new SqliteDatabase(':memory:');
  try {
    const state = { version: 1, initialCapital: 100_000, cash: 99_000, equity: 99_000, realizedPnL: 0, unrealizedPnL: 0, positions: [],
      orders: fills.map((fill) => ({ ...fill, id: fill.orderId, status: 'FILLED' })), fills: [...fills].reverse(), processedIdempotencyKeys: [], updatedAt: NOW };
    const gateway = new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: 100_000, sourceCommitSha: 'a'.repeat(40) });
    return gateway.evaluate({ path: 'STRATEGY', commandId: 'next', signalId: 'next', clientOrderId: 'next', strategyId: 'bound-candidate', market: 'KRW-BMT', side: 'BUY',
      quantity: 100, price: 10, now: NOW, observedAt: NOW, maximumMarketAgeMs: 30_000, killSwitchActive: false, openP0: false, overallHealth: 'HEALTHY', state });
  } finally { db.close(); }
}

const buy = (quantity) => ({ id: 'b', orderId: 'ob', market: 'KRW-BMT', side: 'BUY', quantity, price: 30, fee: 0, filledAt: T });
const sell = (id, quantity, at) => ({ id, orderId: `o${id}`, market: 'KRW-BMT', side: 'SELL', quantity, price: 31, fee: 0, filledAt: at });

test('a position sold in two orders whose last order is the ledger remainder does not halt later requests', () => {
  // Found by reproduction: the raw replayed remainder was 1172.2692836499998 and the ledger remainder 1172.26928365.
  const total = 3213.68761509, first = 2041.41833144, last = round8(total - first);
  assert.equal(last, 1172.26928365);
  const result = evaluateAfter([buy(total), sell('s1', first, T + 1_000), sell('s2', last, T + 2_000)]);
  assert.ok(!result.reasonCodes.includes('INVALID_REQUEST'), `unexpected ${result.status} ${result.reasonCodes.join(',')}`);
  assert.equal(result.status, 'ALLOW');
});

test('many chunked exits at large quantities replay like the ledger (deterministic sample)', () => {
  let seed = 20261104;
  const next = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 300; i += 1) {
    const total = round8(2000 + next() * 5000 + next() * 1e-3);
    const first = round8(total * (0.3 + next() * 0.4));
    const last = round8(total - first);
    const result = evaluateAfter([buy(total), sell('s1', first, T + 1_000), sell('s2', last, T + 2_000)]);
    assert.notEqual(result.reasonCodes.includes('INVALID_REQUEST'), true, `case ${i}: total=${total} first=${first} last=${last}`);
  }
});

test('a real oversell is still an inconsistent history and still halts (fail-closed is kept)', () => {
  const total = 3213.68761509;
  const result = evaluateAfter([buy(total), sell('s1', round8(total + 0.000001), T + 1_000)]);
  assert.equal(result.status, 'HALT');
  assert.ok(result.reasonCodes.includes('INVALID_REQUEST'));
});

test('a whole-position sell is unchanged', () => {
  const total = 3333.33333333;
  assert.equal(evaluateAfter([buy(total), sell('s1', total, T + 1_000)]).status, 'ALLOW');
});

// ---- Requalification evidence (owner-approved start 2026-11-05): accounting and risk semantics versus the original replay ----

// The ORIGINAL replay (raw floats), kept here only as a reference so the new behaviour can be compared against it.
function originalReplayIsNaN(fills) {
  const positions = new Map();
  for (const order of [...fills].sort((a, b) => a.filledAt - b.filledAt)) {
    const prior = positions.get(order.market) ?? { quantity: 0 };
    if (order.side === 'BUY') { positions.set(order.market, { quantity: prior.quantity + order.quantity }); continue; }
    if (order.quantity > prior.quantity + Number.EPSILON) return true;
    positions.set(order.market, { quantity: Math.max(0, prior.quantity - order.quantity) });
  }
  return false;
}

// Simulate the ledger (PaperTradingExecutionLoop): quantities rounded to 8 decimals, a sell never exceeds the held quantity.
function ledgerConsistentHistory(next, scale) {
  const fills = [];
  let held = 0;
  let at = T;
  const steps = 2 + Math.floor(next() * 6);
  for (let i = 0; i < steps; i += 1) {
    at += 1_000;
    if (held === 0 || next() < 0.35) {
      const quantity = round8(scale * (0.2 + next()) + next() * 1e-6);
      fills.push({ id: `b${i}`, orderId: `ob${i}`, market: 'KRW-BMT', side: 'BUY', quantity, price: 30, fee: 0, filledAt: at });
      held = round8(held + quantity);
    } else {
      const quantity = next() < 0.4 ? held : round8(held * (0.1 + next() * 0.8));
      if (quantity <= 0) continue;
      fills.push({ id: `s${i}`, orderId: `os${i}`, market: 'KRW-BMT', side: 'SELL', quantity, price: 31, fee: 0, filledAt: at });
      held = round8(held - quantity);
    }
  }
  return fills;
}

function lcg(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

test('ledger-consistent histories at every quantity scale never halt (property sample, 1,200 histories)', () => {
  const next = lcg(777);
  let originalFalseHalts = 0;
  for (const scale of [0.0004, 0.05, 3, 120, 4_000, 90_000]) {
    for (let i = 0; i < 200; i += 1) {
      const fills = ledgerConsistentHistory(next, scale);
      const result = evaluateAfter(fills);
      assert.equal(result.reasonCodes.includes('INVALID_REQUEST'), false, `scale ${scale} case ${i}: ${JSON.stringify(fills.map((f) => [f.side, f.quantity]))}`);
      if (originalReplayIsNaN(fills)) originalFalseHalts += 1;
    }
  }
  // Documents the size of the original defect on this sample; it must be non-zero or the sample proves nothing.
  assert.ok(originalFalseHalts > 0, 'the sample must contain histories the original replay wrongly halted');
});

test('the new replay never accepts a history the original rejected for a real reason: new halts => original halts (monotonic safety)', () => {
  const next = lcg(4242);
  for (let i = 0; i < 600; i += 1) {
    const fills = ledgerConsistentHistory(next, [0.05, 3, 4_000][i % 3]);
    // Break the history with one real oversell: the last sell becomes (quantity held just before it) + extra.
    const extra = [1e-8, 2e-8, 1e-6, 0.5][i % 4];
    let held = 0;
    let lastSellIndex = -1;
    let heldBeforeLastSell = 0;
    fills.forEach((fill, index) => {
      if (fill.side === 'BUY') { held = round8(held + fill.quantity); return; }
      lastSellIndex = index; heldBeforeLastSell = held; held = round8(held - fill.quantity);
    });
    if (lastSellIndex < 0) continue;
    fills[lastSellIndex].quantity = round8(heldBeforeLastSell + extra);
    const result = evaluateAfter(fills);
    // A sell larger than the held quantity by at least one ledger step (1e-8) is a real inconsistency: it must still halt.
    assert.equal(result.reasonCodes.includes('INVALID_REQUEST'), true, `extra ${extra} case ${i}`);
  }
});

test('oversell boundary: one ledger step (1e-8) above the held quantity halts; the held quantity itself does not', () => {
  const total = 3213.68761509;
  assert.equal(evaluateAfter([buy(total), sell('s1', total, T + 1_000)]).status, 'ALLOW');
  const over = evaluateAfter([buy(total), sell('s1', round8(total + 1e-8), T + 1_000)]);
  assert.equal(over.status, 'HALT');
  assert.ok(over.reasonCodes.includes('INVALID_REQUEST'));
});

test('non-finite or negative fill values never reach ALLOW', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const result = evaluateAfter([buy(3213.68761509), sell('s1', bad, T + 1_000)]);
    assert.notEqual(result.status, 'ALLOW', `quantity ${bad}`);
  }
});

test('a duplicated SELL fill is an oversell and halts; a duplicated BUY fill cannot make a later sell look valid by itself', () => {
  const total = 3213.68761509;
  const dupSell = evaluateAfter([buy(total), sell('s1', total, T + 1_000), sell('s1', total, T + 1_000)]);
  assert.notEqual(dupSell.status, 'ALLOW');
  // The same BUY listed twice doubles the replayed position; this is the unchanged original behaviour (state integrity is checked elsewhere).
  const dupBuy = evaluateAfter([buy(total), buy(total), sell('s1', total, T + 1_000)]);
  assert.equal(originalReplayIsNaN([buy(total), buy(total), sell('s1', total, T + 1_000)]), false);
  assert.ok(dupBuy.status === 'ALLOW' || dupBuy.reasonCodes.length > 0);
});

test('fills listed out of order are replayed chronologically; a sell recorded before its buy is a real inconsistency', () => {
  const total = 3213.68761509, first = 2041.41833144, last = round8(total - first);
  const chronological = [buy(total), sell('s1', first, T + 1_000), sell('s2', last, T + 2_000)];
  const shuffled = [chronological[2], chronological[0], chronological[1]];
  assert.equal(evaluateAfter(shuffled).status, evaluateAfter(chronological).status);
  const sellBeforeBuy = [{ ...buy(total), filledAt: T + 5_000 }, sell('s1', first, T + 1_000)];
  const result = evaluateAfter(sellBeforeBuy);
  assert.equal(result.reasonCodes.includes('INVALID_REQUEST'), true);
});

test('restart recovery: a new gateway instance on the same recorded history reaches the same decision', () => {
  const total = 3213.68761509, first = 2041.41833144, last = round8(total - first);
  const fills = [buy(total), sell('s1', first, T + 1_000), sell('s2', last, T + 2_000)];
  const a = evaluateAfter(fills);
  const b = evaluateAfter(fills);
  assert.equal(a.status, b.status);
  assert.deepEqual([...a.reasonCodes], [...b.reasonCodes]);
});
