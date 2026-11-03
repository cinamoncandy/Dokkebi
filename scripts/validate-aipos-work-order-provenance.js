// Work-order ids are not unique in this repository's history: both WO-0063 and WO-0070 were
// registered twice, each time for two genuinely different scopes. No record may be deleted, so
// the number alone can no longer identify a scope. This validator enforces the reconciliation
// recorded by WO-0071 -- every colliding work order must carry a distinct scope_id, must name
// the file it collides with, and the canonical lineage of each scope must stay exactly as
// reconciled. Without this, the next tool that looks up "WO-0070" silently gets whichever of
// the two it happens to read first, and attributes one scope's completion evidence to the other.
//
// This deliberately enumerates every work order rather than special-casing the two known ids:
// a third artifact reusing an existing number must fail here, not be discovered later the way
// the WO-0063 collision was.
const { existsSync, readFileSync } = require("node:fs");
const { join, normalize } = require("node:path");
const { block, scalar } = require("./validate-aipos-drift.js");
const { listWorkOrderEntries } = require("./lib/aipos-work-order-paths.js");

const RECONCILIATION_PATH = ".aipos/evidence/WO-0071-work-order-id-provenance-reconciliation.json";
const WORK_ORDER_DIR = ".aipos/work-orders";
const STATE_PATH = ".aipos/state.yaml";

function workOrderFiles(root) {
  // Archived (closed, merged) orders are still work orders: the id-collision check must see them.
  return listWorkOrderEntries(root).map((entry) => ({
    name: entry.name,
    path: entry.path,
    source: readFileSync(join(root, normalize(entry.path)), "utf8"),
  }));
}

function validateStateBinding(root, reconciliation, failures) {
  const statePath = join(root, normalize(STATE_PATH));
  if (!existsSync(statePath)) {
    failures.push(`RECONCILIATION_STATE_MISSING:${STATE_PATH}`);
    return;
  }

  const state = readFileSync(statePath, "utf8");
  const current = block(state, "current_non_live_work_order");
  const id = scalar(current, "id");
  const scopeId = scalar(current, "scope_id");
  const collidingIds = new Set((reconciliation.scopes || []).map((scope) => String(scope?.scope_id || "").split(".")[0]));
  if (!id || !collidingIds.has(id)) return;

  if (!scopeId) {
    failures.push(`RECONCILIATION_STATE_SCOPE_ID_MISSING:${id}`);
    return;
  }
  const scope = (reconciliation.scopes || []).find((candidate) => candidate?.scope_id === scopeId);
  if (!scope) {
    failures.push(`RECONCILIATION_STATE_SCOPE_UNKNOWN:${scopeId}`);
    return;
  }
  if (scope.scope_id !== `${id}.${scope.scope_id.slice(id.length + 1)}`) {
    failures.push(`RECONCILIATION_STATE_SCOPE_ID_UNSCOPED:${scopeId}`);
  }
  for (const [stateKey, scopeKey] of [
    ["canonical_work_order", "work_order"],
    ["canonical_implementation_head", "implementation_head"],
    ["canonical_merge_commit", "merge_commit"]
  ]) {
    if (scalar(current, stateKey) !== String(scope[scopeKey])) {
      failures.push(`RECONCILIATION_STATE_CANONICAL_${stateKey.toUpperCase()}_MISMATCH:${scopeId}`);
    }
  }
  if (scalar(current, "canonical_pull_request") !== String(scope.pull_request)) {
    failures.push(`RECONCILIATION_STATE_CANONICAL_PULL_REQUEST_MISMATCH:${scopeId}`);
  }

  const legacyCommit = scalar(current, "implementation_commit");
  const dangling = (reconciliation.unresolvable_recorded_commits || []).find((entry) => entry?.value === legacyCommit);
  if (dangling && scalar(current, "implementation_commit_status") !== dangling.handling) {
    failures.push(`RECONCILIATION_STATE_LEGACY_COMMIT_NOT_EXPLICITLY_PRESERVED:${legacyCommit}`);
  }
}

