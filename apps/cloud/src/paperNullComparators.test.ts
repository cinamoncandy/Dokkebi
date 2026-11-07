import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperBaselineShadow } from "./paperBaselineShadow";
import { NULL_COMPARATOR_SEED, PaperNullComparators, baselineNetBp, decodeNullComparators, roundTripNet, seededUnit } from "./paperNullComparators";
import { nullComparatorsRecordPath, readNullComparatorsRecord, writeNullComparatorsRecord } from "./paperNullComparatorsRecord";
import { ownerBaselineStrategySpec } from "./ownerBaselinePaperStrategy";

const spec = ownerBaselineStrategySpec("a".repeat(40));
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 8, 0, 0, 0);
const FEE = 0.0005;
const bars = (count: number, price: (index: number) => number, from = 0): Array<readonly [number, number]> => Array.from({ length: count }, (_, index) => [T0 + (from + index) * MINUTE, price(from + index)] as const);
// Three rises and falls: three baseline round trips with different holding times.
const wave = (index: number): number => 1000 + Math.abs(((index % 90) - 45)) * 3 + (index % 7);
const rig = (restore?: Parameters<typeof decodeNullComparators>[0]) => {
  let nulls: PaperNullComparators | undefined;
  const shadow = new PaperBaselineShadow({ spec, feeRate: FEE, now: () => 1_000, onRoundTrip: (trip) => nulls?.onBaselineRoundTrip(trip) });
  nulls = new PaperNullComparators({ feeRate: FEE, now: () => 2_000, baselineTotals: () => shadow.summary(), ...(restore == null ? {} : { restore: decodeNullComparators(restore)! }) });
  const feed = (all: ReadonlyArray<readonly [number, number]>): void => {
    for (let end = 1; end <= all.length; end += 1) {
      const window = all.slice(Math.max(0, end - 60), end);
      nulls!.observe("KRW-XRP", window); // same order as the runtime: comparators first, then the baseline shadow
      shadow.observe("KRW-XRP", window);
    }
  };
  return { shadow, nulls, feed };
};

test("fee parity: the baseline shadow's net result for a real trip equals roundTripNet on the same two prices", () => {
  const all = bars(70, (i) => (i < 30 ? 1000 + i * 2 : 1000 + (60 - i) * 2));
  const priceAt = (minute: number): number => all.find((b) => Math.floor(b[0] / MINUTE) === minute)![1];
  const trips: Array<{ entryMinute: number; exitMinute: number }> = [];
  const shadow = new PaperBaselineShadow({ spec, feeRate: FEE, now: () => 1, onRoundTrip: (trip) => trips.push(trip) });
  for (let end = 1; end <= all.length; end += 1) shadow.observe("KRW-XRP", all.slice(Math.max(0, end - 60), end));
  const t = shadow.summary();
  assert.equal(t.trades, 1);
  assert.equal(trips.length, 1);
  const probe = roundTripNet(priceAt(trips[0]!.entryMinute), priceAt(trips[0]!.exitMinute), FEE);
  assert.equal(baselineNetBp(t), probe.netBp, "gain - loss - fee of the baseline equals the comparator's per-trip net");
  assert.equal(t.feeBp, probe.grossBp - probe.netBp, "same fee drag");
  assert.equal(roundTripNet(1000, 1000, FEE).netBp, -10, "a flat round trip costs the 0.05% fee on both legs");
  assert.throws(() => new PaperNullComparators({ feeRate: 0.5, now: () => 1, baselineTotals: () => undefined }), /fee rate/);
  const nulls = new PaperNullComparators({ feeRate: FEE, now: () => 1, baselineTotals: () => undefined });
  nulls.observe("KRW-XRP", [[T0, 1000], [T0 + MINUTE, 1012]]);
  assert.equal(nulls.summary()!.holdNetBp, roundTripNet(1000, 1012, FEE).netBp);
});

test("buy-and-hold is one position per market from the first bar to the latest bar, and absent without a span", () => {
  const nulls = new PaperNullComparators({ feeRate: FEE, now: () => 5, baselineTotals: () => undefined });
  assert.equal(nulls.summary(), undefined, "no bars: no data, not zeros");
  nulls.observe("KRW-XRP", [[T0, 1000]]);
  assert.equal(nulls.summary()!.holdNetBp, undefined, "one bar has no measurable span");
  assert.equal(nulls.summary()!.holdMarkets, undefined);
  nulls.observe("KRW-XRP", [[T0, 1000], [T0 + MINUTE, 1010], [T0 + 2 * MINUTE, 1100]]);
  nulls.observe("KRW-ETH", [[T0, 2000], [T0 + MINUTE, 1900]]);
  const s = nulls.summary()!;
  assert.equal(s.holdMarkets, 2);
  assert.equal(s.holdNetBp, roundTripNet(1000, 1100, FEE).netBp + roundTripNet(2000, 1900, FEE).netBp);
  // Idempotent: the same bars again change nothing.
  nulls.observe("KRW-XRP", [[T0, 1000], [T0 + MINUTE, 1010], [T0 + 2 * MINUTE, 1100]]);
  assert.deepEqual(nulls.summary(), s);
});

