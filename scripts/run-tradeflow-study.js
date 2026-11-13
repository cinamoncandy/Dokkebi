"use strict";
/**
 * Pre-registered TRADES+INTRADAY+ALL_KRW+ML 60m study (trade-flow replication on live-recorded ticks), work order
 * WO-RESEARCH-20261113-TRADEFLOW-PREREG. The rules below are written in docs/RESEARCH_PREREG_2026-11-13_TRADEFLOW_60M.md; this file
 * implements that document and nothing else. It runs on the PAPER host inside the nusa-research service, reads research_trade_ticks_v2 and
 * the order-book source READ-ONLY from NUSA_CLOUD_STATE_DB_PATH, and prints one line:
 *   TRADEFLOW_STUDY {"status":"WAITING_DATA"|"INSUFFICIENT_DATA"|"DATA_INTEGRITY_FAIL"|"HOLDOUT_PASS"|"HOLDOUT_FAIL", ...fixed numeric fields}
 * It places no order, writes nothing, and its result is research evidence only (a PASS qualifies a forward SHADOW test, not promotion).
 *
 * Identical to scripts/run-orderbook-study.js except: the six trade features, the span, the eligibility counts, and ONE tie-break (equal predicted
 * probabilities within an hour are ordered by market code ascending; the order-book script keeps input order). The PASS rule is the same with K = 198.
 * Two readings of the document that differ from the order-book script's code are spelled out here so nobody has to guess:
 * - eligibility counts decision hours t in [START, VAL) (168 hours) that have a book at t, and separately those with at least one tick in
 *   (t - 1 h, t]; each must reach 90% of 168. The order-book script counts finished rows instead.
 * - INSUFFICIENT_DATA when fewer than 3 markets are eligible (the order-book script uses fewer than 4) or when the holdout has fewer than 50 trades.
 */
const crypto = require("node:crypto");
const { orderBookSource } = require("./lib/orderBookSource.js");
const M = 60_000;
const H = 60 * M;
const SPANS = Object.freeze({
  ML_TRADEFLOW_60M_20261113: Object.freeze({ START: Date.parse("2026-11-07T00:00:00Z"), VAL: Date.parse("2026-11-14T00:00:00Z"), HOLD: Date.parse("2026-11-16T00:00:00Z"), END: Date.parse("2026-11-20T00:00:00Z") }),
});
const DEFAULT_STUDY_ID = "ML_TRADEFLOW_60M_20261113";
// An unknown id is refused instead of falling back to another span (fail closed).
const STUDY_ID = process.env.NUSA_TRADEFLOW_STUDY_ID === undefined || process.env.NUSA_TRADEFLOW_STUDY_ID === "" ? DEFAULT_STUDY_ID : process.env.NUSA_TRADEFLOW_STUDY_ID;
if (!Object.prototype.hasOwnProperty.call(SPANS, STUDY_ID)) throw new Error("TRADEFLOW_STUDY_ID_UNKNOWN");
const { START, VAL, HOLD, END } = SPANS[STUDY_ID];
const K = 198;
const FEE = 0.0005;
const STRESS_SLIP = 0.0005;
const PICKS = 3;
const MIN_ELIGIBLE = 3;
const MIN_HOLDOUT_TRADES = 50;
const EARLIEST_RUN_AFTER_END = 30 * M;
const EPS = 1e-9;

/** The one fixed total order of the pre-registration: time, then price, then volume, then side (ASK before BID). Storage order is never used. */
function compareTicks(a, b) {
  return (a.t - b.t) || (a.p - b.p) || (a.v - b.v) || (a.s === b.s ? 0 : a.s < b.s ? -1 : 1);
}

/** All ticks of one market in (START - 24 h, END], put in that order here (not left to the database's index order). */
function tickSeries(db, market) {
  const stmt = db.prepare("SELECT traded_at_ms AS t, price AS p, volume AS v, side AS s FROM research_trade_ticks_v2 WHERE market = ? AND traded_at_ms > ? AND traded_at_ms <= ?");
  const rows = [...stmt.iterate(market, START - 24 * H, END)].sort(compareTicks);
  const time = []; const price = []; const volume = []; const bid = [];
  for (const r of rows) { time.push(r.t); price.push(r.p); volume.push(r.v); bid.push(r.s === "BID" ? 1 : 0); }
  const cumVolume = new Array(time.length + 1).fill(0);
  for (let i = 0; i < time.length; i += 1) cumVolume[i + 1] = cumVolume[i] + volume[i];
  return { time, price, volume, bid, cumVolume };
}

