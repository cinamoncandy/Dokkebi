#!/usr/bin/env node
"use strict";
/**
 * AIPOS work-order index (WO-20260924-AIPOS-WORK-ORDER-INDEX).
 *
 * The work-order directory holds every order ever written, with ~25 ad-hoc status spellings, so a
 * recovering agent had to open all of them to find what is still open. This prints a single
 * index that separates open orders from closed ones, and freezes the status vocabulary for new
 * dated orders. Existing orders keep their historical spelling: validators and docs reference
 * those files by path and some read their status.
 *
 * It never moves, rewrites, or re-statuses an existing order. In particular it does not close any
 * LIVE-readiness order; that stays an owner decision.
 *
 * The index is printed, not committed: a committed index would make every PR that adds an order
 * regenerate it, which is exactly the process overhead this exists to remove.
 *
 *   node scripts/aipos-work-order-index.js          # print the index of open orders
 *   node scripts/aipos-work-order-index.js --check  # fail if a new order uses a non-canonical status
 */
const { readFileSync } = require("node:fs");
const { listWorkOrderEntries } = require("./lib/aipos-work-order-paths.js");
const { join } = require("node:path");

const CANONICAL_STATUSES = Object.freeze({
  PLANNED: "open",
  PROPOSED: "open",
  IN_PROGRESS: "open",
  VERIFYING: "open",
  READY_FOR_REVIEW: "open",
  BLOCKED: "open",
  MERGED: "closed",
  COMPLETED: "closed",
  SUPERSEDED: "closed",
});

// Only orders dated on or after this day (WO-YYYYMMDD-... filenames) must use a canonical status.
// Many open PRs still add older-style orders; enforcing on those would turn main red when they
// merge. Undated and earlier orders are reported by the index but never fail the check.
const ENFORCED_FROM = 20260924;

function enforced(name) {
  const match = /^WO-(\d{8})-/.exec(name);
  return match != null && Number(match[1]) >= ENFORCED_FROM;
}

// Historical spellings that mean the order is closed. Anything not listed here or canonical is
// treated as open, so an unfamiliar status can never hide work from the index.
const LEGACY_CLOSED = new Set(["COMPLETE", "VERIFIED", "COMPLETED_CODE_SCOPE"]);

function scalar(source, key) {
  const match = new RegExp(`^${key}:\\s*"?([^"\\n]*?)"?\\s*$`, "m").exec(source);
  return match ? match[1].trim() : "";
}

function readOrders(root) {
  return listWorkOrderEntries(root).map(({ name, path }) => {
    const source = readFileSync(join(root, path), "utf8");
    return { name, id: scalar(source, "id") || name.replace(/\.ya?ml$/i, ""), title: scalar(source, "title"), status: scalar(source, "status") || "MISSING" };
  });
}

function classify(status) {
  if (CANONICAL_STATUSES[status]) return CANONICAL_STATUSES[status];
  return LEGACY_CLOSED.has(status) ? "closed" : "open";
}

function render(orders) {
  const open = orders.filter((o) => classify(o.status) === "open");
  const closed = orders.length - open.length;
  const cell = (v) => String(v).replace(/\|/g, "\\|");
  const lines = [
    "# AIPOS work-order index",
    "",
    "Printed by `node scripts/aipos-work-order-index.js`. `.aipos/state.yaml` still names the current target.",
    "",
    `Total: ${orders.length} · open: ${open.length} · closed: ${closed}`,
    "",
    "Open orders include historical statuses that were never closed; closing one (especially a",
    "LIVE-readiness order) is an owner decision, not an index change.",
    "",
    "| Work order | Status | Title |",
    "|---|---|---|",
    ...open.map((o) => `| \`${cell(o.id)}\` | ${cell(o.status)} | ${cell(o.title)} |`),
    "",
    `Canonical statuses for new orders: ${Object.keys(CANONICAL_STATUSES).join(", ")}.`,
    "",
  ];
  return lines.join("\n");
}

function check(root) {
  const failures = [];
  const orders = readOrders(root);
  for (const order of orders) {
    if (CANONICAL_STATUSES[order.status] || !enforced(order.name)) continue;
    failures.push(`NON_CANONICAL_STATUS:${order.name}:${order.status}`);
  }
  return { ok: failures.length === 0, failures };
}

module.exports = { CANONICAL_STATUSES, ENFORCED_FROM, enforced, readOrders, classify, render, check };

if (require.main === module) {
  const root = process.cwd();
  if (process.argv.includes("--check")) {
    const result = check(root);
    if (!result.ok) { console.error(`AIPOS_WORK_ORDER_INDEX FAIL\n${result.failures.join("\n")}\nUse one of: ${Object.keys(CANONICAL_STATUSES).join(", ")}`); process.exit(1); }
    console.log("AIPOS_WORK_ORDER_INDEX PASS");
  } else {
    process.stdout.write(render(readOrders(root)));
  }
}
