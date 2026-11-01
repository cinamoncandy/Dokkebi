const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { SqliteDatabase, SqliteResearchCandleStore } = require("../dist/packages/storage/src/index.js");
const { composeResearchExperiments, readResearchExperimentSettings, RESEARCH_FLAG, RESEARCH_BACKTEST_COST, RESEARCH_GAP_FILL_INTERVAL_MS, RESEARCH_GAP_FILL_MAX_PAGES_PER_RUN } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
const { materializeResearchDatasetManifest } = require("../dist/apps/cloud/src/researchDatasetManifestMaterializer.js");
const { AggregatedResearchCandleSource } = require("../dist/apps/cloud/src/researchCandleAggregation.js");
const { UPBIT_CANDLE_SOURCE_FINGERPRINT } = require("../dist/apps/cloud/src/researchCandleBackfill.js");

const M = 60_000;
const SHA = "b".repeat(40);
const T_END = Date.UTC(2026, 9, 2, 3, 0, 0);
const env = (over = {}) => ({ [RESEARCH_FLAG]: "1", NUSA_SOURCE_COMMIT_SHA: SHA, ...over });
const open = () => new SqliteDatabase(join(mkdtempSync(join(tmpdir(), "nusa-compose-")), "c.db"));

test("disabled by default: no flag, or any value other than exactly 1, composes nothing and says nothing", () => {
  const db = open();
  const lines = [];
  for (const value of [undefined, "", "0", "true", "yes", " 1", "11"]) {
    assert.equal(composeResearchExperiments({ env: { [RESEARCH_FLAG]: value, NUSA_SOURCE_COMMIT_SHA: SHA }, database: db, log: (l) => lines.push(l) }), undefined, String(value));
  }
  assert.deepEqual(lines, []);
  assert.equal(readResearchExperimentSettings({}).status, "DISABLED");
  db.close();
});

test("enabled but misconfigured stays disabled with one reason (fail closed)", () => {
  const db = open();
  const cases = [
    [env({ NUSA_SOURCE_COMMIT_SHA: "" }), "SOURCE_COMMIT_MISSING_OR_MALFORMED"],
    [env({ NUSA_SOURCE_COMMIT_SHA: "abc" }), "SOURCE_COMMIT_MISSING_OR_MALFORMED"],
    [env({ NUSA_SOURCE_COMMIT_SHA: "A".repeat(40) }), "SOURCE_COMMIT_MISSING_OR_MALFORMED"],
    [env({ NUSA_RESEARCH_MARKETS: "BTC-KRW" }), "MARKETS_INVALID"],
    [env({ NUSA_RESEARCH_MARKETS: "KRW-BTC,KRW-BTC" }), "MARKETS_INVALID"],
    [env({ NUSA_RESEARCH_MARKETS: "KRW-A,KRW-B,KRW-C,KRW-D,KRW-E,KRW-F" }), "MARKETS_INVALID"],
    [env({ NUSA_RESEARCH_TRAIN_DAYS: "0" }), "NUMERIC_SETTING_INVALID"],
    [env({ NUSA_RESEARCH_VALIDATION_DAYS: "1.5" }), "NUMERIC_SETTING_INVALID"],
    [env({ NUSA_RESEARCH_HOLDOUT_DAYS: "99" }), "NUMERIC_SETTING_INVALID"],
    [env({ NUSA_RESEARCH_TICK_MINUTES: "1" }), "NUMERIC_SETTING_INVALID"],
    [env({ NUSA_RESEARCH_DAILY_BUDGET: "1000" }), "NUMERIC_SETTING_INVALID"],
    [env({ NUSA_RESEARCH_INTERVAL_MINUTES: "5" }), "INTERVALS_INVALID"],
    [env({ NUSA_RESEARCH_INTERVAL_MINUTES: "60,60" }), "INTERVALS_INVALID"],
    [env({ NUSA_RESEARCH_INTERVAL_MINUTES: "1.5" }), "INTERVALS_INVALID"],
  ];
  for (const [e, reason] of cases) {
    const lines = [];
    assert.equal(composeResearchExperiments({ env: e, database: db, log: (l) => lines.push(l) }), undefined);
    assert.deepEqual(lines, [`[research-experiments] disabled: ${reason}`], reason);
  }
  db.close();
});

