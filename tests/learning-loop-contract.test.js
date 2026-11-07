const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("the operations contract keeps a consistent learning-loop object and drops an inconsistent or malformed one on its own", () => {
  const { buildPersonalPaperOperationsSnapshot, validatePersonalPaperOperationsSnapshot } = require("../dist/packages/contracts/src/personalPaperOperations.js");
  const heartbeat = (extra) => ({ startedAt: 1_000, lastHeartbeatAt: 1_000, lastMarketEventAt: null, lastPaperDecisionAt: null, lastPaperOrderAt: null, lastPaperFillAt: null, eventCount: 0, decisionCount: 0, paperOrderCount: 0, paperFillCount: 0, lastError: null, ...extra });
  const dashboard = { apiVersion: "1", generatedAt: 1_000, mode: "PAPER", killSwitchActive: false, overallHealth: "HEALTHY", tradingAllowed: true, headline: "PAPER healthy", issues: [], deployableCapital: 1_000, deployedCapital: 500, cashCapital: 500, reservedCapital: 0, spotCapital: 500, futuresCapital: 0, positions: [], decisions: [], liveAuthority: "NONE", productionMutationAllowed: false };
  const operations = { runtimeState: "READY", schedulerRunning: true, schedulerMode: "OBSERVE", pipelineStage: "MONITORING", transport: "ONLINE", killSwitchActive: false, accountHalted: false, pendingWrites: 0, lastEventAt: 1_000, updatedAt: 1_000 };
  const attempt = (extra) => validatePersonalPaperOperationsSnapshot(buildPersonalPaperOperationsSnapshot({ dashboard, research: null, operations: { ...operations, heartbeat: heartbeat(extra) }, paperLearning: null }, 1_000), 1_100, 500).operations.heartbeat;
  const good = { experiments: 15, configurations: 192, discoveryPasses: 15, holdoutPasses: 0, overfitRatePercent: 100, paperPeriodsConsumed: 68, paperNetBp: -17, paperExcessBp: 2, shadowSince: 1_000, shadowTrades: 580, shadowWins: 115, shadowGrossGainBp: 3900, shadowGrossLossBp: 5684, shadowFeeBp: 5799, evaluatedAt: 1_000 };
  assert.equal(attempt({ learningLoop: good, windowDecisionCount: 4 }).learningLoop.shadowTrades, 580);
  assert.equal(attempt({ learningLoop: { evaluatedAt: 1_000, paperNetBp: -17 }, windowDecisionCount: 4 }).learningLoop.paperNetBp, -17);
  for (const bad of [
    { ...good, extra: 1 },
    { ...good, evaluatedAt: -1 },
    { ...good, discoveryPasses: 200 },
    { ...good, holdoutPasses: 16 },
    { ...good, shadowWins: 581 },
    { ...good, overfitRatePercent: 101 },
    { ...good, shadowFeeBp: -1 },
    { ...good, shadowTrades: 1.5 },
    { ...good, paperNetBp: 1e9 },
    [1, 2],
  ]) {
    const hb = attempt({ learningLoop: bad, windowDecisionCount: 4 });
    assert.equal(hb.learningLoop, undefined);
    assert.equal(hb.windowDecisionCount, 4, "other display fields survive");
  }
});

test("the runtime copies only consistent integers from the closed-learning status and never sends an empty object", () => {
  const body = fs.readFileSync("apps/cloud/src/runtime.ts", "utf8").replace(/\r\n/g, "\n");
  assert.match(body, /\.\.\.learningFunnelHeartbeat\(\), \.\.\.learningLoopHeartbeat\(\)/);
  assert.match(body, /if \(Object\.keys\(out\)\.length === 0\) return \{\};/);
  assert.match(body, /out\.discoveryPasses > out\.configurations/);
  assert.match(body, /out\.shadowWins > out\.shadowTrades/);
});

test("the contract carries the null comparator figures (counts, signed bp) and drops the object when they are malformed or inconsistent", () => {
  const { buildPersonalPaperOperationsSnapshot } = require("../dist/packages/contracts/src/personalPaperOperations.js");
  const nulls = { nullSince: 5, nullSeed: 20261030, nullBaseTrades: 3, nullBaseNetBp: -40, nullHoldMarkets: 2, nullHoldNetBp: -15, nullRandTrades: 3, nullRandWins: 1, nullRandNetBp: -55, nullRandSkipped: 0, evaluatedAt: 1_000 };
  const runtime = fs.readFileSync("apps/cloud/src/runtime.ts", "utf8");
  assert.match(runtime, /out\.nullRandWins > out\.nullRandTrades/);
  assert.match(runtime, /"nullBaseNetBp", "nullHoldNetBp", "nullRandNetBp"\] as const\) put\(key, signed/);
  const contract = fs.readFileSync("packages/contracts/src/personalPaperOperations.ts", "utf8");
  for (const key of Object.keys(nulls).filter((k) => k !== "evaluatedAt")) assert.ok(contract.includes(`readonly ${key}?: number;`) && contract.includes(`"${key}"`), `${key} is a declared, validated field`);
  assert.equal(typeof buildPersonalPaperOperationsSnapshot, "function");
});
