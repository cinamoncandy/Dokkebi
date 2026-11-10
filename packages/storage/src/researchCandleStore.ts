import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./index";

const TABLE = "research_closed_candles";
const MATERIAL_TABLE = "research_dataset_material";
const ABSENCE_TABLE = "research_candle_absence";
const MARKET = /^KRW-[A-Z0-9-]+$/;

/**
 * Durable store of CLOSED research candles. A candle is identified by (market, intervalMs, closeTimeMs) and is
 * immutable: appending an identical candle is a no-op, appending a different candle for the same key is a
 * conflict and throws. Rows carry a checksum that is verified on every read. Retention is bounded per market.
 * `volume` is deliberately not stored (ticker-derived candles have none).
 */
export interface StoredResearchCandle {
  readonly closeTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
}

export interface ResearchDatasetMaterial {
  readonly market: string;
  readonly intervalMs: number;
  readonly firstCloseTimeMs: number;
  readonly lastCloseTimeMs: number;
  readonly candleCount: number;
  readonly storeContentSha256: string;
  readonly source: string;
  readonly sourceFingerprint?: string;
  readonly evidenceFingerprintSha256?: string;
  readonly missingBuckets: number;
  readonly incompleteBuckets: number;
  readonly rejectedObservations: number;
}

function materialDigest(material: Omit<ResearchDatasetMaterial, "storeContentSha256">): string {
  const normalized = Object.fromEntries(Object.entries(material).filter(([, value]) => value != null));
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

/**
 * A run of closes the exchange itself reported as having no candle: one Upbit page (fingerprinted in
 * `evidenceFingerprintSha256`) listed `beforeCloseMs` and then, with nothing in between, `afterCloseMs`
 * (or ended at an exclusive `to` bound with `afterCloseMs` stored). Upbit omits a minute with no trades.
 * This is not our own data loss: it is recorded only from a page that spans the run, and only while
 * both bounding candles are stored and nothing inside the run is.
 */
export interface ResearchCandleAbsence {
  readonly market: string;
  readonly intervalMs: number;
  readonly firstAbsentCloseMs: number;
  readonly lastAbsentCloseMs: number;
  readonly beforeCloseMs: number;
  readonly afterCloseMs: number;
  readonly evidenceFingerprintSha256: string;
  readonly observedAt: string;
}

const absenceDigest = (a: ResearchCandleAbsence): string => createHash("sha256").update(JSON.stringify([a.market, a.intervalMs, a.firstAbsentCloseMs, a.lastAbsentCloseMs, a.beforeCloseMs, a.afterCloseMs, a.evidenceFingerprintSha256, a.observedAt]), "utf8").digest("hex");

export class ResearchCandleStoreError extends Error {
  public constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResearchCandleStoreError";
  }
}

const price = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ResearchCandleStoreError("INVALID_CANDLE", `research candle ${field} is invalid`);
  return value;
};

function rowChecksum(market: string, intervalMs: number, c: StoredResearchCandle): string {
  return createHash("sha256").update(JSON.stringify([market, intervalMs, c.closeTimeMs, c.open, c.high, c.low, c.close, ...(c.volume == null ? [] : [c.volume])]), "utf8").digest("hex");
}

function validate(market: string, intervalMs: number, candle: StoredResearchCandle): StoredResearchCandle {
  if (typeof market !== "string" || !MARKET.test(market)) throw new ResearchCandleStoreError("INVALID_MARKET", "research candle market is invalid");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 86_400_000) throw new ResearchCandleStoreError("INVALID_INTERVAL", "research candle interval is invalid");
  if (!Number.isSafeInteger(candle.closeTimeMs) || candle.closeTimeMs <= 0 || candle.closeTimeMs % intervalMs !== 0) throw new ResearchCandleStoreError("INVALID_CANDLE", "research candle close time must be a positive multiple of the interval");
  const open = price(candle.open, "open");
  const high = price(candle.high, "high");
  const low = price(candle.low, "low");
  const close = price(candle.close, "close");
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) throw new ResearchCandleStoreError("INVALID_CANDLE", "research candle high/low do not bound open/close");
  if (candle.volume != null && (!Number.isFinite(candle.volume) || candle.volume < 0)) throw new ResearchCandleStoreError("INVALID_CANDLE", "research candle volume is invalid");
  return Object.freeze({ closeTimeMs: candle.closeTimeMs, open, high, low, close, ...(candle.volume == null ? {} : { volume: candle.volume }) });
}

