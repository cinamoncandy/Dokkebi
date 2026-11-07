import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperBaselineShadow } from "./paperBaselineShadow";
import { SHADOW_STRATEGY_IDS, readShadowStrategyRecord, shadowStrategyRecordPath, shadowStrategySpec, writeShadowStrategyRecord } from "./paperShadowStrategies";
import { evaluatePaperCandidateStrategy } from "./paperCandidateStrategy";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 8, 0, 0, 0);
const bars = (count: number, price: (index: number) => number): Array<readonly [number, number]> => Array.from({ length: count }, (_, index) => [T0 + index * MINUTE, price(index)] as const);
const feed = (shadow: PaperBaselineShadow, all: ReadonlyArray<readonly [number, number]>): void => { for (let end = 1; end <= all.length; end += 1) shadow.observe("KRW-XRP", all.slice(Math.max(0, end - 60), end)); };

test("pre-registered parameters are fixed and valid for the strategy evaluator", () => {
  assert.deepEqual({ ...shadowStrategySpec("rsi").parameters }, { period: 14, oversold: 30, overbought: 70 });
  assert.deepEqual({ ...shadowStrategySpec("donchian").parameters }, { channelPeriod: 20 });
  for (const id of SHADOW_STRATEGY_IDS) {
    const spec = shadowStrategySpec(id);
    assert.equal(spec.lineageId, "shadow-only");
    assert.match(spec.specificationHash, /^[a-f0-9]{64}$/);
    assert.doesNotThrow(() => evaluatePaperCandidateStrategy(spec, [], T0, "KRW-XRP", bars(40, (i) => 1000 + i)));
  }
  assert.notEqual(shadowStrategySpec("rsi").specificationHash, shadowStrategySpec("donchian").specificationHash);
});

test("the Donchian shadow completes a round trip with fee drag and never throws", () => {
  const shadow = new PaperBaselineShadow({ spec: shadowStrategySpec("donchian"), feeRate: 0.0005, now: () => 1_000 });
  // a noisy range, a breakout above the channel high, then a breakdown below the channel low: one hypothetical round trip.
  feed(shadow, bars(120, (i) => (i < 40 ? 1000 + (i % 2) * 10 : i < 60 ? 1100 : i < 80 ? 1100 + (i % 2) * 10 : 900)));
  const totals = shadow.summary();
  assert.ok(totals.trades >= 1, `expected at least one round trip, got ${totals.trades}`);
  assert.ok(totals.feeBp > 0);
  assert.ok(totals.since > 0);
});

test("the RSI shadow runs on the same bars without throwing and stays consistent", () => {
  const shadow = new PaperBaselineShadow({ spec: shadowStrategySpec("rsi"), feeRate: 0.0005, now: () => 1_000 });
  feed(shadow, bars(200, (i) => 1000 + Math.round(Math.sin(i / 6) * 40)));
  const totals = shadow.summary();
  assert.ok(totals.wins <= totals.trades);
  assert.ok(totals.since > 0);
});

test("records are separate per strategy, round-trip, and reject missing paths", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shadow-"));
  const db = path.join(dir, "cloud.sqlite");
  assert.equal(shadowStrategyRecordPath(":memory:", "rsi"), undefined);
  assert.notEqual(shadowStrategyRecordPath(db, "rsi"), shadowStrategyRecordPath(db, "donchian"));
  assert.notEqual(path.basename(shadowStrategyRecordPath(db, "rsi")!), "paper-baseline-shadow.json");
  const shadow = new PaperBaselineShadow({ spec: shadowStrategySpec("rsi"), feeRate: 0.0005, now: () => 1_000 });
  feed(shadow, bars(80, (i) => 1000 + Math.round(Math.sin(i / 5) * 60)));
  const persistable = shadow.takePersistable();
  assert.ok(persistable);
  assert.equal(writeShadowStrategyRecord(db, "rsi", persistable!), true);
  assert.deepEqual(readShadowStrategyRecord(db, "rsi"), persistable);
  assert.equal(readShadowStrategyRecord(db, "donchian"), undefined);
  assert.equal(writeShadowStrategyRecord(":memory:", "rsi", persistable!), false);
});
