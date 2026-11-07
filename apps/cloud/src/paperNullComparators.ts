import type { BaselineShadowTotals } from "./paperBaselineShadow";

/**
 * Null comparators for the baseline shadow: what two rules with NO signal would have earned on the SAME completed minute bars and
 * the SAME fee model, so that "edge" is a difference that can be measured instead of a number read alone.
 *
 *  1. Buy-and-hold: one hypothetical position per market, bought at the first bar the comparator saw and marked at the latest bar.
 *  2. Random entry: for every round trip the baseline shadow completes, one random round trip on the same market with the same
 *     holding time (in minutes), entered at a minute drawn from a fixed-seed PRNG among the bars already seen. Same number of round
 *     trips and same holding rule, so the comparison is fair; only the entry timing carries no information.
 *
 * Display and analysis only: it places no order, writes no ledger, creates no fill, is not PAPER evidence, is not promotable, and
 * feeds no Risk, Governance or Research decision. Persisted state is small counters and, per market, the first and latest bar.
 */
export const NULL_COMPARATOR_SEED = 20_261_030;
/** Closes kept per market to draw random entries from (3 days of minutes). Not persisted: a restart refills it from new bars. */
export const NULL_COMPARATOR_BUFFER_MINUTES = 4_320;

const MINUTE_MS = 60_000;
const MARKET = /^KRW-[A-Z0-9]{1,15}$/;
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const signedInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(Number(value)) <= 1e12;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** The one round-trip formula (identical to the baseline shadow's): fee charged on both legs, rounded to whole basis points. */
export function roundTripNet(entry: number, exit: number, feeRate: number): { readonly grossBp: number; readonly netBp: number; readonly netReturn: number } {
  const grossBp = Math.round((exit / entry - 1) * 10_000);
  const netReturn = (exit * (1 - feeRate)) / (entry * (1 + feeRate)) - 1;
  return { grossBp, netBp: Math.round(netReturn * 10_000), netReturn };
}

/** Counter-based mulberry32: draw number `n` (1, 2, ...) of the stream for `seed`, in [0, 1). A restart resumes from the draw count alone. */
export function seededUnit(seed: number, n: number): number {
  let t = ((seed >>> 0) + Math.imul(n, 0x6d2b79f5)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}

export interface NullHoldPosition {
  readonly firstMinute: number;
  readonly firstClose: number;
  readonly lastMinute: number;
  readonly lastClose: number;
}

export interface NullComparatorPersisted {
  readonly schemaVersion: 1;
  readonly seed: number;
  /** Time the comparators started counting (first accepted bar). */
  readonly since: number;
  /** The baseline shadow's totals at that moment, so the comparison covers the same window even when the baseline counted earlier. */
  readonly origin: { readonly trades: number; readonly netBp: number };
  readonly hold: Readonly<Record<string, NullHoldPosition>>;
  readonly random: { readonly trades: number; readonly wins: number; readonly netBp: number; readonly skipped: number; readonly draws: number };
}

/** Measured values for the app. Every field that cannot be measured is absent, never zero. */
export interface NullComparatorSummary {
  readonly since: number;
  readonly seed: number;
  /** Baseline shadow round trips and net result since the comparators started (absent when the baseline totals are not comparable). */
  readonly baselineTrades?: number;
  readonly baselineNetBp?: number;
  /** Buy-and-hold: markets with a measurable span and the sum of their net results. */
  readonly holdMarkets?: number;
  readonly holdNetBp?: number;
  /** Random entry: completed round trips, winners, net result sum, and trips skipped for lack of history. */
  readonly randomTrades: number;
  readonly randomWins: number;
  readonly randomNetBp: number;
  readonly randomSkipped: number;
}

export interface BaselineRoundTrip {
  readonly market: string;
  readonly entryMinute: number;
  readonly exitMinute: number;
}

export interface PaperNullComparatorsOptions {
  readonly feeRate: number;
  readonly now: () => number;
  /** Read-only view of the baseline shadow's totals (the one whose round trips are matched). */
  readonly baselineTotals: () => BaselineShadowTotals | undefined;
  readonly restore?: NullComparatorPersisted;
}

export function baselineNetBp(totals: Pick<BaselineShadowTotals, "grossGainBp" | "grossLossBp" | "feeBp">): number {
  return totals.grossGainBp - totals.grossLossBp - totals.feeBp;
}

export function decodeNullComparators(value: unknown): NullComparatorPersisted | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const origin = raw.origin as Record<string, unknown> | null | undefined;
  const random = raw.random as Record<string, unknown> | null | undefined;
  const hold = raw.hold as Record<string, unknown> | null | undefined;
  if (raw.schemaVersion !== 1 || raw.seed !== NULL_COMPARATOR_SEED || !nonNegativeInteger(raw.since) || raw.since === 0) return undefined;
  if (origin == null || typeof origin !== "object" || !nonNegativeInteger(origin.trades) || !signedInteger(origin.netBp)) return undefined;
  if (random == null || typeof random !== "object" || !(["trades", "wins", "skipped", "draws"] as const).every((key) => nonNegativeInteger(random[key])) || !signedInteger(random.netBp)) return undefined;
  if (Number(random.wins) > Number(random.trades) || Number(random.draws) !== Number(random.trades)) return undefined;
  if (hold == null || typeof hold !== "object" || Array.isArray(hold)) return undefined;
  const positions: Record<string, NullHoldPosition> = {};
  for (const [market, entry] of Object.entries(hold)) {
    const position = entry as Record<string, unknown> | null;
    if (!MARKET.test(market) || position == null || typeof position !== "object") return undefined;
    if (!nonNegativeInteger(position.firstMinute) || !nonNegativeInteger(position.lastMinute) || Number(position.lastMinute) < Number(position.firstMinute) || !positive(position.firstClose) || !positive(position.lastClose)) return undefined;
    positions[market] = Object.freeze({ firstMinute: Number(position.firstMinute), firstClose: Number(position.firstClose), lastMinute: Number(position.lastMinute), lastClose: Number(position.lastClose) });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    seed: NULL_COMPARATOR_SEED,
    since: Number(raw.since),
    origin: Object.freeze({ trades: Number(origin.trades), netBp: Number(origin.netBp) }),
    hold: Object.freeze(positions),
    random: Object.freeze({ trades: Number(random.trades), wins: Number(random.wins), netBp: Number(random.netBp), skipped: Number(random.skipped), draws: Number(random.draws) }),
  });
}

