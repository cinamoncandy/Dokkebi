"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { selectCodexBacklogTask } = require("../dist/apps/autopilot/src/evolveGithubIssueBacklog.js");
const { buildPrompt, selectFromGithubInventory } = require("../scripts/autopilot-codex-select.js");

const SAFE = "liveAuthority=NONE\nproductionMutationAllowed=false\naiAuthority=ZERO_AUTHORITY";
const issue = (number, title, body, extra = {}) => ({ number, title, body: `${body}\ncanonicalOwner: issue-${number}\nconflictKeys: issue:${number}`, state: "open", author_association: "OWNER", updated_at: "2026-09-29T00:00:00Z", labels: [], ...extra });

test("Codex takes the research and general issues the Workers AI runner cannot, highest priority first", () => {
  const issues = [
    issue(10, "P1: research walk-forward gate", `Improve research OOS.\n${SAFE}`),
    issue(11, "P0: mobile UI polish", `Mobile UI.\n${SAFE}`),
    issue(12, "P0: something vague", `No domain words.\n${SAFE}`),
  ];
  const task = selectCodexBacklogTask(issues, []);
  assert.equal(task.issueNumber, 11);
  assert.equal(task.capability, "GENERAL");
  assert.equal(task.canonicalOwner, "issue-11");
  assert.deepEqual(task.conflictKeys, ["issue:11"]);
});

test("unsafe, non-owner, blocked or already-linked issues are never selected", () => {
  const issues = [
    issue(20, "P0: research without contract", "research"),
    issue(21, "P0: research by outsider", `research\n${SAFE}`, { author_association: "CONTRIBUTOR" }),
    issue(22, "P0: research on hold", `research\n${SAFE}`, { labels: [{ name: "hold" }] }),
    issue(23, "P0: research linked", `research\n${SAFE}`),
    issue(24, "P0: live enabling", `research\n${SAFE}\nliveAuthority=LIVE`),
  ];
  assert.equal(selectCodexBacklogTask(issues, [{ title: "fix", body: "Refs #23" }]), null);
});

test("the production Codex selector rejects cursor scans without a point-in-time snapshot contract", () => {
  assert.throws(() => selectFromGithubInventory({
    issues: [issue(900, "P0: eligible-looking task", `Autopilot task.\n${SAFE}`)],
    pulls: [],
    consistency: {
      pagination: "GRAPHQL_CURSOR",
      repeatedScansMatched: true,
      pointInTimeSnapshot: "UNVERIFIED",
      automaticSelectionAllowed: false,
    },
  }), /no verified point-in-time snapshot/);
});

test("Codex refuses to select backlog work without canonical WIP owner and conflict metadata", () => {
  const missingMetadata = issue(25, "P0: research work", `Research OOS.\n${SAFE}`, { body: `Research OOS.\n${SAFE}` });
  assert.equal(selectCodexBacklogTask([missingMetadata], []), null);
});

test("the Codex prompt carries the CORE/AIPOS contract and forbids commit, push and protected paths", () => {
  const prompt = buildPrompt({ issueNumber: 5, capability: "RESEARCH", title: "P1: research", body: "details" });
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /NUSA_CORE_MASTER_INSTRUCTIONS/);
  assert.match(prompt, /Do not commit, push, open a PR/);
  assert.match(prompt, /liveAuthority=NONE/);
  assert.match(prompt, /OWNER ISSUE #5/);
});

