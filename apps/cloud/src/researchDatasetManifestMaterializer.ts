import { createHash } from "node:crypto";
import { calculateResearchCandleSha256, calculateResearchDatasetIdV2, type CanonicalResearchCandle, type HistoricalDatasetManifest, type ResearchDatasetProvenanceV2, type ResearchInterval } from "../../../packages/contracts/src/researchDatasetSemantics";
import { SqliteResearchDatasetManifestStore } from "../../../packages/storage/src/index";
import { SqliteResearchCandleStore, type StoredResearchCandle } from "../../../packages/storage/src/researchCandleStore";
import { ResearchDatasetManifestStoreError } from "../../../packages/storage/src/researchDatasetManifest";
import { UPBIT_CANDLE_SOURCE_FINGERPRINT } from "./researchCandleBackfill";
import { AggregatedResearchCandleSource } from "./researchCandleAggregation";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;

const intervalName = (intervalMs: number): ResearchInterval => {
  const names: Readonly<Record<number, ResearchInterval>> = { 60_000: "1m", 180_000: "3m", 300_000: "5m", 600_000: "10m", 900_000: "15m", 1_800_000: "30m", 3_600_000: "60m", 14_400_000: "240m", 86_400_000: "1d" };
  const interval = names[intervalMs];
  if (interval == null) throw new Error("unsupported canonical dataset interval");
  return interval;
};

