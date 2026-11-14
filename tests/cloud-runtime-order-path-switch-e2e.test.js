const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startCloudRuntime } = require("../dist/apps/cloud/src/runtime.js");
const { CloudRuntimeDashboardHydrator } = require("../dist/apps/cloud/src/cloudRuntimeDashboardHydrator.js");

// Decision-driven proof for NUSA_PAPER_ORDER_PATH (WO-OPS-20261114-ORDER-PATH-SWITCH, runbook precondition for Stage A).
// The harness is the one tests/cloud-runtime-paper-learning-issue-755.test.js uses: a real composition root, a real
// BUY decision from a +3% tick, and the real /api/paper-operations projection. The ON run is the control: it must
// produce a FILL, otherwise a missing FILL under OFF would prove nothing.
const principal = Object.freeze({ userId: "operator", scopes: Object.freeze(["dashboard:read"]) });

function bindPaperDecision(decision) {
  if (decision.action !== "BUY" && decision.action !== "SELL") return decision;
  const candidateId = "sma-5-20";
  return Object.freeze({
    ...decision,
    // Leave deterministic fee headroom inside the configured PAPER allocation. The fixture must
    // exercise a real challenger-bound fill without asking the execution loop to spend the full
    // allocation before fees, which correctly fails closed at the cash-allocation guard.
    allocation: Math.min(decision.allocation, 0.5),
    paperCandidateBinding: Object.freeze({
      schemaVersion: 1,
      status: "BOUND_UNVERIFIED",
      authority: "PAPER_RESEARCH_ONLY",
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      candidateId,
      datasetId: "fixture-dataset",
      datasetContentSha256: "a".repeat(64),
      advisoryGeneratedAt: decision.decidedAt - 2,
      periodStartAt: decision.decidedAt - 1,
      advisoryFingerprintSha256: "b".repeat(64),
      bindingFingerprintSha256: "c".repeat(64),
      candidateStrategy: Object.freeze({
        candidateId,
        familyId: "sma-crossover",
        lineageId: "fixture-lineage",
        specificationHash: "d".repeat(64),
        codeSha: "e".repeat(40),
        costModelVersion: "fixture-cost-v1",
        parameters: Object.freeze({ shortPeriod: 5, longPeriod: 20 })
      })
    }),
    paperCandidateStrategyDecision: Object.freeze({
      action: decision.action,
      score: decision.score,
      confidence: decision.confidence,
      reason: "candidate-bound production fixture",
      observedAt: decision.decidedAt
    })
  });
}

function candidateBoundDashboardHydrator() {
  const base = new CloudRuntimeDashboardHydrator();
  return {
    hydrate(provider, observations = []) {
      base.hydrate(provider, observations);
      const state = provider.read(principal);
      if (state == null) return;
      provider.set(Object.freeze({ ...state, decisions: Object.freeze(state.decisions.map(bindPaperDecision)) }));
    }
  };
}

// Issue #755: the real device symptom was an always-empty PAPER learning timeline. The pieces
// (recorder, durable replay, read-only projection) already had unit coverage in isolation, but
// nothing proved the actual `startCloudRuntime` composition root wires a real market tick all the
// way through to `/api/paper-operations.paperLearning.events` -- which is exactly the path that
// silently produced nothing on a real device. This test drives the real composition root with a
// single injected tick and asserts the acceptance chain the issue requires.

function tempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-paper-learning-e2e-"));
  return { directory, filename: path.join(directory, "cloud.sqlite") };
}

function testEnv(token, port, dbPath, overrides = {}) {
  return {
    NUSA_CLOUD_DASHBOARD_HOST: "127.0.0.1",
    NUSA_CLOUD_DASHBOARD_PORT: String(port),
    NUSA_CLOUD_DASHBOARD_TOKEN: token,
    NUSA_CLOUD_STATE_DB_PATH: dbPath,
    NUSA_CLOUD_UPBIT_PUBLIC_DATA: "true",
    NUSA_CLOUD_UPBIT_MARKETS: "KRW-BTC",
    NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: "10000000",
    NUSA_CLOUD_PAPER_INVESTMENT_PERCENT: "10",
    ...overrides
  };
}