test("valid settings use the documented defaults and explicit cost assumptions", () => {
  const r = readResearchExperimentSettings(env());
  assert.equal(r.status, "ENABLED");
  assert.deepEqual([...r.settings.markets], ["KRW-BTC"]);
  assert.deepEqual({ ...r.settings.windows }, { intervalMs: M, trainMs: 7 * 86_400_000, validationMs: 2 * 86_400_000, holdoutMs: 2 * 86_400_000, maxMissingRatio: 0.05 });
  assert.equal(r.settings.tickMs, 30 * M);
  assert.equal(r.settings.dailyBudgetPerVariant, 48);
  assert.deepEqual({ ...RESEARCH_BACKTEST_COST }, { initialCash: 1_000_000, feeRate: 0.0005, slippageBps: 5 });
  assert.deepEqual([...r.settings.intervalsMinutes], [1], "default keeps the original 1m experiments only");
  assert.deepEqual([...readResearchExperimentSettings(env({ NUSA_RESEARCH_INTERVAL_MINUTES: "1,15,60,240" })).settings.intervalsMinutes], [1, 15, 60, 240]);
});

test("longer bars run the same grid on 1m candles aggregated into complete bars, under separate identities", () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const days = 11; const count = days * 1440;
  const rows = Array.from({ length: count }, (_, i) => { const close = Number((100 + 15 * Math.sin(i / 600) + (i % 11) * 0.2).toFixed(4)); return { closeTimeMs: T_END - (count - 1 - i) * M, open: close, high: close + 1, low: close - 1, close, volume: 1 }; });
  store.appendWithMaterial("KRW-BTC", M, rows, { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: UPBIT_CANDLE_SOURCE_FINGERPRINT, evidenceFingerprintSha256: "c".repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  const lines = [];
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_DAILY_BUDGET: "10", NUSA_RESEARCH_INTERVAL_MINUTES: "1,60" }), database: db, now: () => T_END, log: (l) => lines.push(l) });
  try {
    assert.ok(composition);
    materializeResearchDatasetManifest({ store: composition.datasetManifests, candleStore: store, market: "KRW-BTC", intervalMs: M, candles: store.read("KRW-BTC", M, 0, T_END), source: "upbit-1m-closed:KRW-BTC:60000", createdAt: new Date(T_END).toISOString(), sourceCommitSha: SHA });
    const base = store.read("KRW-BTC", M, 0, T_END);
    const hourlyCandles = new AggregatedResearchCandleSource(store, M).read("KRW-BTC", 60 * M, base[0].closeTimeMs, T_END);
    materializeResearchDatasetManifest({ store: composition.datasetManifests, candleStore: store, market: "KRW-BTC", intervalMs: 60 * M, candles: hourlyCandles, source: "upbit-1m-closed:KRW-BTC:3600000", createdAt: new Date(T_END).toISOString(), sourceCommitSha: SHA });
    assert.equal(composition.orchestrators.length, 2);
    assert.equal(composition.orchestrator, composition.orchestrators[0]);
    for (const o of composition.orchestrators) assert.equal(o.recover().status, "READY");
    const report = composition.tickOnce();
    assert.equal(report.started, 10, "the returned report stays the 1m report (4 SMA + 3 RSI + 3 Donchian variants)");
    assert.ok(lines.some((l) => l.startsWith("[research-experiments] tick OK started=10")));
    assert.ok(lines.some((l) => l.startsWith("[research-experiments] tick 60m OK started=10")), lines.join("\n"));
    const hourly = composition.orchestrators[1].statusProjection();
    assert.ok(hourly != null && hourly.experimentCount >= 1);
    assert.equal(hourly.liveAuthority, "NONE");
    assert.equal(hourly.challenger.authority, "ZERO_AUTHORITY");
    const byInterval = composition.experimentTicksByInterval();
    assert.deepEqual(Object.keys(byInterval), ["1m", "60m"]);
    assert.equal(byInterval["60m"].lastStatus, "OK");
    assert.equal(byInterval["60m"].sessionsStarted, 10);
  } finally { composition.stop(); db.close(); }
});