test("the random entry is deterministic: the same bars give the same result, and the fixed seed is recorded", () => {
  const all = bars(400, wave);
  const a = rig(); a.feed(all);
  const b = rig(); b.feed(all);
  assert.deepEqual(a.nulls.summary(), b.nulls.summary());
  assert.equal(a.nulls.summary()!.seed, NULL_COMPARATOR_SEED);
  assert.equal(a.nulls.takePersistable()!.seed, NULL_COMPARATOR_SEED);
  assert.deepEqual([1, 2, 3, 4].map((n) => seededUnit(NULL_COMPARATOR_SEED, n)), [1, 2, 3, 4].map((n) => seededUnit(NULL_COMPARATOR_SEED, n)));
  const draws = Array.from({ length: 200 }, (_, n) => seededUnit(NULL_COMPARATOR_SEED, n + 1));
  assert.ok(draws.every((u) => u >= 0 && u < 1) && new Set(draws).size > 190, "unit draws are in [0,1) and not constant");
  assert.notDeepEqual(draws, Array.from({ length: 200 }, (_, n) => seededUnit(NULL_COMPARATOR_SEED + 1, n + 1)), "a different seed is a different stream");
});

test("the random entry makes the same number of round trips as the baseline, with the same holding times", () => {
  const all = bars(400, wave);
  const { shadow, nulls, feed } = rig();
  feed(all);
  const s = nulls.summary()!;
  assert.ok(shadow.summary().trades >= 3);
  assert.equal(s.baselineTrades, shadow.summary().trades, "the window starts with the first bar, so every baseline trip counts");
  assert.equal(s.randomTrades + s.randomSkipped, s.baselineTrades, "every baseline trip is matched by one random trip or an explicit skip");
  assert.ok(s.randomWins <= s.randomTrades);
});

test("a trip with no history to draw from is counted as skipped, never invented", () => {
  const nulls = new PaperNullComparators({ feeRate: FEE, now: () => 5, baselineTotals: () => undefined });
  nulls.observe("KRW-XRP", bars(10, (i) => 1000 + i));
  const minute = Math.floor(T0 / MINUTE);
  nulls.onBaselineRoundTrip({ market: "KRW-XRP", entryMinute: minute, exitMinute: minute + 500 });
  nulls.onBaselineRoundTrip({ market: "KRW-DOGE", entryMinute: minute, exitMinute: minute + 2 });
  const s = nulls.summary()!;
  assert.equal(s.randomTrades, 0);
  assert.equal(s.randomSkipped, 1, "a market with no bars is ignored; a hold longer than the history is skipped");
});

test("the comparison covers the baseline's window only: trips counted before the comparators started are excluded", () => {
  let totals = { since: 1, trades: 7, wins: 3, grossGainBp: 500, grossLossBp: 200, feeBp: 70 };
  const nulls = new PaperNullComparators({ feeRate: FEE, now: () => 5, baselineTotals: () => totals });
  nulls.observe("KRW-XRP", bars(3, (i) => 1000 + i));
  totals = { since: 1, trades: 9, wins: 4, grossGainBp: 560, grossLossBp: 230, feeBp: 90 };
  const s = nulls.summary()!;
  assert.equal(s.baselineTrades, 2);
  assert.equal(s.baselineNetBp, (560 - 230 - 90) - (500 - 200 - 70));
  totals = { ...totals, trades: 5 }; // the baseline record was reset: not comparable, so absent rather than negative
  assert.equal(nulls.summary()!.baselineTrades, undefined);
  assert.equal(nulls.summary()!.baselineNetBp, undefined);
});

test("counters and positions survive a restart, and the draw stream resumes where it stopped", () => {
  const all = bars(400, wave);
  const first = rig(); first.feed(all);
  const saved = first.nulls.takePersistable()!;
  assert.equal(first.nulls.takePersistable(), undefined, "nothing changed since the last take");
  const restored = rig(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.nulls.summary()!.randomTrades, saved.random.trades);
  assert.equal(restored.nulls.summary()!.holdNetBp, first.nulls.summary()!.holdNetBp);
  assert.equal(restored.nulls.summary()!.since, saved.since);
});

