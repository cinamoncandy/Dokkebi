const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { SqliteDatabase, SqliteResearchCandleStore, ResearchCandleStoreError } = require("../dist/packages/storage/src/index.js");

const M = 60_000;
const candle = (n, o = 100, h = 110, l = 95, c = 105) => ({ closeTimeMs: (10 + n) * M, open: o, high: h, low: l, close: c });
const open = (max) => {
  const db = new SqliteDatabase(join(mkdtempSync(join(tmpdir(), "nusa-candles-")), "c.db"));
  return { db, store: new SqliteResearchCandleStore(db, max) };
};

test("migration 026 creates the table and the store records and reads candles in order", () => {
  const { db, store } = open();
  assert.equal(db.migrationResult.currentVersion, "032_research_orderbook_study_rows");
  assert.equal(store.append("KRW-BTC", M, [candle(2), candle(0), candle(1)]), 3);
  assert.deepEqual(store.read("KRW-BTC", M, 0, 99 * M).map((c) => c.closeTimeMs), [10 * M, 11 * M, 12 * M]);
  assert.deepEqual(store.read("KRW-BTC", M, 11 * M, 11 * M).map((c) => c.closeTimeMs), [11 * M]);
  assert.equal(store.earliestCloseTime("KRW-BTC", M), 10 * M);
  assert.equal(store.earliestCloseTime("KRW-ETH", M), undefined);
  assert.equal(store.count("KRW-BTC", M), 3);
  db.close();
});

test("appending the same candle again is a no-op; a different candle for the same key is a conflict", () => {
  const { db, store } = open();
  store.append("KRW-BTC", M, [candle(0)]);
  assert.equal(store.append("KRW-BTC", M, [candle(0)]), 0);
  assert.throws(() => store.append("KRW-BTC", M, [candle(0, 100, 111, 95, 105)]), (e) => e instanceof ResearchCandleStoreError && e.code === "CANDLE_CONFLICT");
  assert.equal(store.count("KRW-BTC", M), 1);
  db.close();
});

test("a batch with any invalid candle writes nothing", () => {
  const { db, store } = open();
  const bad = [candle(0), candle(1, 100, 90, 95, 105)]; // high below open/close
  assert.throws(() => store.append("KRW-BTC", M, bad), (e) => e instanceof ResearchCandleStoreError && e.code === "INVALID_CANDLE");
  assert.equal(store.count("KRW-BTC", M), 0);
  for (const invalid of [{ ...candle(0), closeTimeMs: 10 * M + 1 }, { ...candle(0), open: 0 }, { ...candle(0), close: NaN }, { ...candle(0), low: -1 }, { ...candle(0), closeTimeMs: 0 }]) {
    assert.throws(() => store.append("KRW-BTC", M, [invalid]), ResearchCandleStoreError);
  }
  assert.throws(() => store.append("BTC-KRW", M, [candle(0)]), (e) => e.code === "INVALID_MARKET");
  assert.throws(() => store.append("KRW-BTC", 10, [candle(0)]), (e) => e.code === "INVALID_INTERVAL");
  assert.equal(store.count("KRW-BTC", M), 0);
  db.close();
});

test("retention keeps the newest candles per market and does not touch other markets", () => {
  const { db, store } = open(3);
  store.append("KRW-BTC", M, [candle(0), candle(1), candle(2), candle(3), candle(4)]);
  store.append("KRW-ETH", M, [candle(0)]);
  assert.deepEqual(store.read("KRW-BTC", M, 0, 99 * M).map((c) => c.closeTimeMs), [12 * M, 13 * M, 14 * M]);
  assert.equal(store.count("KRW-ETH", M), 1);
  assert.throws(() => new SqliteResearchCandleStore(db, 1), ResearchCandleStoreError);
  db.close();
});

test("a corrupted stored row is detected on read", () => {
  const { db, store } = open();
  store.append("KRW-BTC", M, [candle(0)]);
  db.connection.prepare("UPDATE research_closed_candles SET high = 999 WHERE market = ?").run("KRW-BTC");
  assert.throws(() => store.read("KRW-BTC", M, 0, 99 * M), (e) => e instanceof ResearchCandleStoreError && e.code === "CANDLE_CHECKSUM_MISMATCH");
  db.close();
});

test("read rejects an invalid window and an invalid market", () => {
  const { db, store } = open();
  assert.throws(() => store.read("KRW-BTC", M, 5, 1), (e) => e.code === "INVALID_WINDOW");
  assert.throws(() => store.read("nope", M, 1, 5), (e) => e.code === "INVALID_MARKET");
  db.close();
});

