"use strict";
/**
 * Pre-registered ORDERBOOK+INTRADAY+ALL_KRW+ML study (the meta-learner's recommendation after ML_TRADES_FLOW_15M_20261013
 * failed), work order WO-RESEARCH-20261014-ORDERBOOK-STUDY. Runs on the PAPER host inside the existing nusa-research service,
 * reads research_orderbook_samples READ-ONLY from NUSA_CLOUD_STATE_DB_PATH, and prints one line:
 *   ORDERBOOK_STUDY {"status":"WAITING_DATA"|"INSUFFICIENT_DATA"|"HOLDOUT_PASS"|"HOLDOUT_FAIL", ...fixed numeric fields}
 * It places no order, writes nothing, and its result is research evidence only (a PASS qualifies a forward SHADOW test, not
 * promotion). Bounded: one market's rows in memory at a time, down-sampled to one per minute.
 *
 * Fixed before any order-book row was examined (nothing below may change after this commit):
 * - Span of the FIRST run: 2026-10-15T00:00Z .. 2026-10-29T00:00Z (14 days of the all-KRW collector, deployed 2026-10-14 01:22Z). The second run uses the span in docs/RESEARCH_PREREG_2026-11-11_ORDERBOOK_60M.md (see SPANS below); every other rule here is shared by both runs.
 *   Train 10-15..10-22, validation 10-23..10-24, holdout 10-25..10-28. Decision rows whose 60m exit would cross into the next
 *   split are dropped.
 * - Book at time t = the last sample captured in (t - 2 min, t]; a decision needs a book at t, t-15m, t-60m, t-240m and t+60m.
 * - Eligible market: a book at >= 90% of training decision hours AND median training spread <= 20 bp (training data only).
 * - Decision every hour on the hour. Features: mid log return over 15, 60, 240 minutes; top-5 imbalance
 *   (bid5 - ask5) / (bid5 + ask5) at t, and its change over 60 minutes; total-depth imbalance at t; spread in bp at t;
 *   cross-sectional percentile of the 60m return. Standardised with training means and deviations.
 * - Execution: buy at the best ask at t, sell at the best bid at t+60m, fee 0.05% per side (stress: 2x fee plus 5 bp per side).
 *   Label: net return after base costs > 0.
 * - Model: L2 logistic regression, full-batch gradient descent (2,000 steps, rate 0.1, zero init), lambda in {0.1, 1, 10};
 *   the lambda with the best validation mean net per trade is chosen. Nothing is tuned on holdout.
 * - Rule: each decision hour buy the top 3 eligible markets by predicted probability, equal weight, hold 60m.
 * - Holdout PASS only if all hold: >= 50 trades; mean net per trade > 0; one-sided z-test p < 0.05 / 195 (ledger 192
 *   configurations + 3 lambdas); mean net under stress costs > 0; mean net beats buying every eligible market at the same hours.
 *
 * Data-integrity addendum (2026-10-14, WO-DATA-20261014-ORDERBOOK-INTEGRITY; changes no rule above): the result line also carries
 * the identity of the dataset actually consumed (sha256 over the per-minute rows of every eligible market in canonical order,
 * row count and observed range), and the study fails closed with DATA_INTEGRITY_FAIL:DATA_FUTURE if any stored row is stamped
 * more than 5 s after the run time.
 */
