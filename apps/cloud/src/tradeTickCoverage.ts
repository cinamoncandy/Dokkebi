import { DatabaseSync } from "node:sqlite";

/**
 * Display only: how many of the last 192 full hours have at least one stored trade tick for one market. A trade-flow study is only
 * a draft (docs/DRAFT_TRADEFLOW_STUDY_DESIGN_20261112.md); its data bar is NOT fixed yet, so this publishes no bar and no verdict,
 * only counts. It reads one market's rows read-only, never writes, never fills a gap, and changes no study rule, threshold or gate.
 * Same shape as orderBookCoverage without `meetsStudyBar`.
 */
export const TRADE_COVERAGE_WINDOW_HOURS = 192;
const HOUR_MS = 3_600_000;
const REFRESH_MS = HOUR_MS;

export interface TradeTickCoverage {
  readonly schemaVersion: 1;
  readonly windowHours: number;
  readonly coveredHours: number;
  /** coveredHours / windowHours, rounded to 3 decimals. */
  readonly ratio: number;
  /** Longest run of consecutive hours without a stored tick. */
  readonly longestGapHours: number;
  readonly asOfMs: number;
}

export interface TradeTickCoverageUnavailable {
  readonly schemaVersion: 1;
  readonly status: "UNAVAILABLE";
  /** A fixed upper-case code (never the raw error text, path or market). */
  readonly reason: string;
  readonly asOfMs: number;
}

/** Pure summary of one flag per hour, oldest first. Undefined for an empty or non-boolean window (never a guess). */
export function summarizeTradeCoverage(flags: readonly boolean[], asOfMs: number): TradeTickCoverage | undefined {
  if (flags.length === 0 || !Number.isSafeInteger(asOfMs) || asOfMs <= 0 || flags.some((f) => typeof f !== "boolean")) return undefined;
  let covered = 0, run = 0, longest = 0;
  for (const flag of flags) {
    if (flag) { covered += 1; run = 0; } else { run += 1; longest = Math.max(longest, run); }
  }
  const ratio = Math.round((covered / flags.length) * 1000) / 1000;
  return Object.freeze({ schemaVersion: 1 as const, windowHours: flags.length, coveredHours: covered, ratio, longestGapHours: longest, asOfMs });
}

function failureCode(stage: "OPEN" | "QUERY", error: unknown): string {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return Number.isSafeInteger(code) && (code as number) >= 0 && (code as number) < 100_000 ? `${stage}_FAILED_SQLITE_${code as number}` : `${stage}_FAILED`;
}

/** The last `hours` full hours ending at the latest full hour at or before `nowMs`; an hour (t-1h, t] is covered when one tick sits in it. Read-only; one indexed lookup per hour. */
export function readTradeTickCoverageDetailed(stateDbPath: string, market: string, nowMs: number, hours: number = TRADE_COVERAGE_WINDOW_HOURS): TradeTickCoverage | TradeTickCoverageUnavailable {
  const lastHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const unavailable = (reason: string): TradeTickCoverageUnavailable => Object.freeze({ schemaVersion: 1 as const, status: "UNAVAILABLE" as const, reason, asOfMs: lastHour });
  if (!/^KRW-[A-Z0-9-]+$/.test(market) || !Number.isSafeInteger(hours) || hours <= 0 || hours > 24 * 60 || !Number.isSafeInteger(lastHour) || lastHour <= 0) return unavailable("INVALID_INPUT");
  let database: DatabaseSync | undefined;
  let stage: "OPEN" | "QUERY" = "OPEN";
  try {
    database = new DatabaseSync(stateDbPath, { readOnly: true });
    stage = "QUERY";
    const lookup = database.prepare("SELECT 1 AS present FROM research_trade_ticks_v2 WHERE market = ? AND traded_at_ms > ? AND traded_at_ms <= ? LIMIT 1");
    const flags: boolean[] = [];
    for (let i = hours - 1; i >= 0; i -= 1) {
      const t = lastHour - i * HOUR_MS;
      flags.push(lookup.get(market, t - HOUR_MS, t) !== undefined);
    }
    return summarizeTradeCoverage(flags, lastHour) ?? unavailable("SUMMARY_REJECTED");
  } catch (error) { return unavailable(failureCode(stage, error)); } finally { try { database?.close(); } catch { /* display only */ } }
}

/** Caches the coverage for an hour so /health never scans the database per request. Never throws. */
export class TradeTickCoverageWatch {
  private cached: TradeTickCoverage | TradeTickCoverageUnavailable | undefined;
  private refreshedAt = 0;
  public constructor(private readonly stateDbPath: string, private readonly market: string, private readonly now: () => number = Date.now) {}

  public snapshot(): TradeTickCoverage | TradeTickCoverageUnavailable | undefined {
    const now = this.now();
    if (this.refreshedAt === 0 || now - this.refreshedAt >= REFRESH_MS) {
      this.refreshedAt = now;
      this.cached = readTradeTickCoverageDetailed(this.stateDbPath, this.market, now);
    }
    return this.cached;
  }
}
