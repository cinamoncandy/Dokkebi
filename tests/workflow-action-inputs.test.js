const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { validateWorkflowActionInputs, REQUIRED_INPUTS } = require("../scripts/validate-workflow-action-inputs.js");

/**
 * Regression for the Firebase distribution outage of 2026-09-16.
 *
 * `android-actions/setup-android` defaults `packages` to `'tools platform-tools'`. Google removed
 * the deprecated `tools` package upstream, so SDK setup failed with
 * `Warning: Failed to find package 'tools'`. Setup is step 8 of android-stable-release.yml, so all
 * later steps were skipped, including every Firebase App Distribution step. The reported symptom
 * was a broken Firebase deployment; Firebase was never reached.
 *
 * Nothing in this repository changed. The build broke because an inherited default changed
 * underneath it, which is the class of failure this guard exists to prevent.
 */

function sandbox(files) {
  const root = mkdtempSync(join(tmpdir(), "nusa-action-inputs-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, ".github", "workflows", name), body, "utf8");
  return root;
}

const SETUP = "android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407";

test("the repository states every liability-carrying action input explicitly", () => {
  const result = validateWorkflowActionInputs();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test("omitting the input reproduces the exact outage state and fails", () => {
  const root = sandbox({
    "android.yml": ["name: A", "on:", "  push:", "jobs:", "  build:", "    steps:", `      - uses: ${SETUP}`, "      - run: ./gradlew assemble", ""].join("\n")
  });
  const result = validateWorkflowActionInputs(root);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith("WORKFLOW_ACTION_INPUT_NOT_EXPLICIT:android.yml:7:android-actions/setup-android:packages")), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});

test("a `with:` block that omits the required input still fails", () => {
  const root = sandbox({
    "android.yml": ["name: A", "on:", "  push:", "jobs:", "  build:", "    steps:", `      - uses: ${SETUP}`, "        with:", "          cmdline-tools-version: 11076708", ""].join("\n")
  });
  assert.equal(validateWorkflowActionInputs(root).ok, false, "an unrelated input must not satisfy the rule");
  rmSync(root, { recursive: true, force: true });
});

test("stating the input passes, in either key order", () => {
  const first = ["name: A", "on:", "  push:", "jobs:", "  build:", "    steps:", `      - uses: ${SETUP}`, "        with:", "          packages: platform-tools", "          cmdline-tools-version: 11076708", ""].join("\n");
  const second = ["name: B", "on:", "  push:", "jobs:", "  build:", "    steps:", `      - uses: ${SETUP}`, "        with:", "          cmdline-tools-version: 11076708", "          packages: platform-tools", ""].join("\n");
  const root = sandbox({ "a.yml": first, "b.yml": second });
  assert.deepEqual(validateWorkflowActionInputs(root).failures, []);
  rmSync(root, { recursive: true, force: true });
});

test("a later step's `with:` cannot satisfy an earlier step's requirement", () => {
  const root = sandbox({
    "android.yml": [
      "name: A", "on:", "  push:", "jobs:", "  build:", "    steps:",
      `      - uses: ${SETUP}`,
      "      - uses: actions/setup-node@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "        with:", "          packages: platform-tools", ""
    ].join("\n")
  });
  assert.equal(validateWorkflowActionInputs(root).ok, false, "the input must belong to the action that needs it");
  rmSync(root, { recursive: true, force: true });
});

test("every rule explains why the default is a liability", () => {
  assert.ok(REQUIRED_INPUTS.length > 0);
  for (const rule of REQUIRED_INPUTS) {
    assert.ok(rule.action && rule.input, "a rule names an action and an input");
    assert.ok((rule.reason ?? "").length > 20, `${rule.action}:${rule.input} must say why it is required`);
  }
});

// Follow-up of the 2026-11-07 canary: `bundle-path` is an OUTPUT of actions/attest, but the workflows passed it as an input.
// The runner ignored it, the signed bundle was never written where the next step read it, and the upload step failed.
const { validateUnknownInputs, KNOWN_INPUTS } = require("../scripts/validate-workflow-action-inputs.js");
const ATTEST = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";

test("the repository passes no key that a checked action does not declare", () => {
  assert.deepEqual(validateUnknownInputs().failures, []);
});

test("passing an output as an input is reported with its file and line (the canary defect)", () => {
  const root = sandbox({
    "attest.yml": ["name: A", "on:", "  push:", "jobs:", "  a:", "    steps:", `      - uses: ${ATTEST}`, "        with:", "          subject-path: receipt.json", "          bundle-path: out/attestation.json", ""].join("\n")
  });
  const result = validateUnknownInputs(root);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith("WORKFLOW_ACTION_INPUT_UNKNOWN:attest.yml:10:actions/attest:bundle-path:")), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});

test("declared inputs pass, in any order, and other actions are not checked", () => {
  const root = sandbox({
    "ok.yml": ["name: A", "on:", "  push:", "jobs:", "  a:", "    steps:", `      - uses: ${ATTEST}`, "        with:", "          predicate-path: receipt.json", "          subject-path: receipt.json", "          push-to-registry: false",
      "      - uses: actions/upload-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "        with:", "          anything-goes: 1", ""].join("\n")
  });
  assert.deepEqual(validateUnknownInputs(root).failures, []);
  rmSync(root, { recursive: true, force: true });
});

test("a later step's with-key and a deeper block scalar line are not mistaken for this action's inputs", () => {
  const root = sandbox({
    "scalar.yml": ["name: A", "on:", "  push:", "jobs:", "  a:", "    steps:", `      - uses: ${ATTEST}`, "        with:", "          predicate: |", "            {\"not-an-input\": true}", "          subject-path: receipt.json",
      "      - uses: actions/setup-node@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "        with:", "          bundle-path: fine-here", ""].join("\n")
  });
  assert.deepEqual(validateUnknownInputs(root).failures, []);
  rmSync(root, { recursive: true, force: true });
});

test("every checked action names the pinned source its input list was copied from", () => {
  for (const [action, rule] of Object.entries(KNOWN_INPUTS)) {
    assert.ok(rule.inputs.length > 0, action);
    assert.match(rule.source, /@[0-9a-f]{40}/, `${action} must name its pinned commit`);
  }
});

test("a step that starts with `- name:` (uses and with at the same indent) is checked too (the real attestor layout)", () => {
  const root = sandbox({
    "named.yml": ["name: A", "on:", "  push:", "jobs:", "  a:", "    steps:", "      - name: Attest", `        uses: ${ATTEST}`, "        with:", "          subject-path: receipt.json", "          bundle-path: out/attestation.json", ""].join("\n")
  });
  const result = validateUnknownInputs(root);
  assert.ok(result.failures.some((f) => f.startsWith("WORKFLOW_ACTION_INPUT_UNKNOWN:named.yml:11:actions/attest:bundle-path:")), JSON.stringify(result.failures));
  rmSync(root, { recursive: true, force: true });
});