const crypto = require("node:crypto");
const { orderBookSource } = require("./lib/orderBookSource.js");
const M = 60_000;
const H = 60 * M;
// Span per pre-registered run. Only the span differs between runs; every rule in this file is shared.
// ML_ORDERBOOK_60M_20261029: the closed first run (INSUFFICIENT_DATA, docs: WO-RESEARCH-20261014-ORDERBOOK-STUDY).
// ML_ORDERBOOK_60M_20261111: the second run, docs/RESEARCH_PREREG_2026-11-11_ORDERBOOK_60M.md (forward holdout).
const SPANS = Object.freeze({
  ML_ORDERBOOK_60M_20261029: Object.freeze({ START: Date.parse("2026-10-15T00:00:00Z"), VAL: Date.parse("2026-10-23T00:00:00Z"), HOLD: Date.parse("2026-10-25T00:00:00Z"), END: Date.parse("2026-10-29T00:00:00Z") }),
  ML_ORDERBOOK_60M_20261111: Object.freeze({ START: Date.parse("2026-11-04T00:00:00Z"), VAL: Date.parse("2026-11-12T00:00:00Z"), HOLD: Date.parse("2026-11-14T00:00:00Z"), END: Date.parse("2026-11-18T00:00:00Z") }),
});
const DEFAULT_STUDY_ID = "ML_ORDERBOOK_60M_20261111";
// An unknown id is refused instead of falling back to another span (fail closed).
const STUDY_ID = process.env.NUSA_ORDERBOOK_STUDY_ID === undefined || process.env.NUSA_ORDERBOOK_STUDY_ID === "" ? DEFAULT_STUDY_ID : process.env.NUSA_ORDERBOOK_STUDY_ID;
if (!Object.prototype.hasOwnProperty.call(SPANS, STUDY_ID)) throw new Error("ORDERBOOK_STUDY_ID_UNKNOWN");
const { START, VAL, HOLD, END } = SPANS[STUDY_ID];
const K = 195;
const FEE = 0.0005;
const STRESS_SLIP = 0.0005;
const PICKS = 3;

function bookSeries(db, market) {
  // Data-access addendum 2026-10-21 (WO-RESEARCH-20261021-ORDERBOOK-RETENTION): the books come from the live table AND the study archive,
  // so the collector's 14-day prune cannot remove the training days. No rule below changes.
  // One row per minute (the last sample of each minute), so a 5-second WebSocket market costs the same as a collector market.
  const byMinute = new Map();
  const stmt = db.prepare(`SELECT captured_at_ms AS t, best_bid AS b, best_ask AS a, bid_size_5 AS b5, ask_size_5 AS a5, total_bid_size AS tb, total_ask_size AS ta FROM ${orderBookSource(db)} WHERE market = ? AND captured_at_ms > ? AND captured_at_ms <= ? ORDER BY captured_at_ms`);
  for (const r of stmt.iterate(market, START - 5 * H, END + 2 * H)) byMinute.set(Math.floor(r.t / M), r);
  return byMinute;
}

function bookAt(series, t) {
  for (const minute of [Math.floor(t / M), Math.floor(t / M) - 1]) {
    const r = series.get(minute);
    if (r != null && r.t <= t && r.t > t - 2 * M) return r;
  }
  return undefined;
}

function median(values) { const s = [...values].sort((x, y) => x - y); return s.length === 0 ? Infinity : s[Math.floor(s.length / 2)]; }
const mid = (r) => (r.a + r.b) / 2;
const imb5 = (r) => (r.b5 + r.a5 > 0 ? (r.b5 - r.a5) / (r.b5 + r.a5) : 0);

function rowsFor(series) {
  const rows = [];
  for (let t = START; t + H <= END; t += H) {
    const now = bookAt(series, t); const b15 = bookAt(series, t - 15 * M); const b60 = bookAt(series, t - H); const b240 = bookAt(series, t - 4 * H); const exit = bookAt(series, t + H);
    if (!now || !b15 || !b60 || !b240 || !exit) continue;
    const spreadBp = ((now.a - now.b) / mid(now)) * 10_000;
    const net = (stress) => (exit.b * (1 - (stress ? STRESS_SLIP : 0)) * (1 - FEE * (stress ? 2 : 1))) / (now.a * (1 + (stress ? STRESS_SLIP : 0)) * (1 + FEE * (stress ? 2 : 1))) - 1;
    rows.push({ t, spreadBp, x: [Math.log(mid(now) / mid(b15)), Math.log(mid(now) / mid(b60)), Math.log(mid(now) / mid(b240)), imb5(now), imb5(now) - imb5(b60), now.tb + now.ta > 0 ? (now.tb - now.ta) / (now.tb + now.ta) : 0, spreadBp], net: net(false), stress: net(true) });
  }
  return rows;
}

