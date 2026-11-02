const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { validateWorkflowAuthorityMap, collect } = require("../scripts/validate-workflow-authority-map.js");

/**
 * The repository's workflow permissions had been audited by hand, which is why the same class of
 * finding kept being filed one workflow at a time. These assertions pin the guard that replaces
 * that audit, and each rule is proved to fire against a synthetic workflow rather than only
 * asserted to exist -- a guard that cannot fail is not a guard.
 */

function sandbox(workflows, baseline) {
  const root = mkdtempSync(join(tmpdir(), "nusa-authority-map-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(root, ".github", "workflows", name), body, "utf8");
  writeFileSync(join(root, ".github", "workflow-authority-map.json"), JSON.stringify(baseline, null, 2), "utf8");
  return root;
}

const EMPTY_BASELINE = { jobs: {}, acknowledgedDebt: {} };

test("the repository's own workflows satisfy the committed authority map", () => {
  const result = validateWorkflowAuthorityMap();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test("the scheduled security gate watch declares only its issue-writing authority", () => {
  const job = collect()["security-gate-watch.yml"].jobs.watch;
  assert.deepEqual(job.write, ["issues"]);
  assert.equal(job.secrets, false);
  assert.equal(job.environment, null);
});

test("the map records every workflow and reports real write authority", () => {
  const map = collect();
  assert.ok(Object.keys(map).length >= 30, "all workflows are parsed");
  const jobs = Object.values(map).flatMap((workflow) => Object.values(workflow.jobs));
  assert.ok(jobs.some((job) => job.write.length > 0), "write authority is actually detected, not silently empty");
});

test("undeclared write authority fails, so a new privileged job cannot appear silently", () => {
  const root = sandbox({
    "new.yml": ["name: New", "on:", "  push:", "jobs:", "  grant:", "    permissions:", "      contents: write", "    steps:", "      - run: echo hi", ""].join("\n")
  }, EMPTY_BASELINE);
  const result = validateWorkflowAuthorityMap(root);
  assert.ok(result.failures.some((failure) => failure.startsWith("UNDECLARED_WRITE_AUTHORITY:new.yml:grant")), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});

test("widening an already declared job's authority fails", () => {
  const workflow = ["name: Widen", "on:", "  push:", "jobs:", "  grant:", "    permissions:", "      contents: write", "      actions: write", "    steps:", "      - run: echo hi", ""].join("\n");
  const root = sandbox({ "widen.yml": workflow }, { jobs: { "widen.yml:grant": { write: ["contents"], secrets: false, environment: null } }, acknowledgedDebt: {} });
  const result = validateWorkflowAuthorityMap(root);
  assert.ok(result.failures.includes("WRITE_AUTHORITY_EXPANDED:widen.yml:grant:actions"), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});

test("shrinking authority is always allowed", () => {
  const workflow = ["name: Shrink", "on:", "  push:", "jobs:", "  grant:", "    permissions:", "      contents: read", "    steps:", "      - run: echo hi", ""].join("\n");
  const root = sandbox({ "shrink.yml": workflow }, { jobs: { "shrink.yml:grant": { write: ["contents", "actions"], secrets: false, environment: null } }, acknowledgedDebt: {} });
  assert.deepEqual(validateWorkflowAuthorityMap(root).failures, []);
  rmSync(root, { recursive: true, force: true });
});

test("running PR-controlled code while holding a mutation token fails", () => {
  const workflow = [
    "name: Risky", "on:", "  pull_request_target:", "jobs:", "  risky:", "    permissions:", "      contents: write",
    "    steps:", "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "        with:", "          ref: ${{ github.event.pull_request.head.sha }}", "      - run: npm test", ""
  ].join("\n");
  const root = sandbox({ "risky.yml": workflow }, { jobs: { "risky.yml:risky": { write: ["contents"], secrets: false, environment: null } }, acknowledgedDebt: {} });
  const result = validateWorkflowAuthorityMap(root);
  assert.ok(result.failures.some((failure) => failure.startsWith("PR_CODE_EXECUTION_WITH_WRITE_AUTHORITY:risky.yml:risky")), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});

test("id-token alone does not make a PR job dangerous, because it mutates nothing", () => {
  const workflow = [
    "name: Oidc", "on:", "  pull_request_target:", "jobs:", "  bridge:", "    permissions:", "      id-token: write",
    "    steps:", "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "        with:", "          ref: ${{ github.event.pull_request.head.sha }}", ""
  ].join("\n");
  const root = sandbox({ "oidc.yml": workflow }, { jobs: { "oidc.yml:bridge": { write: ["id-token"], secrets: false, environment: null } }, acknowledgedDebt: {} });
  assert.deepEqual(validateWorkflowAuthorityMap(root).failures, []);
  rmSync(root, { recursive: true, force: true });
});

test("a second merge engine fails, and only the canonical release workflow may merge", () => {
  const workflow = ["name: Alt", "on:", "  push:", "jobs:", "  merge:", "    permissions:", "      contents: write", "    steps:", "      - run: gh pr merge \"$PR\" --merge", ""].join("\n");
  const root = sandbox({ "alt.yml": workflow }, { jobs: { "alt.yml:merge": { write: ["contents"], secrets: false, environment: null } }, acknowledgedDebt: {} });
  const result = validateWorkflowAuthorityMap(root);
  assert.ok(result.failures.includes("ALTERNATE_MERGE_ENGINE:alt.yml:merge"), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});

test("acknowledged debt suppresses only its own entry and never a second occurrence", () => {
  const body = (job) => ["name: Alt", "on:", "  push:", "jobs:", `  ${job}:`, "    permissions:", "      contents: write", "    steps:", "      - run: gh pr merge \"$PR\" --merge", ""].join("\n");
  const baseline = {
    jobs: { "known.yml:merge": { write: ["contents"], secrets: false, environment: null }, "fresh.yml:merge": { write: ["contents"], secrets: false, environment: null } },
    acknowledgedDebt: { alternateMergeEngine: [{ job: "known.yml:merge", issue: "#1861", note: "known" }] }
  };
  const root = sandbox({ "known.yml": body("merge"), "fresh.yml": body("merge") }, baseline);
  const result = validateWorkflowAuthorityMap(root);
  assert.ok(!result.failures.includes("ALTERNATE_MERGE_ENGINE:known.yml:merge"), "the recorded entry is not re-reported");
  assert.ok(result.failures.includes("ALTERNATE_MERGE_ENGINE:fresh.yml:merge"), "a new occurrence still fails");
  rmSync(root, { recursive: true, force: true });
});

test("debt that has been fixed must be removed from the baseline", () => {
  const clean = ["name: Clean", "on:", "  push:", "jobs:", "  build:", "    steps:", "      - run: echo hi", ""].join("\n");
  const baseline = { jobs: {}, acknowledgedDebt: { alternateMergeEngine: [{ job: "gone.yml:merge", issue: "#1861", note: "already fixed" }] } };
  const root = sandbox({ "clean.yml": clean }, baseline);
  const result = validateWorkflowAuthorityMap(root);
  assert.ok(result.failures.includes("ACKNOWLEDGED_DEBT_RESOLVED_REMOVE_ENTRY:alternateMergeEngine:gone.yml:merge"), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});

test("every acknowledged debt entry names the issue that owns it", () => {
  const baseline = require("../.github/workflow-authority-map.json");
  for (const [rule, entries] of Object.entries(baseline.acknowledgedDebt ?? {})) {
    for (const entry of entries) {
      assert.match(entry.issue ?? "", /^#\d+$/, `${rule}:${entry.job} must reference an owning issue`);
      assert.ok((entry.note ?? "").length > 0, `${rule}:${entry.job} must say what removes it`);
    }
  }
});
