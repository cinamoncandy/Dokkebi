const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { evaluatePreflight, EXPECTED_TARGET_BLOB } = require("../scripts/canary-preflight-evaluate.js");
const { analyze } = require("../scripts/canary-evidence-hash.js");

const good = () => ({ targetBlob: EXPECTED_TARGET_BLOB, autopilotCodexCodingState: "disabled_manually", mainCi: { conclusion: "success" }, otherPrsInAuditOrMerge: [], server: { restarts: 0, newAlarms: 0 }, openP0: 0, canaryPrDraft: true, canaryPrMerged: false });

test("preflight passes only when every fact is good", () => {
  assert.equal(evaluatePreflight(good()).verdict, "PASS");
});

test("preflight fails closed on each bad or missing fact", () => {
  for (const patch of [{ targetBlob: "x" }, { autopilotCodexCodingState: "active" }, { mainCi: { conclusion: "failure" } }, { otherPrsInAuditOrMerge: [2] }, { server: { restarts: 1, newAlarms: 0 } }, { openP0: 1 }, { canaryPrDraft: false }, { canaryPrMerged: true }]) {
    const result = evaluatePreflight({ ...good(), ...patch });
    assert.equal(result.verdict, "FAIL", JSON.stringify(patch));
  }
  assert.equal(evaluatePreflight(undefined).verdict, "FAIL");
  assert.equal(evaluatePreflight({}).verdict, "FAIL");
  assert.equal(evaluatePreflight({ ...good(), openP0: "0" }).verdict, "FAIL");
  assert.equal(evaluatePreflight({ ...good(), server: undefined }).verdict, "FAIL");
});

function evidence(attempts, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-canary-"));
  for (let i = 1; i <= attempts; i += 1) {
    const a = path.join(dir, `nusa-causal-attestation-${i}`);
    fs.mkdirSync(a);
    const receipt = { source: { repository: "cinamoncandy/NUSA", sha: "a".repeat(40), workflowRef: "ci.yml@refs/heads/main" }, observation: { status: "OBSERVED_MISMATCH" } };
    if (mutate) mutate(receipt, i);
    fs.writeFileSync(path.join(a, "receipt.json"), JSON.stringify(receipt));
    fs.writeFileSync(path.join(a, "attestation.json"), `{"bundle":${i}}`);
  }
  return dir;
}

test("evidence: up to three consistent attempts are OK and hashed", () => {
  const result = analyze(evidence(3));
  assert.equal(result.verdict, "OK");
  assert.equal(result.attempts, 3);
  assert.equal(result.files.length, 6);
  for (const f of result.files) assert.match(f.sha256, /^[a-f0-9]{64}$/);
});

test("evidence: a fourth attempt, a different source identity, a non-mismatch or a CODE_ACTIONABLE key need review", () => {
  assert.deepEqual(analyze(evidence(4)).stop, ["MORE_THAN_THREE_ATTEMPTS"]);
  assert.deepEqual(analyze(evidence(2, (r, i) => { if (i === 2) r.source.sha = "b".repeat(40); })).stop, ["DIFFERENT_SOURCE_IDENTITY"]);
  assert.equal(analyze(evidence(1, (r) => { r.observation.status = "MATCH"; })).verdict, "REVIEW");
  assert.equal(analyze(evidence(1, (r) => { r.CODE_ACTIONABLE = true; })).verdict, "REVIEW");
  assert.equal(analyze(fs.mkdtempSync(path.join(os.tmpdir(), "nusa-canary-empty-"))).verdict, "REVIEW");
});

test("evidence helper does not modify its input directory", () => {
  const dir = evidence(1);
  const before = fs.readdirSync(path.join(dir, "nusa-causal-attestation-1")).sort();
  analyze(dir);
  assert.deepEqual(fs.readdirSync(path.join(dir, "nusa-causal-attestation-1")).sort(), before);
});