test("the workflow pins Codex to the single dedicated-account runner and publishes only after validation", () => {
  const workflow = fs.readFileSync(".github/workflows/autopilot-codex-coding.yml", "utf8");
  const selectJob = workflow.slice(workflow.indexOf("  select:"), workflow.indexOf("  codex:"));
  assert.match(selectJob, /permissions:\n\s+actions: read\n\s+contents: read\n\s+issues: read\n\s+pull-requests: read/, "only the read-only selector job can query the GraphQL issue and PR connections");
  assert.match(workflow, /runs-on: \[self-hosted, Linux, nusa-codex-autopilot\]/, "only the runner labelled for the dedicated ChatGPT account");
  assert.doesNotMatch(workflow, /nusa-codex-dev\]/, "never the shared Codex runner label");
  const codexJob = workflow.slice(workflow.indexOf("  codex:"), workflow.indexOf("  publish:"));
  assert.doesNotMatch(codexJob, /git push|gh pr create|NUSA_AUTOPILOT_GITHUB_TOKEN/, "Codex has no commit or push authority");
  assert.match(codexJob, /usage limit/, "a ChatGPT usage limit is a wait, not a fallback to another account");
  assert.match(codexJob, /\[ "\$rc" -ne 0 \] && grep -qiE "\^ERROR: \.\*hit your usage limit"/, "only a failed run's own usage-limit error line is a wait");
  assert.ok(workflow.indexOf("git commit -q") < workflow.indexOf("Validate exactly like a contributor"), "the Codex patch is committed before validation so the suite's git reset cannot drop it");
  assert.match(workflow, /validated-head/, "only the validated commit is published");
  assert.match(codexJob, /set \+e -uo pipefail/, "the default bash -e must not end the step before the usage-limit check");
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  const order = ["protected path", "pnpm run build", "pnpm run typecheck", "pnpm run validate", "node --test tests/*.test.js", "node scripts/run-tests-isolated.js", "gh pr create"].map((marker) => publish.indexOf(marker));
  assert.ok(order.every((index) => index > 0), "every gate is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "validation gates run before the PR is created");
  assert.match(workflow, /group: autopilot-codex-coding/);
  assert.match(workflow, /head:autopilot\/codex\//, "one open autopilot Codex PR at a time");
  assert.match(codexJob, /Claim shared WIP slot/, "WIP admission happens before the coding model runs");
  assert.match(codexJob, /Release shared WIP slot/);
  assert.match(workflow, /task_digest: \$\{\{ steps\.pick\.outputs\.task_digest \}\}/, "the selected issue snapshot digest follows the prompt into the trusted claim job");
  assert.match(codexJob, /if: always\(\) && steps\.wip_claim\.outcome != 'skipped'/, "release is attempted after every executed claim step, including an ambiguous response failure");
  assert.match(codexJob, /id-token: write/, "only the Codex job can mint the narrow claim identity");
  assert.match(codexJob, /timeout-minutes: 50/, "the run budget is below the one-hour active-WIP expiry");
  assert.match(codexJob, /-u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN/, "the coding model cannot mint OIDC tokens");
});

test("the Codex prompt keeps heavy validation off the shared PAPER host", () => {
  const prompt = buildPrompt({ issueNumber: 7, capability: "GENERAL", title: "P1: t", body: "b" });
  assert.match(prompt, /Do NOT run pnpm install, build, typecheck, the test suite/);
  assert.doesNotMatch(prompt, /Run the relevant local validation/);
  assert.match(prompt, /Exception for this delegated-validation lane/, "the AGENTS verification rule is explicitly delegated, not contradicted");
  const workflow = fs.readFileSync(".github/workflows/autopilot-codex-coding.yml", "utf8");
  assert.match(workflow, /for tool in pnpm npm npx yarn tsc vitest jest/, "heavy tools are technically blocked for Codex");
  assert.match(workflow, /PATH="\$blocked:\$PATH"/, "Codex runs with the blocked tools first on PATH");
  assert.match(workflow, /node --test is disabled on the shared PAPER host/, "node stays usable but not as the test runner");
});

test("the host guard keeps Codex off the shared Oracle host whenever PAPER needs it", () => {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-guard-"));
  const meminfo = path.join(dir, "meminfo");
  const guard = (mode, availableKb, releases, extra = {}) => {
    fs.writeFileSync(meminfo, `MemTotal: 1000000 kB\nMemAvailable: ${availableKb} kB\n`);
    return spawnSync("bash", ["scripts/autopilot-codex-host-guard.sh", mode], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: dir, NUSA_HOST_GUARD_MEMINFO: meminfo, NUSA_HOST_GUARD_ACTIVE_RELEASES: releases, ...extra },
    }).status;
  };
  assert.equal(guard("start", 600000, "0"), 0, "enough memory and no release: Codex may start");
  assert.equal(guard("start", 300000, "0"), 1, "low memory defers the start");
  assert.equal(guard("start", 400000, "0"), 0, "the owner-set 350 MiB start threshold admits a host with ~390 MiB free");
  assert.equal(guard("start", 350000, "0"), 1, "below 350 MiB the start is still deferred");
  assert.equal(guard("start", 600000, "1"), 1, "a queued or running PAPER release defers the start");
  assert.equal(guard("watch", 300000, "0"), 0, "above the floor Codex keeps running");
  assert.equal(guard("watch", 150000, "0"), 1, "below the floor Codex is stopped");
  assert.equal(guard("watch", 600000, "1", { NUSA_HOST_GUARD_RELEASE_CHECK_SECONDS: "0" }), 1, "a release that starts mid-run stops Codex");

  const workflow = fs.readFileSync(".github/workflows/autopilot-codex-coding.yml", "utf8");
  assert.match(workflow, /cp scripts\/autopilot-codex-host-guard\.sh "\$guard" && chmod 0555 "\$guard"/, "the guard runs from an immutable copy outside Codex's writable tree");
  assert.match(workflow, /bash "\$guard" start/, "Codex starts only through the host guard");
  assert.match(workflow, /bash "\$guard" watch/, "the host guard watches the whole Codex run");
  assert.match(workflow, /bash "\$guard" reap "\$mark"/, "the whole marked Codex tree is reaped");
  assert.match(workflow, /env -u GUARD_GH_TOKEN -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN NUSA_CODEX_RUN_MARK=/, "Codex never receives GitHub or OIDC token-minting authority");
  assert.doesNotMatch(workflow, /^\s+GH_TOKEN: \$\{\{ github\.token \}\}\n\s+run: \|\n\s+# Actions runs bash/m, "no step-wide token for the Codex step");
  assert.match(workflow, /nice -n 19 ionice -c3 codex exec/, "Codex runs at the lowest CPU and IO priority");
  assert.match(workflow, /host_deferred != 'true'/, "a deferred or stopped run never publishes a patch");
});

