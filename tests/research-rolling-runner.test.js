"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { SqliteDatabase, SqliteResearchCandleStore, SqliteResearchHoldoutLedger } = require("../dist/packages/storage/src/index.js");
const { canonicalSha256 } = require("../dist/apps/cloud/src/researchProvenanceBuilder.js");
const { runRollingResearchExperiment } = require("../dist/apps/cloud/src/researchExperimentRunner.js");

const M = 60_000;
const END = 5000 * M;
const windows = { intervalMs: M, trainMs: 200 * M, validationMs: 80 * M, holdoutMs: 80 * M, maxMissingRatio: 0 };
const wave = (count, startMinute) => Array.from({ length: count }, (_, i) => { const close = 100 + 12 * Math.sin(i / 6); return { closeTimeMs: (startMinute + i) * M, open: close, high: close + 1, low: close - 1, close: Number(close.toFixed(4)) }; });
const strategy = { strategyId: "challenger", version: "1.0.0", dsl: {} };
const setup = (count) => {
  const db = new SqliteDatabase(join(mkdtempSync(join(tmpdir(), "nusa-rolling-")), "r.db"));
  const store = new SqliteResearchCandleStore(db);
  store.append("KRW-BTC", M, wave(count, 5000 - count + 1));
  return { store, holdout: new SqliteResearchHoldoutLedger(db) };
};
const spec = {
  sessionId: "rolling-1", market: "KRW-BTC", intervalMs: M, endCloseMs: END, windows,
  champion: { strategy, config: { fast: 3 } }, challenger: { strategy, config: { fast: 5, slow: 12 } },
  featurePipeline: { version: "closed-candle-agg-v1", config: { intervalMs: M } }, evaluator: { version: "backtest-eval-v1", modelVersion: "dsl-backtest-v1" },
  models: { fill: "fill-close-v1", fee: "fee-0.0005-v1", slippage: "slip-5bps-v1" }, sourceCommitSha: "a".repeat(40),
  experimentFamilyId: "family", attempt: 1, hypothesisLineage: "h0", split: { identity: "wf" }, walkForwardConfig: { grid: {} },
};
// The single-fold runner needs a real automation runtime to produce evidence; here the evidence is scripted per window role and fold.
const portsFor = (s, script, seen = []) => ({
  candles: s.store, holdout: s.holdout, now: () => END,
  runExperiment: (input) => { const role = input.provenance.windowRole; const fold = input.evaluationId; seen.push(`${role}:${fold}`); return { result: script(role, input) }; },
});

test("three folds each claim their own holdout, and two passes out of three pass", () => {
  const s = setup(3 * 360 + 40);
  let holdoutCalls = 0;
  const seen = [];
  const out = runRollingResearchExperiment(portsFor(s, (role) => { if (role === "VALIDATION") return "CHALLENGER_BETTER"; holdoutCalls += 1; return holdoutCalls === 2 ? "NOT_BETTER" : "CHALLENGER_BETTER"; }, seen), spec);
  assert.equal(out.refusal, undefined);
  assert.equal(out.folds.length, 3);
  assert.deepEqual(out.folds.map((f) => f.outcome), ["CHALLENGER_BETTER", "NOT_BETTER", "CHALLENGER_BETTER"]);
  assert.equal(out.decision.decision, "PASS");
  assert.equal(new Set(out.folds.map((f) => f.endCloseMs)).size, 3, "distinct fold ends");
  assert.equal(out.folds[2].endCloseMs, END);
  assert.equal(new Set(seen.filter((x) => x.startsWith("HOLDOUT"))).size, 3, "a distinct holdout evaluation per fold");
});

test("one holdout pass is not enough", () => {
  const s = setup(3 * 360 + 40);
  let n = 0;
  const out = runRollingResearchExperiment(portsFor(s, (role) => role === "VALIDATION" ? "CHALLENGER_BETTER" : (n += 1) === 1 ? "CHALLENGER_BETTER" : "NOT_BETTER"), spec);
  assert.equal(out.decision.decision, "FAIL");
});

test("a fold whose validation does not favour the challenger counts as not better and never claims its holdout", () => {
  const s = setup(3 * 360 + 40);
  const roles = [];
  const out = runRollingResearchExperiment(portsFor(s, (role) => { roles.push(role); return role === "VALIDATION" ? "NOT_BETTER" : "CHALLENGER_BETTER"; }), spec);
  assert.deepEqual(out.folds.map((f) => f.note), ["VALIDATION_NOT_FAVOURABLE", "VALIDATION_NOT_FAVOURABLE", "VALIDATION_NOT_FAVOURABLE"]);
  assert.equal(out.decision.decision, "FAIL");
  assert.ok(!roles.includes("HOLDOUT"));
});

test("not enough history refuses the whole set before any run or holdout claim", () => {
  const s = setup(2 * 360 + 40);
  let runs = 0;
  const out = runRollingResearchExperiment({ ...portsFor(s, () => "CHALLENGER_BETTER"), runExperiment: () => { runs += 1; return { result: "CHALLENGER_BETTER" }; } }, spec);
  assert.match(out.refusal, /^ROLLING_INSUFFICIENT_HISTORY_FOLD_0$/);
  assert.equal(out.decision.decision, "INSUFFICIENT_EVIDENCE");
  assert.equal(runs, 0);
  assert.equal(s.holdout.overlapsUsedHoldout(canonicalSha256(spec.challenger.config), "KRW-BTC", M, M, END), false, "no claim was made");
});

test("running the same rolling check again finds every holdout already used and never passes", () => {
  const s = setup(3 * 360 + 40);
  const ports = portsFor(s, () => "CHALLENGER_BETTER");
  assert.equal(runRollingResearchExperiment(ports, spec).decision.decision, "PASS");
  const again = runRollingResearchExperiment(ports, spec);
  assert.notEqual(again.decision.decision, "PASS");
  assert.ok(again.folds.every((f) => f.outcome === "INSUFFICIENT"));
});

test("a failing port is reported as a refusal, never a pass", () => {
  const s = setup(3 * 360 + 40);
  const out = runRollingResearchExperiment({ ...portsFor(s, () => "CHALLENGER_BETTER"), candles: { read: () => { throw new Error("boom"); } } }, spec);
  assert.equal(out.refusal, "ROLLING_RUN_FAILED");
  assert.equal(out.decision.decision, "INSUFFICIENT_EVIDENCE");
});

test("a newest-fold outcome the caller already has is classified instead of run again, and only the older folds run", () => {
  const s = setup(3 * 360 + 40);
  const seen = [];
  const given = { status: "COMPLETED", validation: { result: "CHALLENGER_BETTER" }, holdout: { result: "CHALLENGER_BETTER" } };
  const out = runRollingResearchExperiment(portsFor(s, () => "CHALLENGER_BETTER", seen), spec, 3, given);
  assert.deepEqual(out.folds.map((f) => f.outcome), ["CHALLENGER_BETTER", "CHALLENGER_BETTER", "CHALLENGER_BETTER"]);
  assert.equal(out.decision.decision, "PASS");
  assert.equal(seen.filter((x) => x.startsWith("VALIDATION")).length, 2, "the newest fold was not run a second time");
  const already = runRollingResearchExperiment(portsFor(setup(3 * 360 + 40), () => "CHALLENGER_BETTER"), spec, 3, { status: "COMPLETED", validation: { result: "CHALLENGER_BETTER" }, holdout: null, holdoutNote: "HOLDOUT_ALREADY_USED" });
  assert.equal(already.folds[2].outcome, "INSUFFICIENT");
});
