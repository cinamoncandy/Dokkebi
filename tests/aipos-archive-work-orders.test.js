"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { plan, apply } = require("../scripts/aipos-archive-work-orders.js");
const { gitBlobSha1, validateEvidenceRecord } = require("../scripts/validate-aipos-evidence.js");
const { resolveWorkOrderPath, listWorkOrderEntries } = require("../scripts/lib/aipos-work-order-paths.js");

// WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH: only closed AND merged orders move, byte for byte, and references still resolve.
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-archive-"));
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.eol", "lf");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  write(root, "README.md", "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "commit", "-q", "--allow-empty", "-m", "Merge pull request #77 from x/y");
  const orders = {
    "WO-MERGED.yaml": `id: WO-MERGED\nstatus: COMPLETED\nmerge_commit: ${merged}\n`,
    "WO-PR.yaml": "id: WO-PR\nstatus: completed\npull_request: 77\n",
    "WO-NOPROOF.yaml": "id: WO-NOPROOF\nstatus: COMPLETED\npull_request: 78\n",
    "WO-OPEN.yaml": `id: WO-OPEN\nstatus: IN_PROGRESS\nmerge_commit: ${merged}\n`,
    "WO-AMBIGUOUS.yaml": `id: WO-AMBIGUOUS\nstatus: COMPLETED_FAIL\nmerge_commit: ${merged}\n`,
    "WO-LINKED.yaml": `id: WO-LINKED\nstatus: COMPLETED\nmerge_commit: ${merged}\n`,
    "WO-DUP-A.yaml": `id: WO-DUP\nstatus: COMPLETED\nmerge_commit: ${merged}\n`,
    "WO-DUP-B.yaml": `id: WO-DUP\nstatus: COMPLETED\nmerge_commit: ${merged}\n`,
  };
  for (const [name, body] of Object.entries(orders)) write(root, `.aipos/work-orders/${name}`, body);
  write(root, "docs/note.md", "See .aipos/work-orders/WO-LINKED.yaml\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "orders");
  return { root, orders };
}

test("only closed, merge-proven, uniquely-identified, unreferenced orders are planned", () => {
  const { root } = fixture();
  const { move, stay } = plan(root);
  assert.deepEqual(move.map((m) => m.name).sort(), ["WO-MERGED.yaml", "WO-PR.yaml"]);
  const reason = (name) => stay.find((s) => s.name === name).reason;
  assert.match(reason("WO-NOPROOF.yaml"), /merge not proven/);
  assert.match(reason("WO-OPEN.yaml"), /not an unambiguous closed/);
  assert.match(reason("WO-AMBIGUOUS.yaml"), /not an unambiguous closed/);
  assert.match(reason("WO-LINKED.yaml"), /still referenced by docs\/note\.md/);
  assert.match(reason("WO-DUP-A.yaml"), /not unique/);
});

test("apply moves the files byte for byte and deletes nothing", () => {
  const { root, orders } = fixture();
  apply(root, plan(root).move);
  for (const name of ["WO-MERGED.yaml", "WO-PR.yaml"]) {
    assert.equal(fs.existsSync(path.join(root, ".aipos/work-orders", name)), false);
    assert.equal(fs.readFileSync(path.join(root, ".aipos/work-orders/archive", name), "utf8"), orders[name]);
  }
  assert.equal(listWorkOrderEntries(root).length, Object.keys(orders).length);
  assert.deepEqual(plan(root).move, [], "a second run is a no-op");
});

test("a recorded work-order path and its evidence still resolve after the move", () => {
  const { root, orders } = fixture();
  apply(root, plan(root).move);
  const old = ".aipos/work-orders/WO-MERGED.yaml";
  assert.equal(resolveWorkOrderPath(root, old), ".aipos/work-orders/archive/WO-MERGED.yaml");
  write(root, ".aipos/evidence/WO-MERGED.json", JSON.stringify({
    version: 1, id: "e", result: "PASS", observed_at: "2026-10-30T00:00:00Z",
    subject: { type: "work_order", id: "WO-MERGED", path: old, hash: { algorithm: "git-blob-sha1", value: gitBlobSha1(orders["WO-MERGED.yaml"]) } },
  }));
  const failures = validateEvidenceRecord(root, ".aipos/evidence/WO-MERGED.json", "WO-MERGED");
  assert.equal(failures.some((f) => f.startsWith("EVIDENCE_SUBJECT_PATH_MISSING") || f.startsWith("EVIDENCE_SUBJECT_HASH")), false, failures.join(","));
});
