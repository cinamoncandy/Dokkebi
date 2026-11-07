const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sanitizeAutopilotDispatch } = require("../scripts/sanitize-autopilot-dispatch.js");

test("persisted dispatch keeps evidence identity but excludes the one-time capability", () => {
  const event = { action: "nusa_autopilot_execution", client_payload: { workflow_run_id: 456, head_sha: "a".repeat(40), causal_dispatch_capability: "secret-capability" } };
  const result = sanitizeAutopilotDispatch(event);
  assert.equal(result.client_payload.workflow_run_id, 456);
  assert.equal(result.client_payload.head_sha, "a".repeat(40));
  assert.equal(Object.hasOwn(result.client_payload, "causal_dispatch_capability"), false);
  assert.equal(JSON.stringify(result).includes("secret-capability"), false);
  assert.equal(event.client_payload.causal_dispatch_capability, "secret-capability");
});

test("malformed dispatch event cannot be persisted as trusted evidence", () => {
  for (const value of [null, [], {}, { client_payload: null }, { client_payload: [] }]) {
    assert.throws(() => sanitizeAutopilotDispatch(value), /AUTOPILOT_DISPATCH_EVENT_INVALID/);
  }
});

test("malformed input cannot leak its capability through the sanitizer's stderr", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-dispatch-sanitize-"));
  try {
    const input = path.join(directory, "input.json");
    const output = path.join(directory, "output.json");
    const secret = "secret-capability-do-not-print";
    fs.writeFileSync(input, `{"client_payload":{"causal_dispatch_capability":"${secret}",`);
    const result = spawnSync(process.execPath, [path.resolve("scripts/sanitize-autopilot-dispatch.js"), input, output], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AUTOPILOT_DISPATCH_SANITIZATION_FAILED/);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
