const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { SqliteDatabase, SqliteResearchCandleStore, SqliteResearchGapFillProgressStore } = require("../dist/packages/storage/src/index.js");
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

test("verified base receipts materialize each configured interval manifest on backfill and gap-fill paths", async () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const count = 4 * 24 * 60;
  const candles = Array.from({ length: count }, (_, i) => {
    const closeTimeMs = T_END - (count - 1 - i) * M;
    const close = 100 + (i % 13) / 10;
    return { closeTimeMs, open: close, high: close + 1, low: close - 1, close, volume: 2 };
  });
  for (let offset = 0; offset < candles.length; offset += 200) {
    const page = candles.slice(offset, offset + 200);
    store.appendWithMaterial("KRW-BTC", M, page, {
      source: "UPBIT_PUBLIC_CANDLES",
      sourceFingerprint: UPBIT_CANDLE_SOURCE_FINGERPRINT,
      evidenceFingerprintSha256: (offset + 1).toString(16).padStart(64, "0"),
      missingBuckets: 0,
      incompleteBuckets: 0,
      rejectedObservations: 0,
    });
  }
  let now = T_END;
  let fetchCalls = 0;
  let yieldedIntervals = 0;
  const lines = [];
  const composition = composeResearchExperiments({
    env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC", NUSA_RESEARCH_TRAIN_DAYS: "1", NUSA_RESEARCH_VALIDATION_DAYS: "1", NUSA_RESEARCH_HOLDOUT_DAYS: "1", NUSA_RESEARCH_INTERVAL_MINUTES: "1,15,60,240" }),
    database: db,
    now: () => now,
    log: (line) => lines.push(line),
    fetchImpl: async () => { fetchCalls += 1; throw new Error("complete verified source must not fetch"); },
    yieldControl: async () => { yieldedIntervals += 1; await new Promise(setImmediate); },
  });
  try {
    const [backfill] = await composition.backfill();
    assert.equal(backfill.status, "COMPLETE");
    assert.equal(fetchCalls, 0);
    assert.equal(yieldedIntervals, 4, "the event loop yields after each configured interval's synchronous materialization");
    // The 240m window begins inside a 4-hour bar, so its partial leading bar is correctly omitted.
    const expectedCounts = new Map([["1m", count], ["15m", count / 15], ["60m", count / 60], ["240m", count / 240 - 1]]);
    const initial = new Map();
    for (const [interval, candleCount] of expectedCounts) {
      const manifest = composition.datasetManifests.latest("KRW-BTC", interval);
      assert.ok(manifest, `${interval} manifest should be materialized from the verified 1m source`);
      assert.equal(manifest.candleCount, candleCount, interval);
      assert.equal(manifest.source, interval === "1m" ? `upbit-1m-closed:KRW-BTC:${M}` : `upbit-1m-aggregated:KRW-BTC:${Number.parseInt(interval, 10) * M}`);
      initial.set(interval, manifest);
    }

    // A later successful no-op pass has the same source identity but a different observation time.
    // It must preserve the immutable existing manifest instead of conflicting on createdAt.
    now += 1_000;
    assert.equal((await composition.backfill())[0].status, "COMPLETE");
    assert.equal(yieldedIntervals, 8, "no-op intervals also provide event-loop checkpoints between markets/intervals");
    assert.equal((await composition.fillGaps())[0].status, "NO_GAPS");
    for (const [interval, prior] of initial) {
      const replay = composition.datasetManifests.latest("KRW-BTC", interval);
      assert.equal(replay.datasetId, prior.datasetId, interval);
      assert.equal(replay.createdAt, prior.createdAt, interval);
    }
    assert.equal(fetchCalls, 0);
    assert.equal(lines.filter((line) => line === "[research-manifest] KRW-BTC/1m materialized dataset manifest").length, 1, "unchanged no-op passes do not recompute the 1m manifest");
    assert.equal(lines.filter((line) => line === "[research-manifest] KRW-BTC/15m materialized dataset manifest").length, 1, "unchanged no-op passes do not recompute the 15m manifest");
    assert.equal(lines.filter((line) => line === "[research-manifest] KRW-BTC/60m materialized dataset manifest").length, 1, "unchanged no-op passes do not recompute the 60m manifest");
    assert.equal(lines.filter((line) => line === "[research-manifest] KRW-BTC/240m materialized dataset manifest").length, 1, "unchanged no-op passes do not recompute the 240m manifest");
    assert.ok(lines.some((line) => line === "[research-manifest] KRW-BTC/15m materialized dataset manifest"));
    assert.ok(lines.some((line) => line === "[research-manifest] KRW-BTC/60m materialized dataset manifest"));
    assert.ok(!lines.some((line) => /\[research-manifest\].*blocked/.test(line)), lines.join("\n"));
  } finally { composition.stop(); db.close(); }
});

