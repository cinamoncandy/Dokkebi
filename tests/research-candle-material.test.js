const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { SqliteDatabase, SqliteResearchCandleStore, SqliteResearchDatasetManifestStore } = require("../dist/packages/storage/src/index.js");
const { calculateResearchCandleSha256, calculateResearchDatasetId, calculateResearchDatasetIdV2 } = require("../dist/packages/contracts/src/index.js");
const { materializeResearchDatasetManifest } = require("../dist/apps/cloud/src/researchDatasetManifestMaterializer.js");
const TEST_PROVENANCE = { rawSourceIdentitySha256s: ["1".repeat(64)], transformationGraphSha256: "2".repeat(64), transformationConfigSha256: "3".repeat(64), schemaContractSha256: "4".repeat(64), qualitySuiteSha256: "5".repeat(64), qualityResultsSha256: "6".repeat(64), derivedFeatureLineageSha256: "7".repeat(64), replayRuntimeSha256: "8".repeat(64) };

function seedHistoricalV1(db, manifest) {
  const json = JSON.stringify(manifest);
  const digest = createHash("sha256").update(json, "utf8").digest("hex");
  db.connection.prepare("INSERT INTO research_dataset_manifests (dataset_id, manifest_json, manifest_sha256) VALUES (?, ?, ?)").run(manifest.datasetId, json, digest);
}

function candles() {
  return [
    { closeTimeMs: 60_000, open: 100, high: 101, low: 99, close: 100.5 },
    { closeTimeMs: 120_000, open: 100.5, high: 102, low: 100, close: 101 },
  ];
}

test("dataset material survives SQLite restart and binds to candle content", () => {
  const dir = mkdtempSync(join(tmpdir(), "nusa-dataset-material-"));
  const filename = join(dir, "state.db");
  try {
    const first = new SqliteDatabase(filename);
    const store = new SqliteResearchCandleStore(first);
    store.appendWithMaterial("KRW-BTC", 60_000, candles(), { source: "UPBIT_PUBLIC_TICKER", evidenceFingerprintSha256: "a".repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
    const material = store.latestMaterial("KRW-BTC", 60_000);
    assert.ok(material);
    first.close();
    const reopened = new SqliteDatabase(filename);
    const restored = new SqliteResearchCandleStore(reopened).readMaterial("KRW-BTC", 60_000, material.firstCloseTimeMs, material.lastCloseTimeMs, material.storeContentSha256);
    assert.equal(restored.source, "UPBIT_PUBLIC_TICKER");
    assert.equal(restored.candleCount, 2);
    reopened.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may release the SQLite handle after the test turn. */ } }
});

test("canonical dataset manifest survives SQLite restart and verifies its fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "nusa-dataset-manifest-"));
  const filename = join(dir, "state.db");
  const manifest = { schemaVersion: 1, datasetId: "source_KRW-BTC_1m_19700101_19700101_abc", source: "UPBIT_PUBLIC_TICKER", market: "KRW-BTC", interval: "1m", candleCount: 2, startOpenTime: 0, endCloseTime: 120_000, timezone: "UTC", ordering: "OPEN_TIME_ASC", missingCandlePolicy: "REJECT", missingCandleCount: 0, createdAt: "1970-01-01T00:00:00.000Z", contentSha256: "a".repeat(64) };
  try {
    const first = new SqliteDatabase(filename);
    const store = new SqliteResearchDatasetManifestStore(first);
    seedHistoricalV1(first, manifest);
    const fingerprint = store.read(manifest.datasetId) && createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
    assert.throws(() => store.persist({ ...manifest, createdAt: "1970-01-01T00:00:01.000Z" }), /different manifest already exists/);
    assert.equal(fingerprint.length, 64);
    first.close();
    const reopened = new SqliteDatabase(filename);
    assert.deepEqual(new SqliteResearchDatasetManifestStore(reopened).read(manifest.datasetId), manifest);
    reopened.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may release the SQLite handle after the test turn. */ } }
});

