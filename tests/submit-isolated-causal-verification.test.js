const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("consumer writes a sanitized fail-closed receipt when OIDC bootstrap is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "nusa-isolated-receipt-"));
  const eventPath = join(directory, "event.json");
  const bundlePath = join(directory, "bundle.json");
  const receiptPath = join(directory, "receipt.json");
  try {
    writeFileSync(eventPath, JSON.stringify({
      repository: { full_name: "cinamoncandy/NUSA" },
      workflow_run: {
        id: 123456789,
        run_attempt: 2,
        head_sha: "a".repeat(40),
        head_branch: "main",
        head_repository: { full_name: "cinamoncandy/NUSA" },
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
      },
    }));
    writeFileSync(bundlePath, JSON.stringify({ fixtureOnly: true }));
    const environment = { ...process.env };
    delete environment.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    Object.assign(environment, {
      GITHUB_EVENT_PATH: eventPath,
      NUSA_ATTESTATION_BUNDLE: bundlePath,
      NUSA_VERIFICATION_RECEIPT: receiptPath,
    });

    const result = spawnSync(process.execPath, ["scripts/submit-isolated-causal-verification.js"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ISOLATED_VERIFICATION_INPUT_MISSING/);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.receiptType, "NUSA_ISOLATED_CAUSAL_VERIFICATION_RESULT_V1");
    assert.equal(receipt.outcome, "FAIL_CLOSED_OR_UNKNOWN");
    assert.equal(receipt.failureCode, "ISOLATED_VERIFICATION_INPUT_MISSING");
    assert.equal(receipt.sourceSha, "a".repeat(40));
    assert.equal(receipt.sourceRunId, "123456789");
    assert.equal(receipt.sourceRunAttempt, "2");
    assert.equal(receipt.claimOutcome, "UNKNOWN");
    assert.equal(receipt.productionMutationAllowed, false);
    assert.equal(receipt.aiAuthority, "ZERO_AUTHORITY");
    assert.equal(JSON.stringify(receipt).includes("ACTIONS_ID_TOKEN_REQUEST_TOKEN"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the consumer checks out trusted main before it runs the submit script (consumer 42789040136 failed with MODULE_NOT_FOUND)", () => {
  const workflow = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", ".github", "workflows", "causal-verification-consumer.yml"), "utf8");
  const checkout = workflow.indexOf("uses: actions/checkout@");
  const submit = workflow.indexOf("node scripts/submit-isolated-causal-verification.js");
  assert.ok(checkout > 0 && submit > checkout, "checkout must come before the submit step");
  assert.match(workflow.slice(checkout, submit), /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow.slice(checkout, submit), /persist-credentials: false/);
  assert.match(workflow, /permissions:\s*\n\s*actions: read\s*\n\s*contents: read\s*\n\s*id-token: write/);
  assert.equal(/contents: write|actions: write/.test(workflow), false, "no write authority is added");
});

test("on a Worker rejection the consumer keeps only the Worker's fixed stage constant from a bounded body", () => {
  const source = readFileSync(join(__dirname, "..", "scripts", "submit-isolated-causal-verification.js"), "utf8");
  const reject = source.slice(source.indexOf("if (!response.ok) {"), source.indexOf("let payload;"));
  assert.match(reject, /text\.length <= 16 \* 1024/);
  assert.match(reject, /\?\.rejectionStage/);
  assert.ok(reject.includes("/^[A-Z][A-Z0-9_]{2,95}(?::[A-Za-z0-9_]{1,64}){0,4}$/.test(candidate)"));
  assert.match(reject, /fail\(`ISOLATED_VERIFICATION_WORKER_REJECTED_\$\{response\.status\}`, stage\)/);
  const receipt = source.slice(source.indexOf("function writeFailureReceipt"), source.indexOf("const fail ="));
  assert.match(receipt, /workerRejectionStage \}/, "the receipt carries the stage under its own key");
  assert.ok(receipt.includes("/^[A-Z][A-Z0-9_]{2,95}(?::[A-Za-z0-9_]{1,64}){0,4}$/.test(workerRejectionStage)"), "and re-validates it before writing");
});
