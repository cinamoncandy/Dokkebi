const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPaperExecutionIntent,
  validatePaperExecutionIntent,
  paperExecutionIntentCommandId,
} = require("../dist/apps/cloud/src/paperExecutionIntent.js");

const binding = Object.freeze({
  schemaVersion: 1,
  status: "BOUND_UNVERIFIED",
  authority: "PAPER_RESEARCH_ONLY",
  liveAuthority: "NONE",
  productionMutationAllowed: false,
  candidateId: "candidate-a",
  datasetId: "dataset-a",
  datasetContentSha256: "a".repeat(64),
  advisoryGeneratedAt: 100,
  periodStartAt: 200,
  advisoryFingerprintSha256: "b".repeat(64),
  bindingFingerprintSha256: "c".repeat(64),
  candidateStrategy: Object.freeze({
    candidateId: "candidate-a",
    familyId: "family-a",
    lineageId: "lineage-a",
    specificationHash: "d".repeat(64),
    codeSha: "e".repeat(40),
    costModelVersion: "cost-v1",
    parameters: Object.freeze({ shortPeriod: 5, longPeriod: 20 }),
  }),
});

function decision(action = "BUY", allocation = 0.1) {
  return Object.freeze({
    symbol: "KRW-BTC",
    action,
    confidence: 0.9,
    risk: "LOW",
    allocation,
    leverage: 1,
    score: action === "SELL" ? -0.9 : 0.9,
    reasons: Object.freeze(["fixture"]),
    decidedAt: 1_000,
    paperCandidateBinding: binding,
    paperCandidateStrategyDecision: Object.freeze({
      action,
      score: action === "SELL" ? -0.9 : 0.9,
      confidence: 0.9,
      reason: "fixture",
      observedAt: 900,
    }),
  });
}

function state(overrides = {}) {
  return Object.freeze({
    version: 1,
    initialCapital: 10_000_000,
    cash: 10_000_000,
    equity: 10_000_000,
    realizedPnL: 0,
    unrealizedPnL: 0,
    positions: Object.freeze([]),
    orders: Object.freeze([]),
    fills: Object.freeze([]),
    processedIdempotencyKeys: Object.freeze([]),
    updatedAt: 900,
    ...overrides,
  });
}

function buyPortfolio() {
  return Object.freeze({
    allocations: Object.freeze([Object.freeze({
      symbol: "KRW-BTC",
      instrument: "SPOT",
      action: "BUY",
      capital: 1_000_000,
      share: 0.1,
      leverage: 1,
      confidence: 0.9,
      risk: "LOW",
    })]),
    deployedCapital: 1_000_000,
    cashCapital: 9_000_000,
    reservedCapital: 0,
    grossShare: 0.1,
    futuresShare: 0,
    decidedAt: 1_000,
  });
}

