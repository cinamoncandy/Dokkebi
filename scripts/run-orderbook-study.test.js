"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { runStudy, START, END } = require("./run-orderbook-study.js");

function syntheticDb(markets) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE research_orderbook_samples (market TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, best_bid REAL NOT NULL, best_ask REAL NOT NULL, bid_size_5 REAL NOT NULL, ask_size_5 REAL NOT NULL, total_bid_size REAL NOT NULL, total_ask_size REAL NOT NULL, PRIMARY KEY (market, captured_at_ms))");
  const insert = db.prepare("INSERT INTO research_orderbook_samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  db.exec("BEGIN");
  for (let m = 0; m < markets; m += 1) {
    let price = 1000 + m * 10;
    for (let t = START - 5 * 3_600_000; t <= END + 3_600_000; t += 5 * 60_000) {
      price *= 1 + (rand() - 0.5) * 0.004;
      insert.run(`KRW-M${m}`, t, price * 0.9998, price * 1.0002, 1 + rand(), 1 + rand(), 10 + rand(), 10 + rand());
    }
  }
  db.exec("COMMIT");
  return db;
}

test("waits until the pre-registered span has been collected", () => {
  const db = syntheticDb(1);
  assert.deepEqual(runStudy({ db, now: START + 3.5 * 86_400_000 }), { status: "WAITING_DATA", daysCollected: 3 });
});

test("runs once the span is complete and reports only fixed numeric fields", () => {
  const db = syntheticDb(6);
  const result = runStudy({ db, now: END + 3 * 3_600_000 });
  assert.match(result.status, /^HOLDOUT_(PASS|FAIL)$/);
  assert.equal(result.markets, 6);
  assert.equal(result.eligible, 6);
  assert.equal(result.bar, Number((0.05 / 195).toPrecision(3)));
  for (const [key, value] of Object.entries(result)) if (key !== "status" && key !== "datasetFingerprint") assert.ok(typeof value === "number" || typeof value === "boolean", key);
  assert.ok(result.holdoutTrades > 0);
  assert.match(result.datasetFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(result.datasetRows > 0 && result.datasetFirstAt < result.datasetLastAt);
  assert.equal(runStudy({ db: syntheticDb(6), now: END + 3 * 3_600_000 }).datasetFingerprint, result.datasetFingerprint, "deterministic identity for the same data");
});

test("a row stamped after the run time fails closed as DATA_FUTURE", () => {
  const db = syntheticDb(6);
  const now = END + 3 * 3_600_000;
  db.prepare("INSERT INTO research_orderbook_samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("KRW-M0", now + 600_000, 100, 101, 1, 1, 1, 1);
  assert.deepEqual(runStudy({ db, now }), { status: "DATA_INTEGRITY_FAIL", reasonCode: "DATA_FUTURE" });
  assert.notEqual(runStudy({ db, now: now + 600_000 }).status, "DATA_INTEGRITY_FAIL", "the same row is valid once its time has come");
});

test("too few eligible markets is reported, not guessed", () => {
  const db = syntheticDb(2);
  assert.equal(runStudy({ db, now: END + 3 * 3_600_000 }).status, "INSUFFICIENT_DATA");
});

test("only a final result is handed off, atomically, beside the state database", () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const { writeResult, RESULT_FILE } = require("./run-orderbook-study.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-ob-"));
  const dbPath = path.join(dir, "cloud-state.db");
  assert.equal(writeResult(dbPath, { status: "WAITING_DATA", daysCollected: 3 }), false);
  assert.equal(fs.existsSync(path.join(dir, RESULT_FILE)), false);
  assert.equal(writeResult(dbPath, { status: "HOLDOUT_FAIL", eligible: 9, discoveryPass: false, datasetFingerprint: "b".repeat(64) }), true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, RESULT_FILE), "utf8"));
  const { STUDY_ID } = require("./run-orderbook-study.js");
  assert.equal(saved.studyId, STUDY_ID, "a result is attributed to the study that produced it (independent review P1 on #3084)");
  assert.equal(saved.studyId, "ML_ORDERBOOK_60M_20261111");
  assert.equal(saved.schemaVersion, 1);
  assert.equal(fs.existsSync(path.join(dir, `${RESULT_FILE}.tmp`)), false);
});

test("the default span is the second pre-registered run and the first run's span is still selectable", () => {
  const { SPANS, STUDY_ID } = require("./run-orderbook-study.js");
  assert.equal(STUDY_ID, "ML_ORDERBOOK_60M_20261111");
  const iso = (ms) => new Date(ms).toISOString();
  const second = SPANS.ML_ORDERBOOK_60M_20261111;
  assert.deepEqual([iso(second.START), iso(second.VAL), iso(second.HOLD), iso(second.END)], ["2026-11-04T00:00:00.000Z", "2026-11-12T00:00:00.000Z", "2026-11-14T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
  const first = SPANS.ML_ORDERBOOK_60M_20261029;
  assert.deepEqual([iso(first.START), iso(first.VAL), iso(first.HOLD), iso(first.END)], ["2026-10-15T00:00:00.000Z", "2026-10-23T00:00:00.000Z", "2026-10-25T00:00:00.000Z", "2026-10-29T00:00:00.000Z"]);
  assert.ok(Object.isFrozen(SPANS) && Object.isFrozen(second));
});

test("an unknown study id is refused, never mapped to another span", () => {
  const { spawnSync } = require("node:child_process");
  const run = spawnSync(process.execPath, ["-e", "require('./scripts/run-orderbook-study.js')"], { cwd: require("node:path").resolve(__dirname, ".."), env: { ...process.env, NUSA_ORDERBOOK_STUDY_ID: "ML_ORDERBOOK_60M_19990101" }, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /ORDERBOOK_STUDY_ID_UNKNOWN/);
});

test("before END + 2h the study answers WAITING_DATA and touches no order-book value (pre-registration invariant)", () => {
  const { runStudy, END } = require("./run-orderbook-study.js");
  const db = { prepare() { throw new Error("DB_TOUCHED_BEFORE_THE_HOLDOUT_ENDED"); } };
  for (const now of [END - 86_400_000, END, END + 2 * 3_600_000 - 1]) {
    const result = runStudy({ db, now });
    assert.equal(result.status, "WAITING_DATA", String(now));
  }
});

test("the result of a run started with the first study's id is attributed to the first study", () => {
  const { spawnSync } = require("node:child_process");
  const code = "const m=require('./scripts/run-orderbook-study.js');const fs=require('fs'),os=require('os'),p=require('path');const d=fs.mkdtempSync(p.join(os.tmpdir(),'ob1-'));m.writeResult(p.join(d,'s.db'),{status:'HOLDOUT_PASS',eligible:9,discoveryPass:true,datasetFingerprint:'c'.repeat(64)});console.log(JSON.parse(fs.readFileSync(p.join(d,m.RESULT_FILE),'utf8')).studyId);";
  const run = spawnSync(process.execPath, ["-e", code], { cwd: require("node:path").resolve(__dirname, ".."), env: { ...process.env, NUSA_ORDERBOOK_STUDY_ID: "ML_ORDERBOOK_60M_20261029" }, encoding: "utf8" });
  assert.equal(run.stdout.trim(), "ML_ORDERBOOK_60M_20261029");
});
