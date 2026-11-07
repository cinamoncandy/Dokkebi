"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { probe } = require("./run-data-integrity-probe.js");

const M = 60_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE research_closed_candles (market TEXT, interval_ms INTEGER, close_time_ms INTEGER, open REAL, high REAL, low REAL, close REAL, checksum TEXT, PRIMARY KEY (market, interval_ms, close_time_ms));
    CREATE TABLE research_orderbook_samples (market TEXT, captured_at_ms INTEGER, best_bid REAL, best_ask REAL, bid_size_5 REAL, ask_size_5 REAL, total_bid_size REAL, total_ask_size REAL, PRIMARY KEY (market, captured_at_ms));
    CREATE TABLE research_trade_ticks_v2 (market TEXT, traded_at_ms INTEGER, price REAL, volume REAL, side TEXT, PRIMARY KEY (market, traded_at_ms, price, volume, side));`);
  const candle = d.prepare("INSERT INTO research_closed_candles VALUES (?, ?, ?, 100, 101, 99, 100, 'c')");
  for (let k = 0; k < 120; k += 1) candle.run("KRW-BTC", M, NOW - 60 * M - k * M);
  d.prepare("INSERT INTO research_orderbook_samples VALUES ('KRW-ETH', ?, 10, 11, 1, 1, 1, 1)").run(NOW - M);
  d.prepare("INSERT INTO research_trade_ticks_v2 VALUES ('KRW-BTC', ?, 100, 1, 'BID')").run(NOW - M);
  return d;
}

test("a complete, current series with no future rows passes", () => {
  const d = db();
  const add = d.prepare("INSERT INTO research_closed_candles VALUES ('KRW-BTC', ?, ?, 100, 101, 99, 100, 'c')");
  for (let k = 1; k < 60; k += 1) add.run(M, NOW - k * M);
  assert.equal(probe({ db: d, now: NOW }).status, "PASS");
});

test("a 1-minute series whose newest candle is within two gap-fill cycles is not stale, one older than that warns", () => {
  const fresh = probe({ db: db(), now: NOW });
  assert.equal(fresh.candleStaleSeries, 0, "60 minutes old is normal between hourly fills");
  assert.equal(probe({ db: db(), now: NOW + 56.5 * M }).candleStaleSeries, 0, "116 minutes old: one hourly fill late, still not stale");
  assert.equal(probe({ db: db(), now: NOW + 60 * M }).candleStaleSeries, 0, "exactly two hours is still the limit, not past it");
  const late = probe({ db: db(), now: NOW + 61 * M });
  assert.equal(late.candleStaleSeries, 1, "two hours and a minute means a fill was missed");
  assert.equal(late.status, "WARN");
});

test("the stale-series check changes no other count", () => {
  const d = db();
  const r = probe({ db: d, now: NOW });
  assert.equal(r.candleStaleSeries, 0);
  assert.equal(r.candleMissing7d, 0);
  assert.equal(r.candleRows7d, 120);
  assert.equal(r.orderBookMarkets24h, 1);
  assert.equal(r.tradeRows24h, 1);
  d.prepare("INSERT INTO research_closed_candles VALUES ('KRW-BTC', ?, ?, 100, 101, 99, 100, 'c')").run(M, NOW - M);
  assert.equal(probe({ db: d, now: NOW }).candleMissing7d, 58, "the 58 minutes between the old series and the new candle are missing");
});

test("gaps warn; future, misaligned, inconsistent and crossed rows fail", () => {
  const d = db();
  d.prepare("DELETE FROM research_closed_candles WHERE close_time_ms = ?").run(NOW - 100 * M);
  assert.equal(probe({ db: d, now: NOW }).candleMissing7d, 1);
  for (const [sql, field] of [
    ["INSERT INTO research_closed_candles VALUES ('KRW-X', 60000, " + (NOW + 10 * M) + ", 1, 1, 1, 1, 'c')", "candleFuture"],
    ["INSERT INTO research_closed_candles VALUES ('KRW-Y', 60000, " + (NOW - 30_001) + ", 1, 1, 1, 1, 'c')", "candleMisaligned"],
    ["INSERT INTO research_closed_candles VALUES ('KRW-Z', 60000, " + (NOW - 2 * M) + ", 5, 4, 1, 3, 'c')", "candleInvalidOhlc"],
    ["INSERT INTO research_orderbook_samples VALUES ('KRW-Q', " + (NOW - M) + ", 12, 11, 1, 1, 1, 1)", "orderBookCrossed"],
    ["INSERT INTO research_trade_ticks_v2 VALUES ('KRW-Q', " + (NOW + 10 * M) + ", 1, 1, 'ASK')", "tradeFuture"],
  ]) {
    const fresh = db();
    fresh.exec(sql);
    const r = probe({ db: fresh, now: NOW });
    assert.equal(r.status, "FAIL", field);
    assert.equal(r[field], 1, field);
  }
});

test("live future checks refresh their wall clock during a slow probe", () => {
  const d = db();
  // These rows are ahead of the probe start, but behind the time at which the later table checks
  // execute. A live recorder could have inserted them while an earlier large-table scan ran.
  d.prepare("INSERT INTO research_orderbook_samples VALUES ('KRW-LIVE', ?, 10, 11, 1, 1, 1, 1)").run(NOW + 10_000);
  d.prepare("INSERT INTO research_trade_ticks_v2 VALUES ('KRW-LIVE', ?, 100, 1, 'BID')").run(NOW + 10_000);
  const r = probe({ db: d, now: NOW, currentNow: () => NOW + 20_000 });
  assert.equal(r.orderBookFuture, 0);
  assert.equal(r.tradeFuture, 0);
});

test("the refreshed live clock still rejects genuinely future rows", () => {
  const d = db();
  d.prepare("INSERT INTO research_orderbook_samples VALUES ('KRW-FUTURE', ?, 10, 11, 1, 1, 1, 1)").run(NOW + 30_000);
  d.prepare("INSERT INTO research_trade_ticks_v2 VALUES ('KRW-FUTURE', ?, 100, 1, 'ASK')").run(NOW + 30_000);
  const r = probe({ db: d, now: NOW, currentNow: () => NOW + 20_000 });
  assert.equal(r.status, "FAIL");
  assert.equal(r.orderBookFuture, 1);
  assert.equal(r.tradeFuture, 1);
});

test("an invalid refreshed wall clock fails closed", () => {
  const d = db();
  assert.throws(() => probe({ db: d, now: NOW, currentNow: () => Number.NaN }), /clock is invalid/);
});

test("the result is written atomically beside the state database for /health", () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const { writeResult, RESULT_FILE } = require("./run-data-integrity-probe.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-probe-"));
  writeResult(path.join(dir, "cloud-state.db"), { status: "PASS", candleSeries: 2 }, 123);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, RESULT_FILE), "utf8")), { schemaVersion: 1, observedAt: 123, status: "PASS", candleSeries: 2 });
  assert.equal(fs.existsSync(path.join(dir, `${RESULT_FILE}.tmp`)), false);
});
