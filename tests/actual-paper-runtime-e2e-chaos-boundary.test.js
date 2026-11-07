const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const source = fs.readFileSync("scripts/actual-paper-runtime-e2e.js", "utf8");
const supervisor = fs.readFileSync("scripts/paper-runtime-supervisor.js", "utf8");
const workflow = fs.readFileSync(".github/workflows/wo-0059-actual-paper-runtime.yml", "utf8");

test("Actual PAPER E2E exercises the canonical closed-learning production root", () => {
  assert.match(source, /const \{ PRODUCTION_RUNTIME_ENTRYPOINT \} = require\("\.\/start-cloud-runtime\.js"\);/);
  assert.match(source, /const runtimePath = resolve\(root, PRODUCTION_RUNTIME_ENTRYPOINT\);/);
  assert.match(source, /spawn\(process\.execPath, \[PRODUCTION_RUNTIME_ENTRYPOINT\]/);
  assert.match(source, /args: \[PRODUCTION_RUNTIME_ENTRYPOINT\]/);
  assert.match(source, /NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH: researchReplaySnapshotPath/);
  assert.match(source, /NUSA_QUALIFIED_PAPER_CHALLENGER_ARTIFACT_PATH: qualifiedArtifactPath/);
  assert.match(source, /closed_learning_production_root: true/);
  assert.doesNotMatch(source, /dist\/apps\/cloud\/src\/runtime\.js/);
});

test("automatic startup check remains separate from the bounded natural observation window", () => {
  assert.match(source, /async function waitForAutomaticRuntime\(/);
  assert.match(source, /startupSnapshot = await waitForAutomaticRuntime\(baseUrl, token\);[\s\S]*?const observation = await observeAutomaticRuntime\(/);
  assert.match(source, /minimumDurationMs: 60_000/);
  assert.match(source, /maximumDurationMs: 180_000/);
  assert.match(source, /minimumDecisionCycles: 3/);
  assert.match(source, /if \(elapsedMs >= minimumDurationMs && decisionCycleCount >= minimumDecisionCycles\)/);
  assert.match(source, /MAX_OBSERVATION_BUDGET_EXHAUSTED/);
  assert.doesNotMatch(source, /if \(.*(?:order|fill).*length === 0\)[\s\S]{0,100}break;/i);
});

test("observation evidence does not replace the existing readiness classifier or authority boundary", () => {
  assert.match(source, /liveAuthority: "NONE"/);
  assert.match(source, /productionMutationAllowed: false/);
  assert.match(source, /aiAuthority: "ZERO_AUTHORITY"/);
  assert.match(source, /execution: \{[\s\S]*?order_count: observedOrders\.length,[\s\S]*?fill_count: observedFills\.length/);
  assert.match(source, /result: observation\.status === "PASS" \? "PASS" : "INCOMPLETE"/);
  assert.match(workflow, /node scripts\/classify-actual-paper-runtime-readiness\.js artifacts\/operational-evidence\/actual-paper-runtime-e2e\.json/);
  assert.doesNotMatch(source, /require\("\.\/classify-actual-paper-runtime-readiness\.js"\)/);
});

test("PAPER chaos restart evidence binds the last pre-crash cycle to recovery", () => {
  assert.match(source, /buildBoundPaperChaosRestartEvidence\(root, secondCycleSnapshot, supervisedRecovery\)/);
  assert.doesNotMatch(source, /buildBoundPaperChaosRestartEvidence\(root, supervisedStart, supervisedRecovery\)/);
});

test("PAPER chaos E2E uses production bounded supervisor backoff instead of lease retry storm", () => {
  const supervisorBlock = source.match(/supervisor = new PaperRuntimeProcessSupervisor\(\{[\s\S]*?\n    \}\);/);
  assert.ok(supervisorBlock, "supervisor construction must remain present");
  assert.doesNotMatch(supervisorBlock[0], /initialBackoffMs\s*:/);
  assert.doesNotMatch(supervisorBlock[0], /maxBackoffMs\s*:/);
  assert.match(supervisorBlock[0], /stableWindowMs:\s*60_000/);
});

test("PAPER chaos restart segment is explicitly non-mutating without weakening writer safety", () => {
  assert.match(workflow, /NUSA_PAPER_CHAOS_E2E_NON_MUTATING:\s*"true"/);
  assert.match(supervisor, /baseEnv\.NUSA_PAPER_CHAOS_E2E_NON_MUTATING === "true"/);
  assert.match(supervisor, /NUSA_CLOUD_PAPER_INVESTMENT_PERCENT = "0"/);
  assert.match(supervisor, /PAPER_WRITER_LEASE_CONFLICT_EXIT_CODE = 75/);
  assert.match(supervisor, /DEFAULT_WRITER_LEASE_RETRY_MS = 31_000/);
  assert.match(supervisor, /PAPER_WRITER_ALREADY_ACTIVE.*childStderrTail/);
  assert.match(supervisor, /leaseConflict\s*\?\s*this\.writerLeaseRetryMs/);
});

test("PAPER chaos E2E keeps fail-closed authority invariants", () => {
  assert.match(source, /NUSA_MODE:\s*"PAPER"/);
  assert.match(source, /NUSA_LIVE_MUTATION:\s*"PROHIBITED"/);
  assert.match(source, /liveAuthority:\s*"NONE"/);
  assert.match(source, /productionMutationAllowed:\s*false/);
  assert.match(source, /aiAuthority:\s*"ZERO_AUTHORITY"/);
});

test("restart and replay duplicate-order/fill rejection remains in the actual runtime E2E", () => {
  assert.match(source, /repeatedOrders\.length !== 1 \|\| repeatedFills\.length !== 1/);
  assert.match(source, /new Set\(orderIds\)\.size !== orderIds\.length \|\| new Set\(fillIds\)\.size !== fillIds\.length/);
  assert.match(source, /paperLearning replay produced duplicate event ids after restart/);
  assert.match(source, /persisted_window_matches_recovery: true/);
});