export class PaperNullComparators {
  private since = 0;
  private origin = { trades: 0, netBp: 0 };
  private readonly hold = new Map<string, NullHoldPosition>();
  private random = { trades: 0, wins: 0, netBp: 0, skipped: 0, draws: 0 };
  private readonly buffers = new Map<string, Array<readonly [number, number]>>();
  private changed = false;

  public constructor(private readonly options: PaperNullComparatorsOptions) {
    if (!Number.isFinite(options.feeRate) || options.feeRate < 0 || options.feeRate >= 0.1) throw new Error("null comparator fee rate is invalid");
    const restored = options.restore;
    if (restored != null) {
      this.since = restored.since;
      this.origin = { ...restored.origin };
      this.random = { ...restored.random };
      for (const [market, position] of Object.entries(restored.hold)) this.hold.set(market, position);
    }
  }

  /** Feeds the completed minute closes the strategy just read (call BEFORE the baseline shadow sees the same bars). Never throws. */
  public observe(market: string, bars: readonly (readonly [number, number])[]): void {
    try {
      const key = market.trim().toUpperCase();
      if (!MARKET.test(key)) return;
      let processed = this.hold.get(key)?.lastMinute ?? -1;
      let previous = -1;
      for (const [at, close] of bars) {
        if (!Number.isSafeInteger(at) || at <= 0 || !positive(close)) continue;
        const minute = Math.floor(at / MINUTE_MS);
        if (minute <= previous) continue; // minutes must be strictly ascending, as in the baseline shadow
        previous = minute;
        if (minute <= processed) continue;
        processed = minute;
        if (this.since === 0) {
          this.since = Math.max(1, this.options.now());
          const totals = this.options.baselineTotals();
          this.origin = totals == null ? { trades: 0, netBp: 0 } : { trades: totals.trades, netBp: baselineNetBp(totals) };
        }
        const first = this.hold.get(key);
        this.hold.set(key, first == null ? { firstMinute: minute, firstClose: close, lastMinute: minute, lastClose: close } : { ...first, lastMinute: minute, lastClose: close });
        const buffer = this.buffers.get(key) ?? [];
        buffer.push([minute, close]);
        if (buffer.length > NULL_COMPARATOR_BUFFER_MINUTES) buffer.splice(0, buffer.length - NULL_COMPARATOR_BUFFER_MINUTES);
        this.buffers.set(key, buffer);
        this.changed = true;
      }
    } catch { /* the comparators must never affect the runtime */ }
  }

