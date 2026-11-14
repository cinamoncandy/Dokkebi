"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../.github/workflows/security-gate-watch.yml"), "utf8");

test("security gate watch reuses only the exact canonical incident title", () => {
  assert.match(workflow, /--limit 100 --search "\$TITLE in:title" --json number,title/);
  assert.match(workflow, /map\(select\(\.title == "Security gate is failing on main"\)\) \| \.\[0\]\.number \/\/ empty/);
});
