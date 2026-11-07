const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { ResearchExperimentOrchestrator } = require("../dist/apps/cloud/src/researchExperimentOrchestrator.js");
const { startCloudDashboardServer } = require("../dist/apps/cloud/src/server.js");

const proto = ResearchExperimentOrchestrator.prototype;
const fresh = () => Object.create(proto);

test("gap-fill outcomes are counted by fixed status code, with the last error code and deferrals", () => {
  const o = fresh();
  assert.equal(proto.gapFill.call(o) ?? null, null);
  proto.recordGapFill.call(o, [{ status: "FILLED" }, { status: "NO_GAPS" }], 100);
  proto.noteGapFillDeferred.call(o);
  proto.recordGapFill.call(o, [{ status: "RATE_LIMITED", errorCode: "RATE_LIMITED" }, { status: "free text", errorCode: "not a code" }], 200);
  assert.deepEqual(proto.gapFill.call(o), { lastRunAt: 200, runs: 2, deferred: 1, counts: { FILLED: 1, NO_GAPS: 1, RATE_LIMITED: 1 }, lastErrorCode: "RATE_LIMITED" });
});

test("the composition records every gap-fill run and every deferral", () => {
  const source = fs.readFileSync("apps/cloud/src/researchExperimentComposition.ts", "utf8");
  assert.match(source, /finally \{\s*gapFilling = false;\s*try \{ orchestrator\.recordGapFill\(results, now\(\)(?:, \{ fillMs, readMs, materializeMs \})?\); \} catch/);
  assert.match(source, /if \(!retry\) \{ try \{ orchestrator\.noteGapFillDeferred\(\); \} catch/, "one deferral per scheduled attempt, not per one-second retry");
  assert.match(source, /scheduleGapFill\(true\); \}, 1_000\)/);
  assert.match(fs.readFileSync("apps/cloud/src/runtime.ts", "utf8"), /\.\.\.researchGapFillLiveness\(\),/);
});

function get(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/health", headers: { connection: "close" } }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => { body += c; }); res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

test("/health publishes only codes and integers for the gap fill", async () => {
  const liveness = { startedAt: 1, lastHeartbeatAt: 1, lastMarketEventAt: null, lastPaperDecisionAt: null, lastPaperOrderAt: null, lastPaperFillAt: null, eventCount: 0, decisionCount: 0, paperOrderCount: 0, paperFillCount: 0, lastError: null,
    researchGapFill: { lastRunAt: 5, runs: 3, deferred: 2, counts: { FILLED: 2, "KRW-BTC secret": 9, ERROR: 1 }, lastErrorCode: "REQUEST_FAILED", extra: "private" } };
  const server = startCloudDashboardServer({ tokenVerifier: { verify: () => undefined }, loadDashboard: () => { throw new Error("unused"); }, port: 43000 + Math.floor(Math.random() * 900), runtimeLiveness: () => liveness });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const body = await get(server.port);
    assert.deepEqual(body.runtime.researchGapFill, { runs: 3, deferred: 2, counts: { FILLED: 2, ERROR: 1 }, lastRunAt: 5, lastErrorCode: "REQUEST_FAILED" });
    assert.doesNotMatch(JSON.stringify(body), /secret|private/);
  } finally {
    await server.stop();
  }
});