test("canonical dataset manifest rejects identity substitution", () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchDatasetManifestStore(db);
  const manifest = { schemaVersion: 1, datasetId: "dataset-a", source: "source-a", market: "KRW-BTC", interval: "1m", candleCount: 1, startOpenTime: 0, endCloseTime: 60_000, timezone: "UTC", ordering: "OPEN_TIME_ASC", missingCandlePolicy: "REJECT", missingCandleCount: 0, createdAt: "1970-01-01T00:00:00.000Z", contentSha256: "a".repeat(64) };
  seedHistoricalV1(db, manifest);
  assert.throws(() => store.persist({ ...manifest, source: "source-b" }), /different manifest already exists/);
  db.close();
});

test("verified manifest persistence rejects content substitution", () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchDatasetManifestStore(db);
  const candles = [{ market: "KRW-BTC", interval: "1m", openTime: 0, closeTime: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 }];
  const contentSha256 = calculateResearchCandleSha256(candles);
  const manifest = { schemaVersion: 2, datasetId: calculateResearchDatasetIdV2("source", candles, contentSha256, TEST_PROVENANCE), source: "source", market: "KRW-BTC", interval: "1m", candleCount: 1, startOpenTime: 0, endCloseTime: 60_000, timezone: "UTC", ordering: "OPEN_TIME_ASC", missingCandlePolicy: "REJECT", missingCandleCount: 0, createdAt: "1970-01-01T00:00:00.000Z", contentSha256, provenance: TEST_PROVENANCE };
  assert.equal(store.persistVerified(manifest, candles).length, 64);
  assert.throws(() => store.persistVerified(manifest, [{ ...candles[0], close: 100.6 }]), /manifest does not match/);
  db.close();
});

test("manifest materializer requires v2 provenance and rejects missing volume and non-contiguous candles", () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchDatasetManifestStore(db);
  const base = { store, candleStore: new SqliteResearchCandleStore(db), market: "KRW-BTC", intervalMs: 60_000, source: "upbit", createdAt: "1970-01-01T00:00:00.000Z", sourceCommitSha: "a".repeat(40) };
  assert.throws(() => materializeResearchDatasetManifest({ ...base, candles: [{ closeTimeMs: 60_000, open: 1, high: 1, low: 1, close: 1 }] }), /explicit OHLCV/);
  assert.throws(() => materializeResearchDatasetManifest({ ...base, candles: [{ closeTimeMs: 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { closeTimeMs: 180_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }] }), /missing intervals/);
  assert.throws(() => materializeResearchDatasetManifest({ ...base, candles: [{ closeTimeMs: 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }] }), (error) => error.code === "MANIFEST_PROVENANCE_REQUIRED");
  db.close();
});