function train(X, y, lambda) {
  const d = X[0].length; const w = new Array(d + 1).fill(0);
  for (let step = 0; step < 2000; step += 1) {
    const g = new Array(d + 1).fill(0);
    for (let r = 0; r < X.length; r += 1) {
      let z = w[d]; for (let j = 0; j < d; j += 1) z += w[j] * X[r][j];
      const e = 1 / (1 + Math.exp(-z)) - y[r];
      for (let j = 0; j < d; j += 1) g[j] += e * X[r][j];
      g[d] += e;
    }
    for (let j = 0; j < d; j += 1) w[j] -= 0.1 * (g[j] / X.length + (lambda * w[j]) / X.length);
    w[d] -= (0.1 * g[d]) / X.length;
  }
  return (x) => { let z = w[d]; for (let j = 0; j < d; j += 1) z += w[j] * x[j]; return z; };
}

function erfc(x) { const t = 1 / (1 + 0.5 * Math.abs(x)); const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851547 + t * (-0.82215223 + t * 0.17087277))))))))); return x >= 0 ? r : 2 - r; }

function evaluate(rows, score) {
  const byHour = new Map();
  for (const r of rows) { if (!byHour.has(r.t)) byHour.set(r.t, []); byHour.get(r.t).push(r); }
  const picks = []; const all = [];
  for (const group of byHour.values()) {
    for (const r of group) all.push(r.net);
    [...group].sort((a, b) => score(b.x) - score(a.x)).slice(0, PICKS).forEach((r) => picks.push(r));
  }
  const mean = (a) => (a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length);
  const nets = picks.map((r) => r.net);
  const m = mean(nets);
  const sd = Math.sqrt(nets.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, nets.length - 1));
  const z = sd > 0 && nets.length > 1 ? m / (sd / Math.sqrt(nets.length)) : 0;
  return { trades: nets.length, meanBp: m * 10_000, universeBp: mean(all) * 10_000, stressBp: mean(picks.map((r) => r.stress)) * 10_000, winPct: nets.length === 0 ? 0 : (100 * nets.filter((v) => v > 0).length) / nets.length, p: 0.5 * erfc(z / Math.SQRT2) };
}