test("enabled composition recovers, runs a real tick on stored candles and exposes the status the app reads", () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const days = 11; const count = days * 1440;
  const rows = Array.from({ length: count }, (_, i) => { const close = Number((100 + 15 * Math.sin(i / 90) + (i % 11) * 0.2).toFixed(4)); return { closeTimeMs: T_END - (count - 1 - i) * M, open: close, high: close + 1, low: close - 1, close, volume: 1 }; });
  store.appendWithMaterial("KRW-BTC", M, rows, { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: UPBIT_CANDLE_SOURCE_FINGERPRINT, evidenceFingerprintSha256: "d".repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  const lines = [];
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_DAILY_BUDGET: "10" }), database: db, now: () => T_END, log: (l) => lines.push(l) });
  try {
    assert.ok(composition);
    materializeResearchDatasetManifest({ store: composition.datasetManifests, candleStore: store, market: "KRW-BTC", intervalMs: M, candles: store.read("KRW-BTC", M, 0, T_END), source: "upbit-1m-closed:KRW-BTC:60000", createdAt: new Date(T_END).toISOString(), sourceCommitSha: SHA });
    assert.equal(composition.orchestrator.recover().status, "READY");
    const report = composition.tickOnce();
    assert.equal(report.status, "OK");
    assert.equal(report.started, 10, "4 SMA + 3 RSI + 3 Donchian variants");
    assert.equal(report.experiments.length, 10);
    for (const e of report.experiments) assert.equal(e.outcome.status, "COMPLETED", JSON.stringify(e));
    // The RSI mean-reversion family runs as its own variants and experiment family, against the same SMA champion.
    const rsi = report.experiments.filter((e) => e.variantId.startsWith("rsi_"));
    assert.deepEqual(rsi.map((e) => e.variantId).sort(), ["rsi_14_25", "rsi_14_30", "rsi_7_20"]);
    for (const e of rsi) assert.equal(e.outcome.validation.challenger.strategyId, `research-challenger-${e.variantId}`);
    for (const e of rsi) assert.match(e.outcome.validation.provenance.experimentFamilyId, /^rsi-research:/);
    const donchian = report.experiments.filter((e) => e.variantId.startsWith("donchian_"));
    assert.deepEqual(donchian.map((e) => e.variantId).sort(), ["donchian_10", "donchian_20", "donchian_30"]);
    for (const e of donchian) assert.match(e.outcome.validation.provenance.experimentFamilyId, /^donchian-research:/);
    for (const e of report.experiments.filter((x) => x.variantId.startsWith("sma_"))) assert.match(e.outcome.validation.provenance.experimentFamilyId, /^sma-research:/, "SMA identities are unchanged");
    const projection = composition.orchestrator.statusProjection();
    assert.ok(projection != null && projection.experimentCount >= 1);
    assert.equal(projection.liveAuthority, "NONE");
    assert.equal(projection.productionMutationAllowed, false);
    assert.equal(projection.champion.authority, "PAPER_ONLY");
    assert.equal(projection.challenger.authority, "ZERO_AUTHORITY");
    assert.ok(lines.some((l) => l.startsWith("[research-experiments] tick OK started=10")));
    const again = composition.tickOnce();
    assert.equal(again.started, 0);
  } finally { composition.stop(); db.close(); }
});

test("start and stop manage timers without leaking and stop is idempotent", () => {
  const db = open();
  const composition = composeResearchExperiments({ env: env(), database: db, log: () => {} });
  composition.start();
  composition.start();
  composition.stop();
  composition.stop();
  db.close();
});

test("backfill fills the research market from the public candle endpoint and shows up in the collection progress", async () => {
  const db = open();
  const lines = [];
  const now = Date.UTC(2026, 9, 3, 6, 0, 30);
  const anchor = Math.floor(now / M) * M;
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const to = new URL(url).searchParams.get("to");
    const upper = to == null ? anchor + M : Date.parse(to);
    const page = [];
    for (let start = upper - M; page.length < 200; start -= M) page.push({ market: "KRW-XRP", candle_date_time_utc: new Date(start).toISOString().slice(0, 19), opening_price: 1000, high_price: 1001, low_price: 999, trade_price: 1000.5 });
    return { status: 200, ok: true, json: async () => page };
  };
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-XRP" }), database: db, now: () => now, log: (l) => lines.push(l), fetchImpl, sleep: async () => undefined });
  try {
    const results = await composition.backfill();
    assert.deepEqual(results.map((r) => [r.market, r.status]), [["KRW-XRP", "COMPLETE"]]);
    const progress = composition.orchestrator.collectionProgress();
    // 7 + 2 + 2 days of windows plus one day of margin, one candle per minute.
    assert.ok(progress.candleCount >= 12 * 1440);
    assert.equal(progress.requiredCandles, 11 * 1440);
    assert.equal(progress.lastCloseMs, anchor);
    assert.ok(requests.every((u) => u.startsWith("https://api.upbit.com/v1/candles/minutes/1?")));
    assert.ok(requests.length <= 100, "bounded number of requests");
    assert.ok(lines.some((l) => l.startsWith("[research-backfill] KRW-XRP COMPLETE")));
    assert.deepEqual(await composition.backfill().then((r) => r.map((x) => x.status)), ["COMPLETE"], "a second run is a no-op");
  } finally { composition.stop(); db.close(); }
});

