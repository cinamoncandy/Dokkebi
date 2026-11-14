"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { runStudy, evaluate, featuresAt, tickSeries, compareTicks, START, VAL, HOLD, END, K } = require("./run-tradeflow-study.js");

const H = 3_600_000;
const M = 60_000;
const TICKS_DDL = "CREATE TABLE research_trade_ticks_v2 (market TEXT NOT NULL, traded_at_ms INTEGER NOT NULL, price REAL NOT NULL, volume REAL NOT NULL, side TEXT NOT NULL, PRIMARY KEY (market, traded_at_ms, price, volume, side))";
const BOOKS_DDL = "CREATE TABLE research_orderbook_samples (market TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, best_bid REAL NOT NULL, best_ask REAL NOT NULL, bid_size_5 REAL NOT NULL, ask_size_5 REAL NOT NULL, total_bid_size REAL NOT NULL, total_ask_size REAL NOT NULL, PRIMARY KEY (market, captured_at_ms))";

function emptyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(TICKS_DDL); db.exec(BOOKS_DDL);
  return db;
}

/** Every market: a book every 5 minutes and three ticks per hour; `sparse` markets only have ticks in every other hour. */
function syntheticDb(markets, { sparse = [] } = {}) {
  const db = emptyDb();
  const book = db.prepare("INSERT INTO research_orderbook_samples VALUES (?, ?, ?, ?, 1, 1, 10, 10)");
  const tick = db.prepare("INSERT INTO research_trade_ticks_v2 VALUES (?, ?, ?, ?, ?)");
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  db.exec("BEGIN");
  for (let m = 0; m < markets; m += 1) {
    const market = `KRW-M${m}`;
    let price = 1000 + m * 10;
    for (let t = START - 5 * H; t <= END + H; t += 5 * M) { price *= 1 + (rand() - 0.5) * 0.004; book.run(market, t, price * 0.9998, price * 1.0002); }
    for (let t = START - 24 * H; t <= END; t += H) {
      if (sparse.includes(m) && Math.floor((t - START) / H) % 2 !== 0) continue;
      for (let k = 0; k < 3; k += 1) tick.run(market, t - (k + 1) * 7 * M + k, 1000 + rand() * 10, 0.1 + rand(), rand() < 0.5 ? "BID" : "ASK");
    }
  }
  db.exec("COMMIT");
  return db;
}

test("the pre-registered span, bar and constants are the ones in the document", () => {
  assert.equal(START, Date.parse("2026-11-07T00:00:00Z"));
  assert.equal(VAL, Date.parse("2026-11-14T00:00:00Z"));
  assert.equal(HOLD, Date.parse("2026-11-16T00:00:00Z"));
  assert.equal(END, Date.parse("2026-11-20T00:00:00Z"));
  assert.equal(K, 198);
});

test("waits until 30 minutes after the end of the span", () => {
  const db = syntheticDb(1);
  assert.deepEqual(runStudy({ db, now: START + 3.5 * 24 * H }), { status: "WAITING_DATA", daysCollected: 3 });
  assert.equal(runStudy({ db, now: END + 29 * M }).status, "WAITING_DATA");
  assert.notEqual(runStudy({ db, now: END + 31 * M }).status, "WAITING_DATA");
});

test("the six features follow the document, including the fixed tick order inside a shared timestamp", () => {
  const t = START + 3 * H;
  const build = (reverse) => {
    const db = emptyDb();
    const insert = db.prepare("INSERT INTO research_trade_ticks_v2 VALUES ('KRW-X', ?, ?, ?, ?)");
    const rows = [[t - 5 * H, 100, 20, "BID"], [t - 59 * M, 99, 1, "BID"], [t - 30 * M, 101, 1, "ASK"], [t - 10 * M, 103, 1, "ASK"], [t - 10 * M, 100, 2, "BID"]];
    for (const r of reverse ? [...rows].reverse() : rows) insert.run(...r);
    return tickSeries(db, "KRW-X");
  };
  const expectedRv = Math.sqrt(Math.log(101 / 99) ** 2 + Math.log(100 / 101) ** 2 + Math.log(103 / 100) ** 2);
  for (const reverse of [false, true]) {
    const x = featuresAt(build(reverse), t);
    assert.ok(Math.abs(x[0] - 1 / 3) < 1e-12, "imb15 (BID 2, ASK 1)");
    assert.ok(Math.abs(x[1] - 0.2) < 1e-12, "imb60 (BID 3, ASK 2)");
    assert.ok(Math.abs(x[2] - 95 / 503) < 1e-12, "valImb60 (BID 299, ASK 204)");
    assert.ok(Math.abs(x[3] - Math.log(3)) < 1e-12, "logCount15 (two ticks)");
    assert.ok(Math.abs(x[4] - expectedRv) < 1e-12, `rv60 uses price-ascending order inside the shared timestamp (reverse insert ${reverse})`);
    assert.ok(Math.abs(x[5] - Math.log((5 + 1e-9) / (25 / 24 + 1e-9))) < 1e-12, "volRatio (V60 5, V24 25)");
  }
});

