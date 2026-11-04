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