/** First index whose time is strictly greater than `limit` (ticks of a window (a, b] are the indexes [after(a), after(b))). */
function after(time, limit) {
  let lo = 0; let hi = time.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (time[mid] > limit) hi = mid; else lo = mid + 1; }
  return lo;
}

function imbalance(series, from, to, weighted) {
  let b = 0; let a = 0;
  for (let i = from; i < to; i += 1) { const w = weighted ? series.price[i] * series.volume[i] : series.volume[i]; if (series.bid[i] === 1) b += w; else a += w; }
  return b + a > 0 ? (b - a) / (b + a) : 0;
}

/** The six pre-registered features at decision time t, or undefined when there is no tick in (t - 60 min, t]. */
function featuresAt(series, t) {
  const t15 = after(series.time, t - 15 * M); const t60 = after(series.time, t - H); const t24 = after(series.time, t - 24 * H); const end = after(series.time, t);
  if (end - t60 < 1) return undefined;
  let squares = 0;
  for (let i = t60 + 1; i < end; i += 1) squares += Math.log(series.price[i] / series.price[i - 1]) ** 2;
  const v60 = series.cumVolume[end] - series.cumVolume[t60];
  const v24 = series.cumVolume[end] - series.cumVolume[t24];
  return [imbalance(series, t15, end, false), imbalance(series, t60, end, false), imbalance(series, t60, end, true), Math.log(1 + (end - t15)), Math.sqrt(squares), Math.log((v60 + EPS) / (v24 / 24 + EPS))];
}

function hasTickInHour(series, t) { return after(series.time, t) - after(series.time, t - H) >= 1; }

function bookSeries(db, market) {
  const byMinute = new Map();
  const stmt = db.prepare(`SELECT captured_at_ms AS t, best_bid AS b, best_ask AS a FROM ${orderBookSource(db)} WHERE market = ? AND captured_at_ms > ? AND captured_at_ms <= ? ORDER BY captured_at_ms ASC`);
  for (const r of stmt.iterate(market, START - 5 * H, END + 2 * H)) byMinute.set(Math.floor(r.t / M), r);
  return byMinute;
}

/** Book at t = the last sample in (t - 2 min, t], exactly as in the order-book study. */
function bookAt(series, t) {
  for (const minute of [Math.floor(t / M), Math.floor(t / M) - 1]) {
    const r = series.get(minute);
    if (r != null && r.t <= t && r.t > t - 2 * M) return r;
  }
  return undefined;
}

function median(values) { const s = [...values].sort((x, y) => x - y); return s.length === 0 ? Infinity : s[Math.floor(s.length / 2)]; }
const mid = (r) => (r.a + r.b) / 2;

function marketRows(market, ticks, books) {
  const rows = [];
  let bookHours = 0; let tickHours = 0;
  for (let t = START; t + H <= END; t += H) {
    const now = bookAt(books, t);
    if (t < VAL) { if (now) bookHours += 1; if (hasTickInHour(ticks, t)) tickHours += 1; }
    const exit = bookAt(books, t + H);
    if (!now || !exit) continue;
    const x = featuresAt(ticks, t);
    if (!x) continue;
    const spreadBp = ((now.a - now.b) / mid(now)) * 10_000;
    const net = (stress) => (exit.b * (1 - (stress ? STRESS_SLIP : 0)) * (1 - FEE * (stress ? 2 : 1))) / (now.a * (1 + (stress ? STRESS_SLIP : 0)) * (1 + FEE * (stress ? 2 : 1))) - 1;
    rows.push({ market, t, spreadBp, x, ask: now.a, exitBid: exit.b, net: net(false), stress: net(true) });
  }
  return { rows, bookHours, tickHours };
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
    // The one deliberate deviation from the order-book study: equal predicted probabilities are ordered by market code ascending.
    [...group].sort((a, b) => (score(b.x) - score(a.x)) || (a.market < b.market ? -1 : a.market > b.market ? 1 : 0)).slice(0, PICKS).forEach((r) => picks.push(r));
  }
  const mean = (a) => (a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length);
  const nets = picks.map((r) => r.net);
  const m = mean(nets);
  const sd = Math.sqrt(nets.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, nets.length - 1));
  const z = sd > 0 && nets.length > 1 ? m / (sd / Math.sqrt(nets.length)) : 0;
  return { trades: nets.length, meanBp: m * 10_000, universeBp: mean(all) * 10_000, stressBp: mean(picks.map((r) => r.stress)) * 10_000, winPct: nets.length === 0 ? 0 : (100 * nets.filter((v) => v > 0).length) / nets.length, p: 0.5 * erfc(z / Math.SQRT2) };
}

