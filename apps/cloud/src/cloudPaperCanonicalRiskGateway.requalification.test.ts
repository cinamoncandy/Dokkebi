import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CLOUD_PAPER_RISK_LIMITS } from "./cloudPaperCanonicalRiskGateway";

const EXPECTED_RISK_BLOB = "b43962beb41a193eda30c8dc717f2cbcc8971edd";

function committedGitBlobSha(path: string): string {
  return execFileSync("git", ["rev-parse", `HEAD:${path}`], {
    cwd: process.cwd(),
    encoding: "utf8"
  }).trim();
}

describe("RISK exact-source re-qualification evidence", () => {
  it("binds evidence to the exact canonical RISK source blob", () => {
    const sourcePath = "apps/cloud/src/cloudPaperCanonicalRiskGateway.ts";
    readFileSync(sourcePath, "utf8");
    assert.equal(committedGitBlobSha(sourcePath), EXPECTED_RISK_BLOB);
  });

  it("qualifies fill-derived accounting without cancellation erasing executed risk", () => {
    const source = readFileSync("apps/cloud/src/cloudPaperCanonicalRiskGateway.ts", "utf8");
    assert.doesNotMatch(source, /order\.status === "CANCELLED"/);
    assert.match(source, /function rateState[\s\S]*?state\.fills/);
    assert.match(source, /function dailyNotional[\s\S]*?state\.fills/);
    assert.match(source, /function realizedLossState[\s\S]*?state\.fills/);
    assert.match(source, /second\.add\(fill\.orderId\)/);
    assert.match(source, /sellOrders\.set\(order\.orderId/);
  });

  it("re-qualifies intent-bound idempotency without placeholder payload identity", () => {
    const source = readFileSync("apps/cloud/src/cloudPaperCanonicalRiskGateway.ts", "utf8");
    assert.match(source, /payloadFingerprintSha256\?: string/);
    assert.match(source, /const payloadFingerprint = input\.payloadFingerprintSha256 \?\? hash\(/);
    assert.match(source, /IDEMPOTENCY_FINGERPRINT_INVALID/);
    assert.match(source, /payloadFingerprint, createdAtMs: input\.now/);
    assert.doesNotMatch(source, /payloadFingerprint:\s*"PENDING"/);
  });

  it("re-qualifies the consecutive-loss streak as scoped to the current canonical (Asia/Seoul) trading day", () => {
    const source = readFileSync("apps/cloud/src/cloudPaperCanonicalRiskGateway.ts", "utf8");
    assert.match(source, /const completed = \[\.\.\.sellOrders\.values\(\)\]\.filter\(\(sell\) => dayOf\(sell\.filledAt\) === today\)/);
    assert.match(source, /const dayOf = \(timestamp: number\): string => paperTradingDayKey\(timestamp\);/, "one canonical trading day, not a local UTC day");
    assert.match(readFileSync("apps/cloud/src/paperTradingDay.ts", "utf8"), /tradingDayKey\(timestamp\)/, "the helper delegates to the canonical Asia\/Seoul trading day");
    assert.doesNotMatch(source, /toISOString\(\)\.slice\(0, 10\)/);
    // The unmatched-sell fail-closed path is unchanged.
    assert.match(source, /consecutiveLossCount: Number\.MAX_SAFE_INTEGER/);
  });

  it("re-qualifies the loss-session counts as display only: recorded after the streak is computed and never read by a decision", () => {
    const source = readFileSync("apps/cloud/src/cloudPaperCanonicalRiskGateway.ts", "utf8");
    assert.match(source, /todayCompletedSells: completed\.length, todayLosingSells: completed\.filter\(\(sell\) => sell\.pnl < 0\)\.length/);
    assert.match(source, /public lossSession\(\): CloudPaperLossSessionSnapshot \| null \{\r?\n\s*return this\.lastLossSession;/);
    assert.equal((source.match(/this\.lastLossSession/g) ?? []).length, 2, "written once per evaluation and read only by lossSession()");
    assert.match(source, /consecutiveLossCount: lossState\.consecutiveLossCount, sessionPeakEquity/, "the decision still uses the same streak");
  });

  it("re-qualifies risk rows keyed by the real PAPER account id, with the legacy account read only to tighten", () => {
    const source = readFileSync("apps/cloud/src/cloudPaperCanonicalRiskGateway.ts", "utf8");
    assert.doesNotMatch(source, /ACCOUNT_ID|"paper-default"/, "no fixed account label");
    assert.match(source, /this\.accountId = resolveRiskAccountId\(options\.initialCapital, options\.accountId\)/);
    assert.match(source, /accountId: this\.accountId,\r?\n\s+requestId: `\$\{input\.path\}:\$\{input\.commandId\}`/);
    assert.match(source, /idempotency: \{ accountId: this\.accountId,/);
    assert.match(source, /new CanonicalRiskSafetyGate\(new AccountScopedRiskPersistence\(this\.persistence, this\.accountId\)\)/);
  });

  it("re-qualifies the persisted drawdown peak: restored at start, only raised, unknown halts", () => {
    const source = readFileSync("apps/cloud/src/cloudPaperCanonicalRiskGateway.ts", "utf8");
    assert.match(source, /this\.restorePeak\(\);/);
    assert.match(source, /this\.peakEquity = Math\.max\(this\.peakEquity, stored\.peak\)/);
    assert.match(source, /if \(!this\.peakVerified\) return Object\.freeze\(\{ status: "HALT", reasonCodes: Object\.freeze\(\["PERSISTENCE_UNHEALTHY"\]\) \}\);/);
    assert.match(source, /this\.peakEquity = Math\.max\(this\.peakEquity, currentEquity\);\r?\n\s+if \(!\(this\.peakEquity <= this\.persistedPeak\)\)/);
    // The limits are the same object the existing deepEqual test pins; the drawdown ratio is not touched here.
    assert.equal(CLOUD_PAPER_RISK_LIMITS.maxSessionDrawdownRatio, 0.2);
  });

  it("verifies owner-approved Cloud loss-veto removal and every other risk limit unchanged", () => {
    assert.deepEqual(CLOUD_PAPER_RISK_LIMITS, {
      maxOrderNotional: 2_000_000,
      maxPositionNotional: 2_000_000,
      maxOpenOrders: 1,
      maxOrdersPerSecond: 1,
      maxOrdersPerMinute: 60,
      maxSameSideStreak: 10,
      maxSymbolExposureNotional: 2_000_000,
      maxPortfolioExposureNotional: 2_000_000,
      maxDailyBuyNotional: 2_000_000,
      maxDailySellNotional: 2_000_000,
      maxDailyLoss: 1_000_000,
      maxConsecutiveLosses: 3,
      consecutiveLossLimitEnabled: false,
      maxSessionDrawdownRatio: 0.2,
      maxPriceDeviationRatio: 0.05
    });
  });
});