test("persisted state is validated: a different seed, an inconsistent counter or a bad position is refused", () => {
  const good = rig(); good.feed(bars(300, wave));
  const saved = JSON.parse(JSON.stringify(good.nulls.takePersistable()));
  assert.ok(decodeNullComparators(saved) != null);
  for (const bad of [
    { ...saved, seed: NULL_COMPARATOR_SEED + 1 }, { ...saved, schemaVersion: 2 }, { ...saved, since: 0 },
    { ...saved, random: { ...saved.random, wins: saved.random.trades + 1 } }, { ...saved, random: { ...saved.random, draws: saved.random.trades + 1 } },
    { ...saved, hold: { "KRW-XRP": { firstMinute: 5, firstClose: 0, lastMinute: 6, lastClose: 1 } } }, { ...saved, hold: { "BTC-USD": saved.hold["KRW-XRP"] } },
    { ...saved, origin: { trades: -1, netBp: 0 } }, null, [], "x",
  ]) assert.equal(decodeNullComparators(bad), undefined);
});

test("the record file is atomic, round-trips, and unusable content reads as absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nulls-"));
  const db = path.join(dir, "cloud.sqlite");
  assert.equal(nullComparatorsRecordPath(":memory:"), undefined);
  assert.equal(readNullComparatorsRecord(db), undefined);
  const good = rig(); good.feed(bars(300, wave));
  const saved = good.nulls.takePersistable()!;
  assert.equal(writeNullComparatorsRecord(db, saved), true);
  assert.deepEqual(readNullComparatorsRecord(db), saved);
  assert.equal(writeNullComparatorsRecord(":memory:", saved), false);
  writeFileSync(nullComparatorsRecordPath(db)!, "{not json");
  assert.equal(readNullComparatorsRecord(db), undefined);
});

test("malformed input and a throwing listener never reach the baseline shadow or the runtime", () => {
  const nulls = new PaperNullComparators({ feeRate: FEE, now: () => 5, baselineTotals: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => nulls.observe("KRW-XRP", [[Number.NaN, 1], [T0, -1], [T0, Number.POSITIVE_INFINITY], [0, 5]] as never));
  assert.doesNotThrow(() => nulls.observe("btc", bars(3, () => 1)));
  assert.equal(nulls.summary(), undefined);
  const shadow = new PaperBaselineShadow({ spec, feeRate: FEE, now: () => 1, onRoundTrip: () => { throw new Error("listener"); } });
  const all = bars(70, (i) => (i < 30 ? 1000 + i * 2 : 1000 + (60 - i) * 2));
  for (let end = 1; end <= all.length; end += 1) shadow.observe("KRW-XRP", all.slice(0, end));
  assert.equal(shadow.summary().trades, 1, "the baseline settles its trip even when the listener throws");
});

test("the baseline shadow's own totals are unchanged by observing the comparators (zero authority over the baseline)", () => {
  const all = bars(400, wave);
  const alone = new PaperBaselineShadow({ spec, feeRate: FEE, now: () => 1 });
  for (let end = 1; end <= all.length; end += 1) alone.observe("KRW-XRP", all.slice(Math.max(0, end - 60), end));
  const { shadow, feed } = rig(); feed(all);
  assert.deepEqual(shadow.summary(), { ...alone.summary(), since: shadow.summary().since });
});

test("source: the comparators are display-only (no order, ledger, risk, governance or strategy import) and the runtime wires them beside the shadow", () => {
  for (const file of ["paperNullComparators.ts", "paperNullComparatorsRecord.ts"]) {
    const src = readFileSync(path.join(__dirname.replace(/dist[\\/]/, ""), file), "utf8");
    const imports = [...src.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    assert.ok(imports.every((i) => ["node:fs", "node:path", "./paperBaselineShadow", "./paperNullComparators"].includes(i!)), `${file} imports only ${imports.join(", ")}`);
  }
  const runtime = readFileSync(path.join(__dirname.replace(/dist[\\/]/, ""), "closedLearningProductionRuntime.ts"), "utf8");
  assert.match(runtime, /nullComparators\?\.observe\(market, bars\);[^\n]*\n\s*baselineShadow\?\.observe\(market, bars\)/, "comparators see the bars first, on the same read the baseline uses");
  assert.match(runtime, /feeRate: 0\.0005, now: Date\.now, baselineTotals/, "the same fee rate as the baseline shadow");
});