export function materializeResearchDatasetManifest(input: {
  readonly store: SqliteResearchDatasetManifestStore;
  readonly candleStore: SqliteResearchCandleStore;
  readonly market: string;
  readonly intervalMs: number;
  readonly candles: readonly StoredResearchCandle[];
  readonly source: string;
  readonly createdAt: string;
  readonly sourceCommitSha: string;
}): HistoricalDatasetManifest {
  if (!input.source.trim()) throw new Error("canonical dataset source is required");
  if (!/^KRW-[A-Z0-9-]+$/.test(input.market)) throw new Error("canonical dataset market is invalid");
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("canonical dataset createdAt is invalid");
  if (input.candles.length === 0 || input.candles.some((candle) => candle.volume == null)) throw new Error("canonical dataset requires explicit OHLCV candles");
  const interval = intervalName(input.intervalMs);
  const candles: readonly CanonicalResearchCandle[] = input.candles.map((candle) => ({ market: input.market, interval, openTime: candle.closeTimeMs - input.intervalMs, closeTime: candle.closeTimeMs, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume! }));
  // A gap is allowed only on the 1-minute series and only where the exchange itself proved there was no candle
  // (ResearchCandleAbsence, recorded from a fingerprinted Upbit page). Our own data loss is still rejected.
  const gapCloses: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!.closeTime;
    if (candles[index]!.openTime === previous) continue;
    if (candles[index]!.openTime < previous) throw new Error("canonical dataset has overlapping intervals");
    for (let close = previous + input.intervalMs; close <= candles[index]!.openTime; close += input.intervalMs) gapCloses.push(close);
  }
  // A longer bar is derived only from complete 1-minute buckets (AggregatedResearchCandleSource drops a bucket that lacks any minute),
  // so a gap in a 15m or 60m series exists exactly where at least one of its 1-minute closes is missing. The same rule then applies
  // to those minutes: every missing 1-minute close in the dataset's range must lie inside a run the exchange itself proved empty.
  // Our own data loss is still rejected, and a longer series with no missing minute cannot have a gap at all.
  let absences: readonly { readonly firstAbsentCloseMs: number; readonly lastAbsentCloseMs: number; readonly evidenceFingerprintSha256: string }[] = [];
  let gapMinuteCount = gapCloses.length;
  if (gapCloses.length > 0 && input.intervalMs === 60_000) {
    absences = input.candleStore.listAbsence(input.market, 60_000, gapCloses[0]!, gapCloses.at(-1)!);
    if (gapCloses.some((close) => !absences.some((run) => close >= run.firstAbsentCloseMs && close <= run.lastAbsentCloseMs))) throw new Error("canonical dataset has missing intervals");
  } else if (gapCloses.length > 0 && (input.intervalMs === 900_000 || input.intervalMs === 3_600_000)) {
    const firstMinuteClose = candles[0]!.openTime + 60_000;
    const lastMinuteClose = candles.at(-1)!.closeTime;
    const present = new Set(input.candleStore.read(input.market, 60_000, firstMinuteClose, lastMinuteClose).map((row) => row.closeTimeMs));
    const missingMinutes: number[] = [];
    for (let close = firstMinuteClose; close <= lastMinuteClose; close += 60_000) if (!present.has(close)) missingMinutes.push(close);
    if (missingMinutes.length === 0) throw new Error("canonical dataset has missing intervals");
    absences = input.candleStore.listAbsence(input.market, 60_000, missingMinutes[0]!, missingMinutes.at(-1)!);
    if (missingMinutes.some((close) => !absences.some((run) => close >= run.firstAbsentCloseMs && close <= run.lastAbsentCloseMs))) throw new Error("canonical dataset has missing intervals");
    gapMinuteCount = missingMinutes.length;
  }
  const contentSha256 = calculateResearchCandleSha256(candles);
  if (!SHA1.test(input.sourceCommitSha)) throw Object.assign(new Error("dataset replay runtime source commit is unavailable"), { code: "MANIFEST_PROVENANCE_REQUIRED" });
  const sourceIntervalMs = 60_000;
  const firstBaseClose = candles[0]!.openTime + sourceIntervalMs;
  const lastBaseClose = candles.at(-1)!.closeTime;
  const baseCandles = input.candleStore.read(input.market, sourceIntervalMs, firstBaseClose, lastBaseClose);
  const expectedBaseCount = (lastBaseClose - firstBaseClose) / sourceIntervalMs + 1 - gapMinuteCount;
  if (!Number.isSafeInteger(expectedBaseCount) || baseCandles.length !== expectedBaseCount || baseCandles.some((candle) => candle.volume == null)) throw Object.assign(new Error("dataset source candle coverage is incomplete"), { code: "MANIFEST_PROVENANCE_REQUIRED" });
  const derived = new AggregatedResearchCandleSource(input.candleStore, sourceIntervalMs).read(input.market, input.intervalMs, candles[0]!.openTime + input.intervalMs, candles.at(-1)!.closeTime);
  const derivedCanonical = derived.map((candle): CanonicalResearchCandle => ({ market: input.market, interval, openTime: candle.closeTimeMs - input.intervalMs, closeTime: candle.closeTimeMs, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume! }));
  if (calculateResearchCandleSha256(derivedCanonical) !== contentSha256) throw Object.assign(new Error("dataset material does not match the verified source candles"), { code: "MANIFEST_CONTENT_MISMATCH" });
  const materials = input.candleStore.listMaterial(input.market, sourceIntervalMs, firstBaseClose, lastBaseClose);
  if (materials.length === 0 || materials.some((material) => material.source !== "UPBIT_PUBLIC_CANDLES" || material.sourceFingerprint !== UPBIT_CANDLE_SOURCE_FINGERPRINT || material.evidenceFingerprintSha256 == null || !SHA256.test(material.evidenceFingerprintSha256))) throw Object.assign(new Error("complete canonical raw-source receipts are required"), { code: "MANIFEST_PROVENANCE_REQUIRED" });
  if (materials.some((material) => material.rejectedObservations !== 0)) throw Object.assign(new Error("malformed raw-source observations cannot produce a canonical manifest"), { code: "MANIFEST_SOURCE_MALFORMED" });
  const receiptCovered = new Set<number>();
  for (const material of materials) {
    for (const candle of input.candleStore.read(input.market, sourceIntervalMs, material.firstCloseTimeMs, material.lastCloseTimeMs)) receiptCovered.add(candle.closeTimeMs);
  }
  if (baseCandles.some((candle) => !receiptCovered.has(candle.closeTimeMs))) throw Object.assign(new Error("raw-source receipts do not cover the complete dataset"), { code: "MANIFEST_PROVENANCE_REQUIRED" });
  const provenance: ResearchDatasetProvenanceV2 = {
    rawSourceIdentitySha256s: [...new Set([...materials.map((material) => material.evidenceFingerprintSha256!), ...absences.map((run) => run.evidenceFingerprintSha256)])],
    transformationGraphSha256: hash(["UPBIT_PUBLIC_CANDLES", "parseUpbitMinuteCandles", "CanonicalResearchCandle", "AggregatedResearchCandleSource", "v1"]),
    // Unchanged for gap-free datasets, so their identities stay exactly as before.
    transformationConfigSha256: hash(gapCloses.length === 0
      ? { sourceIntervalMs, targetIntervalMs: input.intervalMs, ordering: "OPEN_TIME_ASC", missingCandlePolicy: "REJECT" }
      : { sourceIntervalMs, targetIntervalMs: input.intervalMs, ordering: "OPEN_TIME_ASC", missingCandlePolicy: "EXCHANGE_CONFIRMED_ABSENCE_ONLY", confirmedAbsentRuns: absences.map((run) => [run.firstAbsentCloseMs, run.lastAbsentCloseMs, run.evidenceFingerprintSha256]) }),
    schemaContractSha256: hash(["CanonicalResearchCandle", "market", "interval", "openTime", "closeTime", "open", "high", "low", "close", "volume"]),
    // A gapped dataset must not claim contiguity; gap-free datasets keep the original label and identity.
    qualitySuiteSha256: hash(gapCloses.length === 0
      ? ["explicit OHLCV", "contiguous source closes", "complete source receipts", "verified source aggregation", "v1"]
      : ["explicit OHLCV", "contiguous source closes except exchange-confirmed absences", "complete source receipts", "verified source aggregation", "v1"]),
    qualityResultsSha256: hash({ sourceCandles: baseCandles.length, outputCandles: candles.length, sourceReceipts: materials.length, missingBuckets: materials.reduce((sum, material) => sum + material.missingBuckets, 0), incompleteBuckets: materials.reduce((sum, material) => sum + material.incompleteBuckets, 0), rejectedObservations: materials.reduce((sum, material) => sum + material.rejectedObservations, 0), ...(gapCloses.length === 0 ? {} : { confirmedAbsentCloses: gapCloses.length, confirmedAbsentRuns: absences.length }) }),
    derivedFeatureLineageSha256: hash({ derivedFeatures: [] }),
    replayRuntimeSha256: hash({ sourceCommitSha: input.sourceCommitSha, nodeVersion: process.version, materializer: "research-dataset-v2-v1" }),
  };
  const manifest: HistoricalDatasetManifest = { schemaVersion: 2, datasetId: calculateResearchDatasetIdV2(input.source, candles, contentSha256, provenance), source: input.source, market: input.market, interval, candleCount: candles.length, startOpenTime: candles[0]!.openTime, endCloseTime: candles.at(-1)!.closeTime, timezone: "UTC", ordering: "OPEN_TIME_ASC", missingCandlePolicy: gapCloses.length === 0 ? "REJECT" : "ALLOW", missingCandleCount: gapCloses.length, ...(gapCloses.length === 0 ? {} : { notes: `exchange-confirmed absent closes: ${gapCloses.length}` }), createdAt: input.createdAt, contentSha256, provenance };
  try {
    const existing = input.store.read(manifest.datasetId);
    const existingWithCurrentCreatedAt = { ...existing, createdAt: manifest.createdAt };
    if (JSON.stringify(existingWithCurrentCreatedAt) !== JSON.stringify(manifest)) {
      throw new ResearchDatasetManifestStoreError("MANIFEST_CONFLICT", "an existing dataset identity has different canonical manifest content");
    }
    // Replays of unchanged, immutable source material keep the original creation timestamp and are no-ops.
    return existing;
  } catch (error) {
    if (!(error instanceof ResearchDatasetManifestStoreError) || error.code !== "MANIFEST_NOT_FOUND") throw error;
  }
  input.store.persistVerified(manifest, candles);
  return Object.freeze(manifest);
}