  /** Called by the baseline shadow for each completed round trip: draws one random round trip with the same holding time. */
  public onBaselineRoundTrip(trip: BaselineRoundTrip): void {
    try {
      const buffer = this.buffers.get(trip.market);
      const holdMinutes = trip.exitMinute - trip.entryMinute;
      if (this.since === 0 || buffer == null || !Number.isSafeInteger(holdMinutes) || holdMinutes < 1) return;
      // Only bars up to the baseline trade's exit: the draw uses nothing the baseline had not yet seen.
      let last = buffer.length - 1;
      while (last >= 0 && buffer[last]![0] > trip.exitMinute) last -= 1;
      const candidates: Array<readonly [number, number]> = [];
      let exit = 0;
      for (let entry = 0; entry <= last; entry += 1) {
        const target = buffer[entry]![0] + holdMinutes;
        if (exit < entry) exit = entry;
        while (exit <= last && buffer[exit]![0] < target) exit += 1;
        if (exit > last) break;
        candidates.push([entry, exit]);
      }
      this.changed = true;
      if (candidates.length === 0) { this.random.skipped += 1; return; }
      this.random.draws += 1;
      const picked = candidates[Math.min(candidates.length - 1, Math.floor(seededUnit(NULL_COMPARATOR_SEED, this.random.draws) * candidates.length))]!;
      const result = roundTripNet(buffer[picked[0]]![1], buffer[picked[1]]![1], this.options.feeRate);
      this.random.trades += 1;
      if (result.netReturn > 0) this.random.wins += 1;
      this.random.netBp += result.netBp;
    } catch { /* the comparators must never affect the runtime */ }
  }

  /** Undefined until a bar was seen. Fields that cannot be compared on the same window are left out. */
  public summary(): NullComparatorSummary | undefined {
    if (this.since === 0) return undefined;
    let holdMarkets = 0;
    let holdNetBp = 0;
    for (const position of this.hold.values()) {
      if (position.lastMinute <= position.firstMinute) continue;
      holdMarkets += 1;
      holdNetBp += roundTripNet(position.firstClose, position.lastClose, this.options.feeRate).netBp;
    }
    const base = this.options.baselineTotals();
    const comparable = base != null && base.trades >= this.origin.trades;
    return Object.freeze({
      since: this.since,
      seed: NULL_COMPARATOR_SEED,
      ...(comparable ? { baselineTrades: base.trades - this.origin.trades, baselineNetBp: baselineNetBp(base) - this.origin.netBp } : {}),
      ...(holdMarkets > 0 ? { holdMarkets, holdNetBp } : {}),
      randomTrades: this.random.trades,
      randomWins: this.random.wins,
      randomNetBp: this.random.netBp,
      randomSkipped: this.random.skipped,
    });
  }

  public takePersistable(): NullComparatorPersisted | undefined {
    if (!this.changed || this.since === 0) return undefined;
    this.changed = false;
    return Object.freeze({
      schemaVersion: 1 as const,
      seed: NULL_COMPARATOR_SEED,
      since: this.since,
      origin: Object.freeze({ ...this.origin }),
      hold: Object.freeze(Object.fromEntries(this.hold)),
      random: Object.freeze({ ...this.random }),
    });
  }

  public markUnpersisted(): void {
    this.changed = true;
  }
}
