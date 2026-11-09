const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTodayRealizedPnlKrw } = require('../dist/apps/cloud/src/paperTodayRealized.js');
const { attributeTodayLosses } = require('../dist/apps/cloud/src/paperLossAttribution.js');

// Display-only replays must see the same 8-decimal quantities as the ledger (same defect as the RISK gateway replay fixed in #2999).
const NOW = Date.parse('2026-11-04T12:00:00Z');
const T = NOW - 600_000;
const round8 = (v) => Number(v.toFixed(8));
const fill = (id, side, quantity, price, at) => ({ id, orderId: `o${id}`, market: 'KRW-BMT', side, quantity, price, fee: 0, filledAt: at });

test('today realized PnL is known (not null) after a position is sold in two ledger-rounded chunks', () => {
  const total = 3213.68761509, first = 2041.41833144, last = round8(total - first);
  const fills = [fill('b', 'BUY', total, 30, T), fill('s1', 'SELL', first, 31, T + 1000), fill('s2', 'SELL', last, 31, T + 2000)];
  const pnl = computeTodayRealizedPnlKrw(fills, [], NOW);
  assert.notEqual(pnl, null);
  assert.ok(Math.abs(pnl - total) < 1e-3, `pnl ${pnl}`);
});

test('a real oversell still yields null (fail-closed kept)', () => {
  const total = 3213.68761509;
  const fills = [fill('b', 'BUY', total, 30, T), fill('s1', 'SELL', round8(total + 1e-6), 31, T + 1000)];
  assert.equal(computeTodayRealizedPnlKrw(fills, [], NOW), null);
});

test('loss attribution still runs on chunked exits', () => {
  const total = 3213.68761509, first = 2041.41833144, last = round8(total - first);
  const fills = [fill('b', 'BUY', total, 30, T), fill('s1', 'SELL', first, 29, T + 1000), fill('s2', 'SELL', last, 29, T + 2000)];
  assert.ok(attributeTodayLosses(fills, NOW));
});

// Validator P2-1/P2-2 (PR #3003 review): dust that rounds to zero must not turn the figure into null by dividing by zero,
// and computeLimitReachedAt is covered on chunked exits.
const { computeLimitReachedAt } = require('../dist/apps/cloud/src/paperTodayRealized.js');

test('a dust BUY that rounds to zero at 8 decimals does not make the figure unknown', () => {
  const fills = [fill('d', 'BUY', 1e-10, 30, T), fill('b', 'BUY', 1, 30, T + 500), fill('s', 'SELL', 1, 31, T + 1000)];
  const pnl = computeTodayRealizedPnlKrw(fills.slice().reverse(), [], NOW);
  assert.notEqual(pnl, null);
  assert.ok(Math.abs(pnl - 1) < 1e-6, `pnl ${pnl}`);
});

test('computeLimitReachedAt answers for a streak made of chunked exits (ledger-rounded remainders)', () => {
  const total = 3213.68761509, first = 2041.41833144, last = round8(total - first);
  // two losing sell orders, the first one split in two fills (same order id), all at 29 against a buy at 30
  const stored = [
    { ...fill('s3', 'SELL', last, 29, T + 3000), orderId: 'order-loss-1' },
    { ...fill('s2', 'SELL', first, 29, T + 2000), orderId: 'order-loss-1' },
    fill('b', 'BUY', total, 30, T)
  ];
  assert.equal(computeLimitReachedAt(stored, NOW, 1, 1), T + 3000);
});