test("the host guard reaps a Codex descendant that left the process group", { skip: process.platform !== "linux" }, () => {
  const { spawn, spawnSync } = require("node:child_process");
  const mark = `test-mark-${process.pid}-${Date.now()}`;
  const child = spawn("setsid", ["sleep", "300"], { env: { ...process.env, NUSA_CODEX_RUN_MARK: mark }, detached: true, stdio: "ignore" });
  child.unref();
  const alive = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while (!alive() && Date.now() < deadline) { /* wait for spawn */ }
  const result = spawnSync("bash", ["scripts/autopilot-codex-host-guard.sh", "reap", mark], { encoding: "utf8", env: { ...process.env, NUSA_HOST_GUARD_REAP_WAIT_SECONDS: "1" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = spawnSync("bash", ["-c", `for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -qxF NUSA_CODEX_RUN_MARK=${mark} && echo $p; done`], { encoding: "utf8" });
  assert.equal(after.stdout.trim(), "", "no marked process survives");
});

test("the Codex contract makes AIPOS state true on the published commit so the review bot does not block Release", () => {
  const prompt = buildPrompt({ issueNumber: 1, capability: "test", title: "t", body: "b" });
  assert.match(prompt, /TRUE ON THE PUBLISHED COMMIT/);
  assert.match(prompt, /Never write \\?"uncommitted\\?"/);
  assert.match(prompt, /exact-head CI, independent Audit and Release PLUS every task-specific post-Release action/);
  assert.match(prompt, /exact-main deployment, runtime proof, dogfood/);
  assert.match(prompt, /never imply that Release ends the work when it does not/);
  assert.match(prompt, /Do not commit, push, open a PR/, "the no-commit authority rule is unchanged");
  assert.match(prompt, /liveAuthority=NONE/);
});

test("every Codex run records which outcome it reached so a zero-completion run is never read as a completion", () => {
  const workflow = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", ".github", "workflows", "autopilot-codex-coding.yml"), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Record Codex outcome"), workflow.indexOf("- uses: actions/upload-artifact", workflow.indexOf("- name: Record Codex outcome")));
  assert.match(step, /if: always\(\)/);
  for (const outcome of ["HOST_DEFERRED", "USAGE_LIMITED", "CODEX_FAILED", "PATCH_READY", "NO_PATCH"]) assert.match(step, new RegExp(outcome));
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(step, /GITHUB_OUTPUT|exit 1/, "display only: no output, gate or failure is added");
});
