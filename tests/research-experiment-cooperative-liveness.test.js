const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
const { ResearchExperimentOrchestrator } = require("../dist/apps/cloud/src/researchExperimentOrchestrator.js");
const { composeResearchExperiments, RESEARCH_FLAG } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
const { researchSessionIdFor } = require("../dist/apps/cloud/src/researchSessionPlanner.js");

const NOW = Date.UTC(2026, 9, 19, 10, 0, 0);
const M = 60_000;

function variant(variantId) {
  return {
    variantId,
    champion: { strategy: { strategyId: `champion-${variantId}`, version: "1.0.0" }, config: {} },
    challenger: { strategy: { strategyId: `challenger-${variantId}`, version: "1.0.0" }, config: {} },
    runtime: {
      recover: () => ({ status: "READY", snapshot: null, reasons: [] }),
      status: () => { throw new Error("not used"); },
      startSession: () => { throw new Error("today's session already exists"); },
      runExperiment: () => { throw new Error("no closed candle is due"); },
      resume: () => { throw new Error("not paused"); },
      stop: () => { throw new Error("not stale"); },
    },
  };
}

function buildOrchestrator() {
  const variants = [variant("v1"), variant("v2"), variant("v3")];
  const sessions = new Map(variants.map(({ variantId }) => {
    const sessionId = researchSessionIdFor(NOW, variantId);
    return [sessionId, { sessionId, state: "RUNNING" }];
  }));
  return new ResearchExperimentOrchestrator({
    variants,
    sessions: { list: () => [...sessions.values()], load: (sessionId) => sessions.get(sessionId) },
    markets: ["KRW-BTC"],
    intervalMs: M,
    windows: { intervalMs: M, trainMs: M, validationMs: M, holdoutMs: M, maxMissingRatio: 0 },
    dailyBudgetPerVariant: 3,
    collect: () => {},
    candles: { read: () => [], latestCloseTime: () => undefined },
    holdout: { claim: () => "CLAIMED", overlapsUsedHoldout: () => false },
    now: () => NOW,
    sourceCommitSha: "a".repeat(40),
    models: { fill: "fill", fee: "fee", slippage: "slippage" },
    evaluator: { version: "test", modelVersion: "test" },
    featurePipeline: { version: "test", config: {} },
    experimentFamilyPrefix: "test-family",
  });
}

test("cooperative Research tick yields between bounded variant/market steps without changing the report", async () => {
  const orchestrator = buildOrchestrator();
  assert.equal(orchestrator.recover().status, "READY");
  let yields = 0;
  const report = await orchestrator.tickAsync(async () => {
    yields += 1;
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(report.status, "OK");
  assert.equal(report.experiments.length, 3);
  assert.ok(report.experiments.every((entry) => entry.outcome.status === "NOT_DUE" || entry.outcome.status === "NO_CANDLES"));
  assert.equal(yields, 4, "one post-collection yield plus one yield after each bounded variant/market step");
});

test("cooperative tick refuses to interleave with an active candle backfill writer", async () => {
  const db = new SqliteDatabase(":memory:");
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const fetchImpl = async () => {
    markFetchStarted();
    await new Promise((resolve) => { releaseFetch = resolve; });
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const composition = composeResearchExperiments({
    env: { [RESEARCH_FLAG]: "1", NUSA_SOURCE_COMMIT_SHA: "b".repeat(40), NUSA_RESEARCH_BACKFILL: "ENABLED" },
    database: db,
    now: () => NOW,
    log: () => {},
    fetchImpl,
    sleep: async () => undefined,
  });
  try {
    assert.ok(composition);
    const backfill = composition.backfill();
    await fetchStarted;
    await assert.rejects(() => composition.tickOnceAsync(), /research evidence writer active/);
    releaseFetch();
    await backfill;
  } finally {
    composition?.stop();
    db.close();
  }
});

test("production Research timers use the cooperative scheduler and serialize evidence writers", () => {
  const source = readFileSync(join(process.cwd(), "apps/cloud/src/researchExperimentComposition.ts"), "utf8");
  assert.match(source, /first = setTimeout\(scheduleTick, 60_000\)/);
  assert.match(source, /timer = setInterval\(scheduleTick, settings\.tickMs\)/);
  assert.match(source, /await orchestrators\[index\]!\.tickAsync\(yieldProductionTurn\)/);
  assert.match(source, /if \(backfilling \|\| researchTickActive \|\| stopped\)/);
  assert.match(source, /if \(gapFilling \|\| researchTickActive \|\| stopped\)/);
  assert.match(source, /if \(backfilling \|\| gapFilling\) \{/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{ try \{ tickOnce\(\)/);
});