function runStudy({ db, now = Date.now() }) {
  if (now < END + EARLIEST_RUN_AFTER_END) return { status: "WAITING_DATA", daysCollected: Math.max(0, Math.floor((Math.min(now, END) - START) / (24 * H))) };
  // Any stored row stamped after the run time (beyond 5 s clock skew) means the clock or the source cannot be trusted.
  const futureTicks = Number(db.prepare("SELECT COUNT(*) AS n FROM research_trade_ticks_v2 WHERE traded_at_ms > ?").get(now + 5_000).n);
  const futureBooks = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${orderBookSource(db)} WHERE captured_at_ms > ?`).get(now + 5_000).n);
  if (futureTicks > 0 || futureBooks > 0) return { status: "DATA_INTEGRITY_FAIL", reasonCode: "DATA_FUTURE" };
  const markets = db.prepare("SELECT DISTINCT market FROM research_trade_ticks_v2 WHERE traded_at_ms > ? AND traded_at_ms <= ? ORDER BY market ASC").all(START - 24 * H, END).map((r) => r.market).filter((m) => /^KRW-[A-Z0-9-]+$/.test(m));
  const trainHours = (VAL - START) / H;
  const rows = [];
  let eligible = 0;
  const hash = crypto.createHash("sha256");
  let datasetRows = 0; let firstAt = Infinity; let lastAt = -Infinity;
  for (const market of markets) {
    const built = marketRows(market, tickSeries(db, market), bookSeries(db, market));
    const trainRows = built.rows.filter((r) => r.t + H <= VAL);
    if (built.bookHours < 0.9 * trainHours || built.tickHours < 0.9 * trainHours || median(trainRows.map((r) => r.spreadBp)) > 20) continue;
    eligible += 1;
    hash.update(`${market}\n`);
    for (const r of built.rows) { hash.update(`${r.t},${r.x.join(",")},${r.ask},${r.exitBid}\n`); datasetRows += 1; firstAt = Math.min(firstAt, r.t); lastAt = Math.max(lastAt, r.t); }
    rows.push(...built.rows.filter((r) => (r.t < VAL ? r.t + H <= VAL : r.t < HOLD ? r.t + H <= HOLD : true)));
  }
  const trainRows = rows.filter((r) => r.t < VAL); const valRows = rows.filter((r) => r.t >= VAL && r.t < HOLD); const holdRows = rows.filter((r) => r.t >= HOLD);
  if (eligible < MIN_ELIGIBLE || trainRows.length === 0 || valRows.length === 0 || holdRows.length === 0) return { status: "INSUFFICIENT_DATA", markets: markets.length, eligible };
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
  if (h.trades < MIN_HOLDOUT_TRADES) return { status: "INSUFFICIENT_DATA", markets: markets.length, eligible, holdoutTrades: h.trades };
  const pass = h.meanBp > 0 && h.p < 0.05 / K && h.stressBp > 0 && h.meanBp > h.universeBp;
  const round = (x) => Math.round(x * 100) / 100;
  return {
    status: pass ? "HOLDOUT_PASS" : "HOLDOUT_FAIL", markets: markets.length, eligible, lambda: best.lambda,
    datasetFingerprint: hash.digest("hex"), datasetRows, datasetFirstAt: firstAt, datasetLastAt: lastAt,
    discoveryPass: best.v.meanBp > 0 && best.v.meanBp > best.v.universeBp, validationTrades: best.v.trades, validationMeanBp: round(best.v.meanBp), validationUniverseBp: round(best.v.universeBp),
    holdoutTrades: h.trades, holdoutMeanBp: round(h.meanBp), holdoutUniverseBp: round(h.universeBp), holdoutStressBp: round(h.stressBp), holdoutWinPct: round(h.winPct), holdoutP: Number(h.p.toPrecision(3)), bar: Number((0.05 / K).toPrecision(3)),
  };
}

module.exports = { runStudy, evaluate, featuresAt, tickSeries, compareTicks, START, VAL, HOLD, END, SPANS, STUDY_ID, K };

if (require.main === module) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const path = String(process.env.NUSA_CLOUD_STATE_DB_PATH || "");
    if (!path.startsWith("/")) throw new Error("state path");
    const db = new DatabaseSync(path, { readOnly: true });
    try { console.log("TRADEFLOW_STUDY", JSON.stringify(runStudy({ db }))); } finally { db.close(); }
  } catch { console.error("TRADEFLOW_STUDY_FAILED_CLOSED"); process.exitCode = 1; }
}