test("backfill is skipped entirely when disabled, and after stop", async () => {
  const db = open();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 200, ok: true, json: async () => [] }; };
  const off = composeResearchExperiments({ env: env({ NUSA_RESEARCH_BACKFILL: "DISABLED" }), database: db, log: () => {}, fetchImpl });
  off.start();
  off.stop();
  const stopped = composeResearchExperiments({ env: env(), database: db, log: () => {}, fetchImpl });
  stopped.stop();
  assert.deepEqual(await stopped.backfill(), []);
  assert.equal(calls, 0);
  db.close();
});

test("start recovers every longer bar length so its ticks are not stuck at RECOVERY_NOT_READY", () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const count = 11 * 1440;
  store.append("KRW-BTC", M, Array.from({ length: count }, (_, i) => { const close = Number((100 + 15 * Math.sin(i / 600)).toFixed(4)); return { closeTimeMs: T_END - (count - 1 - i) * M, open: close, high: close + 1, low: close - 1, close }; }));
  const lines = [];
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_DAILY_BUDGET: "10", NUSA_RESEARCH_INTERVAL_MINUTES: "1,60", NUSA_RESEARCH_BACKFILL: "DISABLED" }), database: db, now: () => T_END, log: (l) => lines.push(l) });
  try {
    assert.equal(composition.orchestrators[0].recover().status, "READY", "the runtime recovers the first orchestrator");
    composition.tickOnce();
    assert.equal(composition.experimentTicksByInterval()["60m"].lastStatus, "RECOVERY_NOT_READY", "without start the longer bar never recovers");
    composition.start();
    assert.ok(lines.includes("[research-experiments] recover 60m READY"), lines.join("\n"));
    composition.tickOnce();
    assert.equal(composition.experimentTicksByInterval()["60m"].lastStatus, "OK");
  } finally { composition.stop(); db.close(); }
});

test("meta-learning steering defers only the longer bar lengths, and a bad steering value falls back to every tick", () => {
  const db = open();
  const lines = [];
  let every = 4;
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_DAILY_BUDGET: "10", NUSA_RESEARCH_INTERVAL_MINUTES: "1,60", NUSA_RESEARCH_BACKFILL: "DISABLED" }), database: db, now: () => T_END, log: (l) => lines.push(l), longBarTickEvery: () => every });
  try {
    const deferred = () => lines.filter((l) => l.includes("tick 60m deferred by meta-learning steering")).length;
    const firstTicks = () => lines.filter((l) => /^\[research-experiments\] tick (?!\d+m)/.test(l)).length;
    for (let i = 0; i < 8; i += 1) composition.tickOnce();
    assert.equal(firstTicks(), 8, "the first bar length (which collects candles) ticks every time");
    assert.equal(deferred(), 6, "the 60m bar runs on ticks 0 and 4 only");
    every = 0;
    composition.tickOnce();
    assert.equal(deferred(), 6, "an invalid steering value is treated as every tick");
  } finally { composition.stop(); db.close(); }
});

test("the composition refills restart gaps in the recent history through the public candle fetcher", async () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const last = Math.floor(T_END / M) * M;
  store.append("KRW-BTC", M, [{ closeTimeMs: last - 3 * M, open: 10, high: 11, low: 9, close: 10 }, { closeTimeMs: last, open: 10, high: 11, low: 9, close: 10 }]);
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  const fetchImpl = async () => new Response(JSON.stringify([last - 2 * M, last - 3 * M].map((start) => ({ market: "KRW-BTC", candle_date_time_utc: stamp(start), opening_price: 10, high_price: 11, low_price: 9, trade_price: 10 }))), { status: 200, headers: { "content-type": "application/json" } });
  const lines = [];
  const composition = composeResearchExperiments({ env: env(), database: db, now: () => T_END, log: (l) => lines.push(l), fetchImpl, sleep: async () => undefined });
  try {
    const [result] = await composition.fillGaps();
    assert.equal(result.missing, 2);
    assert.equal(result.recorded, 2);
    assert.equal(store.count("KRW-BTC", M), 4);
    assert.ok(lines.some((l) => l.startsWith("[research-gap-fill] KRW-BTC FILLED missing=2 recorded=2")), lines.join("\n"));
  } finally { composition.stop(); db.close(); }
});

