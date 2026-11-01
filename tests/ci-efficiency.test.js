const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

test("CI produces core and UI/E2E coverage in parallel before a merge-only job", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.doesNotMatch(workflow, /- name: UI tests\n/);
  assert.doesNotMatch(workflow, /- name: E2E tests\n/);
  assert.doesNotMatch(workflow, /- name: Full isolated test suite\n/);
  assert.match(workflow, /coverage-core:\n/);
  assert.match(workflow, /matrix:\n\s+shard: \[0, 1, 2, 3\]/);
  assert.match(workflow, /- name: Core isolated coverage shard\n[\s\S]*?run: node scripts\/run-tests-isolated\.js/);
  assert.match(workflow, /coverage-ui-e2e:\n/);
  assert.match(workflow, /- name: Produce UI and E2E coverage in parallel with core shards\n[\s\S]*?--produce-ui-e2e/);
  assert.match(workflow, /name: coverage-ui-precomputed/);
  assert.match(workflow, /name: coverage-v8-e2e/);
  assert.match(workflow, /needs: \[coverage-core, coverage-ui-e2e\]/);
  assert.match(workflow, /pattern: coverage-v8-\*/);
  assert.match(workflow, /- name: Merge coverage baseline\n[\s\S]*?--merge-precomputed/);

  const validation = workflow.split("\n  validation:\n")[1].split("\n  coverage-core:\n")[0];
  assert.doesNotMatch(validation, /Install Playwright Chromium/);

  const producer = workflow.split("\n  coverage-ui-e2e:\n")[1].split("\n  coverage:\n")[0];
  assert.ok(
    producer.indexOf("- name: Install Playwright Chromium") < producer.indexOf("- name: Produce UI and E2E coverage in parallel with core shards"),
    "Playwright Chromium must be installed before parallel E2E coverage execution"
  );
  const mergeJob = workflow.split("\n  coverage:\n")[1].split("\n  test:\n")[0];
  assert.doesNotMatch(mergeJob, /Install Playwright Chromium/);
  assert.doesNotMatch(mergeJob, /playwright test/);
});

test("prepared coverage modes skip only setup already proven by their CI producer", () => {
  const workflow = read(".github/workflows/ci.yml");
  const pkg = JSON.parse(read("package.json"));
  const coverage = read("scripts/run-coverage.js");
  assert.match(workflow, /- name: Preflight\n\s+run: pnpm run preflight/);
  assert.ok(workflow.indexOf("- name: Preflight") < workflow.indexOf("- name: Typecheck"), "Preflight must pass before Typecheck");
  assert.ok(workflow.indexOf("- name: Typecheck") < workflow.indexOf("- name: Build"), "Typecheck must pass before Build");
  assert.equal(pkg.scripts.coverage, "node scripts/run-coverage.js");
  assert.equal(pkg.scripts["coverage:prepared"], "node scripts/run-coverage.js --prepared");
  assert.equal(pkg.scripts["release:check:prepared"], "node scripts/release-readiness.js");
  assert.match(pkg.scripts["release:check"], /preflight/);
  assert.match(pkg.scripts["release:check"], /typecheck/);
  assert.match(pkg.scripts["release:check"], /build/);
  assert.match(pkg.scripts["release:check"], /release-readiness\.js/);
  assert.match(coverage, /process\.argv\.includes\("--prepared"\)/);
  assert.match(coverage, /process\.argv\.includes\("--reuse-core-v8"\)/);
  assert.match(coverage, /process\.argv\.includes\("--produce-ui-e2e"\)/);
  assert.match(coverage, /process\.argv\.includes\("--merge-precomputed"\)/);
  assert.match(coverage, /NUSA_COVERAGE_E2E_V8_DIR/);
  assert.match(coverage, /NUSA_COVERAGE_COMBINED_V8_DIR/);
  assert.match(coverage, /if \(!prepared\) runSetup\(\)/);
  assert.match(coverage, /run-tests-isolated\.js/);
  assert.match(coverage, /vitest\.config\.mjs/);
  assert.match(coverage, /playwrightCommand, "test"/);
});

test("CI optimization preserves critical safety gates", () => {
  const workflow = read(".github/workflows/ci.yml");
  for (const step of [
    "Security gate",
    "AI zero-authority architecture validation",
    "Restricted LIVE governance validation",
    "PAPER runtime operational verification",
    "Deployment capability scan (live trading / credential storage must be absent)",
    "Risk safety drills"
  ]) {
    assert.ok(workflow.includes(`- name: ${step}`), `missing critical CI step: ${step}`);
  }
  assert.match(workflow, /run: pnpm run release:check:prepared/);
  assert.match(workflow, /test:\n\s+name: test\n\s+needs: \[validation, coverage, verify-causal-positive-verification\]/);
  assert.match(workflow, /needs\.verify-causal-positive-verification\.result/);
});


test("core shard runner consumes validated multi-run timing evidence", () => {
  const runner = read("scripts/run-tests-isolated.js");
  const evidence = JSON.parse(read("scripts/lib/deterministic-test-shard-costs.json"));
  assert.match(runner, /deterministic-test-shard-costs\.json/);
  assert.match(runner, /selectDeterministicShard\(allFiles, shard, shardCostEvidence\)/);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.sourceRuns.length, 4);
  assert.ok(Object.keys(evidence.costsMs).length > 300);
  assert.ok(Object.keys(evidence.costsMs).length < 1189);
  assert.equal(evidence.defaultDurationMs, 245);
  assert.ok(evidence.costsMs["tests/research-experiment-composition.test.js"] > 1000);
});
