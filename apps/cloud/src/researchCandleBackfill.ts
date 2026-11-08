import type { StoredResearchCandle } from "../../../packages/storage/src/researchCandleStore";
import { createHash } from "node:crypto";

/**
 * One-time history fill for the research candle store from Upbit's PUBLIC 1-minute candle endpoint (no
 * credentials, GET only). The research experiments need train + validation + holdout days of closed candles;
 * collecting them only from the live ticker takes that many real days.
 *
 * Safety properties (research evidence only: LIVE NONE, no orders, no capital/risk/execution change):
 * - It only ever writes candles OLDER than anything already stored, evaluated at the moment of each append, so
 *   it can never conflict with, replace or race the live collector (stored candles are immutable).
 * - Only fully closed minutes are accepted; every candle is validated; invalid ones are dropped and counted.
 * - Requests are sequential, spaced, time-bounded and page-bounded; a rate limit or any request error stops the
 *   attempt and reports it. It never retries in a tight loop.
 */
export const UPBIT_MINUTE_CANDLES_URL = "https://api.upbit.com/v1/candles/minutes/1";
export const BACKFILL_PAGE_SIZE = 200;
const MINUTE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MARKET = /^KRW-[A-Z0-9-]+$/;
const UTC_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

export class BackfillRateLimitedError extends Error {
  public constructor() { super("upbit candle request was rate limited"); this.name = "BackfillRateLimitedError"; }
}

export interface ParsedCandles {
  readonly candles: readonly StoredResearchCandle[];
  readonly rejected: number;
  /** Start of the oldest candle in the page (ms), for the next page cursor; undefined when the page had none. */
  readonly oldestStartMs: number | undefined;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Parses one Upbit page (newest first). Never throws: malformed items are counted and skipped. */
export function parseUpbitMinuteCandles(raw: unknown, market: string): ParsedCandles {
  if (!Array.isArray(raw)) return Object.freeze({ candles: Object.freeze([]), rejected: 1, oldestStartMs: undefined });
  const candles: StoredResearchCandle[] = [];
  let rejected = 0;
  let oldest: number | undefined;
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const match = typeof o.candle_date_time_utc === "string" ? UTC_LOCAL.exec(o.candle_date_time_utc) : null;
    const startMs = match == null ? NaN : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
    const open = o.opening_price;
    const high = o.high_price;
    const low = o.low_price;
    const close = o.trade_price;
    const volume = o.candle_acc_trade_volume;
    const hasVolume = volume !== undefined && volume !== null;
    if (o.market !== market || !Number.isSafeInteger(startMs) || startMs <= 0 || startMs % MINUTE_MS !== 0
      || !positive(open) || !positive(high) || !positive(low) || !positive(close)
      || (hasVolume && (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0))
      || high < Math.max(open, close, low) || low > Math.min(open, close, high)) { rejected += 1; continue; }
    oldest = oldest === undefined ? startMs : Math.min(oldest, startMs);
    candles.push(Object.freeze({ closeTimeMs: startMs + MINUTE_MS, open, high, low, close, ...(hasVolume ? { volume } : {}) }));
  }
  candles.sort((a, b) => a.closeTimeMs - b.closeTimeMs);
  return Object.freeze({ candles: Object.freeze(candles), rejected, oldestStartMs: oldest });
}

export interface BackfillStore {
  earliestCloseTime(market: string, intervalMs: number): number | undefined;
  append(market: string, intervalMs: number, candles: readonly StoredResearchCandle[]): number;
  read?: (market: string, intervalMs: number, fromCloseTimeMs: number, toCloseTimeMs: number) => readonly StoredResearchCandle[];
  hasMaterialCoverage?: (market: string, intervalMs: number, fromCloseTimeMs: number, toCloseTimeMs: number, source: string, sourceFingerprint: string) => boolean;
  appendWithMaterial?: (market: string, intervalMs: number, candles: readonly StoredResearchCandle[], material: { readonly source: string; readonly sourceFingerprint: string; readonly evidenceFingerprintSha256: string; readonly missingBuckets: number; readonly incompleteBuckets: number; readonly rejectedObservations: number }) => number;
}