function validateRepository(root = process.cwd()) {
  const failures = [];
  const files = workOrderFiles(root);
  if (files.length === 0) return { ok: false, failures: ["WORK_ORDER_DIRECTORY_EMPTY"] };

  const byId = new Map();
  for (const file of files) {
    const id = scalar(file.source, "id");
    if (!id) { failures.push(`WORK_ORDER_ID_MISSING:${file.path}`); continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(file);
  }

  const colliding = [...byId.entries()].filter(([, group]) => group.length > 1);
  const scopeIds = new Set();

  for (const [id, group] of colliding) {
    const paths = group.map((file) => file.path);
    for (const file of group) {
      const provenance = block(file.source, "provenance");
      if (!provenance) {
        failures.push(`COLLIDING_WORK_ORDER_PROVENANCE_MISSING:${file.path}`);
        continue;
      }
      const scopeId = scalar(provenance, "scope_id");
      if (!scopeId) failures.push(`COLLIDING_WORK_ORDER_SCOPE_ID_MISSING:${file.path}`);
      else if (scopeIds.has(scopeId)) failures.push(`COLLIDING_WORK_ORDER_SCOPE_ID_NOT_UNIQUE:${scopeId}`);
      else scopeIds.add(scopeId);
      if (scopeId && !scopeId.startsWith(`${id}.`)) failures.push(`COLLIDING_WORK_ORDER_SCOPE_ID_UNSCOPED:${file.path}:${scopeId}`);

      if (scalar(provenance, "work_order_id_collision") !== "true") failures.push(`COLLIDING_WORK_ORDER_COLLISION_NOT_DECLARED:${file.path}`);
      if (scalar(provenance, "reconciliation") !== "NON_DESTRUCTIVE") failures.push(`COLLIDING_WORK_ORDER_RECONCILIATION_NOT_NON_DESTRUCTIVE:${file.path}`);

      // Each colliding record must point at its counterpart, so neither can be read in isolation.
      const collidesWith = scalar(provenance, "collides_with");
      const counterparts = paths.filter((path) => path !== file.path);
      if (!collidesWith || !counterparts.includes(collidesWith)) {
        failures.push(`COLLIDING_WORK_ORDER_COUNTERPART_NOT_DECLARED:${file.path}:${collidesWith || "missing"}`);
      } else if (!existsSync(join(root, normalize(collidesWith)))) {
        failures.push(`COLLIDING_WORK_ORDER_COUNTERPART_MISSING:${collidesWith}`);
      }
    }
  }

  const reconciliationPath = join(root, normalize(RECONCILIATION_PATH));
  if (!existsSync(reconciliationPath)) {
    failures.push(`RECONCILIATION_RECORD_MISSING:${RECONCILIATION_PATH}`);
    return { ok: failures.length === 0, failures, collidingIds: colliding.map(([id]) => id) };
  }

  let reconciliation;
  try {
    reconciliation = JSON.parse(readFileSync(reconciliationPath, "utf8"));
  } catch {
    return { ok: false, failures: [...failures, "RECONCILIATION_RECORD_MALFORMED_JSON"], collidingIds: colliding.map(([id]) => id) };
  }

  if (reconciliation.reconciliation !== "NON_DESTRUCTIVE") failures.push("RECONCILIATION_NOT_NON_DESTRUCTIVE");
  if (reconciliation.reconciled_by !== "WO-0071") failures.push("RECONCILIATION_OWNER_INVALID");
  if (!Array.isArray(reconciliation.scopes) || reconciliation.scopes.length < 2) failures.push("RECONCILIATION_SCOPES_INCOMPLETE");

  validateStateBinding(root, reconciliation, failures);

  // Every colliding id observed on disk must actually be covered by the reconciliation record,
  // so a third artifact reusing the same number cannot slip in unreconciled.
  for (const [id, group] of colliding) {
    const covered = (reconciliation.scopes || []).filter((scope) => typeof scope?.scope_id === "string" && scope.scope_id.startsWith(`${id}.`));
    if (covered.length !== group.length) {
      failures.push(`RECONCILIATION_SCOPE_COVERAGE_MISMATCH:${id}:${covered.length}:${group.length}`);
    }
    for (const scope of covered) {
      if (!scope.work_order || !existsSync(join(root, normalize(scope.work_order)))) {
        failures.push(`RECONCILIATION_SCOPE_WORK_ORDER_MISSING:${scope.scope_id}`);
      }
      for (const field of ["implementation_head", "merge_commit"]) {
        if (!/^[0-9a-f]{40}$/.test(scope[field] || "")) failures.push(`RECONCILIATION_SCOPE_SHA_INVALID:${scope.scope_id}:${field}`);
      }
      if (typeof scope.pull_request !== "number") failures.push(`RECONCILIATION_SCOPE_PULL_REQUEST_INVALID:${scope.scope_id}`);
      // A scope with no completion evidence must say so explicitly rather than leaving the field
      // absent, because an absent field is exactly what invites borrowing the other scope's record.
      if (!("completion_evidence" in scope)) failures.push(`RECONCILIATION_SCOPE_COMPLETION_EVIDENCE_UNDECLARED:${scope.scope_id}`);
      if (typeof scope.completion_evidence === "string" && !existsSync(join(root, normalize(scope.completion_evidence)))) {
        failures.push(`RECONCILIATION_SCOPE_COMPLETION_EVIDENCE_MISSING:${scope.completion_evidence}`);
      }
    }
  }

  // No two scopes may claim the same completion-evidence file: that is the precise failure this
  // reconciliation exists to prevent.
  const claimedEvidence = (reconciliation.scopes || []).map((scope) => scope?.completion_evidence).filter((value) => typeof value === "string");
  if (new Set(claimedEvidence).size !== claimedEvidence.length) failures.push("RECONCILIATION_COMPLETION_EVIDENCE_SHARED_BETWEEN_SCOPES");

  return { ok: failures.length === 0, failures, collidingIds: colliding.map(([id]) => id) };
}

if (require.main === module) {
  const result = validateRepository();
  if (!result.ok) {
    console.error("AIPOS work-order provenance validation FAILED");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`AIPOS work-order provenance validation PASS (reconciled colliding ids: ${result.collidingIds.join(", ") || "none"})`);
}

module.exports = { RECONCILIATION_PATH, STATE_PATH, WORK_ORDER_DIR, workOrderFiles, validateRepository };