test("missing manifests retry no more than hourly without new complete interval input, then retry when due", async () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  let clock = Date.UTC(2026, 9, 2, 2, 30, 0); // safely inside the same four-hour candle interval for the full test
  const appendMinutes = (fromClose, throughClose) => {
    const rows = [];
    for (let closeTimeMs = fromClose; closeTimeMs <= throughClose; closeTimeMs += M) rows.push({ closeTimeMs, open: 10, high: 11, low: 9, close: 10 });
    store.append("KRW-BTC", M, rows);
  };
  appendMinutes(clock - 2 * M, clock);
  let latestClose = clock;
  const lines = [];
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC", NUSA_RESEARCH_INTERVAL_MINUTES: "240" }), database: db, now: () => clock, log: (line) => lines.push(line), fetchImpl: async () => { throw new Error("contiguous input must not fetch"); } });
  try {
    await composition.fillGaps();
    assert.equal(lines.filter((line) => line.includes("KRW-BTC/240m blocked")).length, 1, "first missing manifest attempt occurs immediately");

    clock += 15 * M;
    appendMinutes(latestClose + M, clock);
    latestClose = clock;
    await composition.fillGaps();
    assert.equal(lines.filter((line) => line.includes("KRW-BTC/240m blocked")).length, 1, "unchanged complete-interval watermark suppresses an early retry");

    clock += 45 * M;
    appendMinutes(latestClose + M, clock);
    latestClose = clock;
    await composition.fillGaps();
    assert.equal(lines.filter((line) => line.includes("KRW-BTC/240m blocked")).length, 2, "the persisted missing-manifest retry becomes due at one hour");
  } finally { composition.stop(); db.close(); }
});

test("incomplete raw-source receipt coverage cannot materialize any configured interval manifest", async () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const count = 4 * 24 * 60;
  const candles = Array.from({ length: count }, (_, i) => {
    const closeTimeMs = T_END - (count - 1 - i) * M;
    const close = 100 + (i % 13) / 10;
    return { closeTimeMs, open: close, high: close + 1, low: close - 1, close, volume: 2 };
  });
  store.append("KRW-BTC", M, candles);
  let fetchCalls = 0;
  const composition = composeResearchExperiments({
    env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC", NUSA_RESEARCH_TRAIN_DAYS: "1", NUSA_RESEARCH_VALIDATION_DAYS: "1", NUSA_RESEARCH_HOLDOUT_DAYS: "1", NUSA_RESEARCH_INTERVAL_MINUTES: "1,15,60" }),
    database: db,
    now: () => T_END,
    log: () => {},
    fetchImpl: async () => { fetchCalls += 1; return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); },
  });
  try {
    const [backfill] = await composition.backfill();
    assert.equal(backfill.status, "INCOMPLETE");
    assert.equal(backfill.errorCode, "SOURCE_RECEIPTS_INCOMPLETE");
    assert.equal(fetchCalls, 1);
    for (const interval of ["1m", "15m", "60m"]) assert.equal(composition.datasetManifests.latest("KRW-BTC", interval), undefined, interval);
  } finally { composition.stop(); db.close(); }
});