export interface BackfillResult {
  readonly market: string;
  readonly status: "COMPLETE" | "INCOMPLETE" | "RATE_LIMITED" | "ERROR";
  readonly recorded: number;
  readonly rejected: number;
  readonly pages: number;
  readonly earliestCloseMs?: number;
  readonly errorCode?: string;
}

export interface BackfillInput {
  readonly market: string;
  /** How far back from now the history should reach. */
  readonly targetSpanMs: number;
  readonly nowMs: number;
  readonly store: BackfillStore;
  /** Returns the raw JSON page ending before `toIso` (UTC, no zone suffix); the newest page when undefined. */
  readonly fetchPage: (market: string, toIso: string | undefined) => Promise<unknown>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pageDelayMs?: number;
  readonly maxPages?: number;
  /** Cooperative production yield after each bounded page write/verification step. */
  readonly yieldControl?: () => Promise<void>;
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
export const UPBIT_CANDLE_SOURCE_FINGERPRINT = sha256("UPBIT_PUBLIC_CANDLES:minute:1:v1");

function recordPage(store: BackfillStore, market: string, raw: unknown, toIso: string | undefined, observedAt: string, candles: readonly StoredResearchCandle[], rejected: number): number {
  if (candles.length === 0) return 0;
  if (store.appendWithMaterial == null) return store.append(market, MINUTE_MS, candles);
  const missingBuckets = candles.slice(1).reduce((sum, candle, index) => sum + Math.max(0, (candle.closeTimeMs - candles[index]!.closeTimeMs) / MINUTE_MS - 1), 0);
  return store.appendWithMaterial(market, MINUTE_MS, candles, {
    source: "UPBIT_PUBLIC_CANDLES",
    sourceFingerprint: UPBIT_CANDLE_SOURCE_FINGERPRINT,
    evidenceFingerprintSha256: sha256({ endpoint: UPBIT_MINUTE_CANDLES_URL, market, count: BACKFILL_PAGE_SIZE, to: toIso ?? null, observedAt, response: raw }),
    missingBuckets,
    incompleteBuckets: 0,
    rejectedObservations: rejected,
  });
}

export async function backfillMarket(input: BackfillInput): Promise<BackfillResult> {
  const { market, store } = input;
  if (!MARKET.test(market)) throw new Error("backfill market is invalid");
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) throw new Error("backfill clock is invalid");
  if (!Number.isSafeInteger(input.targetSpanMs) || input.targetSpanMs < MINUTE_MS || input.targetSpanMs % MINUTE_MS !== 0) throw new Error("backfill span is invalid");
  const anchor = Math.floor(input.nowMs / MINUTE_MS) * MINUTE_MS; // the last minute that has fully closed
  const goal = anchor - input.targetSpanMs;
  const delay = input.pageDelayMs ?? 150;
  const maxPages = input.maxPages ?? Math.ceil(input.targetSpanMs / (BACKFILL_PAGE_SIZE * MINUTE_MS)) + 10;
  let recorded = 0;
  let rejected = 0;
  let pages = 0;
  let cursor: string | undefined;
  const result = (status: BackfillResult["status"], errorCode?: string): BackfillResult => {
    const earliest = store.earliestCloseTime(market, MINUTE_MS);
    return Object.freeze({ market, status, recorded, rejected, pages, ...(earliest === undefined ? {} : { earliestCloseMs: earliest }), ...(errorCode === undefined ? {} : { errorCode }) });
  };
  const targetStart = goal + MINUTE_MS;
  const reached = (): boolean => { const earliest = store.earliestCloseTime(market, MINUTE_MS); return earliest !== undefined && earliest <= targetStart; };
  const expectedCandles = (anchor - targetStart) / MINUTE_MS + 1;
  const receiptsComplete = (): boolean => {
    if (store.read == null || store.hasMaterialCoverage == null) return false;
    const candles = store.read(market, MINUTE_MS, targetStart, anchor);
    return candles.length === expectedCandles && candles.every((candle, index) => candle.closeTimeMs === targetStart + index * MINUTE_MS)
      && store.hasMaterialCoverage(market, MINUTE_MS, targetStart, anchor, "UPBIT_PUBLIC_CANDLES", UPBIT_CANDLE_SOURCE_FINGERPRINT);
  };
  if (reached() && receiptsComplete()) return result("COMPLETE");
  while (pages < maxPages) {
    let raw: unknown;
    try {
      raw = await input.fetchPage(market, cursor);
    } catch (error) {
      if (error instanceof BackfillRateLimitedError) return result("RATE_LIMITED", "RATE_LIMITED");
      return result("ERROR", typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "REQUEST_FAILED");
    }
    pages += 1;
    const parsed = parseUpbitMinuteCandles(raw, market);
    rejected += parsed.rejected;
    if (parsed.oldestStartMs === undefined) {
      if (parsed.rejected > 0) return result("ERROR", "MALFORMED_PAGE");
      return receiptsComplete() ? result("COMPLETE") : result("INCOMPLETE", "SOURCE_RECEIPTS_INCOMPLETE");
    }
    try {
      // Existing rows are only re-recorded as material after appendWithMaterial proves their exact content matches the fetched source page.
      const ceiling = store.earliestCloseTime(market, MINUTE_MS) ?? Number.POSITIVE_INFINITY;
      const pageCandles = parsed.candles.filter((candle) => candle.closeTimeMs >= targetStart && candle.closeTimeMs <= anchor);
      const existing = store.read == null || pageCandles.length === 0 ? new Map<number, StoredResearchCandle>() : new Map(store.read(market, MINUTE_MS, pageCandles[0]!.closeTimeMs, pageCandles.at(-1)!.closeTimeMs).map((candle) => [candle.closeTimeMs, candle]));
      const eligible = pageCandles.filter((candle) => {
        const prior = existing.get(candle.closeTimeMs);
        return candle.closeTimeMs < ceiling || (prior != null && prior.open === candle.open && prior.high === candle.high && prior.low === candle.low && prior.close === candle.close && prior.volume === candle.volume);
      });
      if (store.appendWithMaterial == null) {
        const fresh = eligible.filter((candle) => candle.closeTimeMs < ceiling);
        if (fresh.length > 0) recorded += store.append(market, MINUTE_MS, fresh);
      } else {
        let group: StoredResearchCandle[] = [];
        const flush = (): void => { if (group.length > 0) recorded += recordPage(store, market, raw, cursor, new Date(input.nowMs).toISOString(), group, parsed.rejected); group = []; };
        for (const candle of eligible) {
          if (group.length > 0 && candle.closeTimeMs !== group.at(-1)!.closeTimeMs + MINUTE_MS) flush();
          group.push(candle);
        }
        flush();
      }
    } catch (error) {
      return result("ERROR", typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "STORE_FAILED");
    }
    // Give the HTTP loop and PAPER writer-lease heartbeat a turn after each synchronous
    // SQLite page write/receipt check. The default remains a no-op for deterministic tests and
    // non-production callers; production supplies setImmediate below.
    await (input.yieldControl?.() ?? Promise.resolve());
    if (reached() && receiptsComplete()) return result("COMPLETE");
    if (parsed.oldestStartMs <= goal) return result("INCOMPLETE", "SOURCE_RECEIPTS_INCOMPLETE"); // the source reaches the target but some stored candles lack verified receipts
    cursor = iso(parsed.oldestStartMs);
    await input.sleep(delay);
  }
  return result("INCOMPLETE");
}

