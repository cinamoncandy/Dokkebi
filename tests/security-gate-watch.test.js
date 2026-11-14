"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../.github/workflows/security-gate-watch.yml"), "utf8").replace(/\r\n/g, "\n");

test("security gate watch reuses only the exact canonical incident title, from the full open-issue list", () => {
  assert.match(workflow, /gh api --paginate "repos\/\$GITHUB_REPOSITORY\/issues\?state=open&per_page=100"/);
  assert.match(workflow, /select\(\.pull_request == null and \.title == "Security gate is failing on main"\)/);
  assert.doesNotMatch(workflow, /gh issue list/, "no search-index lookup");
  assert.doesNotMatch(workflow, /--limit/, "no result limit");
  const lookups = workflow.match(/EXISTING="\$\(find_existing\)"/g) ?? [];
  assert.equal(lookups.length, 2, "the lookup is repeated right before an issue is created");
});

test("the issue never carries the gate output", () => {
  assert.doesNotMatch(workflow, /gate-output/, "the gate output is not saved for later use");
  assert.doesNotMatch(workflow, /head -n/, "no lines of the gate output are copied");
  assert.doesNotMatch(workflow, /\| tee /, "the gate output is not written to a file");
  const body = workflow.slice(workflow.indexOf('BODY="$('), workflow.indexOf("# All open issues"));
  assert.match(body, /"\$RUN_URL"\)"/, "the body is fixed text plus the run URL only");
  assert.equal((body.match(/%s/g) ?? []).length, 1, "exactly one substituted value");
});

test("a failing gate still fails the run and the job keeps only issues write", () => {
  assert.match(workflow, /if: steps\.gate\.outcome == 'failure'\n\s+run: exit 1/);
  assert.match(workflow, /permissions:\n  contents: read\n  issues: write/);
});
