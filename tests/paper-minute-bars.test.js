"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { completedMinuteCloses, PaperMinuteBarSource, MINUTE_MS } = require("../dist/apps/cloud/src/paperMinuteBars.js");
const { evaluatePaperCandidateStrategy } = require("../dist/apps/cloud/src/paperCandidateStrategy.js");

const T0 = Date.parse("2026-10-06T10:00:00Z");

test("only completed minutes, last price of each minute, no forward fill, no look-ahead", () => {
  const obs = [
    { observedAt: T0 + 1_000, price: 100 }, { observedAt: T0 + 50_000, price: 101 },
    { observedAt: T0 + MINUTE_MS + 5_000, price: 102 },
    // minute 2 has no observation
    { observedAt: T0 + 3 * MINUTE_MS + 9_000, price: 104 },
    { observedAt: T0 + 4 * MINUTE_MS + 1_000, price: 999 }, // current, incomplete minute
    { observedAt: T0 + 9 * MINUTE_MS, price: 1 }, // future
  ];
  const now = T0 + 4 * MINUTE_MS + 30_000;
  assert.deepEqual(completedMinuteCloses(obs, now), [[T0 + 50_000, 101], [T0 + MINUTE_MS + 5_000, 102], [T0 + 3 * MINUTE_MS + 9_000, 104]]);
  assert.equal(completedMinuteCloses(obs, now, 2).length, 2, "bounded lookback keeps the latest bars");
  assert.deepEqual(completedMinuteCloses([{ observedAt: T0, price: -1 }, { observedAt: 1.5, price: 1 }], now), [], "invalid points are ignored");
});

test("the source reads the store at most once per market per minute, and fails closed to no bars", () => {
  let reads = 0;
  const rows = Array.from({ length: 30 }, (_, i) => ({ observedAt: T0 + i * MINUTE_MS + 10_000, price: 100 + i }));
  const source = new PaperMinuteBarSource(() => { reads += 1; return rows; });
  const now = T0 + 30 * MINUTE_MS + 1_000;
  const first = source.read("krw-xrp", now);
  source.read("KRW-XRP", now + 20_000);
  assert.equal(reads, 1, "cached within the same minute");
  assert.equal(first.length, 30);
  source.read("KRW-XRP", now + MINUTE_MS);
  assert.equal(reads, 2, "re-read on the next minute");
  const failing = new PaperMinuteBarSource(() => { throw new Error("store unavailable"); });
  assert.deepEqual(failing.read("KRW-XRP", now), []);
});

test("supplied minute closes replace the per-ticker series in the candidate strategy", () => {
  const spec = { candidateId: "c", familyId: "sma-crossover", lineageId: "l", parameters: { shortPeriod: 5, longPeriod: 20 }, costModelVersion: "v", specificationHash: "a".repeat(64), codeSha: "b".repeat(40) };
  const now = T0 + 60 * MINUTE_MS;
  const rising = Array.from({ length: 40 }, (_, i) => [T0 + i * MINUTE_MS, 100 + i]);
  const tickObservations = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, source: "CHART", market: "KRW-XRP", price: 200 - i, observedAt: T0 + i * 1_000, expiresAt: now + 1, confidence: 1, summary: "" }));
  const withBars = evaluatePaperCandidateStrategy(spec, tickObservations, now, "KRW-XRP", rising);
  const withTicks = evaluatePaperCandidateStrategy(spec, tickObservations, now, "KRW-XRP");
  assert.equal(withBars.action, "BUY", "rising minute closes");
  assert.equal(withTicks.action, "SELL", "falling ticks");
  assert.equal(withBars.observedAt, rising.at(-1)[0]);
  const fewBars = evaluatePaperCandidateStrategy(spec, tickObservations, now, "KRW-XRP", rising.slice(0, 10));
  assert.equal(fewBars.action, "WAIT", "too few minute bars waits instead of using ticks");
  assert.match(fewBars.reason, /^INSUFFICIENT_SMA_OBSERVATIONS:10\/20$/);
});

test("the production composition wires minute closes from the persisted ticker store", () => {
  const fs = require("node:fs"), path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "apps", "cloud", "src", "closedLearningProductionRuntime.ts"), "utf8");
  assert.match(src, /new PaperMinuteBarSource\(\(market, startAt, endAt\) => minuteObservationReader\.readWindow\(market, startAt, endAt\)\)/);
  // The strategy still receives exactly the bars the minute-bar source returns; the baseline shadow and the null comparators only observe them on the way (no mutation, no extra read).
  assert.match(src, /paperCandidateMinuteCloses: \(market, now\) => \{\s*const bars = minuteBars\.read\(market, now\);\s*nullComparators\?\.observe\(market, bars\);[^\n]*\n\s*baselineShadow\?\.observe\(market, bars\);\s*return bars;\s*\}/);
});