test("the tick order is time, price, volume, side with ASK before BID, whatever order the rows arrive in", () => {
  const rows = [{ t: 5, p: 100, v: 2, s: "BID" }, { t: 5, p: 100, v: 2, s: "ASK" }, { t: 5, p: 99, v: 9, s: "BID" }, { t: 5, p: 100, v: 1, s: "BID" }, { t: 4, p: 200, v: 1, s: "ASK" }];
  const expected = [{ t: 4, p: 200, v: 1, s: "ASK" }, { t: 5, p: 99, v: 9, s: "BID" }, { t: 5, p: 100, v: 1, s: "BID" }, { t: 5, p: 100, v: 2, s: "ASK" }, { t: 5, p: 100, v: 2, s: "BID" }];
  for (const arrival of [rows, [...rows].reverse(), [rows[2], rows[4], rows[0], rows[3], rows[1]]]) assert.deepEqual([...arrival].sort(compareTicks), expected);
});

test("window edges: a tick at t counts, a tick at t - 60 min does not, and no tick means no decision", () => {
  const t = START + 5 * H;
  const series = (times) => {
    const db = emptyDb();
    const insert = db.prepare("INSERT INTO research_trade_ticks_v2 VALUES ('KRW-X', ?, 100, 1, 'BID')");
    for (const x of times) insert.run(x);
    return tickSeries(db, "KRW-X");
  };
  assert.equal(featuresAt(series([t - H]), t), undefined, "a tick exactly 60 minutes before t is outside (t - 60 min, t]");
  assert.ok(featuresAt(series([t]), t) != null, "a tick exactly at t is inside");
  assert.equal(featuresAt(series([t + 1]), t), undefined, "a tick after t is never used");
  const only = featuresAt(series([t - H + 1]), t);
  assert.equal(only[4], 0, "one tick in the window gives rv60 = 0 (no predecessor inside the window)");
  assert.equal(only[0], 0, "the lone tick is outside the 15-minute window, so imb15 has an empty denominator and is 0");
  assert.equal(only[1], 1, "a lone BID tick in the 60-minute window gives imb60 = 1");
});

test("zero volume on both sides gives imbalance 0, not NaN", () => {
  const db = emptyDb();
  // The table forbids volume 0, so the only way to a zero denominator is no tick in the 15-minute window.
  const t = START + 5 * H;
  db.prepare("INSERT INTO research_trade_ticks_v2 VALUES ('KRW-X', ?, 100, 1, 'BID')").run(t - 40 * M);
  const x = featuresAt(tickSeries(db, "KRW-X"), t);
  assert.equal(x[0], 0);
  assert.equal(x[3], 0);
  assert.ok(x.every((v) => Number.isFinite(v)));
});

test("equal predicted probabilities are ordered by market code ascending, whatever the input order", () => {
  const t = START;
  const mk = (market) => ({ market, t, x: [0], net: 0.01, stress: 0.005 });
  const a = evaluate(["KRW-D", "KRW-B", "KRW-E", "KRW-A", "KRW-C"].map(mk), () => 0.5);
  const b = evaluate(["KRW-A", "KRW-B", "KRW-C", "KRW-D", "KRW-E"].map(mk), () => 0.5);
  assert.deepEqual(a, b);
  const rows = ["KRW-D", "KRW-B", "KRW-A", "KRW-C"].map((market, i) => ({ market, t, x: [0], net: [0.4, 0.1, 0.2, 0.3][i], stress: 0 }));
  // With equal scores the picks are A, B, C: nets 0.2, 0.1, 0.3.
  assert.ok(Math.abs(evaluate(rows, () => 1).meanBp - ((0.2 + 0.1 + 0.3) / 3) * 10_000) < 1e-9);
});

