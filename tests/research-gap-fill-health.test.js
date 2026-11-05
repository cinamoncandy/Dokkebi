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
  proto.recordGapFill.call(o, [
    { market: "KRW-BTC", status: "FILLED", missing: 2, recorded: 2, rejected: 0, pages: 1 },
    { market: "KRW-ETH", status: "NO_GAPS", missing: 0, recorded: 0, rejected: 0, pages: 0 },
  ], 100);
  proto.noteGapFillDeferred.call(o);
  proto.recordGapFill.call(o, [
    { market: "KRW-BTC", status: "RATE_LIMITED", missing: 2, recorded: 0, rejected: 0, pages: 1, errorCode: "RATE_LIMITED" },
    { market: "invalid market", status: "ERROR", missing: 1, recorded: 0, rejected: 1, pages: 0, errorCode: "not a code" },
    { market: "KRW-ETH", status: "UNKNOWN", missing: 0, recorded: 0, rejected: 0, pages: 0 },
    { market: "KRW-XRP", status: "PARTIAL", missing: -1, recorded: 0, rejected: 0, pages: 1 },
    { market: "KRW-DOGE", status: "FILLED", missing: 1, recorded: 1, rejected: 0, pages: 1 },
    { market: "KRW-DOGE", status: "ERROR", missing: 1, recorded: 0, rejected: 1, pages: 1 },
    { market: "KRW-SECRET", status: "ERROR", missing: 0, recorded: 0, rejected: 0, pages: 0, errorCode: "raw secret" },
  ], 200);
  assert.deepEqual(proto.gapFill.call(o), {
    lastRunAt: 200, runs: 2, deferred: 1,
    counts: { FILLED: 2, NO_GAPS: 1, RATE_LIMITED: 1, ERROR: 3, UNKNOWN: 1, PARTIAL: 1 },
    lastByMarket: {
      "KRW-BTC": { lastAttemptAt: 200, status: "RATE_LIMITED", missing: 2, recorded: 0, rejected: 0, pages: 1, errorCode: "RATE_LIMITED" },
      "KRW-SECRET": { lastAttemptAt: 200, status: "ERROR", missing: 0, recorded: 0, rejected: 0, pages: 0 },
    },
    lastErrorCode: "RATE_LIMITED",
  });
});

test("latest per-market outcomes replace prior results, and a deferred run preserves the last actual attempt", () => {
  const o = fresh();
  proto.recordGapFill.call(o, [
    { market: "KRW-BTC", status: "FILLED", missing: 1, recorded: 1, rejected: 0, pages: 1 },
    { market: "KRW-ETH", status: "NO_GAPS", missing: 0, recorded: 0, rejected: 0, pages: 0 },
  ], 100);
  const first = proto.gapFill.call(o);
  proto.noteGapFillDeferred.call(o);
  assert.deepEqual(proto.gapFill.call(o).lastByMarket, first.lastByMarket);
  proto.recordGapFill.call(o, [
    { market: "KRW-BTC", status: "ERROR", missing: 2, recorded: 0, rejected: 1, pages: 1, errorCode: "REQUEST_FAILED" },
  ], 300);
  assert.deepEqual(proto.gapFill.call(o).lastByMarket, {
    "KRW-BTC": { lastAttemptAt: 300, status: "ERROR", missing: 2, recorded: 0, rejected: 1, pages: 1, errorCode: "REQUEST_FAILED" },
    "KRW-ETH": { lastAttemptAt: 100, status: "NO_GAPS", missing: 0, recorded: 0, rejected: 0, pages: 0 },
  });
});

