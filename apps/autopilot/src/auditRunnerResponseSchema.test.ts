import assert from "node:assert/strict";
import test from "node:test";
import { executeIndependentAudit, type AuditRunnerRequest } from "./auditRunner";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const request: AuditRunnerRequest = Object.freeze({
  kind: "AUDIT_REQUEST",
  repository: "cinamoncandy/NUSA",
  prNumber: 1437,
  headSha: HEAD,
  baseSha: BASE,
  workflowRunId: 33568450693,
  executionId: "audit:1437:33568450693",
  dedupeKey: `audit:1437:${HEAD}`,
  mutationAllowed: false,
  liveAuthority: "NONE",
  productionMutationAllowed: false,
  aiAuthority: "ZERO_AUTHORITY",
});

function response(status: number, payload: unknown, textValue?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return textValue ?? JSON.stringify(payload); },
  };
}

function fetchSequence(diff = "diff --git a/a.ts b/a.ts\n+const safe = true;\n") {
  const pull = {
    state: "open",
    changed_files: 1,
    head: { sha: HEAD, repo: { full_name: "cinamoncandy/NUSA" } },
    base: { sha: BASE, repo: { full_name: "cinamoncandy/NUSA" } },
  };
  const run = {
    id: request.workflowRunId,
    name: "CI",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    repository: { full_name: "cinamoncandy/NUSA" },
    pull_requests: [{ number: request.prNumber }],
  };
  const queue = [
    response(200, pull),
    response(200, run),
    response(200, [{ filename: "a.ts", status: "modified" }]),
    response(200, {}, diff),
    response(200, pull),
    response(200, run),
    response(200, [{ filename: "a.ts", status: "modified" }]),
  ];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  };
}

test("Workers AI response schema makes verdict invariants structurally expressible", async () => {
  let captured: Record<string, unknown> | undefined;
  const AI = {
    async run(_model: string, modelRequest: Record<string, unknown>) {
      captured = modelRequest;
      return { response: { verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true } };
    },
  };

  const result = await executeIndependentAudit(
    request,
    { AI, NUSA_AUDIT_GITHUB_TOKEN: "github-token" },
    fetchSequence() as never,
  );
  assert.equal(result.verdict, "PASS");

  const responseFormat = captured?.response_format as {
    type?: unknown;
    json_schema?: { anyOf?: readonly Record<string, unknown>[]; properties?: Record<string, { type?: unknown; enum?: readonly string[] }> };
  } | undefined;
  assert.equal(responseFormat?.type, "json_schema");
  assert.equal(responseFormat?.json_schema?.anyOf, undefined);
  assert.deepEqual(responseFormat?.json_schema?.properties?.verdict?.enum, ["PASS", "PASS_WITH_NOTES", "FAIL"]);
  assert.deepEqual(responseFormat?.json_schema?.properties?.safetyInvariantResult?.enum, ["PASS", "FAIL"]);
  assert.equal(responseFormat?.json_schema?.properties?.safetyInvariantResult?.type, "string");
  assert.equal(responseFormat?.json_schema?.properties?.mergeAllowed?.type, "boolean");
});

test("format repair is not source evidence and a genuine grounded blocker remains FAIL", async () => {
  let attempts = 0;
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const amount = missingInput.amount;\n";
  const AI = { async run(_model: string, input: Record<string, unknown>) {
    attempts++;
    if (attempts === 1) return { response: "not JSON" };
    const prompt = String(input.prompt);
    assert.match(prompt, /not a defect observed in the repository/);
    assert.match(prompt, /must not itself become a finding, blocker, or safety failure/);
    assert.match(prompt, /Preserve any genuine source-grounded blocker/);
    assert.match(prompt, /do not choose PASS merely to repair JSON/);
    assert.ok(prompt.includes(diff));
    return { response: { verdict: "FAIL", findings: [{ code: "MISSING_INPUT", severity: "BLOCKER", message: "Undefined input is dereferenced.", evidenceRef: "a.ts:+1", evidenceScope: "SOURCE_CONTENT" }], blockers: ["Undefined input is dereferenced."], safetyInvariantResult: "PASS", mergeAllowed: false } };
  } };
  const result = await executeIndependentAudit(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: "github-token" }, fetchSequence(diff) as never);
  assert.equal(attempts, 2);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.mergeAllowed, false);
  assert.equal(result.findings[0]?.code, "MISSING_INPUT");
});

test("repair feedback does not make repeatedly invalid output an approval", async () => {
  let attempts = 0;
  const AI = { async run() { attempts++; return { response: "not JSON" }; } };
  await assert.rejects(executeIndependentAudit(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: "github-token" }, fetchSequence() as never), /AUDIT_VERDICT_JSON_INVALID/);
  assert.equal(attempts, 3, "existing three-attempt retry budget unchanged");
});
