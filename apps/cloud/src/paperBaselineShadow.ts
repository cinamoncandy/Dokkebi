import type { PaperCandidateStrategySpec } from "../../../packages/contracts/src/paperCandidateExecutionBinding";
import { evaluatePaperCandidateStrategy } from "./paperCandidateStrategy";

/**
 * Uncensored shadow of the owner baseline rule (SMA 5/20 on completed minute closes). It follows the SAME completed-minute bars the
 * PAPER strategy reads and applies the baseline's own BUY/SELL rule to a hypothetical single position, whether or not Risk would have
 * let a real order through. So when the consecutive-loss halt blocks every BUY, the shadow still produces the round trips the rule
 * would have made, with fees, and the PAPER ledger (which a halt censors) is not the only source of evidence.
 *
 * It is display and analysis only: it places no order, writes no ledger, creates no fill, and feeds no Risk, Governance or
 * Research decision. Its totals are NOT PAPER evidence and must never be promoted as such.
 * Persisted state is the totals and the last processed minute per market; an open hypothetical position is NOT persisted, so a
 * restart drops it (the shadow is then flat and re-enters on the next bar the rule says BUY).
 */
export interface BaselineShadowTotals {
  /** Time the shadow started counting (first accepted bar of the first run, kept across restarts). */
  readonly since: number;
  /** Completed hypothetical round trips. */
  readonly trades: number;
  /** Round trips whose return after fees was positive. */
  readonly wins: number;
  /** Sum, in basis points, of the positive gross (before fee) returns. */
  readonly grossGainBp: number;
  /** Sum, in basis points, of the magnitudes of the negative gross returns. */
  readonly grossLossBp: number;
  /** Sum, in basis points, of the fee drag over all round trips. */
  readonly feeBp: number;
}

export interface BaselineShadowPersisted {
  readonly schemaVersion: 1;
  readonly totals: BaselineShadowTotals;
  /** Last processed completed minute (floor(timestamp / 60 000)) per market. */
  readonly lastBarMinute: Readonly<Record<string, number>>;
}

export interface PaperBaselineShadowOptions {
  readonly spec: PaperCandidateStrategySpec;
  readonly feeRate: number;
  readonly now: () => number;
  readonly restore?: BaselineShadowPersisted;
  /** Read-only notification of each completed hypothetical round trip (market and entry/exit minute only). A throwing listener is ignored. */
  readonly onRoundTrip?: (trip: { readonly market: string; readonly entryMinute: number; readonly exitMinute: number }) => void;
}

const MARKET = /^KRW-[A-Z0-9]{1,15}$/;
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function decodeBaselineShadow(value: unknown): BaselineShadowPersisted | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const totals = raw.totals as Record<string, unknown> | null | undefined;
  if (raw.schemaVersion !== 1 || totals == null || typeof totals !== "object" || raw.lastBarMinute == null || typeof raw.lastBarMinute !== "object" || Array.isArray(raw.lastBarMinute)) return undefined;
  const keys = ["since", "trades", "wins", "grossGainBp", "grossLossBp", "feeBp"] as const;
  if (!keys.every((key) => nonNegativeInteger(totals[key])) || Number(totals.wins) > Number(totals.trades)) return undefined;
  // Relational consistency: only states the shadow itself can produce are restored.
  const empty = Number(totals.trades) === 0;
  if (empty && (Number(totals.wins) !== 0 || Number(totals.grossGainBp) !== 0 || Number(totals.grossLossBp) !== 0 || Number(totals.feeBp) !== 0)) return undefined;
  const lastBarMinute: Record<string, number> = {};
  for (const [market, minute] of Object.entries(raw.lastBarMinute as Record<string, unknown>)) {
    if (!MARKET.test(market) || !nonNegativeInteger(minute)) return undefined;
    lastBarMinute[market] = minute;
  }
  const started = Object.keys(lastBarMinute).length > 0;
  if ((Number(totals.since) === 0) === started) return undefined; // since is set exactly when a bar was processed
  return Object.freeze({
    schemaVersion: 1 as const,
    totals: Object.freeze({ since: Number(totals.since), trades: Number(totals.trades), wins: Number(totals.wins), grossGainBp: Number(totals.grossGainBp), grossLossBp: Number(totals.grossLossBp), feeBp: Number(totals.feeBp) }),
    lastBarMinute: Object.freeze(lastBarMinute),
  });
}

