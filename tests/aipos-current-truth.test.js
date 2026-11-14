"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { OUTPUT, render, newestHandoff } = require("../scripts/generate-aipos-current-truth.js");

// WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH: .aipos/CURRENT_TRUTH.md is generated, never hand-written.
const repo = path.join(__dirname, "..");

test("CURRENT_TRUTH.md is generated on read and never committed", () => {
  const ignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8").replace(/\r\n/g, "\n").split("\n");
  assert.ok(ignore.includes(OUTPUT), `${OUTPUT} must be listed in .gitignore`);
  const tracked = spawnSync("git", ["ls-files", "--", OUTPUT], { cwd: repo, encoding: "utf8" });
  // A failing git command must fail this test, never skip the check.
  assert.equal(tracked.status, 0, `git ls-files failed: ${tracked.stderr}`);
  assert.equal(tracked.stdout.trim(), "", `${OUTPUT} must not be tracked (generated on read)`);
});

test("--stdout prints exactly what render() returns and writes no file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-truth-stdout-"));
  fs.cpSync(path.join(repo, ".aipos", "handoffs"), path.join(root, ".aipos", "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".aipos", "work-orders", "archive"), { recursive: true });
  fs.writeFileSync(path.join(root, ".aipos", "work-orders", "WO-X.yaml"), "id: WO-X\ntitle: X\nstatus: IN_PROGRESS\n");
  const run = spawnSync(process.execPath, [path.join(repo, "scripts", "generate-aipos-current-truth.js"), "--stdout"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, render(root));
  assert.equal(fs.existsSync(path.join(root, OUTPUT)), false);
});

test("the cold-start instructions tell the agent to generate the file", () => {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = fs.readFileSync(path.join(repo, name), "utf8").replace(/\r\n/g, "\n");
    assert.match(text, /aipos:truth|generate-aipos-current-truth/, `${name} must say how to generate CURRENT_TRUTH.md`);
    assert.match(text, /not committed|generated on read|untracked/i, `${name} must say the file is not committed`);
    assert.match(text, /regenerate it/i, `${name} must say to regenerate it every time, not trust an existing local copy`);
  }
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
