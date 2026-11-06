import type { SqliteDatabase } from "./index";

const MARKET = /^KRW-[A-Z0-9-]+$/;
const INTERVALS = new Set(["1m", "15m", "60m", "240m"]);
const MINUTE_MS = 60_000;

export type ResearchGapFillNextPass = "HEAD" | "HISTORY";

export interface ResearchGapFillProgress {
  readonly historyCursorStartMs: number;
  readonly nextPass: ResearchGapFillNextPass;
  readonly updatedAtMs: number;
}

export interface ResearchGapFillPassState {
  readonly nextPass: ResearchGapFillNextPass;
  readonly updatedAtMs: number;
}

export class ResearchGapFillProgressError extends Error {
  public constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResearchGapFillProgressError";
  }
}

/** Durable per-market pagination state for bounded Research candle repair passes. */
export class SqliteResearchGapFillProgressStore {
  public constructor(private readonly db: SqliteDatabase) {
    this.db.transaction(() => {
      this.db.connection.exec(`CREATE TABLE IF NOT EXISTS research_gap_fill_progress (
        market TEXT PRIMARY KEY,
        history_cursor_start_ms INTEGER NOT NULL,
        next_pass TEXT NOT NULL CHECK (next_pass IN ('HEAD', 'HISTORY')),
        updated_at_ms INTEGER NOT NULL
      )`);
      this.db.connection.exec(`CREATE TABLE IF NOT EXISTS research_gap_fill_pass_state (
        market TEXT PRIMARY KEY,
        next_pass TEXT NOT NULL CHECK (next_pass IN ('HEAD', 'HISTORY')),
        updated_at_ms INTEGER NOT NULL
      )`);
      // Copy pre-split state once per market while retaining the legacy cursor table unchanged.
      this.db.connection.exec(`INSERT OR IGNORE INTO research_gap_fill_pass_state (market, next_pass, updated_at_ms)
        SELECT market, next_pass, updated_at_ms FROM research_gap_fill_progress`);
    });
  }

  public load(market: string): ResearchGapFillProgress | undefined {
    this.validateMarket(market);
    const row = this.db.connection.prepare("SELECT history_cursor_start_ms, next_pass, updated_at_ms FROM research_gap_fill_progress WHERE market = ?").get(market) as {
      history_cursor_start_ms: number | bigint;
      next_pass: string;
      updated_at_ms: number | bigint;
    } | undefined;
    if (row == null) return undefined;
    const cursor = Number(row.history_cursor_start_ms);
    const updatedAtMs = Number(row.updated_at_ms);
    if (!Number.isSafeInteger(cursor) || cursor <= 0 || cursor % MINUTE_MS !== 0 ||
      (row.next_pass !== "HEAD" && row.next_pass !== "HISTORY") ||
      !Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
      throw new ResearchGapFillProgressError("PROGRESS_CORRUPT", "stored research gap-fill progress is invalid");
    }
    return Object.freeze({ historyCursorStartMs: cursor, nextPass: row.next_pass, updatedAtMs });
  }

  public loadNextPass(market: string): ResearchGapFillPassState | undefined {
    this.validateMarket(market);
    const row = this.db.connection.prepare("SELECT next_pass, updated_at_ms FROM research_gap_fill_pass_state WHERE market = ?").get(market) as {
      next_pass: string;
      updated_at_ms: number | bigint;
    } | undefined;
    if (row == null) return undefined;
    const updatedAtMs = Number(row.updated_at_ms);
    if ((row.next_pass !== "HEAD" && row.next_pass !== "HISTORY") || !Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
      throw new ResearchGapFillProgressError("PASS_STATE_CORRUPT", "stored research gap-fill pass state is invalid");
    }
    return Object.freeze({ nextPass: row.next_pass, updatedAtMs });
  }

  public save(market: string, progress: ResearchGapFillProgress): void {
    this.validateMarket(market);
    if (!Number.isSafeInteger(progress.historyCursorStartMs) || progress.historyCursorStartMs <= 0 || progress.historyCursorStartMs % MINUTE_MS !== 0 ||
      (progress.nextPass !== "HEAD" && progress.nextPass !== "HISTORY") ||
      !Number.isSafeInteger(progress.updatedAtMs) || progress.updatedAtMs <= 0) {
      throw new ResearchGapFillProgressError("PROGRESS_INVALID", "research gap-fill progress is invalid");
    }
    this.db.transaction(() => {
      this.db.connection.prepare(`INSERT INTO research_gap_fill_progress (market, history_cursor_start_ms, next_pass, updated_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(market) DO UPDATE SET history_cursor_start_ms = excluded.history_cursor_start_ms,
          next_pass = excluded.next_pass, updated_at_ms = excluded.updated_at_ms`).run(
        market, progress.historyCursorStartMs, progress.nextPass, progress.updatedAtMs,
      );
      this.saveNextPassInTransaction(market, progress.nextPass, progress.updatedAtMs);
    });
  }

