const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const fail = (message) => { console.error(message); process.exit(1); };
const outputDir = process.env.NUSA_ISOLATED_OUTPUT_DIR;
const repository = process.env.GITHUB_REPOSITORY;
const workflowSha = process.env.NUSA_WORKFLOW_SHA;
const sourceSha = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
const eventName = process.env.GITHUB_EVENT_NAME;
const ref = process.env.GITHUB_REF;
const workflowRef = process.env.NUSA_WORKFLOW_REF;

if (!outputDir || repository !== "cinamoncandy/NUSA" || !/^[0-9a-f]{40}$/.test(workflowSha || "")
  || workflowSha !== sourceSha || !/^[1-9][0-9]{0,19}$/.test(runId || "")
  || !/^[1-9][0-9]{0,9}$/.test(runAttempt || "") || eventName !== "workflow_dispatch"
  || ref !== "refs/heads/main"
  || workflowRef !== "cinamoncandy/NUSA/.github/workflows/causal-verification.yml@refs/heads/main") {
  fail("ISOLATED_CAUSAL_WORKFLOW_CONTEXT_INVALID");
}

const sourcePath = path.join(process.cwd(), "apps/autopilot/src/repairableWorkflowRun.ts");
const original = fs.readFileSync(sourcePath, "utf8");
const allowlist = 'new Set(["CI", "Autopilot Sandbox New-File Guard"])';
if (original.split(allowlist).length !== 2) fail("ISOLATED_FIXTURE_ANCHOR_NOT_UNIQUE");
const mutated = original.replace(allowlist, "new Set([])");
const compiled = ts.transpileModule(mutated, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: "repairableWorkflowRun.fixture.ts",
}).outputText;
fs.mkdirSync(outputDir, { recursive: true });
const fixturePath = path.join(outputDir, "repairableWorkflowRun.fixture.cjs");
fs.writeFileSync(fixturePath, compiled, { flag: "wx", mode: 0o600 });
const fixtureDigest = crypto.createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex");
const fixtureModule = require(fixturePath);
const workflowFailure = Object.freeze({
  name: "CI",
  conclusion: "failure",
  head_branch: "main",
  event: "push",
});
const expected = require(path.join(process.cwd(), "dist/apps/autopilot/src/repairableWorkflowRun.js"))
  .isRepairableMainWorkflowFailure(workflowFailure);
const observed = fixtureModule.isRepairableMainWorkflowFailure(workflowFailure);
if (expected !== true || observed !== false) fail("ISOLATED_CAUSAL_MISMATCH_NOT_OBSERVED");

const receipt = {
  domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1",
  schemaVersion: 1,
  source: {
    repository,
    workflowPath: ".github/workflows/causal-verification.yml",
    workflowRef,
    workflowSha,
    ref,
    event: eventName,
    job: "verify-causal-positive",
    sha: sourceSha,
    runId,
    runAttempt,
  },
  caseId: "isolated-policy-regression",
  fixtureDigest,
  observation: { caseId: "isolated-policy-regression", expected, observed, status: "OBSERVED_MISMATCH" },
};
fs.writeFileSync(path.join(outputDir, "receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: "OBSERVED_MISMATCH", fixtureDigest, sourceSha, runId, runAttempt }));