test("canonical BUY intent is sized from PortfolioPlan capital", () => {
  const intent = buildPaperExecutionIntent({
    now: 1_100,
    market: "KRW-BTC",
    referencePrice: 50_000_000,
    portfolio: buyPortfolio(),
    decision: decision("BUY", 0.5),
    state: state(),
    investmentPercent: 100,
  });
  assert.equal(intent.quantity, 0.02);
  assert.equal(intent.allocationCapital, 1_000_000);
  assert.equal(intent.allocationShare, 0.1);
  assert.equal(intent.candidateId, "candidate-a");
  assert.match(intent.intentFingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal(paperExecutionIntentCommandId(intent), `paper-intent:${intent.intentFingerprintSha256}`);
});

test("owner investment percent scales the PortfolioPlan BUY target without changing the PortfolioPlan source", () => {
  const intent = buildPaperExecutionIntent({
    now: 1_100,
    market: "KRW-BTC",
    referencePrice: 50_000_000,
    portfolio: buyPortfolio(),
    decision: decision("BUY", 0.5),
    state: state(),
    investmentPercent: 25,
  });
  assert.equal(intent.allocationCapital, 250_000);
  assert.equal(intent.allocationShare, 0.025);
  assert.equal(intent.quantity, 0.005);
  assert.equal(intent.investmentPercent, 25);
});

test("intent fingerprint fails closed after sizing tamper", () => {
  const intent = buildPaperExecutionIntent({
    now: 1_100,
    market: "KRW-BTC",
    referencePrice: 50_000_000,
    portfolio: buyPortfolio(),
    decision: decision(),
    state: state(),
    investmentPercent: 100,
  });
  assert.throws(() => validatePaperExecutionIntent({ ...intent, quantity: 0.03 }), /FINGERPRINT_MISMATCH/);
});

test("reserved portfolio capital participates in account reconciliation without becoming BUY notional", () => {
  const portfolio = Object.freeze({
    ...buyPortfolio(),
    cashCapital: 8_000_000,
    reservedCapital: 1_000_000,
  });
  const intent = buildPaperExecutionIntent({
    now: 1_100,
    market: "KRW-BTC",
    referencePrice: 50_000_000,
    portfolio,
    decision: decision(),
    state: state(),
    investmentPercent: 100,
  });
  assert.equal(intent.allocationCapital, 1_000_000);
  assert.equal(intent.quantity, 0.02);
});

test("account and portfolio capital must reconcile before an intent exists", () => {
  assert.throws(() => buildPaperExecutionIntent({
    now: 1_100,
    market: "KRW-BTC",
    referencePrice: 50_000_000,
    portfolio: buyPortfolio(),
    decision: decision(),
    state: state({ equity: 9_000_000 }),
    investmentPercent: 100,
  }), /ACCOUNT_PORTFOLIO_MISMATCH/);
});

test("SELL intent requires zero target allocation and exits the canonical current position", () => {
  const sellState = state({
    cash: 5_000_000,
    equity: 10_000_000,
    positions: Object.freeze([Object.freeze({
      market: "KRW-BTC",
      quantity: 0.1,
      averageEntryPrice: 50_000_000,
      realizedPnL: 0,
      unrealizedPnL: 0,
      markPrice: 50_000_000,
    })]),
  });
  const portfolio = Object.freeze({
    allocations: Object.freeze([]),
    deployedCapital: 0,
    cashCapital: 10_000_000,
    reservedCapital: 0,
    grossShare: 0,
    futuresShare: 0,
    decidedAt: 1_000,
  });
  const intent = buildPaperExecutionIntent({
    now: 1_100,
    market: "KRW-BTC",
    referencePrice: 50_000_000,
    portfolio,
    decision: decision("SELL", 0),
    state: sellState,
    investmentPercent: 100,
  });
  assert.equal(intent.side, "SELL");
  assert.equal(intent.quantity, 0.1);
  assert.equal(intent.allocationCapital, 0);
  assert.equal(intent.allocationShare, 0);
});

test("SELL exit of a position above the order cap is chunked to the cap and never raises a quantity", () => {
  const mk = (qty) => state({
    cash: 5_000_000, equity: 10_000_000,
    positions: Object.freeze([Object.freeze({ market: "KRW-BTC", quantity: qty, averageEntryPrice: 50_000_000, realizedPnL: 0, unrealizedPnL: 0, markPrice: 50_000_000 })]),
  });
  const portfolio = Object.freeze({ allocations: Object.freeze([]), deployedCapital: 0, cashCapital: 10_000_000, reservedCapital: 0, grossShare: 0, futuresShare: 0, decidedAt: 1_000 });
  const build = (qty, maxOrderNotional) => buildPaperExecutionIntent({ now: 1_100, market: "KRW-BTC", referencePrice: 50_000_000, portfolio, decision: decision("SELL", 0), state: mk(qty), investmentPercent: 100, maxOrderNotional });
  const capped = build(0.5, 20_000_000); // position 25,000,000 > cap 20,000,000
  assert.equal(capped.quantity, 0.4);
  assert.ok(capped.quantity * capped.referencePrice <= 20_000_000);
  assert.equal(validatePaperExecutionIntent(capped).quantity, 0.4);
  assert.equal(build(0.3, 20_000_000).quantity, 0.3); // within cap: unchanged
  assert.equal(build(0.5, undefined).quantity, 0.5); // no cap given: previous behaviour
  assert.equal(build(0.5, 0).quantity, 0.5); // invalid cap ignored
});

test("boot-configured cap chunks SELL without a per-call cap and can be cleared", () => {
  const { configurePaperExitOrderNotionalCap } = require("../dist/apps/cloud/src/paperExecutionIntent.js");
  const st = state({ cash: 5_000_000, equity: 10_000_000, positions: Object.freeze([Object.freeze({ market: "KRW-BTC", quantity: 0.5, averageEntryPrice: 50_000_000, realizedPnL: 0, unrealizedPnL: 0, markPrice: 50_000_000 })]) });
  const portfolio = Object.freeze({ allocations: Object.freeze([]), deployedCapital: 0, cashCapital: 10_000_000, reservedCapital: 0, grossShare: 0, futuresShare: 0, decidedAt: 1_000 });
  const run = () => buildPaperExecutionIntent({ now: 1_100, market: "KRW-BTC", referencePrice: 50_000_000, portfolio, decision: decision("SELL", 0), state: st, investmentPercent: 100 }).quantity;
  try {
    configurePaperExitOrderNotionalCap(20_000_000);
    assert.equal(run(), 0.4);
    configurePaperExitOrderNotionalCap(undefined);
    assert.equal(run(), 0.5);
  } finally { configurePaperExitOrderNotionalCap(undefined); }
});