test("gap-fill per-market diagnostics are capped at twenty markets", () => {
  const o = fresh();
  const results = Array.from({ length: 24 }, (_, index) => ({
    market: `KRW-M${index}`, status: "NO_GAPS", missing: 0, recorded: 0, rejected: 0, pages: 0,
  }));
  proto.recordGapFill.call(o, results, 100);
  assert.equal(Object.keys(proto.gapFill.call(o).lastByMarket).length, 20);
  assert.equal(proto.gapFill.call(o).lastByMarket["KRW-M0"], undefined, "oldest result is evicted when the bounded market set changes");
  assert.equal(proto.gapFill.call(o).lastByMarket["KRW-M23"].status, "NO_GAPS");
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
    researchGapFill: { lastRunAt: 5, runs: 3, deferred: 2, counts: { FILLED: 2, "KRW-BTC secret": 9, ERROR: 1 }, lastErrorCode: "REQUEST_FAILED", extra: "private", lastByMarket: {
      "KRW-BTC": { lastAttemptAt: 4, status: "RATE_LIMITED", missing: 3, recorded: 0, rejected: 0, pages: 1, errorCode: "RATE_LIMITED", extra: "private" },
      "KRW-XRP": { lastAttemptAt: 4, status: "ERROR", missing: 4, recorded: 0, rejected: 1, pages: 2, errorCode: "UPSTREAM_FAILED", rawError: "secret text" },
      "KRW-ETH secret": { status: "ERROR", missing: 1, recorded: 0, rejected: 0, pages: 1 },
      "KRW-DOGE": { status: "COMPLETE", missing: 1, recorded: 1, rejected: 0, pages: 1 },
      "KRW-SOL": { status: "FILLED", missing: -1, recorded: 1, rejected: 0, pages: 1 },
    } } };
  const server = startCloudDashboardServer({ tokenVerifier: { verify: () => undefined }, loadDashboard: () => { throw new Error("unused"); }, port: 43000 + Math.floor(Math.random() * 900), runtimeLiveness: () => liveness });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const body = await get(server.port);
    assert.deepEqual(body.runtime.researchGapFill, { runs: 3, deferred: 2, counts: { FILLED: 2, ERROR: 1 }, lastByMarket: {
      "KRW-BTC": { lastAttemptAt: 4, status: "RATE_LIMITED", missing: 3, recorded: 0, rejected: 0, pages: 1, errorCode: "RATE_LIMITED" },
      "KRW-XRP": { lastAttemptAt: 4, status: "ERROR", missing: 4, recorded: 0, rejected: 1, pages: 2, errorCode: "UPSTREAM_FAILED" },
    }, lastRunAt: 5, lastErrorCode: "REQUEST_FAILED" });
    assert.doesNotMatch(JSON.stringify(body), /secret|private|rawError/);
  } finally {
    await server.stop();
  }
});

test("/health caps per-market diagnostics and rejects rows with invalid counters", async () => {
  const lastByMarket = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`KRW-M${index}`, {
    lastAttemptAt: 1_900, status: "FILLED", missing: 0, recorded: 0, rejected: 0, pages: 1,
  }]));
  lastByMarket["KRW-BAD"] = { lastAttemptAt: 1_900, status: "ERROR", missing: 0, recorded: 0, rejected: -1, pages: 1 };
  const liveness = { startedAt: 1, lastHeartbeatAt: 1, lastMarketEventAt: null, lastPaperDecisionAt: null, lastPaperOrderAt: null, lastPaperFillAt: null, eventCount: 0, decisionCount: 0, paperOrderCount: 0, paperFillCount: 0, lastError: null,
    researchGapFill: { runs: 1, deferred: 0, counts: {}, lastByMarket } };
  const server = startCloudDashboardServer({ tokenVerifier: { verify: () => undefined }, loadDashboard: () => { throw new Error("unused"); }, port: 43000 + Math.floor(Math.random() * 900), runtimeLiveness: () => liveness });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const published = (await get(server.port)).runtime.researchGapFill.lastByMarket;
    assert.equal(Object.keys(published).length, 20);
    assert.equal(published["KRW-M0"].status, "FILLED");
    assert.equal(published["KRW-BAD"], undefined, "invalid rows are withdrawn");
  } finally {
    await server.stop();
  }
});
