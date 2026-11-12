import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TradeTickCoverageWatch, readTradeTickCoverageDetailed, summarizeTradeCoverage } from "./tradeTickCoverage";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-12T10:30:00Z");
const LAST = Math.floor(NOW / HOUR) * HOUR;
const DDL = "CREATE TABLE research_trade_ticks_v2 (market TEXT NOT NULL, traded_at_ms INTEGER NOT NULL, price REAL NOT NULL, volume REAL NOT NULL, side TEXT NOT NULL, PRIMARY KEY (market, traded_at_ms, price, volume, side))";

/** `hoursAgo` = 0 means the hour ending at LAST, i.e. ticks in (LAST - 1h, LAST]. */
function makeDb(ticks: ReadonlyArray<{ hoursAgo: number; offsetMs?: number; market?: string }>): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "trade-coverage-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(DDL);
  const insert = db.prepare("INSERT INTO research_trade_ticks_v2 VALUES (?, ?, 100, 1, 'BID')");
  for (const t of ticks) insert.run(t.market ?? "KRW-XRP", LAST - t.hoursAgo * HOUR - (t.offsetMs ?? 1_000));
  db.close();
  return { path, dir };
}

describe("trade tick hour coverage watch", () => {
  it("summarizes covered hours and the longest gap, with no study bar", () => {
    const c = summarizeTradeCoverage([true, true, false, false, false, true, true, true, true, true], NOW)!;
    assert.deepEqual([c.windowHours, c.coveredHours, c.ratio, c.longestGapHours], [10, 7, 0.7, 3]);
    assert.equal("meetsStudyBar" in c, false, "the data bar is not fixed yet, so none is published");
    assert.equal(summarizeTradeCoverage([], NOW), undefined);
    assert.equal(summarizeTradeCoverage([true], 0), undefined);
    assert.equal(summarizeTradeCoverage([true, "yes" as unknown as boolean], NOW), undefined);
  });

  it("counts an hour when a tick sits in (t-1h, t], including the boundaries", () => {
    const { path, dir } = makeDb([
      { hoursAgo: 0 }, { hoursAgo: 1, offsetMs: 0 }, // exactly at t: covered
      { hoursAgo: 3, offsetMs: HOUR - 1 }, // one ms after t-1h: still inside hour 3
      { hoursAgo: 4, offsetMs: HOUR }, // exactly t-1h: belongs to the previous hour (5 ago), not 4 ago
    ]);
    try {
      const c = readTradeTickCoverageDetailed(path, "KRW-XRP", NOW, 6);
      assert.ok(!("status" in c));
      assert.equal(c.windowHours, 6);
      assert.equal(c.coveredHours, 4, "hours 0, 1, 3 and 5 ago");
      assert.equal(c.longestGapHours, 1);
      assert.equal(c.asOfMs, LAST);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores another market's ticks and a tick after the latest full hour", () => {
    const { path, dir } = makeDb([{ hoursAgo: 0, market: "KRW-OTHER" }, { hoursAgo: -1 }]);
    try {
      const c = readTradeTickCoverageDetailed(path, "KRW-XRP", NOW, 3);
      assert.ok(!("status" in c));
      assert.equal(c.coveredHours, 0);
      assert.equal(c.longestGapHours, 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("names why it cannot be read with a fixed code, never raw text", () => {
    const missing = readTradeTickCoverageDetailed(join(tmpdir(), "no-such-dir-trade-coverage", "state.sqlite"), "KRW-XRP", NOW, 6);
    assert.ok("status" in missing && missing.status === "UNAVAILABLE");
    assert.match("reason" in missing ? missing.reason : "", /^[A-Z][A-Z0-9_]{2,63}$/);
    const dir = mkdtempSync(join(tmpdir(), "trade-coverage-"));
    try {
      const path = join(dir, "state.sqlite");
      new DatabaseSync(path).close();
      const noTable = readTradeTickCoverageDetailed(path, "KRW-XRP", NOW, 6);
      assert.match("reason" in noTable ? noTable.reason : "", /^QUERY_FAILED/);
      for (const [market, hours, now] of [["xrp", 6, NOW], ["KRW-XRP", 0, NOW], ["KRW-XRP", 100_000, NOW], ["KRW-XRP", 6, 0], ["KRW-XRP", 6, Number.NaN]] as const) {
        const bad = readTradeTickCoverageDetailed(path, market, now, hours);
        assert.equal("reason" in bad && bad.reason, "INVALID_INPUT", `${market}/${hours}/${now}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("caches for an hour and never throws", () => {
    const { path, dir } = makeDb([{ hoursAgo: 0 }]);
    let now = NOW;
    try {
      const watch = new TradeTickCoverageWatch(path, "KRW-XRP", () => now);
      const first = watch.snapshot();
      assert.ok(first != null);
      now += 10 * 60_000;
      assert.equal(watch.snapshot(), first, "the same object within the hour");
      now += HOUR;
      assert.notEqual(watch.snapshot(), first, "recomputed after an hour");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const unreadable = new TradeTickCoverageWatch(join(tmpdir(), "no-such-dir", "x.sqlite"), "KRW-XRP", () => NOW).snapshot();
    assert.ok(unreadable != null && "status" in unreadable && unreadable.status === "UNAVAILABLE");
  });
});
