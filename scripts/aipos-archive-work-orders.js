#!/usr/bin/env node
"use strict";
/**
 * Move closed, merged AIPOS work orders to `.aipos/work-orders/archive/`
 * (WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH).
 *
 * The directory held 500+ orders, so a cold agent had to reconcile stale claims by hand. This moves an
 * order only when ALL of these hold, and reports every other order with the reason it stayed:
 *   1. its status is an unambiguous closed spelling (COMPLETED, completed, COMPLETE, MERGED, VERIFIED);
 *   2. its merge is proven in the current history: `merge_commit` is an ancestor of HEAD, or its numeric
 *      `pull_request` appears as "Merge pull request #N" / "(#N)" in HEAD's commit subjects;
 *   3. its id is unique (colliding ids are reconciled by WO-0071 and must not move);
 *   4. no tracked file outside the work-order directory, and no other work order, names its path -- except
 *      evidence JSON under `.aipos/evidence/`, whose reader (validate-aipos-evidence.js) resolves the archive.
 * The file is renamed, never edited, so its bytes (and the git-blob hash the evidence records) are unchanged.
 * Nothing is deleted. Re-running is a no-op once everything eligible has moved.
 *
 *   node scripts/aipos-archive-work-orders.js          # dry run: print what would move and what stays
 *   node scripts/aipos-archive-work-orders.js --apply  # move the eligible orders
 */
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, renameSync } = require("node:fs");
const { join } = require("node:path");
const yaml = require("js-yaml");
const { WORK_ORDER_DIR, ARCHIVE_DIR, listWorkOrderEntries } = require("./lib/aipos-work-order-paths.js");
const { isClosedSpelling } = require("./lib/aipos-work-order-status.js");

const EVIDENCE_PREFIX = ".aipos/evidence/";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
}

function mergedPullRequests(root) {
  const numbers = new Set();
  for (const subject of git(root, ["log", "--format=%s", "HEAD"]).split("\n")) {
    const match = /^Merge pull request #(\d+)\b/.exec(subject) || /\(#(\d+)\)$/.exec(subject);
    if (match) numbers.add(match[1]);
  }
  return numbers;
}

function scalarOf(doc, key) {
  const value = doc && doc[key];
  return value == null ? "" : String(value).trim();
}

function mergeProof(root, doc, mergedPrs) {
  const commit = scalarOf(doc, "merge_commit");
  if (/^[0-9a-f]{40}$/.test(commit)) {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root });
    if (result.status === 0) return `merge_commit ${commit.slice(0, 12)} is in HEAD`;
  }
  const pr = scalarOf(doc, "pull_request").replace(/^#/, "");
  if (/^\d+$/.test(pr) && mergedPrs.has(pr)) return `PR #${pr} is merged in HEAD`;
  return null;
}

function externalReferences(root, name) {
  const result = spawnSync("git", ["grep", "-l", "-F", "-e", name, "--", ".", `:!${WORK_ORDER_DIR}/${name}`, `:!${ARCHIVE_DIR}/${name}`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  return result.stdout.split("\n").filter(Boolean).filter((file) => !file.startsWith(EVIDENCE_PREFIX) || !file.endsWith(".json"));
}

function plan(root) {
  const entries = listWorkOrderEntries(root);
  const mergedPrs = mergedPullRequests(root);
  const idCount = new Map();
  const parsed = new Map();
  for (const entry of entries) {
    let doc = null;
    try { doc = yaml.load(readFileSync(join(root, entry.path), "utf8")); } catch { /* reported as unparseable below */ }
    parsed.set(entry.path, doc);
    const id = scalarOf(doc, "id");
    if (id) idCount.set(id, (idCount.get(id) || 0) + 1);
  }
  const move = [];
  const stay = [];
  for (const entry of entries.filter((e) => !e.archived)) {
    const doc = parsed.get(entry.path);
    const status = scalarOf(doc, "status");
    const decide = (reason) => stay.push({ name: entry.name, status, reason });
    if (!doc) { decide("unparseable YAML"); continue; }
    if (!isClosedSpelling(status)) { decide("status is not an unambiguous closed spelling"); continue; }
    if ((idCount.get(scalarOf(doc, "id")) || 0) !== 1) { decide("work-order id is not unique"); continue; }
    const proof = mergeProof(root, doc, mergedPrs);
    if (!proof) { decide("merge not proven in HEAD history"); continue; }
    const refs = externalReferences(root, entry.name);
    if (refs.length > 0) { decide(`path still referenced by ${refs.slice(0, 3).join(", ")}${refs.length > 3 ? ` (+${refs.length - 3})` : ""}`); continue; }
    move.push({ name: entry.name, status, proof });
  }
  return { move, stay, total: entries.filter((e) => !e.archived).length };
}

function apply(root, moves) {
  mkdirSync(join(root, ARCHIVE_DIR), { recursive: true });
  for (const { name } of moves) {
    const target = join(root, ARCHIVE_DIR, name);
    if (existsSync(target)) throw new Error(`archive target already exists: ${ARCHIVE_DIR}/${name}`);
    renameSync(join(root, WORK_ORDER_DIR, name), target);
  }
}

module.exports = { plan, apply, mergedPullRequests };

if (require.main === module) {
  const root = process.cwd();
  const { move, stay, total } = plan(root);
  const doApply = process.argv.includes("--apply");
  if (doApply) apply(root, move);
  console.log(`AIPOS_ARCHIVE ${doApply ? "MOVED" : "WOULD_MOVE"} ${move.length} of ${total} active work orders to ${ARCHIVE_DIR}/`);
  for (const item of move) console.log(`  move ${item.name} [${item.status}] ${item.proof}`);
  const reasons = new Map();
  for (const item of stay) reasons.set(item.reason.replace(/ by .*/, ""), (reasons.get(item.reason.replace(/ by .*/, "")) || 0) + 1);
  console.log(`AIPOS_ARCHIVE STAYED ${stay.length}`);
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${count} ${reason}`);
}
