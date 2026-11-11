const test = require("node:test");
const assert = require("node:assert/strict");
const { learningPipelineProjection, LEARNING_PIPELINE_MARKET_STALE_MS } = require("../dist/apps/cloud/src/learningPipelineStage.js");

const NOW = 1_792_990_000_000;
// Shape of the last readable /health snapshot (2026-10-26): orders all failing, no fill, stale candles, manifests missing, no learning cycle.
const stalled = {
  lastMarketEventAt: NOW - 2_000, decisionCount: 12_984, paperOrderCount: 0, paperFillCount: 0,
  paperFunnel: { since: NOW - 3_600_000, counts: { "DECISION:PASS:BUY": 4824, "ORDER_INTENT:FAIL": 4824 } },
  researchCollectionStatus: "COLLECTING", dataIntegrity: { status: "WARN", candleStaleSeries: 1 },
  researchExperimentTicks: { lastTickAt: NOW, lastStatus: "OK", ticks: 110, sessionsStarted: 0, counts: { SKIPPED_DATASET_MANIFEST_MANIFEST_NOT_FOUND: 110 } },
  closedLearningLoop: { lastTickAt: NOW, ticks: 5, cyclesEvaluated: 0, deployments: 0, bootstrap: "X", rollover: "Y" },
};

test("the 2026-10-26 snapshot reads as order intent failing, stale candles and no learning cycle", () => {
  const p = learningPipelineProjection(stalled, NOW);
  assert.deepEqual([p.trading.firstBrokenStage, p.trading.code], ["ORDER", "ORDER_INTENT_FAILING"]);
  assert.equal(p.trading.stages.MARKET, "PASS");
  assert.equal(p.trading.stages.FILL, "FILL_NONE");
  assert.deepEqual([p.research.firstBrokenStage, p.research.code], ["CANDLES", "CANDLES_STALE"]);
  assert.equal(p.research.stages.DATASET, "DATASET_MANIFEST_MISSING");
  assert.equal(p.learning, "LEARNING_NOT_EVALUATED");
});

test("every stage advancing reads PASS with no broken stage", () => {
  const healthy = { ...stalled, paperOrderCount: 3, paperFillCount: 2, dataIntegrity: { status: "PASS", candleStaleSeries: 0 },
    researchExperimentTicks: { ...stalled.researchExperimentTicks, sessionsStarted: 1 }, closedLearningLoop: { ...stalled.closedLearningLoop, cyclesEvaluated: 1 } };
  const p = learningPipelineProjection(healthy, NOW);
  assert.deepEqual([p.trading.firstBrokenStage, p.trading.code, p.research.firstBrokenStage, p.research.code, p.learning], ["NONE", "PASS", "NONE", "PASS", "PASS"]);
});

test("missing or malformed evidence is UNKNOWN, never PASS (fail closed)", () => {
  const p = learningPipelineProjection({}, NOW);
  assert.deepEqual([p.trading.firstBrokenStage, p.trading.code], ["MARKET", "UNKNOWN"]);
  assert.deepEqual([p.research.firstBrokenStage, p.research.code], ["CANDLES", "UNKNOWN"]);
  assert.equal(p.learning, "UNKNOWN");
  const bad = learningPipelineProjection({ ...stalled, decisionCount: -1, paperFillCount: 1.5, lastMarketEventAt: "x" }, NOW);
  assert.equal(bad.trading.stages.MARKET, "UNKNOWN");
  assert.equal(bad.trading.stages.DECISION, "UNKNOWN");
  assert.equal(bad.trading.stages.FILL, "UNKNOWN");
});

test("market staleness, a null market event and non-collecting research have their own codes", () => {
  assert.equal(learningPipelineProjection({ ...stalled, lastMarketEventAt: NOW - LEARNING_PIPELINE_MARKET_STALE_MS - 1 }, NOW).trading.code, "MARKET_STALE");
  assert.equal(learningPipelineProjection({ ...stalled, lastMarketEventAt: null }, NOW).trading.code, "MARKET_NO_EVENT");
  assert.equal(learningPipelineProjection({ ...stalled, researchCollectionStatus: "DISABLED" }, NOW).research.code, "CANDLES_DISABLED");
  assert.equal(learningPipelineProjection({ ...stalled, paperFunnel: undefined }, NOW).trading.code, "ORDER_NONE");
});

test("the result is frozen and deterministic", () => {
  const a = learningPipelineProjection(stalled, NOW);
  assert.deepEqual(a, learningPipelineProjection(stalled, NOW));
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.trading.stages));
});

test("/health derives learningPipeline only from the already-public runtime object", () => {
  const server = require("node:fs").readFileSync("apps/cloud/src/server.ts", "utf8");
  assert.match(server, /const runtime = publicRuntimeLiveness\(liveness\);\r?\n\s+const learningPipeline = learningPipelineProjection\(runtime as unknown as Readonly<Record<string, unknown>>, now\);/);
  assert.match(server, /\.\.\.\(pipeline \?\? \{\}\),/);
});

test("experiments that produced results after a restart read DATASET PASS even though sessionsStarted is 0 (sessions are resumed, not started)", () => {
  const afterRestart = { ...stalled, researchExperimentTicks: { lastTickAt: NOW, lastStatus: "OK", ticks: 4, sessionsStarted: 0, counts: { NOT_DUE: 40, FAIL_EXCESSIVE_DRAWDOWN: 168, FAIL_NO_EDGE: 52 } } };
  assert.equal(learningPipelineProjection(afterRestart, NOW).research.stages.DATASET, "PASS");
  const onlyIdle = { ...stalled, researchExperimentTicks: { lastTickAt: NOW, lastStatus: "OK", ticks: 4, sessionsStarted: 0, counts: { NOT_DUE: 40 } } };
  assert.equal(learningPipelineProjection(onlyIdle, NOW).research.stages.DATASET, "DATASET_NO_SESSION", "idle alone is not proof");
  const skippedOnly = { ...stalled, researchExperimentTicks: { lastTickAt: NOW, lastStatus: "OK", ticks: 4, sessionsStarted: 0, counts: { SKIPPED_DATASET_MANIFEST_MANIFEST_NOT_FOUND: 4, ERROR_X: 2 } } };
  assert.equal(learningPipelineProjection(skippedOnly, NOW).research.stages.DATASET, "DATASET_MANIFEST_MISSING", "skipped and errors are not results");
});
