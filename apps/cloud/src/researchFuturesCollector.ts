import type { FuturesFundingRow, FuturesKlineRow, FuturesMarkRow } from "../../../packages/storage/src/futuresPublicStore";

/**
 * Research-only collector of PUBLIC Binance USD-M futures data for BTCUSDT and ETHUSDT (WO-FUTURES-20261014-BINANCE-PUBLIC-PROBE;
 * owner decision 2026-10-15). Once a minute: mark price / index / last funding rate. Hourly: funding history and CLOSED 4h klines.
 * No key, account, order or position endpoint is ever called; nothing here feeds PAPER, Risk, Governance or qualification.
 * The design (B4 research -> B5 shadow -> PAPER) means no futures trade can come from this data without a qualified strategy.
 * Every failure is caught and counted, rounds never overlap, and NUSA_RESEARCH_FUTURES_COLLECTOR=DISABLED turns it off.
 */
export interface FuturesRoundSink {
  readonly appendMarks: (rows: readonly FuturesMarkRow[]) => { readonly stored: number; readonly rejected: number };
  readonly appendFunding: (rows: readonly FuturesFundingRow[]) => { readonly stored: number; readonly rejected: number };
  readonly appendKlines: (rows: readonly FuturesKlineRow[]) => { readonly stored: number; readonly rejected: number };
  readonly pruneMarksBefore: (cutoffMs: number) => number;
}

export interface ResearchFuturesCollectorStatus {
  readonly rounds: number;
  readonly marksStored: number;
  readonly fundingStored: number;
  readonly klinesStored: number;
  readonly failures: number;
  readonly rejected: number;
  readonly lastRoundAt?: number;
  /** Fixed code of the most recent failed fetch (for example HTTP_451 for a region block). Never the message. */
  readonly lastFailureClass?: string;
}

export const FUTURES_COLLECTOR_INTERVAL_MS = 60_000;
export const FUTURES_SLOW_EVERY_MS = 3_600_000;
export const FUTURES_MAX_FUTURE_MS = 5_000;
export const FUTURES_MARK_RETENTION_MS = 30 * 24 * 3_600_000;
export const FUTURES_SYMBOLS: readonly string[] = Object.freeze(["BTCUSDT", "ETHUSDT"]);
const BASE = "https://fapi.binance.com";

export function researchFuturesCollectorEnabled(env: NodeJS.ProcessEnv): boolean {
  // Fail-safe: any common "off" spelling disables it (the reviewer found that "disabled" or "0" silently kept it running).
  return !["DISABLED", "0", "FALSE", "OFF", "NO"].includes(String(env.NUSA_RESEARCH_FUTURES_COLLECTOR ?? "").trim().toUpperCase());
}

/** Maps a fetch failure to a fixed code. Only the HTTP status, a timeout or a coarse class leaves this function, never the message. */
export function futuresFailureClass(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^HTTP_[1-5][0-9]{2}$/.test(message)) return message;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "TIMEOUT";
  if (message === "FUNDING_INVALID" || message === "KLINES_INVALID") return "INVALID_RESPONSE";
  return "FETCH_FAILED";
}

const num = (v: unknown): number => (typeof v === "string" || typeof v === "number") && String(v).trim() !== "" ? Number(v) : Number.NaN;

