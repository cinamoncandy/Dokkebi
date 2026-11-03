const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const WORKFLOW_DIR = ".github/workflows";
const BASELINE_PATH = ".github/workflow-authority-map.json";

/**
 * Turns the manual workflow permissions audit into a repeatable guard.
 *
 * Three independent things are checked, because they fail in different ways:
 *
 *   1. A ratchet. Every job's write authority is recorded in a committed baseline. Authority may
 *      shrink freely; it may only grow when the baseline is updated in the same change, which is
 *      what makes a permission expansion visible in review instead of silent.
 *   2. PR-controlled code must never execute while a write token is available. Fork-token
 *      downgrading does not cover same-repository automation, which is how this repository's
 *      autonomous branches run.
 *   3. Exactly one workflow may call a merge API. A second one is an alternate merge engine, which
 *      is the failure this repository has already had to remove once.
 *
 * Parsing is line-based on purpose. The pinned-action validator next to this file works the same
 * way, and adding a YAML dependency to satisfy a security guard would widen the supply chain the
 * guard exists to protect.
 */

const WRITE_LEVELS = new Set(["write"]);
const TRACKED_SCOPES = ["contents", "actions", "issues", "pull-requests", "statuses", "id-token", "packages", "deployments", "security-events", "checks", "attestations", "artifact-metadata"];

