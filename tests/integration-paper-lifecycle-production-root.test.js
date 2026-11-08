import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const launcherSource = readFileSync(new URL("../scripts/start-cloud-runtime.js", import.meta.url), "utf8");
const productionSource = readFileSync(new URL("../apps/cloud/src/closedLearningProductionRuntime.ts", import.meta.url), "utf8");
const bareRuntimeSource = readFileSync(new URL("../apps/cloud/src/runtime.ts", import.meta.url), "utf8");

test("managed PAPER launcher targets the canonical closed-learning production root", () => {
  assert.match(
    launcherSource,
    /PRODUCTION_RUNTIME_ENTRYPOINT\s*=\s*["']dist\/apps\/cloud\/src\/closedLearningProductionRuntime\.js["']/,
  );
  assert.match(productionSource, /startClosedLearningProductionRuntime/);
  assert.match(productionSource, /new SqliteCloudPaperAccountRepository\(database,\s*\{\s*accountId: paperAccountIdForCapital\(config\.paperInitialCapitalKrw\),\s*deferWriterLease: true,/s);
  assert.match(productionSource, /deferPaperRuntimeStart: true/);
  assert.match(bareRuntimeSource, /new PaperTradingExecutionLoop\(/);
  assert.match(productionSource, /new PaperChallengerBindingLedger\(/);
  assert.match(productionSource, /new ClosedLearningProductionResearchAdapter\(/);
  assert.match(productionSource, /new ClosedLearningLoopCoordinator\(/);
  assert.match(productionSource, /new ClosedLearningRolloverScheduler\(/);
});

test("production closed-learning root wires Execution -> durable Ledger -> Performance read evidence", () => {
  assert.match(productionSource, /buildPaperPerformanceFromLedger/);
  assert.match(productionSource, /readPaperPerformanceEvidence/);
  assert.match(productionSource, /paperRepository\?\.loadHistory/);
  assert.match(productionSource, /baseHandle\.listPaperRealizedPeriods\(\)/);
  assert.match(productionSource, /accountHistory:\s*paperRepository\.loadHistory\(\)/);
});

test("bare cloud runtime remains a library/diagnostic entrypoint, not the managed PAPER production target", () => {
  assert.match(bareRuntimeSource, /export function startCloudRuntime/);
  assert.doesNotMatch(
    launcherSource,
    /PRODUCTION_RUNTIME_ENTRYPOINT\s*=\s*["']dist\/apps\/cloud\/src\/runtime\.js["']/,
  );
});

test("production composition preserves PAPER-only authority through the canonical runtime boundary", () => {
  assert.doesNotMatch(productionSource, /productionMutationAllowed\s*:\s*true/);
  assert.doesNotMatch(productionSource, /liveAuthority\s*:\s*["'](?:LIVE|FULL|ENABLED)["']/);
  assert.doesNotMatch(productionSource, /disposeIncompletePeriodFromCanonicalAccount/);
  assert.match(productionSource, /startCloudRuntimeFromOptions\(/);
  assert.doesNotMatch(bareRuntimeSource, /disposeIncompletePaperRealizedPeriod/);
  assert.match(bareRuntimeSource, /productionMutationAllowed:\s*false/);
  assert.match(bareRuntimeSource, /liveAuthority:\s*["']NONE["']/);
});
