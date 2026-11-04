import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRollingFolds, decideRollingHoldout, foldSpanMs, requiredHistoryMs, ROLLING_FOLDS, ROLLING_FOLDS_REQUIRED, type FoldOutcome } from "./researchWalkForwardWindows";

const M = 3_600_000, DAY = 86_400_000;
const config = { intervalMs: M, trainMs: 7 * DAY, validationMs: 2 * DAY, holdoutMs: 2 * DAY, maxMissingRatio: 0.05 };
const candles = (from: number, to: number) => { const out = []; for (let t = from; t <= to; t += M) out.push({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 0 }); return out; };
const END = 100 * DAY;

describe("rolling folds", () => {
  it("lays N disjoint, time-ordered folds back to back ending at the end", () => {
    const need = requiredHistoryMs(config);
    assert.equal(need, 3 * 11 * DAY);
    const result = buildRollingFolds({ candles: candles(END - need - DAY, END), endCloseMs: END, config });
    assert.equal(result.status, "OK");
    if (result.status !== "OK") return;
    assert.equal(result.folds.length, ROLLING_FOLDS);
    assert.equal(result.folds[2]!.bounds.holdout.endCloseMs, END);
    for (let i = 1; i < result.folds.length; i += 1) {
      const older = result.folds[i - 1]!, newer = result.folds[i]!;
      assert.ok(older.bounds.holdout.endCloseMs < newer.bounds.train.startCloseMs, "no data shared between folds");
    }
    for (const fold of result.folds) {
      assert.ok(fold.bounds.train.endCloseMs < fold.bounds.validation.startCloseMs && fold.bounds.validation.endCloseMs < fold.bounds.holdout.startCloseMs);
      assert.equal(fold.bounds.holdout.endCloseMs - fold.bounds.train.startCloseMs + M, foldSpanMs(config));
    }
  });

  it("refuses the whole set when any fold lacks history, and never returns a partial set", () => {
    const result = buildRollingFolds({ candles: candles(END - 2 * foldSpanMs(config), END), endCloseMs: END, config });
    assert.equal(result.status, "REFUSED");
    if (result.status === "REFUSED") { assert.equal(result.reason, "INSUFFICIENT_HISTORY"); assert.equal(result.foldIndex, 0); }
    assert.equal(buildRollingFolds({ candles: candles(0, 10 * M), endCloseMs: END, config, folds: 1 }).status, "REFUSED");
    assert.equal(buildRollingFolds({ candles: [], endCloseMs: END, config }).status, "REFUSED");
  });
});

describe("K-of-N decision", () => {
  const O: readonly FoldOutcome[] = ["CHALLENGER_BETTER", "NOT_BETTER", "INSUFFICIENT"];
  it("passes only with at least K individual passes, and a single pass is never enough", () => {
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER", "NOT_BETTER"]).decision, "PASS");
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "NOT_BETTER", "NOT_BETTER"]).decision, "FAIL");
    assert.equal(decideRollingHoldout(["NOT_BETTER", "NOT_BETTER", "NOT_BETTER"]).decision, "FAIL");
  });
  it("an unevaluable fold is never a pass, and is only INSUFFICIENT_EVIDENCE when it could have changed the answer", () => {
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "NOT_BETTER", "INSUFFICIENT"]).decision, "INSUFFICIENT_EVIDENCE");
    assert.equal(decideRollingHoldout(["NOT_BETTER", "NOT_BETTER", "INSUFFICIENT"]).decision, "FAIL");
  });
  it("is never easier than one holdout: every PASS has at least K individual passes (exhaustive over all 27 outcomes)", () => {
    for (const a of O) for (const b of O) for (const c of O) {
      const d = decideRollingHoldout([a, b, c]);
      if (d.decision === "PASS") assert.ok([a, b, c].filter((x) => x === "CHALLENGER_BETTER").length >= ROLLING_FOLDS_REQUIRED);
    }
  });
  it("covers every PASS / FAIL / INSUFFICIENT_EVIDENCE boundary for N=3, K=2", () => {
    const d = (...o: FoldOutcome[]) => decideRollingHoldout(o).decision;
    assert.equal(d("CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER"), "PASS");
    assert.equal(d("CHALLENGER_BETTER", "CHALLENGER_BETTER", "INSUFFICIENT"), "PASS");
    assert.equal(d("CHALLENGER_BETTER", "INSUFFICIENT", "INSUFFICIENT"), "INSUFFICIENT_EVIDENCE");
    assert.equal(d("INSUFFICIENT", "INSUFFICIENT", "INSUFFICIENT"), "INSUFFICIENT_EVIDENCE");
    assert.equal(d("CHALLENGER_BETTER", "NOT_BETTER", "NOT_BETTER"), "FAIL");
    assert.equal(d("NOT_BETTER", "INSUFFICIENT", "NOT_BETTER"), "FAIL");
  });
  it("other fold counts, K below 2, K above N and non-integer values never pass", () => {
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER"], 2, 2).decision, "PASS", "the pure rule itself is generic in N; the runner only allows N=3");
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER"], 4, 3).decision, "INSUFFICIENT_EVIDENCE");
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER"], 2.5, 3).decision, "INSUFFICIENT_EVIDENCE");
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER"], 2, Number.NaN).decision, "INSUFFICIENT_EVIDENCE");
  });
  it("buildRollingFolds refuses a NaN, fractional, too small or too large fold count", () => {
    for (const folds of [Number.NaN, 2.5, 1, 7, -3]) {
      const r = buildRollingFolds({ candles: candles(END - requiredHistoryMs(config), END), endCloseMs: END, config, folds });
      assert.equal(r.status, "REFUSED");
      if (r.status === "REFUSED") assert.equal(r.reason, "INVALID_FOLD_COUNT");
    }
  });
  it("wrong counts and bad values are INSUFFICIENT_EVIDENCE, never a pass", () => {
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER"]).decision, "INSUFFICIENT_EVIDENCE");
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER"]).decision, "INSUFFICIENT_EVIDENCE");
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER", "MAYBE" as unknown as FoldOutcome]).decision, "INSUFFICIENT_EVIDENCE");
    assert.equal(decideRollingHoldout(["CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER"], 1).decision, "INSUFFICIENT_EVIDENCE", "K of 1 is not a rolling check");
  });
});
