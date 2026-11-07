"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateWorkOrderStatuses, STATUS_BASELINE_PATH } = require("../scripts/validate-aipos-yaml.js");
const { STATUS_ENUM } = require("../scripts/lib/aipos-work-order-status.js");

// WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH: one status enum; the legacy spellings can only shrink.
function fixture(orders, legacy = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-wo-status-"));
  fs.mkdirSync(path.join(root, ".aipos", "work-orders", "archive"), { recursive: true });
  for (const [name, status] of Object.entries(orders)) {
    fs.writeFileSync(path.join(root, ".aipos", "work-orders", name), `id: ${name}\nstatus: ${status}\n`);
  }
  fs.writeFileSync(path.join(root, STATUS_BASELINE_PATH), JSON.stringify({ legacy }));
  return root;
}

test("the repository's work orders pass the status gate", () => {
  const { failures } = validateWorkOrderStatuses(path.join(__dirname, ".."));
  assert.deepEqual(failures, []);
});

test("a new work order must use the enum", () => {
  const root = fixture({ "WO-NEW.yaml": "COMPLETE" });
  assert.equal(validateWorkOrderStatuses(root).failures.length, 1);
  for (const status of STATUS_ENUM) {
    assert.deepEqual(validateWorkOrderStatuses(fixture({ "WO-NEW.yaml": status })).failures, []);
  }
});

test("a legacy order keeps only its recorded spelling", () => {
  assert.deepEqual(validateWorkOrderStatuses(fixture({ "WO-OLD.yaml": "COMPLETE" }, { "WO-OLD.yaml": "COMPLETE" })).failures, []);
  assert.equal(validateWorkOrderStatuses(fixture({ "WO-OLD.yaml": "VERIFIED" }, { "WO-OLD.yaml": "COMPLETE" })).failures.length, 1);
});

test("a baseline entry that is fixed or gone must be removed", () => {
  assert.equal(validateWorkOrderStatuses(fixture({ "WO-OLD.yaml": "COMPLETED" }, { "WO-OLD.yaml": "COMPLETE" })).failures.length, 1);
  assert.equal(validateWorkOrderStatuses(fixture({}, { "WO-GONE.yaml": "COMPLETE" })).failures.length, 1);
});

test("an archived order is still checked", () => {
  const root = fixture({});
  fs.writeFileSync(path.join(root, ".aipos", "work-orders", "archive", "WO-A.yaml"), "id: WO-A\nstatus: MERGED\n");
  assert.equal(validateWorkOrderStatuses(root).failures.length, 1);
});

test("the baseline is sorted, never lists an enum value, and can only shrink", () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, "..", STATUS_BASELINE_PATH), "utf8"));
  const names = Object.keys(baseline.legacy);
  assert.deepEqual([...names].sort(), names);
  assert.ok(Object.values(baseline.legacy).every((status) => !STATUS_ENUM.includes(status)));
  assert.ok(names.length <= 167, "the baseline can only shrink; lower this cap when entries are removed");
});
