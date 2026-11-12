"use strict";

/**
 * Selects the next owner backlog issue for the Codex coding engine and writes it as GitHub Actions
 * step outputs (autopilot-codex-coding.yml). Read-only: it only lists issues and pull requests.
 */
const fs = require("node:fs");
const { codexWorkOrderTaskSnapshotDigest, fetchProtectedMainSha, fetchVerifiedCodexWorkOrderInventory } = require("../dist/apps/autopilot/src/githubWorkOrderInventory.js");

const CONTRACT = [
  "NUSA AUTOPILOT CODEX CONTRACT:",
  "- Read and obey AGENTS.md, the AIPOS recovery protocol and docs/NUSA_CORE_MASTER_INSTRUCTIONS.md before editing. Exception for this delegated-validation lane: the work order's verification commands are executed by the workflow's publish job on separate hardware, not by you (see the next rule).",
  "- Implement only the next smallest verifiable increment of the issue below, with tests, and update the AIPOS work order/state it needs.",
  "- Preserve PAPER-only operation, liveAuthority=NONE, productionMutationAllowed=false and aiAuthority=ZERO_AUTHORITY.",
  "- Never touch LIVE trading, broker/exchange credentials, secrets, .github/workflows or deploy/ files.",
  "- Do not commit, push, open a PR, merge, deploy or trigger CI. Leave changes uncommitted; the workflow validates and publishes them.",
  "- Write every AIPOS state/work-order field as it will be TRUE ON THE PUBLISHED COMMIT: the workflow commits your change and publishes it only after build, typecheck, validate, the work-order index check and the test suites pass. So say the increment is committed and workflow-validated, and list as remaining exact-head CI, independent Audit and Release PLUS every task-specific post-Release action the work order or issue requires (exact-main deployment, runtime proof, dogfood, any HUMAN_ENVIRONMENT_ONLY acceptance): never imply that Release ends the work when it does not. Never write \"uncommitted\", \"pending workflow validation\" or \"validation intentionally left to the workflow\": a review bot flags that stale wording and Release then blocks the PR on the unresolved thread.",
  "- Do NOT run pnpm install, build, typecheck, the test suite or any other heavy command: this runner shares a 1 GB host with the PAPER runtime and a host guard stops the run (discarding your patch) when memory runs low. The workflow runs build, typecheck, validate, the work-order index check, tests/*.test.js and the isolated (co-located) tests on separate hardware after you finish; heavy commands are blocked on this runner and fail immediately. Light reads (git diff, grep, cat) are fine; report truthfully that validation is left to the workflow.",
].join("\n");

function selectFromGithubInventory(inventory) {
  if (inventory?.consistency?.automaticSelectionAllowed !== true
    || inventory?.consistency?.source !== "PROTECTED_MAIN_AIPOS_WORK_ORDERS"
    || !/^[a-f0-9]{40}$/.test(inventory.consistency.mainSha || "")
    || !/^[a-f0-9]{40}$/.test(inventory.consistency.treeSha || "")) {
    throw new Error("Protected-main AIPOS work-order inventory is not verified; automatic Codex selection is blocked");
  }
  const task = inventory.task ?? null;
  if (task && (task.source?.mainSha !== inventory.consistency.mainSha || task.source?.treeSha !== inventory.consistency.treeSha)) {
    throw new Error("Codex task digest source does not match the protected-main Work Order tree");
  }
  return task;
}

function buildPrompt(task) {
  return `${CONTRACT}\n\nOWNER ISSUE #${task.issueNumber} (${task.capability}): ${task.title}\n\n${task.body}`;
}

async function main(env = process.env) {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "nusa-autopilot-codex",
    "x-github-api-version": "2022-11-28",
  };
  const mainSha = await fetchProtectedMainSha(repository, headers);
  if (!/^[a-f0-9]{40}$/.test(env.NUSA_CODEX_CHECKED_OUT_SHA || "")
    || mainSha !== env.NUSA_CODEX_CHECKED_OUT_SHA.toLowerCase()) {
    throw new Error("Protected main moved after the selector checkout; Codex task selection is blocked");
  }
  const inventory = await fetchVerifiedCodexWorkOrderInventory(repository, mainSha, headers);
  const task = selectFromGithubInventory(inventory);
  const lines = task == null ? ["has_task=false"] : [
    "has_task=true",
    `issue=${task.task.issueNumber}`,
    `task=issue-${task.task.issueNumber}`,
    `task_digest=${await codexWorkOrderTaskSnapshotDigest(task)}`,
  ];
  if (task != null) fs.writeFileSync(env.NUSA_CODEX_PROMPT_FILE || "codex-prompt.txt", buildPrompt(task.task));
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  console.log(task == null ? "no explicitly READY protected-main AIPOS work order is eligible for Codex" : `selected issue #${task.task.issueNumber}: ${task.task.title}`);
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });

module.exports = { buildPrompt, CONTRACT, selectFromGithubInventory };
