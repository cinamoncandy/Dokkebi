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