export class SqliteResearchCandleStore {
  public constructor(private readonly db: SqliteDatabase, private readonly maximumRowsPerMarket = 100_000) {
    if (!Number.isSafeInteger(maximumRowsPerMarket) || maximumRowsPerMarket < 2 || maximumRowsPerMarket > 5_000_000) throw new ResearchCandleStoreError("INVALID_RETENTION", "research candle retention is invalid");
    this.db.connection.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (market TEXT NOT NULL, interval_ms INTEGER NOT NULL, close_time_ms INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY (market, interval_ms, close_time_ms))`);
    this.db.connection.exec(`CREATE TABLE IF NOT EXISTS ${MATERIAL_TABLE} (market TEXT NOT NULL, interval_ms INTEGER NOT NULL, first_close_time_ms INTEGER NOT NULL, last_close_time_ms INTEGER NOT NULL, candle_count INTEGER NOT NULL, store_content_sha256 TEXT NOT NULL, source TEXT NOT NULL, source_fingerprint TEXT, evidence_fingerprint_sha256 TEXT, missing_buckets INTEGER NOT NULL, incomplete_buckets INTEGER NOT NULL, rejected_observations INTEGER NOT NULL, material_sha256 TEXT NOT NULL, PRIMARY KEY (market, interval_ms, first_close_time_ms, last_close_time_ms, store_content_sha256))`);
    try { this.db.connection.exec(`ALTER TABLE ${TABLE} ADD COLUMN volume REAL`); } catch { /* existing schema already migrated */ }
    this.db.connection.exec(`CREATE TABLE IF NOT EXISTS ${ABSENCE_TABLE} (market TEXT NOT NULL, interval_ms INTEGER NOT NULL, first_absent_close_ms INTEGER NOT NULL, last_absent_close_ms INTEGER NOT NULL, before_close_ms INTEGER NOT NULL, after_close_ms INTEGER NOT NULL, evidence_fingerprint_sha256 TEXT NOT NULL, observed_at TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY (market, interval_ms, first_absent_close_ms, last_absent_close_ms))`);
  }

  /**
   * Records one exchange-confirmed run of absent closes. Returns false (and writes nothing) when the run is
   * already recorded. Throws before writing when a bounding candle is not stored, any close inside the run is
   * stored, or a different record already exists for the same run.
   */
  public recordAbsence(absence: ResearchCandleAbsence): boolean {
    const a = absence;
    if (!MARKET.test(a.market)) throw new ResearchCandleStoreError("INVALID_MARKET", "research candle market is invalid");
    const i = a.intervalMs;
    const aligned = (ms: number) => Number.isSafeInteger(ms) && ms > 0 && ms % i === 0;
    if (!Number.isSafeInteger(i) || i < 1_000 || i > 86_400_000 || ![a.firstAbsentCloseMs, a.lastAbsentCloseMs, a.beforeCloseMs, a.afterCloseMs].every(aligned)
      || a.firstAbsentCloseMs > a.lastAbsentCloseMs || a.beforeCloseMs !== a.firstAbsentCloseMs - i || a.afterCloseMs !== a.lastAbsentCloseMs + i
      || !/^[a-f0-9]{64}$/.test(a.evidenceFingerprintSha256) || !Number.isFinite(Date.parse(a.observedAt))) throw new ResearchCandleStoreError("INVALID_ABSENCE", "research candle absence is invalid");
    return this.db.transaction(() => {
      const stored = this.read(a.market, i, a.beforeCloseMs, a.afterCloseMs).map((candle) => candle.closeTimeMs);
      if (stored.length !== 2 || stored[0] !== a.beforeCloseMs || stored[1] !== a.afterCloseMs) throw new ResearchCandleStoreError("ABSENCE_NOT_BOUNDED", "an absence must sit between two stored candles with nothing stored inside it");
      const record: ResearchCandleAbsence = Object.freeze({ market: a.market, intervalMs: i, firstAbsentCloseMs: a.firstAbsentCloseMs, lastAbsentCloseMs: a.lastAbsentCloseMs, beforeCloseMs: a.beforeCloseMs, afterCloseMs: a.afterCloseMs, evidenceFingerprintSha256: a.evidenceFingerprintSha256, observedAt: a.observedAt });
      const existing = this.db.connection.prepare(`SELECT 1 FROM ${ABSENCE_TABLE} WHERE market = ? AND interval_ms = ? AND first_absent_close_ms = ? AND last_absent_close_ms = ?`).get(a.market, i, a.firstAbsentCloseMs, a.lastAbsentCloseMs);
      // The first proof of a run is kept; a later page proving the same run again is a no-op.
      if (existing != null) return false;
      const overlap = this.db.connection.prepare(`SELECT 1 FROM ${ABSENCE_TABLE} WHERE market = ? AND interval_ms = ? AND first_absent_close_ms <= ? AND last_absent_close_ms >= ?`).get(a.market, i, a.lastAbsentCloseMs, a.firstAbsentCloseMs);
      if (overlap != null) throw new ResearchCandleStoreError("ABSENCE_CONFLICT", "a different absence run already overlaps this one");
      this.db.connection.prepare(`INSERT INTO ${ABSENCE_TABLE} (market, interval_ms, first_absent_close_ms, last_absent_close_ms, before_close_ms, after_close_ms, evidence_fingerprint_sha256, observed_at, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(a.market, i, a.firstAbsentCloseMs, a.lastAbsentCloseMs, a.beforeCloseMs, a.afterCloseMs, a.evidenceFingerprintSha256, a.observedAt, absenceDigest(record));
      return true;
    });
  }

  /**
   * Absence runs overlapping [fromCloseMs, toCloseMs], oldest first. Verifies each checksum and that the run is
   * still bounded by stored candles with nothing stored inside it; a run that no longer holds is not returned.
   */
  public listAbsence(market: string, intervalMs: number, fromCloseMs: number, toCloseMs: number): readonly ResearchCandleAbsence[] {
    if (!MARKET.test(market)) throw new ResearchCandleStoreError("INVALID_MARKET", "research candle market is invalid");
    if (!Number.isSafeInteger(fromCloseMs) || !Number.isSafeInteger(toCloseMs) || toCloseMs < fromCloseMs) throw new ResearchCandleStoreError("INVALID_WINDOW", "research candle window is invalid");
    const rows = this.db.connection.prepare(`SELECT first_absent_close_ms AS firstAbsentCloseMs, last_absent_close_ms AS lastAbsentCloseMs, before_close_ms AS beforeCloseMs, after_close_ms AS afterCloseMs, evidence_fingerprint_sha256 AS evidenceFingerprintSha256, observed_at AS observedAt, checksum FROM ${ABSENCE_TABLE} WHERE market = ? AND interval_ms = ? AND last_absent_close_ms >= ? AND first_absent_close_ms <= ? ORDER BY first_absent_close_ms ASC`).all(market, intervalMs, fromCloseMs, toCloseMs) as Array<Record<string, unknown>>;
    const out: ResearchCandleAbsence[] = [];
    for (const row of rows) {
      const record: ResearchCandleAbsence = Object.freeze({ market, intervalMs, firstAbsentCloseMs: Number(row.firstAbsentCloseMs), lastAbsentCloseMs: Number(row.lastAbsentCloseMs), beforeCloseMs: Number(row.beforeCloseMs), afterCloseMs: Number(row.afterCloseMs), evidenceFingerprintSha256: String(row.evidenceFingerprintSha256), observedAt: String(row.observedAt) });
      if (absenceDigest(record) !== String(row.checksum)) throw new ResearchCandleStoreError("ABSENCE_CHECKSUM_MISMATCH", "research candle absence checksum mismatch");
      const stored = this.read(market, intervalMs, record.beforeCloseMs, record.afterCloseMs).map((candle) => candle.closeTimeMs);
      if (stored.length === 2 && stored[0] === record.beforeCloseMs && stored[1] === record.afterCloseMs) out.push(record);
    }
    return Object.freeze(out);
  }

  /** Returns how many candles were newly recorded. Throws before writing anything if any candle is invalid or conflicts. */
  public append(market: string, intervalMs: number, candles: readonly StoredResearchCandle[]): number {
    const checked = candles.map((candle) => validate(market, intervalMs, candle));
    return this.db.transaction(() => {
      let recorded = 0;
      for (const candle of checked) {
        const existing = this.db.connection.prepare(`SELECT checksum FROM ${TABLE} WHERE market = ? AND interval_ms = ? AND close_time_ms = ?`).get(market, intervalMs, candle.closeTimeMs) as { checksum: string } | undefined;
        const checksum = rowChecksum(market, intervalMs, candle);
        if (existing != null) {
          if (existing.checksum !== checksum) throw new ResearchCandleStoreError("CANDLE_CONFLICT", "a different closed candle is already stored for this key");
          continue;
        }
        this.db.connection.prepare(`INSERT INTO ${TABLE} (market, interval_ms, close_time_ms, open, high, low, close, volume, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(market, intervalMs, candle.closeTimeMs, candle.open, candle.high, candle.low, candle.close, candle.volume ?? null, checksum);
        recorded += 1;
      }
      this.db.connection.prepare(`DELETE FROM ${TABLE} WHERE market = ? AND interval_ms = ? AND close_time_ms NOT IN (SELECT close_time_ms FROM ${TABLE} WHERE market = ? AND interval_ms = ? ORDER BY close_time_ms DESC LIMIT ?)`).run(market, intervalMs, market, intervalMs, this.maximumRowsPerMarket);
      return recorded;
    });
  }

  public appendWithMaterial(market: string, intervalMs: number, candles: readonly StoredResearchCandle[], material: Omit<ResearchDatasetMaterial, "market" | "intervalMs" | "firstCloseTimeMs" | "lastCloseTimeMs" | "candleCount" | "storeContentSha256">): number {
    const checked = candles.map((candle) => validate(market, intervalMs, candle));
    if (checked.length === 0) return 0;
    const content = createHash("sha256").update(JSON.stringify(checked.map((candle) => [candle.closeTimeMs, candle.open, candle.high, candle.low, candle.close])), "utf8").digest("hex");
    return this.db.transaction(() => {
      let recorded = 0;
      for (const candle of checked) {
        const existing = this.db.connection.prepare(`SELECT checksum FROM ${TABLE} WHERE market = ? AND interval_ms = ? AND close_time_ms = ?`).get(market, intervalMs, candle.closeTimeMs) as { checksum: string } | undefined;
        const checksum = rowChecksum(market, intervalMs, candle);
        if (existing != null) { if (existing.checksum !== checksum) throw new ResearchCandleStoreError("CANDLE_CONFLICT", "a different closed candle is already stored for this key"); continue; }
        this.db.connection.prepare(`INSERT INTO ${TABLE} (market, interval_ms, close_time_ms, open, high, low, close, volume, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(market, intervalMs, candle.closeTimeMs, candle.open, candle.high, candle.low, candle.close, candle.volume ?? null, checksum);
        recorded += 1;
      }
      this.db.connection.prepare(`DELETE FROM ${TABLE} WHERE market = ? AND interval_ms = ? AND close_time_ms NOT IN (SELECT close_time_ms FROM ${TABLE} WHERE market = ? AND interval_ms = ? ORDER BY close_time_ms DESC LIMIT ?)`).run(market, intervalMs, market, intervalMs, this.maximumRowsPerMarket);
      const persisted = { market, intervalMs, firstCloseTimeMs: checked[0]!.closeTimeMs, lastCloseTimeMs: checked.at(-1)!.closeTimeMs, candleCount: checked.length, source: material.source, ...(material.sourceFingerprint == null ? {} : { sourceFingerprint: material.sourceFingerprint }), ...(material.evidenceFingerprintSha256 == null ? {} : { evidenceFingerprintSha256: material.evidenceFingerprintSha256 }), missingBuckets: material.missingBuckets, incompleteBuckets: material.incompleteBuckets, rejectedObservations: material.rejectedObservations };
      this.db.connection.prepare(`INSERT OR REPLACE INTO ${MATERIAL_TABLE} (market, interval_ms, first_close_time_ms, last_close_time_ms, candle_count, store_content_sha256, source, source_fingerprint, evidence_fingerprint_sha256, missing_buckets, incomplete_buckets, rejected_observations, material_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(market, intervalMs, persisted.firstCloseTimeMs, persisted.lastCloseTimeMs, persisted.candleCount, content, material.source, material.sourceFingerprint ?? null, material.evidenceFingerprintSha256 ?? null, material.missingBuckets, material.incompleteBuckets, material.rejectedObservations, materialDigest(persisted));
      return recorded;
    });
  }

  /** Candles with fromCloseMs <= closeTimeMs <= toCloseMs, oldest first. Verifies every row checksum. */
  public read(market: string, intervalMs: number, fromCloseMs: number, toCloseMs: number): readonly StoredResearchCandle[] {
    if (!MARKET.test(market)) throw new ResearchCandleStoreError("INVALID_MARKET", "research candle market is invalid");
    if (!Number.isSafeInteger(fromCloseMs) || !Number.isSafeInteger(toCloseMs) || toCloseMs < fromCloseMs) throw new ResearchCandleStoreError("INVALID_WINDOW", "research candle window is invalid");
    const rows = this.db.connection.prepare(`SELECT close_time_ms, open, high, low, close, volume, checksum FROM ${TABLE} WHERE market = ? AND interval_ms = ? AND close_time_ms >= ? AND close_time_ms <= ? ORDER BY close_time_ms ASC`).all(market, intervalMs, fromCloseMs, toCloseMs) as Array<Record<string, unknown>>;
    return Object.freeze(rows.map((row) => {
      const candle = validate(market, intervalMs, { closeTimeMs: Number(row.close_time_ms), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), ...(row.volume == null ? {} : { volume: Number(row.volume) }) });
      if (rowChecksum(market, intervalMs, candle) !== String(row.checksum)) throw new ResearchCandleStoreError("CANDLE_CHECKSUM_MISMATCH", "persisted research candle checksum mismatch");
      return candle;
    }));
  }

  public readMaterial(market: string, intervalMs: number, firstCloseTimeMs: number, lastCloseTimeMs: number, storeContentSha256: string): ResearchDatasetMaterial {
    const row = this.db.connection.prepare(`SELECT market, interval_ms AS intervalMs, first_close_time_ms AS firstCloseTimeMs, last_close_time_ms AS lastCloseTimeMs, candle_count AS candleCount, store_content_sha256 AS storeContentSha256, source, source_fingerprint AS sourceFingerprint, evidence_fingerprint_sha256 AS evidenceFingerprintSha256, missing_buckets AS missingBuckets, incomplete_buckets AS incompleteBuckets, rejected_observations AS rejectedObservations, material_sha256 AS materialSha256 FROM ${MATERIAL_TABLE} WHERE market = ? AND interval_ms = ? AND first_close_time_ms = ? AND last_close_time_ms = ? AND store_content_sha256 = ?`).get(market, intervalMs, firstCloseTimeMs, lastCloseTimeMs, storeContentSha256) as ResearchDatasetMaterial & { materialSha256: string } | undefined;
    if (row == null) throw new ResearchCandleStoreError("DATASET_MATERIAL_NOT_FOUND", "dataset material is missing");
    const candles = this.read(market, intervalMs, firstCloseTimeMs, lastCloseTimeMs);
    const content = createHash("sha256").update(JSON.stringify(candles.map((candle) => [candle.closeTimeMs, candle.open, candle.high, candle.low, candle.close])), "utf8").digest("hex");
    const { materialSha256, storeContentSha256: persistedContent, ...material } = row;
    if (candles.length !== row.candleCount || content !== persistedContent || content !== storeContentSha256 || materialDigest(material) !== materialSha256) throw new ResearchCandleStoreError("DATASET_MATERIAL_MISMATCH", "dataset material does not match candle collection");
    return Object.freeze({ ...row });
  }

  public latestMaterial(market: string, intervalMs: number): ResearchDatasetMaterial | undefined {
    const row = this.db.connection.prepare(`SELECT market, interval_ms AS intervalMs, first_close_time_ms AS firstCloseTimeMs, last_close_time_ms AS lastCloseTimeMs, candle_count AS candleCount, store_content_sha256 AS storeContentSha256, source, source_fingerprint AS sourceFingerprint, evidence_fingerprint_sha256 AS evidenceFingerprintSha256, missing_buckets AS missingBuckets, incomplete_buckets AS incompleteBuckets, rejected_observations AS rejectedObservations FROM ${MATERIAL_TABLE} WHERE market = ? AND interval_ms = ? ORDER BY last_close_time_ms DESC LIMIT 1`).get(market, intervalMs) as ResearchDatasetMaterial | undefined;
    return row == null ? undefined : Object.freeze({ ...row });
  }

  public listMaterial(market: string, intervalMs: number, fromCloseTimeMs: number, toCloseTimeMs: number): readonly ResearchDatasetMaterial[] {
    if (!MARKET.test(market) || !Number.isSafeInteger(fromCloseTimeMs) || !Number.isSafeInteger(toCloseTimeMs) || toCloseTimeMs < fromCloseTimeMs) throw new ResearchCandleStoreError("INVALID_WINDOW", "dataset material window is invalid");
    const rows = this.db.connection.prepare(`SELECT first_close_time_ms AS firstCloseTimeMs, last_close_time_ms AS lastCloseTimeMs, store_content_sha256 AS storeContentSha256 FROM ${MATERIAL_TABLE} WHERE market = ? AND interval_ms = ? AND first_close_time_ms <= ? AND last_close_time_ms >= ? ORDER BY first_close_time_ms, last_close_time_ms`).all(market, intervalMs, toCloseTimeMs, fromCloseTimeMs) as Array<{ firstCloseTimeMs: number; lastCloseTimeMs: number; storeContentSha256: string }>;
    return Object.freeze(rows.map((row) => this.readMaterial(market, intervalMs, row.firstCloseTimeMs, row.lastCloseTimeMs, row.storeContentSha256)));
  }

  public hasMaterialCoverage(market: string, intervalMs: number, fromCloseTimeMs: number, toCloseTimeMs: number, source: string, sourceFingerprint: string): boolean {
    // Load overlapping receipt metadata first, then checksum-verify their entire union plus the
    // requested candle window with one SQLite read. The old implementation called listMaterial(),
    // whose readMaterial() re-read and re-hashed every receipt range, then read each range yet
    // again while building coverage. On production-sized history those repeated synchronous scans
    // can starve the 30 s PAPER writer-lease heartbeat. We preserve the same material checksum and
    // content-hash proofs below, but reconstruct them from one already-verified in-memory window.
    const rows = this.db.connection.prepare(`SELECT market, interval_ms AS intervalMs, first_close_time_ms AS firstCloseTimeMs, last_close_time_ms AS lastCloseTimeMs, candle_count AS candleCount, store_content_sha256 AS storeContentSha256, source, source_fingerprint AS sourceFingerprint, evidence_fingerprint_sha256 AS evidenceFingerprintSha256, missing_buckets AS missingBuckets, incomplete_buckets AS incompleteBuckets, rejected_observations AS rejectedObservations, material_sha256 AS materialSha256 FROM ${MATERIAL_TABLE} WHERE market = ? AND interval_ms = ? AND first_close_time_ms <= ? AND last_close_time_ms >= ? ORDER BY first_close_time_ms, last_close_time_ms`).all(market, intervalMs, toCloseTimeMs, fromCloseTimeMs) as unknown as Array<ResearchDatasetMaterial & { materialSha256: string }>;
    const materials = rows.filter((row) => row.source === source && row.sourceFingerprint === sourceFingerprint && row.evidenceFingerprintSha256 != null && /^[a-f0-9]{64}$/.test(row.evidenceFingerprintSha256));
    if (materials.length === 0) return false;
    let verificationFrom = fromCloseTimeMs;
    let verificationTo = toCloseTimeMs;
    for (const row of materials) {
      const { materialSha256, storeContentSha256: _storeContentSha256, ...material } = row;
      if (materialDigest(material) !== materialSha256) throw new ResearchCandleStoreError("DATASET_MATERIAL_MISMATCH", "dataset material checksum does not match");
      if (!Number.isSafeInteger(row.firstCloseTimeMs) || !Number.isSafeInteger(row.lastCloseTimeMs) || row.lastCloseTimeMs < row.firstCloseTimeMs || !Number.isSafeInteger(row.candleCount) || row.candleCount < 1) throw new ResearchCandleStoreError("DATASET_MATERIAL_MISMATCH", "dataset material range is invalid");
      verificationFrom = Math.min(verificationFrom, row.firstCloseTimeMs);
      verificationTo = Math.max(verificationTo, row.lastCloseTimeMs);
    }
    const candles = this.read(market, intervalMs, verificationFrom, verificationTo);
    const requested = candles.filter((candle) => candle.closeTimeMs >= fromCloseTimeMs && candle.closeTimeMs <= toCloseTimeMs);
    if (requested.length === 0) return false;
    const byClose = new Map(candles.map((candle) => [candle.closeTimeMs, candle] as const));
    const covered = new Set<number>();
    for (const row of materials) {
      const receiptCandles: StoredResearchCandle[] = [];
      for (let closeTimeMs = row.firstCloseTimeMs; closeTimeMs <= row.lastCloseTimeMs; closeTimeMs += intervalMs) {
        const candle = byClose.get(closeTimeMs);
        if (candle != null) receiptCandles.push(candle);
      }
      const content = createHash("sha256").update(JSON.stringify(receiptCandles.map((candle) => [candle.closeTimeMs, candle.open, candle.high, candle.low, candle.close])), "utf8").digest("hex");
      if (receiptCandles.length !== row.candleCount || content !== row.storeContentSha256) throw new ResearchCandleStoreError("DATASET_MATERIAL_MISMATCH", "dataset material does not match candle collection");
      for (const candle of receiptCandles) if (candle.closeTimeMs >= fromCloseTimeMs && candle.closeTimeMs <= toCloseTimeMs) covered.add(candle.closeTimeMs);
    }
    return requested.every((candle) => covered.has(candle.closeTimeMs));
  }

  /** Earliest stored close time for a market/interval, or undefined when empty. */
  public earliestCloseTime(market: string, intervalMs: number): number | undefined {
    const row = this.db.connection.prepare(`SELECT MIN(close_time_ms) AS earliest FROM ${TABLE} WHERE market = ? AND interval_ms = ?`).get(market, intervalMs) as { earliest: number | null } | undefined;
    return row?.earliest == null ? undefined : Number(row.earliest);
  }

  /** Latest stored close time for a market/interval, or undefined when empty. */
  public latestCloseTime(market: string, intervalMs: number): number | undefined {
    if (!MARKET.test(market)) throw new ResearchCandleStoreError("INVALID_MARKET", "research candle market is invalid");
    const row = this.db.connection.prepare(`SELECT MAX(close_time_ms) AS latest FROM ${TABLE} WHERE market = ? AND interval_ms = ?`).get(market, intervalMs) as { latest: number | null } | undefined;
    return row?.latest == null ? undefined : Number(row.latest);
  }

  public count(market: string, intervalMs: number): number {
    const row = this.db.connection.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE market = ? AND interval_ms = ?`).get(market, intervalMs) as { n: number };
    return Number(row.n);
  }
}
