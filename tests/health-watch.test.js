"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { decide, classifyProbe } = require("../scripts/health-watch-decide.js");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const good = (offsetMs = 0) => ({ httpStatus: 200, body: JSON.stringify({ ok: true, observedAt: new Date(NOW - offsetMs).toISOString() }) });

test("RUNNING expected: any non-answering probe is DOWN, an answering one is fine", () => {
  assert.equal(decide("RUNNING", good(), NOW).alert, "NONE");
  for (const probe of [{ httpStatus: 502, body: "" }, { httpStatus: 0, body: "" }, { httpStatus: 200, body: "not json" }, { httpStatus: 200, body: "{\"ok\":false}" }, { httpStatus: 200, body: "{\"ok\":true}" }, good(11 * 60 * 1000), good(-5 * 60 * 1000), null]) {
    assert.equal(decide("RUNNING", probe, NOW).alert, "DOWN", JSON.stringify(probe));
  }
});

test("STOPPED expected: an answering probe is UNEXPECTED_UP, silence and a stale answer are fine", () => {
  assert.equal(decide("STOPPED", good(), NOW).alert, "UNEXPECTED_UP");
  for (const probe of [{ httpStatus: 502, body: "" }, { httpStatus: 0, body: "" }, good(11 * 60 * 1000), null]) {
    assert.equal(decide("STOPPED", probe, NOW).alert, "NONE", JSON.stringify(probe));
  }
});

test("an unknown expected state is a configuration alarm, never silence", () => {
  for (const state of [undefined, "", "running", "UP", null, 1]) assert.equal(decide(state, good(), NOW).alert, "CONFIG_INVALID");
  assert.equal(classifyProbe(undefined, NOW).answering, false);
});

test("the committed config and workflow stay read-only and https", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy", "health-watch.json"), "utf8"));
  assert.ok(["STOPPED", "RUNNING"].includes(config.expectedState));
  assert.match(config.healthUrl, /^https:\/\/[a-z0-9.-]+\/health$/);
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "health-watch.yml"), "utf8").replace(/\r\n/g, "\n");
  assert.match(workflow, /permissions:\n  contents: read\n  issues: write\n/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /systemctl|ssh /);
  assert.doesNotMatch(workflow, /^\s*(pull_request|pull_request_target|workflow_run)\s*:/m);
  assert.match(workflow, /cron: "7,37 \* \* \* \*"/);
  // An unreadable or invalid config must end in a CONFIG_INVALID alarm, not in a step failure nobody reads.
  assert.match(workflow, /RESULT="CONFIG_INVALID unreadable_or_invalid_config"/);
  assert.match(workflow, /\|\| URL=""/);
  assert.match(workflow, /\|\| RESULT="CONFIG_INVALID unreadable_or_invalid_config"/);
});
