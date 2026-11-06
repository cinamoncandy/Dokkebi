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