test("the existing gap-fill timer policy is frequent and bounded, and preserves stored history", async () => {
  assert.equal(RESEARCH_GAP_FILL_INTERVAL_MS, 5 * M);
  assert.equal(RESEARCH_GAP_FILL_MAX_PAGES_PER_RUN, 1);
  const db = open();
  const scheduledDelays = [];
  const nativeSetInterval = globalThis.setInterval;
  const timerProbe = composeResearchExperiments({ env: env(), database: db, now: () => T_END, log: () => {} });
  globalThis.setInterval = (callback, delay, ...args) => {
    scheduledDelays.push(delay);
    return nativeSetInterval(callback, 60 * M, ...args);
  };
  try {
    timerProbe.start();
    assert.ok(scheduledDelays.includes(RESEARCH_GAP_FILL_INTERVAL_MS), `the existing gap-fill scheduler must use 5 minutes: ${scheduledDelays}`);
  } finally {
    timerProbe.stop();
    globalThis.setInterval = nativeSetInterval;
  }
  const store = new SqliteResearchCandleStore(db, 200_000);
  const last = Math.floor(T_END / M) * M;
  const first = last - 500 * M;
  const existing = [];
  for (let close = first; close <= last; close += M) {
    if (close < last - 400 * M || close === last) existing.push({ closeTimeMs: close, open: 10, high: 11, low: 9, close: 10 });
  }
  store.append("KRW-BTC", M, existing);
  const protectedRow = store.read("KRW-BTC", M, first, first)[0];
  const requests = [];
  const lines = [];
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  const fetchImpl = async (url) => {
    const to = new URL(url).searchParams.get("to");
    const upperExclusive = to == null ? last + M : Date.parse(to);
    const candles = [];
    for (let start = upperExclusive - M; candles.length < 200 && start >= first; start -= M) {
      candles.push({ market: "KRW-BTC", candle_date_time_utc: stamp(start), opening_price: 100, high_price: 101, low_price: 99, trade_price: 100.5, candle_acc_trade_volume: 2 });
    }
    requests.push(url);
    return new Response(JSON.stringify(candles), { status: 200, headers: { "content-type": "application/json" } });
  };
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC" }), database: db, now: () => T_END, log: (line) => lines.push(line), fetchImpl, sleep: async () => undefined });
  try {
    const [result] = await composition.fillGaps();
    assert.equal(result.pages, RESEARCH_GAP_FILL_MAX_PAGES_PER_RUN);
    assert.equal(requests.length, 1, "a periodic pass makes at most one upstream request per market");
    assert.equal(result.status, "PARTIAL", "remaining old gaps stay visible for later bounded passes");
    assert.ok(result.recorded > 0, `the pass still makes useful progress: ${JSON.stringify(result)} rows=${store.count("KRW-BTC", M)} requests=${requests.length} logs=${lines.join("|")}`);
    assert.deepEqual(store.read("KRW-BTC", M, first, first)[0], protectedRow, "existing historical candles remain unchanged");
  } finally { composition.stop(); db.close(); }
});

test("the RSI time limit fits inside the shortest evaluation window after the indicator warm-up", () => {
  const { RSI_TIMEOUT_BARS } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
  const shortestWindowBars = (2 * 24 * 60) / 60; // default 2-day validation/holdout at the longest enabled bar (60m)
  const longestWarmUp = 14; // RSI 14 is the longest period in the grid
  assert.ok(RSI_TIMEOUT_BARS + longestWarmUp < shortestWindowBars, `${RSI_TIMEOUT_BARS} + ${longestWarmUp} must fit in ${shortestWindowBars} bars`);
});

test("the Donchian grid and time limit fit inside the shortest evaluation window after warm-up", () => {
  const { DONCHIAN_GRID, DONCHIAN_TIMEOUT_BARS } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
  const shortestWindowBars = (2 * 24 * 60) / 60; // default 2-day validation/holdout at the longest enabled bar (60m)
  assert.deepEqual([...DONCHIAN_GRID], [10, 20, 30], "the grid is pre-committed");
  assert.ok(Math.max(...DONCHIAN_GRID) + DONCHIAN_TIMEOUT_BARS < shortestWindowBars, "warm-up plus time limit must fit in the window");
});
