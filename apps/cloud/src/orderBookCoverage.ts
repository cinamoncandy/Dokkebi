import { DatabaseSync } from "node:sqlite";

/**
 * Display only: how complete the order-book history is on the decision hours a pre-registered study needs. The ORDERBOOK study
 * (ML_ORDERBOOK_60M_20261029) ended INSUFFICIENT_DATA because only 115 of 192 training hours had a book (59.9%, rule: >= 90%), and
 * that was found only after the window had closed. This watch counts, with the study's own definition (a stored sample in the
 * 2 minutes up to each full hour), how many of the last 192 hours are covered, so a gap shows up in /health while it can still be
 * repaired. It reads one market's rows read-only, never writes, never fills a gap, and changes no study rule.
 */
export const COVERAGE_WINDOW_HOURS = 192;
export const COVERAGE_REQUIRED_RATIO = 0.9;
const HOUR_MS = 3_600_000;
const BOOK_WINDOW_MS = 120_000;
const REFRESH_MS = HOUR_MS;

export interface OrderBookCoverage {
  readonly schemaVersion: 1;
  readonly market: string;
  readonly windowHours: number;
  readonly coveredHours: number;
  /** coveredHours / windowHours, rounded to 3 decimals. */
  readonly ratio: number;
  /** Longest run of consecutive uncovered hours. */
  readonly longestGapHours: number;
  /** ratio >= the study's 90% bar. Not a verdict: only the coverage condition. */
  readonly meetsStudyBar: boolean;
  readonly asOfMs: number;
}

/** Pure summary of one flag per hour, oldest first. Returns undefined for an empty or non-boolean window (never a guess). */
export function summarizeCoverage(flags: readonly boolean[], market: string, asOfMs: number): OrderBookCoverage | undefined {
  if (flags.length === 0 || !Number.isSafeInteger(asOfMs) || asOfMs <= 0 || flags.some((f) => typeof f !== "boolean")) return undefined;
  let covered = 0, run = 0, longest = 0;
  for (const flag of flags) {
    if (flag) { covered += 1; run = 0; } else { run += 1; longest = Math.max(longest, run); }
  }
  const ratio = Math.round((covered / flags.length) * 1000) / 1000;
  return Object.freeze({ schemaVersion: 1 as const, market, windowHours: flags.length, coveredHours: covered, ratio, longestGapHours: longest, meetsStudyBar: ratio >= COVERAGE_REQUIRED_RATIO, asOfMs });
}

export interface OrderBookCoverageUnavailable {
  readonly schemaVersion: 1;
  readonly status: "UNAVAILABLE";
  /** A fixed upper-case code (never the raw error text, path or market). */
  readonly reason: string;
  readonly asOfMs: number;
}

function failureCode(stage: "OPEN" | "QUERY", error: unknown): string {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return Number.isSafeInteger(code) && (code as number) >= 0 && (code as number) < 100_000 ? `${stage}_FAILED_SQLITE_${code as number}` : `${stage}_FAILED`;
}

/** The last `hours` full hours ending at the latest full hour at or before `nowMs`, each as a book-at-t check. Read-only; one indexed lookup per hour. A failure is returned as a fixed code, never guessed away. */
export function readOrderBookCoverageDetailed(stateDbPath: string, market: string, nowMs: number, hours: number = COVERAGE_WINDOW_HOURS): OrderBookCoverage | OrderBookCoverageUnavailable {
  const lastHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const unavailable = (reason: string): OrderBookCoverageUnavailable => Object.freeze({ schemaVersion: 1 as const, status: "UNAVAILABLE" as const, reason, asOfMs: lastHour });
  if (!/^KRW-[A-Z0-9-]+$/.test(market) || !Number.isSafeInteger(hours) || hours <= 0 || hours > 24 * 60) return unavailable("INVALID_INPUT");
  let database: DatabaseSync | undefined;
  let stage: "OPEN" | "QUERY" = "OPEN";
  try {
    database = new DatabaseSync(stateDbPath, { readOnly: true });
    stage = "QUERY";
    const lookup = database.prepare("SELECT 1 AS present FROM research_orderbook_samples WHERE market = ? AND captured_at_ms > ? AND captured_at_ms <= ? LIMIT 1");
    const flags: boolean[] = [];
    for (let i = hours - 1; i >= 0; i -= 1) {
      const t = lastHour - i * HOUR_MS;
      flags.push(lookup.get(market, t - BOOK_WINDOW_MS, t) !== undefined);
    }
    return summarizeCoverage(flags, market, lastHour) ?? unavailable("SUMMARY_REJECTED");
  } catch (error) { return unavailable(failureCode(stage, error)); } finally { try { database?.close(); } catch { /* display only */ } }
}

/** Compatibility wrapper: the coverage, or undefined when it cannot be read. */
export function readOrderBookCoverage(stateDbPath: string, market: string, nowMs: number, hours: number = COVERAGE_WINDOW_HOURS): OrderBookCoverage | undefined {
  const result = readOrderBookCoverageDetailed(stateDbPath, market, nowMs, hours);
  return "status" in result ? undefined : result;
}

/** Caches the coverage for an hour so /health never scans the database per request. Never throws. */
export class OrderBookCoverageWatch {
  private cached: OrderBookCoverage | OrderBookCoverageUnavailable | undefined;
  private refreshedAt = 0;
  public constructor(private readonly stateDbPath: string, private readonly market: string, private readonly now: () => number = Date.now) {}

  public snapshot(): OrderBookCoverage | OrderBookCoverageUnavailable | undefined {
    const now = this.now();
    if (this.refreshedAt === 0 || now - this.refreshedAt >= REFRESH_MS) {
      this.refreshedAt = now;
      this.cached = readOrderBookCoverageDetailed(this.stateDbPath, this.market, now);
    }
    return this.cached;
  }
}