test("a raw-source receipt with rejected observations cannot produce a manifest", () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db);
  const rows = [
    { closeTimeMs: T_END - M, open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { closeTimeMs: T_END, open: 10, high: 12, low: 9, close: 11, volume: 2 },
  ];
  store.appendWithMaterial("KRW-BTC", M, rows, {
    source: "UPBIT_PUBLIC_CANDLES",
    sourceFingerprint: UPBIT_CANDLE_SOURCE_FINGERPRINT,
    evidenceFingerprintSha256: "e".repeat(64),
    missingBuckets: 0,
    incompleteBuckets: 0,
    rejectedObservations: 1,
  });
  const composition = composeResearchExperiments({ env: env(), database: db, now: () => T_END, log: () => {} });
  try {
    assert.throws(() => materializeResearchDatasetManifest({
      store: composition.datasetManifests,
      candleStore: store,
      market: "KRW-BTC",
      intervalMs: M,
      candles: rows,
      source: `upbit-1m-closed:KRW-BTC:${M}`,
      createdAt: new Date(T_END).toISOString(),
      sourceCommitSha: SHA,
    }), (error) => error?.code === "MANIFEST_SOURCE_MALFORMED");
    assert.equal(composition.datasetManifests.latest("KRW-BTC", "1m"), undefined, "rejected source material creates no manifest");
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
  assert.equal(RESEARCH_GAP_FILL_INTERVAL_MS, 15 * M);
  assert.equal(RESEARCH_GAP_FILL_INTERVAL_MS * 2, 30 * M, "alternating head and history revisits the head every thirty minutes");
  assert.ok(RESEARCH_GAP_FILL_INTERVAL_MS * 2 < 120 * M, "the head revisit period stays inside the two-hour stale ceiling");
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
    assert.ok(scheduledDelays.includes(RESEARCH_GAP_FILL_INTERVAL_MS), `the existing gap-fill scheduler must use fifteen minutes: ${scheduledDelays}`);
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

test("bounded gap-fill passes advance past an exchange-missing newest minute", async () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const anchor = Math.floor(T_END / M) * M;
  const first = anchor - 600 * M;
  const oldGapClose = anchor - 450 * M;
  const rows = [];
  for (let close = first; close <= anchor; close += M) {
    if (close !== anchor && close !== oldGapClose) rows.push({ closeTimeMs: close, open: 10, high: 11, low: 9, close: 10 });
  }
  store.append("KRW-BTC", M, rows);
  const requests = [];
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  const fetchImpl = async (url) => {
    const to = new URL(url).searchParams.get("to");
    const exclusiveUpper = to == null ? anchor + M : Date.parse(to);
    const candles = [];
    for (let start = exclusiveUpper - M; candles.length < 200 && start >= first - M; start -= M) {
      if (start === anchor - M) continue; // Upbit has no candle for the newest missing close.
      candles.push({ market: "KRW-BTC", candle_date_time_utc: stamp(start), opening_price: 20, high_price: 21, low_price: 19, trade_price: 20.5, candle_acc_trade_volume: 2 });
    }
    requests.push({ to: to == null ? null : Date.parse(to) });
    return new Response(JSON.stringify(candles), { status: 200, headers: { "content-type": "application/json" } });
  };
  let clock = T_END;
  const composition = composeResearchExperiments({
    env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC", NUSA_RESEARCH_TRAIN_DAYS: "1", NUSA_RESEARCH_VALIDATION_DAYS: "1", NUSA_RESEARCH_HOLDOUT_DAYS: "1" }),
    database: db,
    now: () => clock,
    log: () => {},
    fetchImpl,
    sleep: async () => undefined,
  });
  try {
    const passes = [];
    for (let index = 0; index < 4; index += 1) {
      clock = T_END + index * RESEARCH_GAP_FILL_INTERVAL_MS;
      passes.push((await composition.fillGaps())[0]);
    }
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map((request) => request.to), [anchor, anchor - 201 * M, anchor + 30 * M, anchor - 401 * M]);
    assert.equal(passes[0].status, "PARTIAL");
    assert.equal(passes[1].status, "PARTIAL");
    assert.ok(passes[2].recorded > 0, "the next head-priority pass fills newly closed recent candles");
    assert.equal(passes[3].recorded, 1, "the historical continuation reaches the older missing source candle");
    assert.equal(store.read("KRW-BTC", M, oldGapClose, oldGapClose)[0].close, 20.5);
    assert.equal(store.read("KRW-BTC", M, anchor + 5 * M, anchor + 5 * M).length, 1, "new head closes remain prioritized while older pages advance");
    assert.equal(store.read("KRW-BTC", M, anchor, anchor).length, 0, "the exchange-missing newest close remains missing");
  } finally { composition.stop(); db.close(); }
});

