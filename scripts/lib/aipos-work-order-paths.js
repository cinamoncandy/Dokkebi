"use strict";
/**
 * One place that knows where AIPOS work orders live (WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH).
 *
 * Closed, merged work orders are moved (never rewritten) from `.aipos/work-orders/` to
 * `.aipos/work-orders/archive/`. Every reader goes through this module, so a reference such as
 * `.aipos/work-orders/WO-0020-....yaml` keeps resolving after the move.
 */
const { existsSync, readdirSync } = require("node:fs");
const { join, normalize } = require("node:path");

const WORK_ORDER_DIR = ".aipos/work-orders";
const ARCHIVE_DIR = `${WORK_ORDER_DIR}/archive`;
const YAML_PATTERN = /\.ya?ml$/i;

function listYaml(root, dir) {
  const absolute = join(root, normalize(dir));
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && YAML_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Every work-order YAML, active first then archived: [{ name, path, archived }]. */
function listWorkOrderEntries(root) {
  return [
    ...listYaml(root, WORK_ORDER_DIR).map((name) => ({ name, path: `${WORK_ORDER_DIR}/${name}`, archived: false })),
    ...listYaml(root, ARCHIVE_DIR).map((name) => ({ name, path: `${ARCHIVE_DIR}/${name}`, archived: true })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Map a repo-relative work-order path to where the file is now; the input path if it exists or is not a work order. */
function resolveWorkOrderPath(root, relativePath) {
  const posix = String(relativePath).replace(/\\/g, "/");
  if (existsSync(join(root, normalize(posix)))) return posix;
  const match = new RegExp(`^${WORK_ORDER_DIR.replace(/[.]/g, "\\.")}/([^/]+)$`).exec(posix);
  if (!match) return posix;
  const archived = `${ARCHIVE_DIR}/${match[1]}`;
  return existsSync(join(root, normalize(archived))) ? archived : posix;
}

module.exports = { WORK_ORDER_DIR, ARCHIVE_DIR, listWorkOrderEntries, resolveWorkOrderPath };
