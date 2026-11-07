"use strict";
/**
 * Read-only runtime evidence of the stored public-market research data (WO-DATA-20261014-INTEGRITY-PROBE). Runs on the PAPER host
 * inside the daily nusa-research service, opens NUSA_CLOUD_STATE_DB_PATH READ-ONLY and prints one line:
 *   DATA_INTEGRITY {"status":"PASS"|"WARN"|"FAIL", ...integer fields}
 * FAIL: a stored row is stamped in the future, a candle close time is not aligned to its interval, or a candle's OHLC is
 * inconsistent. WARN: missing candles in the last 7 days or a 1-minute series older than two hours (two gap-fill cycles). It is evidence about the data
 * only: it changes nothing, gates nothing and grants nothing.
 */
const M = 60_000;
const DAY = 24 * 60 * M;
const FUTURE_SKEW_MS = 5_000;
/**
 * A 1-minute series counts as stale when its newest candle is older than two hourly gap-fill cycles. The REST gap fill is the only writer
 * of the series head and runs once an hour, so a 10-minute limit (the value from when live collection wrote the head) flagged a healthy
 * series almost every time the daily probe ran (2026-11-02 reading: newest candle 56.5 minutes old, nothing missing). Display only: it
 * changes no gate and no experiment input.
 */
const STALE_SERIES_AFTER_MS = 2 * 60 * M;

function probe({ db, now = Date.now(), currentNow = () => now }) {
  const since = now - 7 * DAY;
  // The live DB keeps receiving public-market rows while this read-only probe scans large tables.
  // A single start-time cutoff therefore turns rows inserted during a slow probe into false
  // "future" evidence. Refresh only the wall-clock used by each future check; all historical
  // windows remain anchored to the probe start for deterministic, comparable counts.
  const futureCutoff = () => {
    const observedNow = Number(currentNow());
    if (!Number.isSafeInteger(observedNow) || observedNow <= 0) throw new Error("data-integrity probe clock is invalid");
    return Math.max(now, observedNow) + FUTURE_SKEW_MS;
  };
  const one = (sql, ...args) => Number(Object.values(db.prepare(sql).get(...args))[0] ?? 0);
  const series = db.prepare("SELECT market, interval_ms AS i, COUNT(*) AS n, MIN(close_time_ms) AS a, MAX(close_time_ms) AS b FROM research_closed_candles WHERE close_time_ms > ? GROUP BY market, interval_ms").all(since);
  let candleMissing = 0; let staleSeries = 0; let maxLatestAgeMs = 0;
  for (const s of series) {
    const expected = Math.floor((Number(s.b) - Number(s.a)) / Number(s.i)) + 1;
    candleMissing += Math.max(0, expected - Number(s.n));
    if (Number(s.i) === M) {
      const age = now - Number(s.b);
      maxLatestAgeMs = Math.max(maxLatestAgeMs, age);
      if (age > STALE_SERIES_AFTER_MS) staleSeries += 1;
    }
  }
  const out = {
    candleSeries: series.length,
    candleRows7d: series.reduce((sum, s) => sum + Number(s.n), 0),
    candleMissing7d: candleMissing,
    candleMisaligned: one("SELECT COUNT(*) FROM research_closed_candles WHERE close_time_ms % interval_ms <> 0"),
    candleInvalidOhlc: one("SELECT COUNT(*) FROM research_closed_candles WHERE high < open OR high < close OR low > open OR low > close OR low > high"),
    candleFuture: one("SELECT COUNT(*) FROM research_closed_candles WHERE close_time_ms > ?", futureCutoff()),
    candleStaleSeries: staleSeries,
    candleMaxLatestAgeMs: maxLatestAgeMs,
    orderBookMarkets24h: one("SELECT COUNT(DISTINCT market) FROM research_orderbook_samples WHERE captured_at_ms > ?", now - DAY),
    orderBookRows24h: one("SELECT COUNT(*) FROM research_orderbook_samples WHERE captured_at_ms > ?", now - DAY),
    orderBookCrossed: one("SELECT COUNT(*) FROM research_orderbook_samples WHERE best_bid > best_ask"),
    orderBookFuture: one("SELECT COUNT(*) FROM research_orderbook_samples WHERE captured_at_ms > ?", futureCutoff()),
    tradeRows24h: one("SELECT COUNT(*) FROM research_trade_ticks_v2 WHERE traded_at_ms > ?", now - DAY),
    tradeFuture: one("SELECT COUNT(*) FROM research_trade_ticks_v2 WHERE traded_at_ms > ?", futureCutoff()),
  };
  const fail = out.candleMisaligned + out.candleInvalidOhlc + out.candleFuture + out.orderBookCrossed + out.orderBookFuture + out.tradeFuture > 0;
  const warn = out.candleMissing7d + out.candleStaleSeries > 0;
  return { status: fail ? "FAIL" : warn ? "WARN" : "PASS", ...out };
}

/** Durable copy for the runtime (/health runtime.dataIntegrity reads it); written atomically next to the state DB. */
const RESULT_FILE = "data-integrity-result.json";
function writeResult(stateDbPath, result, observedAt = Date.now(), fs = require("node:fs"), pathLib = require("node:path")) {
  const target = pathLib.join(pathLib.dirname(stateDbPath), RESULT_FILE);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify({ schemaVersion: 1, observedAt, ...result }));
  fs.renameSync(`${target}.tmp`, target);
}

module.exports = { probe, writeResult, RESULT_FILE };

if (require.main === module) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const path = String(process.env.NUSA_CLOUD_STATE_DB_PATH || "");
    if (!path.startsWith("/")) throw new Error("state path");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const result = probe({ db, currentNow: Date.now });
      console.log("DATA_INTEGRITY", JSON.stringify(result));
      writeResult(path, result);
    } finally { db.close(); }
  } catch { console.error("DATA_INTEGRITY_FAILED_CLOSED"); process.exitCode = 1; }
}
