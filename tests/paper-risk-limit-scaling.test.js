const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { scalePaperRiskLimitsToCapital, PAPER_RISK_CAPITAL_RATIOS } = require("../dist/apps/cloud/src/paperRiskLimitScaling.js");
const { CLOUD_PAPER_RISK_LIMITS } = require("../dist/apps/cloud/src/cloudPaperCanonicalRiskGateway.js");
const { UPBIT_KRW_MINIMUM_ORDER_KRW } = require("../dist/apps/cloud/src/paperExecutionIntent.js");

test("a KRW 100,000 account gets capital-scaled KRW limits: 3x daily buy/sell (owner decision 2026-11-04) and a 10% daily-loss limit", () => {
  const limits = scalePaperRiskLimitsToCapital(CLOUD_PAPER_RISK_LIMITS, 100_000);
  assert.equal(limits.maxOrderNotional, 20_000);
  assert.equal(limits.maxPositionNotional, 50_000);
  assert.equal(limits.maxSymbolExposureNotional, 50_000);
  assert.equal(limits.maxPortfolioExposureNotional, 100_000);
  assert.equal(limits.maxDailyBuyNotional, 300_000);
  assert.equal(limits.maxDailySellNotional, 300_000);
  assert.ok(limits.maxDailyBuyNotional < CLOUD_PAPER_RISK_LIMITS.maxDailyBuyNotional && limits.maxDailySellNotional < CLOUD_PAPER_RISK_LIMITS.maxDailySellNotional, "still below the fixed canonical daily limits");
  assert.equal(limits.maxDailyLoss, 10_000);
  assert.ok(limits.maxOrderNotional >= UPBIT_KRW_MINIMUM_ORDER_KRW * 1.01, "the minimum order still fits");
});

test("scaling only ever tightens: every limit is at most the fixed canonical limit", () => {
  for (const capital of [1, 10_000, 100_000, 1_000_000, 10_000_000, 1e12]) {
    const limits = scalePaperRiskLimitsToCapital(CLOUD_PAPER_RISK_LIMITS, capital);
    for (const name of Object.keys(PAPER_RISK_CAPITAL_RATIOS)) assert.ok(limits[name] <= CLOUD_PAPER_RISK_LIMITS[name], `${name} at ${capital}`);
  }
  const large = scalePaperRiskLimitsToCapital(CLOUD_PAPER_RISK_LIMITS, 1e12);
  for (const name of Object.keys(PAPER_RISK_CAPITAL_RATIOS)) assert.equal(large[name], CLOUD_PAPER_RISK_LIMITS[name], "a large account keeps the fixed limits");
});

test("counts, ratios and the loss-limit policy pass through unchanged; bad capital fails closed", () => {
  const limits = scalePaperRiskLimitsToCapital(CLOUD_PAPER_RISK_LIMITS, 100_000);
  for (const name of ["maxOpenOrders", "maxOrdersPerSecond", "maxOrdersPerMinute", "maxSameSideStreak", "maxConsecutiveLosses", "maxSessionDrawdownRatio", "maxPriceDeviationRatio", "consecutiveLossLimitEnabled"]) {
    assert.equal(limits[name], CLOUD_PAPER_RISK_LIMITS[name], name);
  }
  assert.ok(Object.isFrozen(limits));
  for (const bad of [0, -1, Number.NaN, Infinity]) assert.throws(() => scalePaperRiskLimitsToCapital(CLOUD_PAPER_RISK_LIMITS, bad));
});

test("the runtime builds the canonical risk gateway with the capital-scaled limits", () => {
  const runtime = fs.readFileSync("apps/cloud/src/runtime.ts", "utf8");
  assert.match(runtime, /new CloudPaperCanonicalRiskGateway\(\{ database: durableRepository\.database\(\), initialCapital: config\.paperInitialCapitalKrw, limits: cloudPaperRiskLimitsForCapital\(config\.paperInitialCapitalKrw\),/);
});

test("closed-learning riskConfigHash is the fingerprint of the same scaled limits the gateway enforces", () => {
  const { CloudPaperCanonicalRiskGateway } = require("../dist/apps/cloud/src/cloudPaperCanonicalRiskGateway.js");
  const { CLOUD_PAPER_RISK_POLICY_FINGERPRINT, cloudPaperRiskPolicyFingerprint } = require("../dist/apps/cloud/src/cloudPaperRiskPolicyIdentity.js");
  const { cloudPaperRiskLimitsForCapital } = require("../dist/apps/cloud/src/paperRiskLimitScaling.js");
  const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
  const gateway = new CloudPaperCanonicalRiskGateway({ database: new SqliteDatabase(":memory:"), initialCapital: 100_000, sourceCommitSha: "a".repeat(40), limits: cloudPaperRiskLimitsForCapital(100_000) });
  const expected = cloudPaperRiskPolicyFingerprint(cloudPaperRiskLimitsForCapital(100_000));
  assert.equal(gateway.fingerprints.riskPolicy, expected);
  assert.notEqual(expected, CLOUD_PAPER_RISK_POLICY_FINGERPRINT);
  const closed = fs.readFileSync("apps/cloud/src/closedLearningProductionRuntime.ts", "utf8");
  assert.match(closed, /cloudPaperRiskPolicyFingerprint\(cloudPaperRiskLimitsForCapital\(config\.paperInitialCapitalKrw\)\)/);
});