function capturingFactory() {
  let onTicker;
  let onConnection;
  let onOrderBook;
  const factory = (_markets, tickerCallback, connectionCallback, orderBookCallback) => {
    onTicker = tickerCallback;
    onConnection = connectionCallback;
    onOrderBook = orderBookCallback;
    return { subscribe() {}, start() {}, stop() {} };
  };
  return { factory, fire: async (ticker) => {
    // Exercise the real snapshot/reconciler/quote path; never let a ticker-only fixture
    // manufacture an incomplete-cost fill. This public REST response is isolated test input.
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (String(url).startsWith("https://api.upbit.com/v1/orderbook?")) {
        return new Response(JSON.stringify([{ market: ticker.code, timestamp: Date.now() }]), { status: 200 });
      }
      return originalFetch(url, options);
    };
    try {
      onConnection("CONNECTED");
      await new Promise((resolve) => setImmediate(resolve));
      onOrderBook({ type: "orderbook", code: ticker.code, timestamp: Date.now(), total_ask_size: 100, total_bid_size: 100,
        orderbook_units: [{ ask_price: ticker.trade_price, bid_price: ticker.trade_price - 1, ask_size: 100, bid_size: 100 }] });
      onTicker(ticker);
    } finally { global.fetch = originalFetch; }
  } };
}

// Same +3% single-observation recipe already proven in tests/cloud-paper-production-e2e.test.js
// to deterministically produce a real BUY decision through the actual CIO/dashboard hydrator.
const buyTicker = () => ({
  type: "ticker",
  code: "KRW-BTC",
  trade_price: 50_000,
  trade_timestamp: Date.now(),
  signed_change_rate: 0.03,
  acc_trade_price_24h: 1_000_000_000
});

async function loadOperations(port, token) {
  const deadline = Date.now() + 5_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/paper-operations`, { headers: { authorization: `Bearer ${token}` } });
      if (response.status === 200) return response.json();
      last = new Error(`unexpected status ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw last;
}


async function runWith(overrides, port, label) {
  const token = ["order-path", label, "e2e", "fixture", "padding-to-reach-the-minimum-length"].join("-");
  const { directory, filename } = tempDbPath();
  let handle;
  try {
    const capture = capturingFactory();
    handle = startCloudRuntime(testEnv(token, port, filename, overrides), undefined, candidateBoundDashboardHydrator(), capture.factory);
    await capture.fire(buyTicker());
    const snapshot = await loadOperations(port, token);
    // A missing field is a failure, never an empty list: the projection must be observable in every run.
    assert.ok(Array.isArray(snapshot.paperLearning?.events), "paperLearning.events must be an array");
    assert.ok(Array.isArray(snapshot.orders), "orders must be an array");
    assert.ok(Array.isArray(snapshot.markets), "markets must be an array");
    const events = snapshot.paperLearning.events;
    return { snapshot, stages: events.map((event) => event.stage), events };
  } finally {
    if (handle) await handle.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("control: with the order path ON a BUY decision produces a FILL (the harness can see an order)", async () => {
  const run = await runWith({}, 41_981, "on");
  assert.equal(run.snapshot.operations?.pipelineStage, "PAPER_EXECUTION_LOOP");
  assert.ok(run.stages.includes("DECISION"));
  assert.ok(run.stages.includes("FILL"), `control must fill, got ${run.stages.join(",")}`);
});

test("a BUY decision with the order path OFF produces no order, no fill and no order intent, while the read-only dashboard and market data continue", async () => {
  for (const [value, port] of [["OFF", 41_982], ["off", 41_983], ["true", 41_984]]) {
    const run = await runWith({ NUSA_PAPER_ORDER_PATH: value }, port, `off-${port}`);
    assert.equal(run.snapshot.liveAuthority, "NONE");
    assert.equal(run.snapshot.productionMutationAllowed, false);
    // The read-only dashboard still answers, the pipeline reports no execution loop, and market data still reaches it.
    assert.equal(run.snapshot.operations?.pipelineStage, "READ_ONLY_DASHBOARD", `pipeline stage with ${JSON.stringify(value)}`);
    assert.ok(run.snapshot.markets.some((market) => market.market === "KRW-BTC"), `market data must still be received with ${JSON.stringify(value)}`);
    assert.ok(!run.stages.includes("FILL"), `no FILL may exist with ${JSON.stringify(value)}, got ${run.stages.join(",")}`);
    // Scope: this proves that no order intent PASSES and no fill exists. It does not prove that a refusal event is recorded
    // (without an order boundary no intent event is expected) and it covers the tick-driven path only.
    const intents = run.events.filter((event) => event.stage === "ORDER_INTENT");
    assert.ok(intents.every((event) => event.status !== "PASS"), `no passing ORDER_INTENT may exist with ${JSON.stringify(value)}`);
    assert.equal(run.snapshot.orders.length, 0, "the read-only order list must be empty");
  }
});

test("candidate rollback mitigation on THIS build: with the PAPER capital unset no order path exists either (not proof for an older build)", async () => {
  const run = await runWith({ NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: undefined }, 41_985, "nocapital").catch((error) => ({ error }));
  if (run.error) { assert.fail(`the runtime must start without capital as read-only: ${run.error.message}`); }
  assert.ok(!run.stages.includes("FILL"), `no FILL may exist without capital, got ${run.stages.join(",")}`);
});
