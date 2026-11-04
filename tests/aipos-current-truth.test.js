"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OUTPUT, render, newestHandoff } = require("../scripts/generate-aipos-current-truth.js");

// WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH: .aipos/CURRENT_TRUTH.md is generated, never hand-written.
const repo = path.join(__dirname, "..");

test("CURRENT_TRUTH.md is up to date with the work orders and newest handoff", () => {
  const committed = fs.readFileSync(path.join(repo, OUTPUT), "utf8");
  assert.equal(committed, render(repo), "stale: run `node scripts/generate-aipos-current-truth.js` and commit the result");
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-truth-"));
  for (const dir of ["work-orders/archive", "handoffs"]) fs.mkdirSync(path.join(root, ".aipos", dir), { recursive: true });
  const wo = (dir, name, status) => fs.writeFileSync(path.join(root, ".aipos", dir, name), `id: ${name.replace(".yaml", "")}\ntitle: T ${name}\nstatus: ${status}\n`);
  wo("work-orders", "WO-A.yaml", "IN_PROGRESS");
  wo("work-orders", "WO-B.yaml", "READY_FOR_REVIEW");
  wo("work-orders", "WO-C.yaml", "COMPLETE");
  wo("work-orders/archive", "WO-D.yaml", "COMPLETED");
  fs.writeFileSync(path.join(root, ".aipos/handoffs/2026-01-01-old.md"), "# Old\n\nold body\n");
  fs.writeFileSync(path.join(root, ".aipos/handoffs/2026-02-01-new.md"), "# New one\n\nnew body\n");
  return root;
}

test("the output changes when a work order or the newest handoff changes", () => {
  const root = fixture();
  const before = render(root);
  assert.match(before, /4 total: 3 in `\.aipos\/work-orders\/`, 1 closed and merged/);
  assert.match(before, /2026-02-01-new\.md/);
  assert.match(before, /\| `WO-A` \| IN_PROGRESS \|/);
  assert.doesNotMatch(before, /WO-B` \| READY/); // only in-progress/blocked orders are listed individually
  fs.writeFileSync(path.join(root, ".aipos/work-orders/WO-E.yaml"), "id: WO-E\ntitle: E\nstatus: BLOCKED\n");
  assert.notEqual(render(root), before);
});

test("the newest handoff is chosen by date prefix, not mtime", () => {
  assert.equal(newestHandoff(fixture()).path, ".aipos/handoffs/2026-02-01-new.md");
});

test("rendering is deterministic", () => {
  const root = fixture();
  assert.equal(render(root), render(root));
});