const CANONICAL_MERGE_WORKFLOW = "autopilot-deterministic-audit-release.yml";
const MERGE_CALL = /gh\s+pr\s+merge|\/pulls\/[^\s"']*\/merge|pulls\/\$\{?[A-Za-z_]*\}?[^\s"']*\/merge|"[^"]*\/merge"/;
const PR_TRIGGERS = /^\s{0,4}(pull_request|pull_request_target):/;
// Only genuinely caller-controlled revisions count. A dispatch `inputs.head_sha` does not: the
// workflows that take one re-verify it against current protected main before doing any work.
const PR_HEAD_REF = /github\.event\.pull_request\.head\.(sha|ref)|client_payload\.head_sha/;
const CHECKOUT = /uses:\s*actions\/checkout@/;
const SECRET_REF = /\$\{\{\s*secrets\./;

const indentOf = (line) => line.length - line.trimStart().length;

/** Parse one workflow into the authority facts the policy cares about. */
function parseWorkflow(name, text) {
  const lines = text.split(/\r?\n/);
  const workflow = { name, triggers: [], permissions: {}, jobs: {} };

  let inOn = false;
  let inJobs = false;
  let jobsIndent = -1;
  let current = null;
  let permTarget = null;
  let permIndent = -1;

  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    const trimmed = line.trim();

    // Collecting a permissions block that started earlier.
    if (permTarget != null) {
      if (indent > permIndent && trimmed.includes(":")) {
        const [scope, value] = trimmed.split(":", 2).map((part) => part.trim());
        permTarget[scope] = value;
        continue;
      }
      permTarget = null;
      permIndent = -1;
    }

    if (/^on:/.test(trimmed) && indent === 0) { inOn = true; inJobs = false; continue; }
    if (/^jobs:/.test(trimmed) && indent === 0) { inJobs = true; inOn = false; jobsIndent = indent; current = null; continue; }
    if (indent === 0 && !/^(on|jobs):/.test(trimmed)) inOn = false;

    if (inOn && PR_TRIGGERS.test(line)) workflow.triggers.push(trimmed.replace(":", ""));
    if (inOn && indent <= 2 && /^[a-z_]+:/.test(trimmed)) {
      const trigger = trimmed.split(":")[0];
      if (!workflow.triggers.includes(trigger)) workflow.triggers.push(trigger);
    }

    if (/^permissions:/.test(trimmed)) {
      const inline = trimmed.slice("permissions:".length).trim();
      const target = current ? workflow.jobs[current].permissions : workflow.permissions;
      if (inline && inline !== "{}") target["*inline*"] = inline;
      else if (!inline || inline === "{}") { permTarget = target; permIndent = indent; }
      continue;
    }

    if (inJobs && indent === jobsIndent + 2 && /^[A-Za-z0-9_-]+:$/.test(trimmed)) {
      current = trimmed.slice(0, -1);
      workflow.jobs[current] = { permissions: {}, environment: null, usesSecrets: false, prCodeExecution: false, mutates: false, merges: false };
      continue;
    }

    if (current == null) continue;
    const job = workflow.jobs[current];
    if (/^environment:/.test(trimmed)) job.environment = trimmed.slice("environment:".length).trim() || "(block)";
    if (SECRET_REF.test(line)) job.usesSecrets = true;
    if (MERGE_CALL.test(line)) job.merges = true;
    if (/--method\s+(PUT|POST|PATCH|DELETE)|git\s+push|\/dispatches|\/statuses\//.test(line)) job.mutates = true;
    if (CHECKOUT.test(line)) job.checkout = true;
    if (PR_HEAD_REF.test(line) && job.checkout) job.prCodeExecution = true;
  }

  return workflow;
}

/** The write scopes a job effectively holds, counting the workflow-level default. */
// `id-token: write` mints an OIDC assertion; it is not repository mutation authority, so it is
// tracked by the ratchet but does not by itself make a job dangerous to run PR code in.
const MUTATION_SCOPES = new Set(["contents", "actions", "issues", "pull-requests", "statuses", "packages", "deployments", "security-events", "checks"]);

function writeScopes(workflow, job) {
  const merged = { ...workflow.permissions, ...job.permissions };
  const scopes = [];
  for (const [scope, value] of Object.entries(merged)) {
    if (scope === "*inline*") continue;
    if (WRITE_LEVELS.has(String(value).trim())) scopes.push(scope);
  }
  return scopes.filter((scope) => TRACKED_SCOPES.includes(scope)).sort();
}

/**
 * Known, already-filed defects are recorded with the issue that owns them so the guard can go green
 * without hiding them. They are not an allowlist: a new occurrence of the same rule still fails,
 * and an entry whose defect is fixed must be deleted, which is checked below.
 */
function acknowledged(baseline, rule, id) {
  return (baseline.acknowledgedDebt?.[rule] ?? []).some((entry) => entry.job === id);
}

function collect(root = process.cwd()) {
  const directory = join(root, WORKFLOW_DIR);
  const map = {};
  for (const name of readdirSync(directory).filter((item) => /\.ya?ml$/i.test(item)).sort()) {
    const workflow = parseWorkflow(name, readFileSync(join(directory, name), "utf8"));
    const jobs = {};
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      jobs[jobName] = {
        write: writeScopes(workflow, job),
        environment: job.environment,
        secrets: job.usesSecrets,
        prCode: job.prCodeExecution,
        merges: job.merges
      };
    }
    map[name] = { triggers: workflow.triggers.sort(), jobs };
  }
  return map;
}

function validateWorkflowAuthorityMap(root = process.cwd()) {
  const directory = join(root, WORKFLOW_DIR);
  if (!existsSync(directory)) return { ok: false, failures: [`WORKFLOW_DIR_MISSING:${WORKFLOW_DIR}`], map: {} };
  const map = collect(root);
  const failures = [];

  const baselinePath = join(root, BASELINE_PATH);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  if (baseline == null) return { ok: false, failures: [`AUTHORITY_BASELINE_MISSING:${BASELINE_PATH}`], map };

  const mergeWorkflows = [];
  const observed = { prCodeWithWrite: new Set(), prSecretWrite: new Set() };

  for (const [name, workflow] of Object.entries(map)) {
    const prTriggered = workflow.triggers.some((trigger) => trigger === "pull_request" || trigger === "pull_request_target");
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const id = `${name}:${jobName}`;
      const recorded = baseline.jobs?.[id];

      if (job.merges) mergeWorkflows.push(id);

      // Rule 2: PR-controlled code must not run while a write token is available.
      const mutating = job.write.filter((scope) => MUTATION_SCOPES.has(scope));
      if (job.prCode && mutating.length > 0) observed.prCodeWithWrite.add(id);
      if (prTriggered && job.secrets && mutating.length > 0) observed.prSecretWrite.add(id);
      if (job.prCode && mutating.length > 0 && !acknowledged(baseline, "prCodeWithWrite", id)) {
        failures.push(`PR_CODE_EXECUTION_WITH_WRITE_AUTHORITY:${id}:${mutating.join(",")}`);
      }
      if (prTriggered && job.secrets && mutating.length > 0 && !acknowledged(baseline, "prSecretWrite", id)) {
        failures.push(`PR_TRIGGERED_SECRET_JOB_WITH_WRITE_AUTHORITY:${id}:${mutating.join(",")}`);
      }

      // Rule 1: the ratchet. Authority may shrink; growth needs the baseline updated with it.
      if (recorded == null) {
        if (job.write.length > 0) failures.push(`UNDECLARED_WRITE_AUTHORITY:${id}:${job.write.join(",")}`);
        continue;
      }
      for (const scope of job.write) {
        if (!recorded.write.includes(scope)) failures.push(`WRITE_AUTHORITY_EXPANDED:${id}:${scope}`);
      }
      if (job.secrets && recorded.secrets === false) failures.push(`UNDECLARED_SECRET_BEARING_JOB:${id}`);
    }
  }

  // Rule 3: exactly one merge engine.
  for (const id of mergeWorkflows) {
    if (id.startsWith(`${CANONICAL_MERGE_WORKFLOW}:`)) continue;
    if (acknowledged(baseline, "alternateMergeEngine", id)) continue;
    failures.push(`ALTERNATE_MERGE_ENGINE:${id}`);
  }

  // Acknowledged debt may only shrink. A recorded entry that no longer occurs means the defect was
  // fixed and the entry must be removed, so the guard cannot quietly keep permitting it.
  for (const [rule, entries] of Object.entries(baseline.acknowledgedDebt ?? {})) {
    for (const entry of entries) {
      const stillPresent = rule === "alternateMergeEngine"
        ? mergeWorkflows.includes(entry.job)
        : observed[rule]?.has(entry.job) === true;
      if (!stillPresent) failures.push(`ACKNOWLEDGED_DEBT_RESOLVED_REMOVE_ENTRY:${rule}:${entry.job}`);
    }
  }

  return { ok: failures.length === 0, failures, map };
}

module.exports = { validateWorkflowAuthorityMap, collect };

if (require.main === module) {
  if (process.argv.includes("--emit")) {
    const map = collect();
    const jobs = {};
    for (const [name, workflow] of Object.entries(map)) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) jobs[`${name}:${jobName}`] = { write: job.write, secrets: job.secrets, environment: job.environment };
    }
    process.stdout.write(`${JSON.stringify({ jobs, allowedPrCodeWithWrite: [], allowedPrSecretWrite: [] }, null, 2)}\n`);
    process.exit(0);
  }
  const result = validateWorkflowAuthorityMap();
  if (!result.ok) {
    console.error("Workflow authority map validation FAILED");
    for (const failure of result.failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`Workflow authority map validation PASS (${Object.keys(result.map).length} workflow(s))`);
}