test("bounded history cursor survives a composition restart and resumes at the next page", async () => {
  const filename = join(mkdtempSync(join(tmpdir(), "nusa-gap-restart-")), "research.db");
  const anchor = Math.floor(T_END / M) * M;
  const first = anchor - 501 * M;
  const requests = [];
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  const fetchImpl = async (url) => {
    const to = Date.parse(new URL(url).searchParams.get("to"));
    requests.push(to);
    const candles = [];
    for (let start = to - M; candles.length < 200 && start >= first; start -= M) {
      candles.push({ market: "KRW-BTC", candle_date_time_utc: stamp(start), opening_price: 20, high_price: 21, low_price: 19, trade_price: 20.5, candle_acc_trade_volume: 2 });
    }
    return new Response(JSON.stringify(candles), { status: 200, headers: { "content-type": "application/json" } });
  };
  let db = new SqliteDatabase(filename);
  const store = new SqliteResearchCandleStore(db, 200_000);
  store.append("KRW-BTC", M, [
    { closeTimeMs: first, open: 10, high: 11, low: 9, close: 10 },
    { closeTimeMs: anchor - M, open: 10, high: 11, low: 9, close: 10 },
  ]);
  let composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC" }), database: db, now: () => T_END, log: () => {}, fetchImpl, sleep: async () => undefined });
  try {
    const firstPass = (await composition.fillGaps())[0];
    assert.equal(firstPass.status, "PARTIAL");
    assert.equal(firstPass.nextCursorStartMs, anchor - 200 * M);
    assert.deepEqual(requests, [anchor]);
  } finally {
    composition.stop();
    db.close();
  }

  db = new SqliteDatabase(filename);
  composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC" }), database: db, now: () => T_END, log: () => {}, fetchImpl, sleep: async () => undefined });
  try {
    const resumed = (await composition.fillGaps())[0];
    assert.equal(requests[1], anchor - 200 * M, "restart resumes the durable history cursor rather than fetching the newest page again");
    assert.equal(resumed.pages, 1);
    assert.equal(resumed.status, "PARTIAL");
    assert.equal(resumed.nextCursorStartMs, anchor - 400 * M);
  } finally {
    composition.stop();
    db.close();
  }
});

test("a failed head request still yields the next attempt to saved historical progress", async () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const anchor = Math.floor(T_END / M) * M;
  const first = anchor - 501 * M;
  store.append("KRW-BTC", M, [
    { closeTimeMs: first, open: 10, high: 11, low: 9, close: 10 },
    { closeTimeMs: anchor - M, open: 10, high: 11, low: 9, close: 10 },
  ]);
  const requests = [];
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  let clock = T_END;
  const fetchImpl = async (url) => {
    const to = Date.parse(new URL(url).searchParams.get("to"));
    requests.push(to);
    if (requests.length === 3) throw Object.assign(new Error("head unavailable"), { code: "UPSTREAM_503" });
    const candles = [];
    for (let start = to - M; candles.length < 200 && start >= first; start -= M) {
      candles.push({ market: "KRW-BTC", candle_date_time_utc: stamp(start), opening_price: 20, high_price: 21, low_price: 19, trade_price: 20.5, candle_acc_trade_volume: 2 });
    }
    return new Response(JSON.stringify(candles), { status: 200, headers: { "content-type": "application/json" } });
  };
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC" }), database: db, now: () => clock, log: () => {}, fetchImpl, sleep: async () => undefined });
  try {
    const results = [];
    for (let index = 0; index < 4; index += 1) {
      clock = T_END + index * RESEARCH_GAP_FILL_INTERVAL_MS;
      results.push((await composition.fillGaps())[0]);
    }
    assert.equal(results[2].status, "ERROR");
    assert.equal(results[2].errorCode, "UPSTREAM_503");
    assert.equal(requests[2], anchor + 30 * M, "the third pass is the scheduled head probe");
    assert.equal(requests[3], requests[1] - 200 * M, "the failed head probe preserves and resumes the historical cursor");
  } finally { composition.stop(); db.close(); }
});

