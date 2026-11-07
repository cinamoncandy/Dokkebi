import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { COVERAGE_REQUIRED_RATIO, OrderBookCoverageWatch, readOrderBookCoverage, summarizeCoverage } from "./orderBookCoverage";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-31T10:30:00Z");
const LAST = Math.floor(NOW / HOUR) * HOUR;

function makeDb(hoursWithBook: readonly number[], market = "KRW-XRP"): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "coverage-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE research_orderbook_samples (market TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, best_bid REAL NOT NULL, best_ask REAL NOT NULL, bid_size_5 REAL NOT NULL, ask_size_5 REAL NOT NULL, total_bid_size REAL NOT NULL, total_ask_size REAL NOT NULL, PRIMARY KEY (market, captured_at_ms))");
  const insert = db.prepare("INSERT INTO research_orderbook_samples VALUES (?, ?, 1, 2, 1, 1, 1, 1)");
  for (const hoursAgo of hoursWithBook) insert.run(market, LAST - hoursAgo * HOUR - 30_000);
  db.close();
  return { path, dir };
}

describe("order-book hour coverage watch", () => {
  it("summarizes covered hours, the longest gap and the study bar", () => {
    const flags = [true, true, false, false, false, true, true, true, true, true];
    const c = summarizeCoverage(flags, "KRW-XRP", NOW)!;
    assert.deepEqual([c.windowHours, c.coveredHours, c.ratio, c.longestGapHours, c.meetsStudyBar], [10, 7, 0.7, 3, false]);
    assert.equal(summarizeCoverage(new Array(10).fill(true), "KRW-XRP", NOW)!.meetsStudyBar, true);
    assert.equal(COVERAGE_REQUIRED_RATIO, 0.9);
    assert.equal(summarizeCoverage([], "KRW-XRP", NOW), undefined);
    assert.equal(summarizeCoverage([true], "KRW-XRP", 0), undefined);
  });

  it("counts a full hour only when a sample sits in the two minutes up to it (the study's definition)", () => {
    const { path, dir } = makeDb([0, 1, 2, 4]);
    try {
      const c = readOrderBookCoverage(path, "KRW-XRP", NOW, 6)!;
      assert.equal(c.windowHours, 6);
      assert.equal(c.coveredHours, 4);
      assert.equal(c.longestGapHours, 1, "hours 3 and 5 ago are single-hour gaps");
      assert.equal(c.asOfMs, LAST);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not count a sample that is outside the two-minute window", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-"));
    const path = join(dir, "state.sqlite");
    try {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE research_orderbook_samples (market TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, best_bid REAL NOT NULL, best_ask REAL NOT NULL, bid_size_5 REAL NOT NULL, ask_size_5 REAL NOT NULL, total_bid_size REAL NOT NULL, total_ask_size REAL NOT NULL, PRIMARY KEY (market, captured_at_ms))");
      db.prepare("INSERT INTO research_orderbook_samples VALUES ('KRW-XRP', ?, 1, 2, 1, 1, 1, 1)").run(LAST - 5 * 60_000);
      db.close();
      assert.equal(readOrderBookCoverage(path, "KRW-XRP", NOW, 1)!.coveredHours, 0, "five minutes before the hour is not a book at t");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("is read-only, bounded, and returns undefined instead of guessing", () => {
    const { path, dir } = makeDb([0]);
    try {
      assert.equal(readOrderBookCoverage(join(dir, "missing.sqlite"), "KRW-XRP", NOW), undefined);
      assert.equal(readOrderBookCoverage(path, "BTC-KRW", NOW), undefined, "invalid market");
      assert.equal(readOrderBookCoverage(path, "KRW-XRP", NOW, 0), undefined);
      assert.equal(readOrderBookCoverage(path, "KRW-XRP", NOW, 100_000), undefined);
      assert.equal(readOrderBookCoverage(path, "KRW-OTHER", NOW, 3)!.coveredHours, 0, "another market's rows are not counted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("caches for an hour and never throws", () => {
    const { path, dir } = makeDb([0, 1]);
    let now = NOW;
    try {
      const watch = new OrderBookCoverageWatch(path, "KRW-XRP", () => now);
      const first = watch.snapshot();
      assert.ok(first != null);
      now += 10 * 60_000;
      assert.equal(watch.snapshot(), first, "the same object within the hour");
      now += HOUR;
      assert.notEqual(watch.snapshot(), first, "recomputed after an hour");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    assert.equal(new OrderBookCoverageWatch(join(tmpdir(), "no-such-dir", "x.sqlite"), "KRW-XRP", () => NOW).snapshot(), undefined);
  });
});