  /** Persist scheduler progress even when no verified page cursor exists yet. */
  public saveNextPass(market: string, nextPass: ResearchGapFillNextPass, updatedAtMs: number): void {
    this.validateMarket(market);
    this.validatePassState(nextPass, updatedAtMs);
    this.db.transaction(() => this.saveNextPassInTransaction(market, nextPass, updatedAtMs));
  }

  public clear(market: string): void {
    this.validateMarket(market);
    this.db.transaction(() => {
      this.db.connection.prepare("DELETE FROM research_gap_fill_progress WHERE market = ?").run(market);
      this.db.connection.prepare("DELETE FROM research_gap_fill_pass_state WHERE market = ?").run(market);
    });
  }

  private saveNextPassInTransaction(market: string, nextPass: ResearchGapFillNextPass, updatedAtMs: number): void {
    this.db.connection.prepare(`INSERT INTO research_gap_fill_pass_state (market, next_pass, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(market) DO UPDATE SET next_pass = excluded.next_pass, updated_at_ms = excluded.updated_at_ms`).run(market, nextPass, updatedAtMs);
    // Keep the legacy combined row readable for older callers while the pass-only table owns scheduling state.
    this.db.connection.prepare("UPDATE research_gap_fill_progress SET next_pass = ?, updated_at_ms = ? WHERE market = ?").run(nextPass, updatedAtMs, market);
  }

  private validatePassState(nextPass: ResearchGapFillNextPass, updatedAtMs: number): void {
    if ((nextPass !== "HEAD" && nextPass !== "HISTORY") || !Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
      throw new ResearchGapFillProgressError("PASS_STATE_INVALID", "research gap-fill pass state is invalid");
    }
  }

  private validateMarket(market: string): void {
    if (typeof market !== "string" || !MARKET.test(market)) throw new ResearchGapFillProgressError("INVALID_MARKET", "research gap-fill market is invalid");
  }
}

/** Durable retry clock for absent multi-interval manifests; a process restart cannot defeat the retry bound. */
export class SqliteResearchManifestRetryStore {
  public constructor(private readonly db: SqliteDatabase) {
    this.db.connection.exec(`CREATE TABLE IF NOT EXISTS research_manifest_materialization_retries (
      market TEXT NOT NULL,
      interval_name TEXT NOT NULL,
      last_attempt_at_ms INTEGER NOT NULL,
      input_watermark_ms INTEGER NOT NULL,
      PRIMARY KEY (market, interval_name)
    )`);
  }

  public lastAttempt(market: string, intervalName: string): { readonly atMs: number; readonly inputWatermarkMs: number } | undefined {
    this.validateKey(market, intervalName);
    const row = this.db.connection.prepare("SELECT last_attempt_at_ms, input_watermark_ms FROM research_manifest_materialization_retries WHERE market = ? AND interval_name = ?").get(market, intervalName) as { last_attempt_at_ms: number | bigint; input_watermark_ms: number | bigint } | undefined;
    if (row == null) return undefined;
    const atMs = Number(row.last_attempt_at_ms);
    const inputWatermarkMs = Number(row.input_watermark_ms);
    if (!Number.isSafeInteger(atMs) || atMs <= 0 || !Number.isSafeInteger(inputWatermarkMs) || inputWatermarkMs < 0) throw new ResearchGapFillProgressError("MANIFEST_RETRY_CORRUPT", "stored manifest retry metadata is invalid");
    return Object.freeze({ atMs, inputWatermarkMs });
  }

  public recordAttempt(market: string, intervalName: string, atMs: number, inputWatermarkMs: number): void {
    this.validateKey(market, intervalName);
    if (!Number.isSafeInteger(atMs) || atMs <= 0 || !Number.isSafeInteger(inputWatermarkMs) || inputWatermarkMs < 0) throw new ResearchGapFillProgressError("MANIFEST_RETRY_INVALID", "manifest retry metadata is invalid");
    this.db.connection.prepare(`INSERT INTO research_manifest_materialization_retries (market, interval_name, last_attempt_at_ms, input_watermark_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(market, interval_name) DO UPDATE SET last_attempt_at_ms = excluded.last_attempt_at_ms,
        input_watermark_ms = excluded.input_watermark_ms`).run(market, intervalName, atMs, inputWatermarkMs);
  }

  private validateKey(market: string, intervalName: string): void {
    if (typeof market !== "string" || !MARKET.test(market)) throw new ResearchGapFillProgressError("INVALID_MARKET", "research manifest retry market is invalid");
    if (typeof intervalName !== "string" || !INTERVALS.has(intervalName)) throw new ResearchGapFillProgressError("INVALID_INTERVAL", "research manifest retry interval is invalid");
  }
}