test("an initial HEAD failure persists only the next pass and restarts into HISTORY from a real stored candle", async () => {
  const filename = join(mkdtempSync(join(tmpdir(), "nusa-gap-initial-head-failure-")), "research.db");
  const anchor = Math.floor(T_END / M) * M;
  const first = anchor - 501 * M;
  const oldGapClose = anchor - 450 * M;
  const requests = [];
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  const fetchImpl = async (url) => {
    const to = Date.parse(new URL(url).searchParams.get("to"));
    requests.push(to);
    if (requests.length === 1) throw Object.assign(new Error("newest page unavailable"), { code: "UPSTREAM_503" });
    const candles = [];
    for (let start = to - M; candles.length < 200 && start >= first - M; start -= M) {
      candles.push({ market: "KRW-BTC", candle_date_time_utc: stamp(start), opening_price: 20, high_price: 21, low_price: 19, trade_price: 20.5, candle_acc_trade_volume: 2 });
    }
    return new Response(JSON.stringify(candles), { status: 200, headers: { "content-type": "application/json" } });
  };
  let db = new SqliteDatabase(filename);
  const store = new SqliteResearchCandleStore(db, 200_000);
  const rows = [];
  for (let close = first; close < anchor; close += M) if (close !== oldGapClose) rows.push({ closeTimeMs: close, open: 10, high: 11, low: 9, close: 10 });
  store.append("KRW-BTC", M, rows);
  const clock = T_END;
  let composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC" }), database: db, now: () => clock, log: () => {}, fetchImpl, sleep: async () => undefined });
  try {
    const [firstResult] = await composition.fillGaps();
    assert.equal(firstResult.status, "ERROR");
    assert.equal(firstResult.errorCode, "UPSTREAM_503");
    const progress = new SqliteResearchGapFillProgressStore(db);
    assert.equal(progress.load("KRW-BTC"), undefined, "a failed API call cannot create a nonexistent history cursor");
    assert.deepEqual(progress.loadNextPass("KRW-BTC"), { nextPass: "HISTORY", updatedAtMs: clock });
    assert.equal(requests[0], anchor, "the initial attempt is the HEAD request");
  } finally { composition.stop(); db.close(); }

  db = new SqliteDatabase(filename);
  composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC" }), database: db, now: () => clock + RESEARCH_GAP_FILL_INTERVAL_MS, log: () => {}, fetchImpl, sleep: async () => undefined });
  try {
    const [historyResult] = await composition.fillGaps();
    assert.equal(requests[1], anchor - M, "HISTORY begins from the actual latest stored candle, not the failed HEAD cursor");
    assert.equal(historyResult.pages, 1);
    assert.equal(historyResult.status, "PARTIAL");
    const progress = new SqliteResearchGapFillProgressStore(db);
    assert.deepEqual(progress.loadNextPass("KRW-BTC"), { nextPass: "HEAD", updatedAtMs: clock + RESEARCH_GAP_FILL_INTERVAL_MS });
    assert.equal(progress.load("KRW-BTC").historyCursorStartMs, historyResult.nextCursorStartMs, "only a cursor returned by a valid page becomes durable history progress");
  } finally { composition.stop(); db.close(); }
});

test("consecutive HEAD and HISTORY failures alternate durably without losing a verified cursor", async () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchCandleStore(db, 200_000);
  const anchor = Math.floor(T_END / M) * M;
  const first = anchor - 501 * M;
  const oldGapClose = anchor - 450 * M;
  const rows = [];
  for (let close = first; close < anchor; close += M) if (close !== oldGapClose) rows.push({ closeTimeMs: close, open: 10, high: 11, low: 9, close: 10 });
  store.append("KRW-BTC", M, rows);
  const initialCursor = anchor - 200 * M;
  const progress = new SqliteResearchGapFillProgressStore(db);
  progress.save("KRW-BTC", { historyCursorStartMs: initialCursor, nextPass: "HEAD", updatedAtMs: T_END });
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(Date.parse(new URL(url).searchParams.get("to")));
    throw Object.assign(new Error("page unavailable"), { code: "UPSTREAM_503" });
  };
  let clock = T_END;
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC" }), database: db, now: () => clock, log: () => {}, fetchImpl, sleep: async () => undefined });
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      clock = T_END + pass * RESEARCH_GAP_FILL_INTERVAL_MS;
      assert.equal((await composition.fillGaps())[0].status, "ERROR");
      assert.equal(progress.load("KRW-BTC").historyCursorStartMs, initialCursor, "failed pages cannot replace the verified cursor");
      assert.equal(progress.loadNextPass("KRW-BTC").nextPass, pass % 2 === 0 ? "HISTORY" : "HEAD");
    }
    assert.deepEqual(requests, [anchor, initialCursor, anchor + 2 * RESEARCH_GAP_FILL_INTERVAL_MS, initialCursor]);
  } finally { composition.stop(); db.close(); }
});

