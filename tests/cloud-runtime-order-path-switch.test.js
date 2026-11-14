const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { startCloudRuntime } = require("../dist/apps/cloud/src/runtime.js");

// A repository stub that records whether the PAPER order path asked for the writer lease.
const run = async (extra, port) => {
  const directory = mkdtempSync(join(tmpdir(), "nusa-order-path-switch-"));
  let leaseStarts = 0;
  const repository = { startWriterLease: () => { leaseStarts += 1; }, loadLatest: () => undefined, loadFills: () => [], save: () => undefined, clear: () => undefined };
  let handle;
  try {
    handle = startCloudRuntime({
      NUSA_CLOUD_STATE_DB_PATH: join(directory, "state.sqlite"),
      NUSA_CLOUD_DASHBOARD_PORT: String(port),
      NUSA_CLOUD_DASHBOARD_TOKEN: "order-path-switch-test-token-0123456789",
      NUSA_CLOUD_UPBIT_PUBLIC_DATA: "false",
      NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: "1000000",
      ...extra,
    }, undefined, undefined, undefined, undefined, repository);
    return leaseStarts;
  } finally {
    if (handle) await handle.stop();
    rmSync(directory, { recursive: true, force: true });
  }
};

test("order path switch: unset and ON keep the order path (writer lease requested)", async () => {
  assert.ok(await run({}, 42991) >= 1);
  assert.ok(await run({ NUSA_PAPER_ORDER_PATH: "ON" }, 42992) >= 1);
});

test("order path switch: OFF and any other value create no order path (fail closed)", async () => {
  for (const [value, port] of [["OFF", 42993], ["off", 42994], ["", 42995], ["true", 42996], ["ONN", 42997]]) {
    assert.equal(await run({ NUSA_PAPER_ORDER_PATH: value }, port), 0, `value ${JSON.stringify(value)} must disable the order path`);
  }
});
