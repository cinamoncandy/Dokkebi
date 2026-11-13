const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const WORKFLOW_DIR = ".github/workflows";

/**
 * Some third-party actions carry a default input that is a standing liability: the workflow never
 * asks for the behaviour, but inherits it, and the day upstream changes underneath that default the
 * step fails for a reason nothing in this repository can explain.
 *
 * That is not hypothetical here. `android-actions/setup-android` defaults `packages` to
 * `'tools platform-tools'`. Google removed the deprecated standalone `tools` package from the SDK
 * repository, so every Android job began failing at setup with
 * `Warning: Failed to find package 'tools'`. Because setup is step 8 of
 * android-stable-release.yml, every later step was skipped -- including all five Firebase App
 * Distribution steps. The visible symptom was "Firebase deployment is broken" while Firebase was
 * never reached and was not at fault.
 *
 * The lesson generalises past this one action: when an action's default input can break the build
 * without the build changing, the workflow must state the value it actually wants. This guard makes
 * that a rule rather than a thing someone has to remember.
 */
const REQUIRED_INPUTS = Object.freeze([
  Object.freeze({
    action: "android-actions/setup-android",
    input: "packages",
    reason: "defaults to 'tools platform-tools'; the deprecated 'tools' package was removed upstream and fails SDK setup"
  })
]);

/**
 * Unknown `with:` keys. A key an action does not declare is silently ignored by the runner (only a log warning), so the step
 * behaves as if it were never written. That is how `bundle-path` was passed to actions/attest, which declares it as an OUTPUT:
 * the signed bundle was never written to the path the next step read, and the upload step failed during the 2026-11-07 canary.
 *
 * Only actions listed here are checked. The list is copied from the action's own action.yml at the pinned commit named in
 * `source`; when a pin changes, re-read that action.yml and update the list in the same change.
 */
const KNOWN_INPUTS = Object.freeze({
  "actions/attest": Object.freeze({
    source: "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 (v4.2.2) action.yml inputs",
    inputs: Object.freeze(["subject-path", "subject-digest", "subject-name", "subject-checksums", "subject-version", "sbom-path", "predicate-type", "predicate", "predicate-path", "push-to-registry", "create-storage-record", "show-summary", "github-token"])
  })
});

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The indent of the step's list dash. A step that starts with `- uses:` has it on the same line; a step that starts with
 * `- name:` has `uses:` and `with:` at the same deeper indent, so the dash is the nearest earlier `- ` line that is shallower.
 */
function stepIndentOf(lines, index) {
  if (/^\s*-\s/.test(lines[index])) return indentOf(lines[index]);
  const usesIndent = indentOf(lines[index]);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (lines[cursor].trim() === "") continue;
    if (/^\s*-\s/.test(lines[cursor]) && indentOf(lines[cursor]) < usesIndent) return indentOf(lines[cursor]);
  }
  return usesIndent - 2;
}

function actionReference(line) {
  const match = line.match(/^\s*(?:-\s*)?uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/** Collect the `with:` keys belonging to the `uses:` step that starts at `index`. */
function withKeys(lines, index) {
  const stepIndent = stepIndentOf(lines, index);
  const keys = new Set();
  let inWith = false;
  let withIndent = -1;

  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    // A new list item or a dedent ends this step.
    if (indent <= stepIndent) break;

    if (inWith) {
      if (indent > withIndent) {
        const key = line.trim().split(":")[0].trim().replace(/^["']|["']$/g, "");
        if (key) keys.add(key);
        continue;
      }
      inWith = false;
    }
    if (/^with:\s*$/.test(line.trim())) { inWith = true; withIndent = indent; }
  }
  return keys;
}

function validateWorkflowActionInputs(root = process.cwd()) {
  const directory = join(root, WORKFLOW_DIR);
  const failures = [];
  if (!existsSync(directory)) return { ok: false, failures: [`WORKFLOW_DIR_MISSING:${WORKFLOW_DIR}`] };

  for (const name of readdirSync(directory).filter((item) => /\.ya?ml$/i.test(item)).sort()) {
    const lines = readFileSync(join(directory, name), "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const action = actionReference(lines[index]);
      if (action == null) continue;
      const bare = action.split("@")[0];
      for (const rule of REQUIRED_INPUTS) {
        if (bare !== rule.action) continue;
        if (withKeys(lines, index).has(rule.input)) continue;
        failures.push(`WORKFLOW_ACTION_INPUT_NOT_EXPLICIT:${name}:${index + 1}:${rule.action}:${rule.input}:${rule.reason}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/** The direct `key:` entries (with line numbers) of the `with:` block of the step that starts at `index`. Deeper lines (block scalars) are ignored. */
function withEntries(lines, index) {
  const stepIndent = stepIndentOf(lines, index);
  const entries = [];
  let withIndent = -1;
  let childIndent = -1;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent <= stepIndent) break;
    if (withIndent >= 0) {
      if (indent <= withIndent) { withIndent = -1; childIndent = -1; }
      else {
        if (childIndent < 0) childIndent = indent;
        if (indent === childIndent) {
          const key = line.trim().split(":")[0].trim().replace(/^["']|["']$/g, "");
          if (key) entries.push({ key, line: cursor + 1 });
        }
        continue;
      }
    }
    if (/^with:\s*$/.test(line.trim())) withIndent = indent;
  }
  return entries;
}

function validateUnknownInputs(root = process.cwd()) {
  const directory = join(root, WORKFLOW_DIR);
  const failures = [];
  if (!existsSync(directory)) return { ok: false, failures: [`WORKFLOW_DIR_MISSING:${WORKFLOW_DIR}`] };
  for (const name of readdirSync(directory).filter((item) => /\.ya?ml$/i.test(item)).sort()) {
    const lines = readFileSync(join(directory, name), "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const action = actionReference(lines[index]);
      if (action == null) continue;
      const known = KNOWN_INPUTS[action.split("@")[0]];
      if (!known) continue;
      for (const entry of withEntries(lines, index)) {
        if (known.inputs.includes(entry.key)) continue;
        failures.push(`WORKFLOW_ACTION_INPUT_UNKNOWN:${name}:${entry.line}:${action.split("@")[0]}:${entry.key}:not an input of ${known.source}; the runner ignores it`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

module.exports = { validateWorkflowActionInputs, validateUnknownInputs, REQUIRED_INPUTS, KNOWN_INPUTS };

if (require.main === module) {
  const result = validateWorkflowActionInputs();
  const unknown = validateUnknownInputs();
  const failures = [...result.failures, ...unknown.failures];
  if (failures.length > 0) {
    console.error("Workflow action input validation FAILED");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log("Workflow action input validation PASS");
}