test("material coverage verifies the candle window once instead of re-reading every receipt range", () => {
  const { db, store } = open();
  const rows = [candle(0), candle(1), candle(2), candle(3)];
  store.appendWithMaterial("KRW-BTC", M, rows.slice(0, 2), { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: "a".repeat(64), evidenceFingerprintSha256: "b".repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  store.appendWithMaterial("KRW-BTC", M, rows.slice(2), { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: "a".repeat(64), evidenceFingerprintSha256: "c".repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  const originalRead = store.read.bind(store);
  let reads = 0;
  store.read = (...args) => { reads += 1; return originalRead(...args); };
  assert.equal(store.hasMaterialCoverage("KRW-BTC", M, 10 * M, 13 * M, "UPBIT_PUBLIC_CANDLES", "a".repeat(64)), true);
  assert.equal(reads, 1, "coverage must not re-read each receipt range from SQLite");
  db.close();
});

test("material coverage accepts a verified receipt that extends beyond the requested window", () => {
  const { db, store } = open();
  const rows = [candle(0), candle(1), candle(2), candle(3)];
  store.appendWithMaterial("KRW-BTC", M, rows, { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: "d".repeat(64), evidenceFingerprintSha256: "e".repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  assert.equal(store.hasMaterialCoverage("KRW-BTC", M, 11 * M, 12 * M, "UPBIT_PUBLIC_CANDLES", "d".repeat(64)), true);
  db.close();
});

test("material coverage remains fail-closed when receipt metadata is tampered", () => {
  const { db, store } = open();
  const rows = [candle(0), candle(1)];
  store.appendWithMaterial("KRW-BTC", M, rows, { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: "f".repeat(64), evidenceFingerprintSha256: "1".repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  db.connection.prepare("UPDATE research_dataset_material SET candle_count = candle_count + 1 WHERE market = ?").run("KRW-BTC");
  assert.throws(() => store.hasMaterialCoverage("KRW-BTC", M, 10 * M, 11 * M, "UPBIT_PUBLIC_CANDLES", "f".repeat(64)), (error) => error instanceof ResearchCandleStoreError && error.code === "DATASET_MATERIAL_MISMATCH");
  db.close();
});

test("an absence run is stored only between two stored candles with nothing inside, is idempotent, and is dropped from reads once it no longer holds", () => {
  const { SqliteDatabase, SqliteResearchCandleStore } = require("../dist/packages/storage/src/index.js");
  const M = 60_000;
  const store = new SqliteResearchCandleStore(new SqliteDatabase(":memory:"));
  const k = (n) => ({ closeTimeMs: n * M, open: 10, high: 11, low: 9, close: 10.5, volume: 1 });
  store.append("KRW-XRP", M, [k(100), k(101), k(106)]);
  const run = { market: "KRW-XRP", intervalMs: M, firstAbsentCloseMs: 102 * M, lastAbsentCloseMs: 105 * M, beforeCloseMs: 101 * M, afterCloseMs: 106 * M, evidenceFingerprintSha256: "a".repeat(64), observedAt: "2026-11-10T00:00:00.000Z" };
  assert.equal(store.recordAbsence(run), true);
  assert.equal(store.recordAbsence({ ...run, evidenceFingerprintSha256: "b".repeat(64) }), false, "the first proof of a run is kept");
  assert.deepEqual(store.listAbsence("KRW-XRP", M, 100 * M, 106 * M).map((r) => [r.firstAbsentCloseMs / M, r.lastAbsentCloseMs / M, r.evidenceFingerprintSha256[0]]), [[102, 105, "a"]]);
  assert.throws(() => store.recordAbsence({ ...run, firstAbsentCloseMs: 103 * M, beforeCloseMs: 102 * M }), (e) => e.code === "ABSENCE_NOT_BOUNDED", "the before-bound must be stored");
  assert.throws(() => store.recordAbsence({ ...run, afterCloseMs: 107 * M }), (e) => e.code === "INVALID_ABSENCE", "bounds must touch the run");
  assert.throws(() => store.recordAbsence({ ...run, evidenceFingerprintSha256: "x" }), (e) => e.code === "INVALID_ABSENCE");
  // a candle later stored inside the run voids the proof for reads
  store.append("KRW-XRP", M, [k(103)]);
  assert.deepEqual(store.listAbsence("KRW-XRP", M, 100 * M, 106 * M), []);
  assert.throws(() => store.recordAbsence({ ...run, firstAbsentCloseMs: 104 * M, beforeCloseMs: 103 * M, lastAbsentCloseMs: 105 * M }), (e) => e.code === "ABSENCE_CONFLICT", "an overlapping different run is refused");
});
