const test = require("node:test");
const assert = require("node:assert/strict");

const { buildWalkForwardWindows } = require("../dist/apps/cloud/src/researchWalkForwardWindows.js");

const M = 60_000;
const config = { intervalMs: M, trainMs: 6 * M, validationMs: 3 * M, holdoutMs: 3 * M, maxMissingRatio: 0 };
const mk = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ timestamp: (from + i) * M, open: 1, high: 2, low: 1, close: 1.5, volume: 0 }));
const END = 2000 * M; // minute 2000

test("splits the most recent history into ordered, disjoint train / validation / holdout windows", () => {
  // holdout 1998..2000, validation 1995..1997, train 1989..1994
  const r = buildWalkForwardWindows({ candles: mk(1980, 2000), endCloseMs: END, config });
  assert.equal(r.status, "OK");
  assert.deepEqual(r.holdout.map((c) => c.timestamp / M), [1998, 1999, 2000]);
  assert.deepEqual(r.validation.map((c) => c.timestamp / M), [1995, 1996, 1997]);
  assert.deepEqual(r.train.map((c) => c.timestamp / M), [1989, 1990, 1991, 1992, 1993, 1994]);
  assert.deepEqual({ ...r.bounds.holdout }, { startCloseMs: 1998 * M, endCloseMs: 2000 * M });
  assert.deepEqual(r.missing, { train: 0, validation: 0, holdout: 0 });
  assert.ok(r.train.at(-1).timestamp < r.validation[0].timestamp && r.validation.at(-1).timestamp < r.holdout[0].timestamp);
});

test("refuses when history does not reach back far enough", () => {
  assert.deepEqual({ ...buildWalkForwardWindows({ candles: mk(1992, 2000), endCloseMs: END, config }) }, { status: "REFUSED", reason: "INSUFFICIENT_HISTORY" });
  assert.equal(buildWalkForwardWindows({ candles: mk(1, 5), endCloseMs: 5 * M, config }).reason, "INSUFFICIENT_HISTORY");
});

test("refuses a window with too many missing candles, tolerates the configured ratio, never fills", () => {
  const withHole = mk(1980, 2000).filter((c) => c.timestamp !== 1996 * M);
  const strict = buildWalkForwardWindows({ candles: withHole, endCloseMs: END, config });
  assert.deepEqual({ ...strict }, { status: "REFUSED", reason: "TOO_MANY_GAPS", window: "validation" });
  // A 6-slot validation window with one hole is 1/6 = 16.7% missing: allowed at 0.2, still refused at 0.1.
  const longer = { ...config, validationMs: 6 * M };
  const lenient = buildWalkForwardWindows({ candles: withHole, endCloseMs: END, config: { ...longer, maxMissingRatio: 0.2 } });
  assert.equal(lenient.status, "OK");
  assert.equal(lenient.missing.validation, 1);
  assert.equal(lenient.validation.length, 5);
  assert.equal(buildWalkForwardWindows({ candles: withHole, endCloseMs: END, config: { ...longer, maxMissingRatio: 0.1 } }).reason, "TOO_MANY_GAPS");
});

test("a window with no candles at all is refused even if the ratio would allow it", () => {
  const noHoldout = mk(1980, 1997);
  const r = buildWalkForwardWindows({ candles: noHoldout, endCloseMs: END, config: { ...config, maxMissingRatio: 0.2 } });
  assert.equal(r.status, "REFUSED");
  assert.equal(r.window, "holdout");
});

test("rejects invalid candles and invalid configuration", () => {
  assert.equal(buildWalkForwardWindows({ candles: [], endCloseMs: END, config }).reason, "NO_CANDLES");
  assert.equal(buildWalkForwardWindows({ candles: [...mk(1990, 1991), ...mk(1990, 1991)], endCloseMs: END, config }).reason, "INVALID_CANDLES");
  assert.equal(buildWalkForwardWindows({ candles: [{ ...mk(1990, 1990)[0], timestamp: 1990 * M + 1 }], endCloseMs: END, config }).reason, "INVALID_CANDLES");
  for (const bad of [{ ...config, trainMs: 5 }, { ...config, holdoutMs: 90_000 }, { ...config, maxMissingRatio: 0.5 }, { ...config, maxMissingRatio: -1 }, { ...config, intervalMs: 10 }]) {
    assert.equal(buildWalkForwardWindows({ candles: mk(1980, 2000), endCloseMs: END, config: bad }).reason, "INVALID_CONFIG");
  }
  assert.equal(buildWalkForwardWindows({ candles: mk(1980, 2000), endCloseMs: END + 1, config }).reason, "INVALID_CONFIG");
  assert.equal(buildWalkForwardWindows({ candles: mk(1980, 2000), endCloseMs: 0, config }).reason, "INVALID_CONFIG");
});

test("exchange-confirmed absent closes leave both sides of the missing ratio; our own gaps still count; a mostly-quiet window still refuses", () => {
  const cfg = { intervalMs: M, trainMs: 100 * M, validationMs: 50 * M, holdoutMs: 50 * M, maxMissingRatio: 0.05 };
  const end = 1000 * M;
  // holdout 951..1000; drop 961..970 (10 closes = 20% of the holdout)
  const without = (drop) => mk(700, 1000).filter((c) => !drop.has(c.timestamp / M));
  const quiet = new Set(Array.from({ length: 10 }, (_, i) => (961 + i) * M));
  const dropped = new Set(Array.from({ length: 10 }, (_, i) => 961 + i));
  assert.equal(buildWalkForwardWindows({ candles: without(dropped), endCloseMs: end, config: cfg }).reason, "TOO_MANY_GAPS", "unexplained: 20% missing");
  const ok = buildWalkForwardWindows({ candles: without(dropped), endCloseMs: end, config: cfg, excludedCloses: quiet });
  assert.equal(ok.status, "OK", "the exchange had no candle there: not counted as missing");
  assert.equal(ok.holdout.length, 40);
  assert.equal(ok.missing.holdout, 0);
  // plus three of our own losses in the remaining 40 slots: 3/40 = 7.5% > 5%
  const ownLoss = new Set([...dropped, 980, 981, 982]);
  assert.equal(buildWalkForwardWindows({ candles: without(ownLoss), endCloseMs: end, config: cfg, excludedCloses: quiet }).reason, "TOO_MANY_GAPS");
  // a confirmed-quiet stretch above 20% of a window is refused: too little of the window traded
  const bigQuiet = new Set(Array.from({ length: 11 }, (_, i) => (961 + i) * M));
  assert.equal(buildWalkForwardWindows({ candles: without(new Set(Array.from({ length: 11 }, (_, i) => 961 + i))), endCloseMs: end, config: cfg, excludedCloses: bigQuiet }).reason, "TOO_MANY_GAPS");
  // closes outside every window do nothing; an empty set equals no set
  assert.deepEqual(buildWalkForwardWindows({ candles: mk(700, 1000), endCloseMs: end, config: cfg, excludedCloses: new Set([5 * M]) }).missing, buildWalkForwardWindows({ candles: mk(700, 1000), endCloseMs: end, config: cfg }).missing);
});