test("fewer than three eligible markets is INSUFFICIENT_DATA, and a market with ticks in only half of the hours is not eligible", () => {
  const two = runStudy({ db: syntheticDb(2), now: END + 3 * H });
  assert.deepEqual(two, { status: "INSUFFICIENT_DATA", markets: 2, eligible: 2 });
  const mixed = runStudy({ db: syntheticDb(5, { sparse: [4] }), now: END + 3 * H });
  assert.match(mixed.status, /^HOLDOUT_(PASS|FAIL)$/);
  assert.equal(mixed.markets, 5);
  assert.equal(mixed.eligible, 4, "the sparse market fails the 90% tick-hour bar");
});

test("a complete synthetic span runs once, reports only fixed numeric fields and is deterministic", () => {
  const result = runStudy({ db: syntheticDb(5), now: END + 3 * H });
  assert.match(result.status, /^HOLDOUT_(PASS|FAIL)$/);
  assert.equal(result.eligible, 5);
  assert.equal(result.bar, Number((0.05 / 198).toPrecision(3)));
  for (const [key, value] of Object.entries(result)) if (key !== "status" && key !== "datasetFingerprint") assert.ok(typeof value === "number" || typeof value === "boolean", key);
  assert.ok(result.holdoutTrades >= 50);
  assert.match(result.datasetFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(runStudy({ db: syntheticDb(5), now: END + 3 * H }), result);
});

test("a stored row stamped after the run time fails the study closed", () => {
  const db = syntheticDb(1);
  db.prepare("INSERT INTO research_trade_ticks_v2 VALUES ('KRW-M0', ?, 100, 1, 'BID')").run(END + 10 * H);
  assert.deepEqual(runStudy({ db, now: END + H }), { status: "DATA_INTEGRITY_FAIL", reasonCode: "DATA_FUTURE" });
  const db2 = syntheticDb(1);
  db2.prepare("INSERT INTO research_orderbook_samples VALUES ('KRW-M0', ?, 99, 101, 1, 1, 1, 1)").run(END + 10 * H);
  assert.equal(runStudy({ db: db2, now: END + H }).reasonCode, "DATA_FUTURE");
});

test("an unknown study id is refused instead of falling back to another span", () => {
  const run = spawnSync(process.execPath, ["-e", "require('./scripts/run-tradeflow-study.js')"], { cwd: require("node:path").resolve(__dirname, ".."), env: { ...process.env, NUSA_TRADEFLOW_STUDY_ID: "ML_TRADEFLOW_60M_OTHER" }, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /TRADEFLOW_STUDY_ID_UNKNOWN/);
});

test("the second pre-registered study has its own span, K and version, and the first keeps its own", () => {
  const run = spawnSync(process.execPath, ["-e", "const m = require('./scripts/run-tradeflow-study.js'); console.log(JSON.stringify({ id: m.STUDY_ID, version: m.VERSION, k: m.K, s: [m.START, m.VAL, m.HOLD, m.END].map((t) => new Date(t).toISOString()) }))"], { cwd: require("node:path").resolve(__dirname, ".."), env: { ...process.env, NUSA_TRADEFLOW_STUDY_ID: "ML_TRADEFLOW_60M_20261114" }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { id: "ML_TRADEFLOW_60M_20261114", version: 2, k: 201, s: ["2026-11-15T06:00:00.000Z", "2026-11-22T06:00:00.000Z", "2026-11-24T06:00:00.000Z", "2026-11-28T06:00:00.000Z"] });
  assert.equal(require("./run-tradeflow-study.js").VERSION, 1);
  assert.equal(K, 198);
  const first = Object.values(require("./run-tradeflow-study.js").SPANS);
  assert.equal(first.length, 2, "exactly the two pre-registered studies exist");
});

test("the printed study line names its study version", () => {
  const src = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "run-tradeflow-study.js"), "utf8");
  assert.match(src, /studyVersion: VERSION/);
});
