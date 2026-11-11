const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const source = fs.readFileSync(path.join(__dirname, "../.github/workflows/oracle-host-diagnose.yml"), "utf8");
test("existing diagnostic includes Research timer and bounded projection without mutation", () => {
  assert.match(source, /nusa-research\.service nusa-research\.timer/);
  assert.match(source, /NextElapseUSecRealtime,LastTriggerUSec/);
  assert.match(source, /--since "-26 hours"/); assert.match(source, /cut -c1-4096/);
  assert.match(source, /FORWARD_EXECUTION_EVIDENCE_UNAVAILABLE/);
  assert.doesNotMatch(source, /systemctl\s+(?:restart|start|enable|stop)|run-regime-forward-study\.js/);
});
test("forward-log projection excludes private or arbitrary fields", () => {
  const code = source.match(/node -e '([\s\S]*?)\n          '/)[1];
  const value = { status: "WAITING_HOLDOUT", executionSourceSha: "a".repeat(40), specificationFingerprint: "b".repeat(64), token: "test", privateField: "PRIVATE_VALUE" };
  const project = input => { const run = spawnSync(process.execPath, ["-e", code], { input, encoding: "utf8" }); assert.equal(run.status, 0); return run.stdout.trim(); };
  const output = project(`REGIME_FORWARD_STUDY ${JSON.stringify(value)}`);
  assert.deepEqual(JSON.parse(output), { status: value.status, executionSourceSha: value.executionSourceSha, specificationFingerprint: value.specificationFingerprint });
  assert.doesNotMatch(output, /PRIVATE_VALUE|token/);
  for (const input of ["REGIME_FORWARD_STUDY {", "REGIME_FORWARD_STUDY {\"status\":\"WAITING_HOLDOUT\"}", `REGIME_FORWARD_STUDY ${JSON.stringify({ ...value, status: "FORGED_PASS" })}`]) assert.equal(project(input), "FORWARD_EXECUTION_EVIDENCE_UNAVAILABLE");
  const records = project([value, { ...value, executionSourceSha: "c".repeat(40) }].map(v => `REGIME_FORWARD_STUDY ${JSON.stringify(v)}`).join("\n")).split("\n").map(JSON.parse);
  assert.equal(records.length, 2); assert.equal(records[1].executionSourceSha, "c".repeat(40));
});
