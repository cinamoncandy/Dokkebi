#!/usr/bin/env node
"use strict";

/**
 * Every AIPOS YAML file must be parseable YAML with no duplicate mapping keys.
 *
 * AIPOS is the repository's source of truth, and every agent's recovery starts by reading it.
 * Until this gate existed, none of the AIPOS validators actually parsed these files: they read
 * them as text and matched patterns. On 2026-09-23 a strict parse of main found six work orders
 * that were not YAML at all (a bare backtick opening a list item; an unquoted `: ` inside a
 * scalar) and a duplicate `safety:` key in state.yaml, where a lenient parser silently keeps
 * the last value and a strict one refuses the whole file. Two readers of the same ledger could
 * therefore disagree about what it says, and nothing noticed.
 *
 * js-yaml rejects duplicate keys by default, so a clean load proves both properties.
 */

const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const yaml = require("js-yaml");

const { STATUS_ENUM } = require("./lib/aipos-work-order-status.js");
const { listWorkOrderEntries } = require("./lib/aipos-work-order-paths.js");

const ROOT = join(__dirname, "..");
const STATUS_BASELINE_PATH = ".aipos/work-order-status-baseline.json";

function trackedAiposYamlFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--", ".aipos/*.yaml", ".aipos/*.yml"], { cwd: root, encoding: "utf8" });
  return out.split("\0").filter(Boolean).sort();
}

function validateAiposYaml(root = ROOT, files = trackedAiposYamlFiles(root)) {
  const failures = [];
  for (const file of files) {
    try {
      yaml.load(readFileSync(join(root, file), "utf8"), { filename: file });
    } catch (error) {
      failures.push({ file, reason: String(error.message).split("\n")[0] });
    }
  }
  return { checked: files.length, failures };
}

/**
 * Work-order status enum (WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH).
 *
 * A work order must use a STATUS_ENUM value. The legacy backlog is frozen in the baseline as
 * `file name -> exact spelling`; a file may keep exactly that spelling and nothing else, so any new
 * order, and any existing order whose status is changed to another non-enum value, fails. A
 * baseline entry for a file that is gone or now uses the enum must be removed (the baseline only shrinks).
 */
function validateWorkOrderStatuses(root = ROOT) {
  const baselineFile = join(root, STATUS_BASELINE_PATH);
  const legacy = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")).legacy || {} : {};
  const failures = [];
  const seen = new Set();
  const entries = listWorkOrderEntries(root);
  for (const { name, path } of entries) {
    seen.add(name);
    let status = "MISSING";
    try {
      const doc = yaml.load(readFileSync(join(root, path), "utf8"));
      if (doc && doc.status != null) status = String(doc.status);
    } catch {
      continue; // unparseable files are reported by validateAiposYaml
    }
    if (STATUS_ENUM.includes(status)) {
      if (name in legacy) failures.push({ file: path, reason: `status is now ${status}; remove it from ${STATUS_BASELINE_PATH}` });
    } else if (legacy[name] !== status) {
      failures.push({ file: path, reason: `status "${status}" is not one of ${STATUS_ENUM.join(", ")}${name in legacy ? ` (baseline allows only "${legacy[name]}")` : ""}` });
    }
  }
  for (const name of Object.keys(legacy)) {
    if (!seen.has(name)) failures.push({ file: name, reason: `in ${STATUS_BASELINE_PATH} but no such work order; remove the entry` });
  }
  return { checked: entries.length, failures };
}

if (require.main === module) {
  const statuses = validateWorkOrderStatuses();
  if (statuses.failures.length > 0) {
    for (const { file, reason } of statuses.failures) console.error(`AIPOS_WORK_ORDER_STATUS FAIL ${file}: ${reason}`);
    process.exit(1);
  }
  console.log(`AIPOS_WORK_ORDER_STATUS PASS (${statuses.checked} work orders; legacy spellings frozen in ${STATUS_BASELINE_PATH})`);
  const { checked, failures } = validateAiposYaml();
  if (checked === 0) {
    console.error("AIPOS_YAML FAIL no tracked AIPOS YAML files found");
    process.exit(1);
  }
  if (failures.length > 0) {
    for (const { file, reason } of failures) console.error(`AIPOS_YAML FAIL ${file}: ${reason}`);
    process.exit(1);
  }
  console.log(`AIPOS_YAML PASS (${checked} files parse strictly; no duplicate keys)`);
}

module.exports = { validateAiposYaml, validateWorkOrderStatuses, trackedAiposYamlFiles, STATUS_BASELINE_PATH };