export class PaperBaselineShadow {
  private totals: { since: number; trades: number; wins: number; grossGainBp: number; grossLossBp: number; feeBp: number };
  private readonly lastBarMinute = new Map<string, number>();
  private readonly entry = new Map<string, number>();
  private readonly entryMinute = new Map<string, number>();
  private changed = false;

  public constructor(private readonly options: PaperBaselineShadowOptions) {
    if (!Number.isFinite(options.feeRate) || options.feeRate < 0 || options.feeRate >= 0.1) throw new Error("shadow fee rate is invalid");
    const restored = options.restore;
    this.totals = restored == null
      ? { since: 0, trades: 0, wins: 0, grossGainBp: 0, grossLossBp: 0, feeBp: 0 }
      : { ...restored.totals };
    if (restored != null) for (const [market, minute] of Object.entries(restored.lastBarMinute)) this.lastBarMinute.set(market, minute);
  }

  /** Feeds the completed minute closes the strategy just read. Idempotent per bar; never throws; never touches execution. */
  public observe(market: string, bars: readonly (readonly [number, number])[]): void {
    try {
      const key = market.trim().toUpperCase();
      if (!MARKET.test(key)) return;
      const valid = bars.filter((bar) => Number.isSafeInteger(bar[0]) && bar[0] > 0 && Number.isFinite(bar[1]) && bar[1] > 0);
      // Bars are deduplicated by their completed-minute bucket, not by the closing tick's timestamp: a late ticker that revises the
      // close of an already completed minute must not be evaluated as a new bar.
      let processed = this.lastBarMinute.get(key) ?? -1;
      for (let index = 0; index < valid.length; index += 1) {
        const [at, close] = valid[index]!;
        const minute = Math.floor(at / 60_000);
        if (minute <= processed) continue;
        if (index > 0 && minute <= Math.floor(valid[index - 1]![0] / 60_000)) continue; // minutes must be strictly ascending
        processed = minute;
        this.lastBarMinute.set(key, minute);
        this.changed = true;
        if (this.totals.since === 0) this.totals.since = Math.max(1, this.options.now());
        const decision = evaluatePaperCandidateStrategy(this.options.spec, [], at, key, valid.slice(0, index + 1));
        const open = this.entry.get(key);
        if (open === undefined && decision.action === "BUY") { this.entry.set(key, close); this.entryMinute.set(key, minute); }
        else if (open !== undefined && decision.action === "SELL") {
          const entryMinute = this.entryMinute.get(key);
          this.entry.delete(key);
          this.entryMinute.delete(key);
          this.settle(open, close);
          if (entryMinute !== undefined) { try { this.options.onRoundTrip?.({ market: key, entryMinute, exitMinute: minute }); } catch { /* display-only listener */ } }
        }
      }
    } catch { /* the shadow must never affect the runtime */ }
  }

  private settle(entry: number, exit: number): void {
    const fee = this.options.feeRate;
    const grossBp = Math.round((exit / entry - 1) * 10_000);
    const netReturn = (exit * (1 - fee)) / (entry * (1 + fee)) - 1;
    const netBp = Math.round(netReturn * 10_000);
    this.totals.trades += 1;
    // A win is any positive after-fee return, decided before rounding (a 0.3 bp winner must not be counted as a loss).
    if (netReturn > 0) this.totals.wins += 1;
    if (grossBp > 0) this.totals.grossGainBp += grossBp; else this.totals.grossLossBp += -grossBp;
    this.totals.feeBp += Math.max(0, grossBp - netBp);
  }

  public summary(): BaselineShadowTotals {
    return Object.freeze({ ...this.totals });
  }

  /** Persisted copy, or undefined when nothing changed since the last call (so a caller writes only on change). */
  public takePersistable(): BaselineShadowPersisted | undefined {
    if (!this.changed) return undefined;
    this.changed = false;
    return Object.freeze({ schemaVersion: 1 as const, totals: this.summary(), lastBarMinute: Object.freeze(Object.fromEntries(this.lastBarMinute)) });
  }

  /** Puts the change flag back when the caller could not write, so the next tick retries. */
  public markUnpersisted(): void {
    this.changed = true;
  }
}