export class ResearchFuturesCollector {
  private rounds = 0; private marksStored = 0; private fundingStored = 0; private klinesStored = 0; private failures = 0; private rejected = 0;
  private lastRoundAt: number | undefined;
  private lastFailureClass: string | undefined;
  private lastSlowAt = 0;
  private lastPruneAt = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly sink: FuturesRoundSink, private readonly options: { readonly fetchImpl?: typeof fetch; readonly now?: () => number } = {}) {}

  private get now(): number { return (this.options.now ?? Date.now)(); }

  private async getJson(path: string): Promise<unknown> {
    const response = await (this.options.fetchImpl ?? fetch)(`${BASE}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  }

  private async collectMarks(roundNow: number): Promise<void> {
    const rows: FuturesMarkRow[] = [];
    for (const symbol of FUTURES_SYMBOLS) {
      try {
        const d = await this.getJson(`/fapi/v1/premiumIndex?symbol=${symbol}`) as Record<string, unknown>;
        // Integrity: the response must name the requested symbol and its exchange time must not be in the future; rows are
        // stamped with the local observation time.
        if (d == null || d.symbol !== symbol || !Number.isSafeInteger(d.time) || Number(d.time) <= 0 || Number(d.time) > roundNow + FUTURES_MAX_FUTURE_MS) { this.rejected += 1; continue; }
        rows.push({ symbol, capturedAtMs: roundNow, markPrice: num(d.markPrice), indexPrice: num(d.indexPrice), lastFundingRate: num(d.lastFundingRate), nextFundingTimeMs: Number(d.nextFundingTime) });
      } catch (error) { this.failures += 1; this.lastFailureClass = futuresFailureClass(error); }
    }
    const result = this.sink.appendMarks(rows);
    this.marksStored += result.stored; this.rejected += result.rejected;
  }

  /** Returns true when at least one fetch succeeded, so a fully blocked round (451/5xx) is retried next minute instead of in an hour. */
  private async collectSlow(roundNow: number): Promise<boolean> {
    let ok = false;
    for (const symbol of FUTURES_SYMBOLS) {
      try {
        const f = await this.getJson(`/fapi/v1/fundingRate?symbol=${symbol}&limit=100`);
        if (!Array.isArray(f)) throw new Error("FUNDING_INVALID");
        const funding: FuturesFundingRow[] = [];
        for (const r of f as Record<string, unknown>[]) {
          if (r?.symbol !== symbol || !Number.isSafeInteger(r.fundingTime) || Number(r.fundingTime) > roundNow + FUTURES_MAX_FUTURE_MS) { this.rejected += 1; continue; }
          funding.push({ symbol, fundingTimeMs: Number(r.fundingTime), fundingRate: num(r.fundingRate) });
        }
        const fr = this.sink.appendFunding(funding);
        ok = true;
        this.fundingStored += fr.stored; this.rejected += fr.rejected;
      } catch (error) { this.failures += 1; this.lastFailureClass = futuresFailureClass(error); }
      try {
        const k = await this.getJson(`/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=100`);
        if (!Array.isArray(k)) throw new Error("KLINES_INVALID");
        const klines: FuturesKlineRow[] = [];
        for (const r of k as unknown[][]) {
          // Only CLOSED candles: the still-forming candle (close time not yet passed) is never stored.
          if (!Array.isArray(r) || r.length < 7 || !Number.isSafeInteger(r[0]) || !Number.isSafeInteger(r[6])) { this.rejected += 1; continue; }
          if (Number(r[6]) >= roundNow) continue;
          klines.push({ symbol, interval: "4h", openTimeMs: Number(r[0]), closeTimeMs: Number(r[6]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]) });
        }
        const kr = this.sink.appendKlines(klines);
        ok = true;
        this.klinesStored += kr.stored; this.rejected += kr.rejected;
      } catch (error) { this.failures += 1; this.lastFailureClass = futuresFailureClass(error); }
    }
    return ok;
  }

  /** One collection round; never throws. Counters are exposed through status(). */
  public async collectOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const roundNow = this.now;
      await this.collectMarks(roundNow);
      if (roundNow - this.lastSlowAt >= FUTURES_SLOW_EVERY_MS && await this.collectSlow(roundNow)) this.lastSlowAt = roundNow;
      if (roundNow - this.lastPruneAt >= FUTURES_SLOW_EVERY_MS) {
        try { this.sink.pruneMarksBefore(roundNow - FUTURES_MARK_RETENTION_MS); this.lastPruneAt = roundNow; } catch { this.failures += 1; }
      }
      this.rounds += 1;
      this.lastRoundAt = this.now;
    } catch { this.failures += 1; } finally { this.running = false; }
  }

  public start(): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => { void this.collectOnce(); }, FUTURES_COLLECTOR_INTERVAL_MS);
    this.timer.unref?.();
  }
  public stop(): void { if (this.timer != null) clearInterval(this.timer); this.timer = undefined; }

  public status(): ResearchFuturesCollectorStatus {
    return Object.freeze({ rounds: this.rounds, marksStored: this.marksStored, fundingStored: this.fundingStored, klinesStored: this.klinesStored, failures: this.failures, rejected: this.rejected, ...(this.lastRoundAt === undefined ? {} : { lastRoundAt: this.lastRoundAt }), ...(this.lastFailureClass === undefined ? {} : { lastFailureClass: this.lastFailureClass }) });
  }
}