test("foreign material reference is rejected", () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchCandleStore(db);
  store.appendWithMaterial("KRW-BTC", 60_000, candles(), { source: "UPBIT_PUBLIC_TICKER", missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  const material = store.latestMaterial("KRW-BTC", 60_000);
  assert.throws(() => store.readMaterial("KRW-BTC", 60_000, material.firstCloseTimeMs, material.lastCloseTimeMs, "b".repeat(64)), /dataset material is missing/);
  db.close();
});

test("tampered candle content is rejected on material read-back", () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchCandleStore(db);
  store.appendWithMaterial("KRW-BTC", 60_000, candles(), { source: "UPBIT_PUBLIC_TICKER", missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
  const material = store.latestMaterial("KRW-BTC", 60_000);
  db.connection.prepare("UPDATE research_closed_candles SET close = ? WHERE market = ? AND interval_ms = ? AND close_time_ms = ?").run(999, "KRW-BTC", 60_000, 60_000);
  assert.throws(() => store.readMaterial("KRW-BTC", 60_000, material.firstCloseTimeMs, material.lastCloseTimeMs, material.storeContentSha256), /research candle (high\/low|checksum)/);
  db.close();
});

test("a 1m dataset may skip only closes the exchange confirmed absent; our own loss and other intervals still refuse; gap-free identity is unchanged", () => {
  const { UPBIT_CANDLE_SOURCE_FINGERPRINT } = require("../dist/apps/cloud/src/researchCandleBackfill.js");
  const M = 60_000;
  const SHA = "f".repeat(40);
  const make = (skip) => {
    const db = new SqliteDatabase(":memory:");
    const store = new SqliteResearchCandleStore(db);
    const rows = [];
    for (let k = 1; k <= 120; k += 1) if (!skip.has(k)) rows.push({ closeTimeMs: k * M, open: 10, high: 11, low: 9, close: 10.5, volume: 1 });
    // one receipt per contiguous run, as a real page write would leave
    let run = [];
    const flush = () => { if (run.length) store.appendWithMaterial("KRW-BTC", M, run, { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: UPBIT_CANDLE_SOURCE_FINGERPRINT, evidenceFingerprintSha256: createHash("sha256").update(String(run[0].closeTimeMs)).digest("hex"), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 }); run = []; };
    for (const row of rows) { if (run.length && row.closeTimeMs !== run.at(-1).closeTimeMs + M) flush(); run.push(row); }
    flush();
    return { store, manifests: new SqliteResearchDatasetManifestStore(db) };
  };
  const materialize = ({ store, manifests }) => materializeResearchDatasetManifest({ store: manifests, candleStore: store, market: "KRW-BTC", intervalMs: M, candles: store.read("KRW-BTC", M, 0, 200 * M), source: "upbit-1m-closed:KRW-BTC:60000", createdAt: "2026-11-10T00:00:00.000Z", sourceCommitSha: SHA });

  const clean = materialize(make(new Set()));
  assert.equal(clean.missingCandlePolicy, "REJECT");
  assert.equal(clean.missingCandleCount, 0);
  assert.equal(materialize(make(new Set())).datasetId, clean.datasetId, "gap-free identity is deterministic");

  const gap = new Set([50, 51, 52]);
  const unconfirmed = make(gap);
  assert.throws(() => materialize(unconfirmed), /missing intervals/, "our own loss (no exchange proof) is still refused");

  const confirmed = make(gap);
  confirmed.store.recordAbsence({ market: "KRW-BTC", intervalMs: M, firstAbsentCloseMs: 50 * M, lastAbsentCloseMs: 52 * M, beforeCloseMs: 49 * M, afterCloseMs: 53 * M, evidenceFingerprintSha256: "e".repeat(64), observedAt: "2026-11-10T00:00:00.000Z" });
  const manifest = materialize(confirmed);
  assert.equal(manifest.missingCandlePolicy, "ALLOW");
  assert.equal(manifest.missingCandleCount, 3);
  assert.equal(manifest.candleCount, 117);
  assert.ok(manifest.provenance.rawSourceIdentitySha256s.includes("e".repeat(64)), "the exchange page that proves the gap is a bound raw source");
  assert.notEqual(manifest.datasetId, clean.datasetId);

  const partly = make(gap);
  partly.store.recordAbsence({ market: "KRW-BTC", intervalMs: M, firstAbsentCloseMs: 50 * M, lastAbsentCloseMs: 52 * M, beforeCloseMs: 49 * M, afterCloseMs: 53 * M, evidenceFingerprintSha256: "e".repeat(64), observedAt: "2026-11-10T00:00:00.000Z" });
  const lossToo = make(new Set([50, 51, 52, 90]));
  lossToo.store.recordAbsence({ market: "KRW-BTC", intervalMs: M, firstAbsentCloseMs: 50 * M, lastAbsentCloseMs: 52 * M, beforeCloseMs: 49 * M, afterCloseMs: 53 * M, evidenceFingerprintSha256: "e".repeat(64), observedAt: "2026-11-10T00:00:00.000Z" });
  assert.throws(() => materialize(lossToo), /missing intervals/, "one unconfirmed missing close still refuses the whole dataset");
});