function runStudy({ db, now = Date.now() }) {
  if (now < END + 2 * H) return { status: "WAITING_DATA", daysCollected: Math.max(0, Math.floor((Math.min(now, END) - START) / (24 * H))) };
  // Any stored row stamped after the run time (beyond 5 s clock skew) means the clock or the source cannot be trusted.
  if (Number(db.prepare(`SELECT COUNT(*) AS n FROM ${orderBookSource(db)} WHERE captured_at_ms > ?`).get(now + 5_000).n) > 0) return { status: "DATA_INTEGRITY_FAIL", reasonCode: "DATA_FUTURE" };
  const markets = db.prepare(`SELECT DISTINCT market FROM ${orderBookSource(db)} WHERE captured_at_ms > ? AND captured_at_ms <= ?`).all(START, END).map((r) => r.market);
  const rows = [];
  let eligible = 0;
  const hash = crypto.createHash("sha256");
  let datasetRows = 0; let firstAt = Infinity; let lastAt = -Infinity;
  const trainHours = (VAL - START) / H;
  for (const market of markets) {
    const series = bookSeries(db, market);
    const marketRows = rowsFor(series);
    const trainRows = marketRows.filter((r) => r.t + H <= VAL);
    if (trainRows.length < 0.9 * trainHours || median(trainRows.map((r) => r.spreadBp)) > 20) continue;
    eligible += 1;
    hash.update(`${market}\n`);
    for (const minute of [...series.keys()].sort((x, y) => x - y)) {
      const r = series.get(minute);
      hash.update(`${r.t},${r.b},${r.a},${r.b5},${r.a5},${r.tb},${r.ta}\n`);
      datasetRows += 1; firstAt = Math.min(firstAt, r.t); lastAt = Math.max(lastAt, r.t);
    }
    rows.push(...marketRows.filter((r) => (r.t < VAL ? r.t + H <= VAL : r.t < HOLD ? r.t + H <= HOLD : true)));
  }
  const byHour = new Map();
  for (const r of rows) { if (!byHour.has(r.t)) byHour.set(r.t, []); byHour.get(r.t).push(r); }
  for (const group of byHour.values()) {
    const sorted = [...group].sort((a, b) => a.x[1] - b.x[1]);
    sorted.forEach((r, k) => r.x.push(sorted.length > 1 ? k / (sorted.length - 1) : 0.5));
  }
  const trainRows = rows.filter((r) => r.t < VAL); const valRows = rows.filter((r) => r.t >= VAL && r.t < HOLD); const holdRows = rows.filter((r) => r.t >= HOLD);
  if (eligible < PICKS + 1 || trainRows.length === 0 || valRows.length === 0 || holdRows.length === 0) return { status: "INSUFFICIENT_DATA", markets: markets.length, eligible };
  const d = trainRows[0].x.length;
  const mu = Array.from({ length: d }, (_, j) => trainRows.reduce((s, r) => s + r.x[j], 0) / trainRows.length);
  const sdv = Array.from({ length: d }, (_, j) => Math.sqrt(trainRows.reduce((s, r) => s + (r.x[j] - mu[j]) ** 2, 0) / trainRows.length) || 1);
  for (const r of rows) r.x = r.x.map((v, j) => (v - mu[j]) / sdv[j]);
  let best;
  for (const lambda of [0.1, 1, 10]) {
    const score = train(trainRows.map((r) => r.x), trainRows.map((r) => (r.net > 0 ? 1 : 0)), lambda);
    const v = evaluate(valRows, score);
    if (best == null || v.meanBp > best.v.meanBp) best = { lambda, score, v };
  }
  const h = evaluate(holdRows, best.score);
  const pass = h.trades >= 50 && h.meanBp > 0 && h.p < 0.05 / K && h.stressBp > 0 && h.meanBp > h.universeBp;
  const round = (x) => Math.round(x * 100) / 100;
  return {
    status: pass ? "HOLDOUT_PASS" : "HOLDOUT_FAIL", markets: markets.length, eligible, lambda: best.lambda,
    datasetFingerprint: hash.digest("hex"), datasetRows, datasetFirstAt: firstAt, datasetLastAt: lastAt,
    discoveryPass: best.v.meanBp > 0 && best.v.meanBp > best.v.universeBp, validationTrades: best.v.trades, validationMeanBp: round(best.v.meanBp), validationUniverseBp: round(best.v.universeBp),
    holdoutTrades: h.trades, holdoutMeanBp: round(h.meanBp), holdoutUniverseBp: round(h.universeBp), holdoutStressBp: round(h.stressBp), holdoutWinPct: round(h.winPct), holdoutP: Number(h.p.toPrecision(3)), bar: Number((0.05 / K).toPrecision(3)),
  };
}

/** Durable handoff to the runtime meta-learner (researchStudyResult.ts reads it); written only for a final HOLDOUT_* result. */
const RESULT_FILE = "orderbook-study-result.json";
function writeResult(stateDbPath, result, fs = require("node:fs"), pathLib = require("node:path")) {
  if (result.status !== "HOLDOUT_PASS" && result.status !== "HOLDOUT_FAIL") return false;
  const target = pathLib.join(pathLib.dirname(stateDbPath), RESULT_FILE);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...result, schemaVersion: 1, studyId: STUDY_ID }));
  fs.renameSync(temporary, target);
  return true;
}

module.exports = { runStudy, writeResult, RESULT_FILE, START, END, SPANS, STUDY_ID };

if (require.main === module) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const path = String(process.env.NUSA_CLOUD_STATE_DB_PATH || "");
    if (!path.startsWith("/")) throw new Error("state path");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const result = runStudy({ db });
      console.log("ORDERBOOK_STUDY", JSON.stringify(result));
      writeResult(path, result);
    } finally { db.close(); }
  } catch { console.error("ORDERBOOK_STUDY_FAILED_CLOSED"); process.exitCode = 1; }
}
