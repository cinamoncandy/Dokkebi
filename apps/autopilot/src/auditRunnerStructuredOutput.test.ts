import assert from "node:assert/strict";
import test from "node:test";
import { executeIndependentAudit, type AuditRunnerRequest } from "./auditRunner";
import type { WorkersAiBinding } from "./codingRunner";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const request: AuditRunnerRequest = Object.freeze({
  kind: "AUDIT_REQUEST",
  repository: "cinamoncandy/NUSA",
  prNumber: 1420,
  headSha: HEAD,
  baseSha: BASE,
  workflowRunId: 33550000001,
  executionId: "audit:1420:33550000001",
  dedupeKey: `audit:1420:${HEAD}`,
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

function fetchSequence() {
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
    response(200, {}, "diff --git a/a.ts b/a.ts\n+const safe = true;\n"),
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

test("requests JSON Schema output and accepts a structured verdict object", async () => {
  let capturedPrompt = "";
  let capturedResponseFormat: unknown;
  const AI: WorkersAiBinding = {
    async run(_model, input) {
      capturedPrompt = input.prompt;
      capturedResponseFormat = input.response_format;
      return {
        response: {
          verdict: "PASS",
          findings: [],
          blockers: [],
          safetyInvariantResult: "PASS",
          mergeAllowed: true,
        },
      };
    },
  };

  const result = await executeIndependentAudit(
    request,
    { AI, NUSA_AUDIT_GITHUB_TOKEN: "github-token" },
    fetchSequence() as never,
  );

  assert.equal(result.verdict, "PASS");
  assert.equal(result.mergeAllowed, true);
  assert.ok(capturedResponseFormat && typeof capturedResponseFormat === "object");
  const format = capturedResponseFormat as Record<string, unknown>;
  assert.equal(format.type, "json_schema");
  const schema = format.json_schema as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["verdict", "findings", "blockers", "safetyInvariantResult", "mergeAllowed"]);
  assert.match(capturedPrompt, /safetyInvariantResult MUST be a JSON string/);
  assert.match(capturedPrompt, /never use a boolean, object, null/);
});