test("a corrupt market cursor fails closed without preventing another market from being processed", async () => {
  const db = new SqliteDatabase(":memory:");
  const progress = new SqliteResearchGapFillProgressStore(db);
  const stamp = T_END - M;
  progress.save("KRW-BTC", { historyCursorStartMs: stamp, nextPass: "HISTORY", updatedAtMs: stamp });
  db.connection.prepare("UPDATE research_gap_fill_progress SET history_cursor_start_ms = 1 WHERE market = ?").run("KRW-BTC");
  const composition = composeResearchExperiments({ env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC,KRW-XRP" }), database: db, now: () => T_END, log: () => {}, fetchImpl: async () => { throw new Error("unexpected request"); } });
  try {
    const results = await composition.fillGaps();
    assert.deepEqual(results.map((result) => [result.market, result.status, result.errorCode]), [
      ["KRW-BTC", "ERROR", "PROGRESS_CORRUPT"],
      ["KRW-XRP", "NO_GAPS", undefined],
    ]);
  } finally { composition.stop(); db.close(); }
});

test("malformed historical pages fail closed without discarding the last verified cursor", async () => {
  const db = open();
  const store = new SqliteResearchCandleStore(db, 200_000);
  const anchor = Math.floor(T_END / M) * M;
  const first = anchor - 600 * M;
  const oldGapClose = anchor - 450 * M;
  const rows = [];
  for (let close = first; close <= anchor; close += M) if (close !== anchor && close !== oldGapClose) rows.push({ closeTimeMs: close, open: 10, high: 11, low: 9, close: 10 });
  store.append("KRW-BTC", M, rows);
  const requests = [];
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  let clock = T_END;
  let malformedHistoricalPage = true;
  const fetchImpl = async (url) => {
    const to = new URL(url).searchParams.get("to");
    const exclusiveUpper = to == null ? anchor + M : Date.parse(to);
    requests.push(to == null ? null : Date.parse(to));
    if (malformedHistoricalPage && exclusiveUpper === anchor - 201 * M) {
      malformedHistoricalPage = false;
      return new Response(JSON.stringify({ malformed: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const candles = [];
    for (let start = exclusiveUpper - M; candles.length < 200 && start >= first - M; start -= M) {
      if (start === anchor - M) continue; // The upstream source has no candle at the newest missing close.
      candles.push({ market: "KRW-BTC", candle_date_time_utc: stamp(start), opening_price: 20, high_price: 21, low_price: 19, trade_price: 20.5, candle_acc_trade_volume: 2 });
    }
    return new Response(JSON.stringify(candles), { status: 200, headers: { "content-type": "application/json" } });
  };
  const composition = composeResearchExperiments({
    env: env({ NUSA_RESEARCH_MARKETS: "KRW-BTC", NUSA_RESEARCH_TRAIN_DAYS: "1", NUSA_RESEARCH_VALIDATION_DAYS: "1", NUSA_RESEARCH_HOLDOUT_DAYS: "1" }),
    database: db,
    now: () => clock,
    log: () => {},
    fetchImpl,
    sleep: async () => undefined,
  });
  try {
    const results = [];
    for (let index = 0; index < 4; index += 1) {
      clock = T_END + index * RESEARCH_GAP_FILL_INTERVAL_MS;
      results.push((await composition.fillGaps())[0]);
    }
    assert.deepEqual(requests, [anchor, anchor - 201 * M, anchor + 30 * M, anchor - 201 * M]);
    assert.equal(results[1].status, "ERROR");
    assert.equal(results[1].errorCode, "MALFORMED_PAGE");
    assert.equal(results[3].pages, 1, "the failed historical page is retried from the last verified cursor");
    assert.ok(results[3].status === "PARTIAL" || results[3].status === "FILLED");
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