/** Public, credential-free page fetch with a hard timeout and no redirects. */
export function createUpbitMinuteCandleFetcher(fetchImpl: typeof fetch = fetch): BackfillInput["fetchPage"] {
  return async (market, toIso) => {
    if (!MARKET.test(market)) throw new Error("backfill market is invalid");
    const url = new URL(UPBIT_MINUTE_CANDLES_URL);
    url.searchParams.set("market", market);
    url.searchParams.set("count", String(BACKFILL_PAGE_SIZE));
    if (toIso !== undefined) url.searchParams.set("to", `${toIso}Z`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url.toString(), { method: "GET", redirect: "error", signal: controller.signal });
      if (response.status === 429) throw new BackfillRateLimitedError();
      if (!response.ok) throw Object.assign(new Error(`upstream status ${response.status}`), { code: `UPSTREAM_${response.status}` });
      return await response.json() as unknown;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface GapFillStore extends BackfillStore {
  latestCloseTime(market: string, intervalMs: number): number | undefined;
  read(market: string, intervalMs: number, fromCloseMs: number, toCloseMs: number): readonly StoredResearchCandle[];
}

export interface GapFillResult {
  readonly market: string;
  readonly status: "NO_GAPS" | "FILLED" | "PARTIAL" | "RATE_LIMITED" | "ERROR";
  /** Missing 1m closes inside the window before this run. */
  readonly missing: number;
  readonly recorded: number;
  readonly rejected: number;
  readonly pages: number;
  /** Exclusive upstream `to` cursor for the next bounded pass, when this pass stopped at its page budget. */
  readonly nextCursorStartMs?: number;
  /** True only when the request reached the oldest required source candle; false/absent keeps a failed cursor retryable. */
  readonly historyComplete?: boolean;
  readonly errorCode?: string;
}

/**
 * Fills missing closed 1-minute candles INSIDE the recent stored history (restart and feed gaps the live collector
 * skips and never revisits) from the same public Upbit 1-minute endpoint the history backfill uses. Only minutes
 * that are absent from the store, older than the latest stored close and fully closed are written; keys that
 * exist are never touched, re-checked synchronously at each append, so it cannot conflict with or replace any
 * stored candle or race the live collector. A minute the exchange also has no candle for stays missing.
 */
export async function fillRecentGaps(input: {
  readonly market: string;
  readonly windowMs: number;
  readonly nowMs: number;
  readonly store: GapFillStore;
  readonly fetchPage: BackfillInput["fetchPage"];
  readonly sleep: BackfillInput["sleep"];
  readonly pageDelayMs?: number;
  readonly maxPages?: number;
  /** Resume an earlier bounded pass at an older Upbit page without skipping its newest stored gaps. */
  readonly startBeforeMs?: number;
}): Promise<GapFillResult> {
  const { market, store } = input;
  if (!MARKET.test(market)) throw new Error("gap fill market is invalid");
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) throw new Error("gap fill clock is invalid");
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < MINUTE_MS) throw new Error("gap fill window is invalid");
  const latest = store.latestCloseTime(market, MINUTE_MS);
  const anchor = Math.floor(input.nowMs / MINUTE_MS) * MINUTE_MS;
  if (latest === undefined) return Object.freeze({ market, status: "NO_GAPS", missing: 0, recorded: 0, rejected: 0, pages: 0 });
  // Up to the newest closed minute, not only up to the last stored close: REST candles are the only writer of the series head.
  const top = anchor;
  const bottom = Math.max(top - input.windowMs + MINUTE_MS, store.earliestCloseTime(market, MINUTE_MS) ?? top);
  const present = new Set(store.read(market, MINUTE_MS, bottom, top).map((candle) => candle.closeTimeMs));
  const missingCloses: number[] = [];
  for (let close = top; close >= bottom; close -= MINUTE_MS) if (!present.has(close)) missingCloses.push(close);
  if (missingCloses.length === 0) return Object.freeze({ market, status: "NO_GAPS", missing: 0, recorded: 0, rejected: 0, pages: 0 });
  const oldestMissing = missingCloses[missingCloses.length - 1]!;
  const delay = input.pageDelayMs ?? 150;
  const maxPages = input.maxPages ?? Math.ceil((top - oldestMissing) / (BACKFILL_PAGE_SIZE * MINUTE_MS)) + 2;
  let recorded = 0;
  let rejected = 0;
  let pages = 0;
  // The page ending before `to` holds candles that START before it; start just after the newest missing close.
  const resumeCursor = input.startBeforeMs;
  if (resumeCursor !== undefined && (!Number.isSafeInteger(resumeCursor) || resumeCursor <= 0 || resumeCursor % MINUTE_MS !== 0)) throw new Error("gap fill resume cursor is invalid");
  let cursor: string | undefined = iso(resumeCursor ?? missingCloses[0]!);
  let requestedCursorStartMs = resumeCursor ?? missingCloses[0]!;
  let previousPageOldestStartMs: number | undefined;
  let nextCursorStartMs: number | undefined;
  let historyComplete = false;
  const done = (status: GapFillResult["status"], errorCode?: string): GapFillResult =>
    Object.freeze({ market, status, missing: missingCloses.length, recorded, rejected, pages, ...(nextCursorStartMs === undefined ? {} : { nextCursorStartMs }), ...(historyComplete ? { historyComplete: true } : {}), ...(errorCode === undefined ? {} : { errorCode }) });
  while (pages < maxPages) {
    let raw: unknown;
    try { raw = await input.fetchPage(market, cursor); } catch (error) {
      if (error instanceof BackfillRateLimitedError) return done("RATE_LIMITED", "RATE_LIMITED");
      return done("ERROR", typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "REQUEST_FAILED");
    }
    pages += 1;
    const parsed = parseUpbitMinuteCandles(raw, market);
    rejected += parsed.rejected;
    if (parsed.oldestStartMs === undefined) {
      if (parsed.rejected > 0) return done("ERROR", "MALFORMED_PAGE");
      break;
    }
    // A repeated or newer page cannot advance the bounded scan. Reject it before recording rows so a
    // provider/proxy replay cannot cause an infinite loop or falsely advance the durable cursor.
    if (parsed.oldestStartMs >= requestedCursorStartMs ||
      (previousPageOldestStartMs !== undefined && parsed.oldestStartMs >= previousPageOldestStartMs)) {
      return done("ERROR", "CURSOR_NOT_ADVANCING");
    }
    try {
      const wanted = parsed.candles.filter((candle) => candle.closeTimeMs >= oldestMissing && candle.closeTimeMs <= top);
      if (wanted.length > 0) {
        const lo = wanted[0]!.closeTimeMs;
        const hi = wanted[wanted.length - 1]!.closeTimeMs;
        const existing = new Set(store.read(market, MINUTE_MS, lo, hi).map((candle) => candle.closeTimeMs));
        const fresh = wanted.filter((candle) => !existing.has(candle.closeTimeMs));
        if (fresh.length > 0) recorded += recordPage(store, market, raw, cursor, new Date(input.nowMs).toISOString(), fresh, parsed.rejected);
      }
    } catch (error) {
      return done("ERROR", typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "STORE_FAILED");
    }
    if (parsed.oldestStartMs + MINUTE_MS <= oldestMissing || parsed.oldestStartMs + MINUTE_MS <= bottom) {
      nextCursorStartMs = undefined;
      historyComplete = true;
      break;
    }
    cursor = iso(parsed.oldestStartMs);
    requestedCursorStartMs = parsed.oldestStartMs;
    previousPageOldestStartMs = parsed.oldestStartMs;
    nextCursorStartMs = parsed.oldestStartMs;
    await input.sleep(delay);
  }
  return done(recorded >= missingCloses.length ? "FILLED" : "PARTIAL");
}
