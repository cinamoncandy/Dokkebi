import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildDeterministicCodingPatch, countChangedPatchLines, MAX_CODING_CHANGED_LINES, validateCodingProposal, CodingRunnerEvidenceError, executeCodingRunner, isWorkflowFailureCodingReason, validateCodingRunnerRequest, verifyCodingRunnerRequestAgainstGitHub, type CodingRuntime, type WorkersAiBinding } from "./codingRunner";
import { classifyCodingRunnerFailure } from "./codingRunnerFailureClass";

describe("workflow-failure reason detection", () => {
  it("recognizes both canonical failure reason forms without classifying issue work", () => {
    const sha = "a".repeat(40);
    assert.equal(isWorkflowFailureCodingReason(`gha:123:${sha}:failure`), true);
    assert.equal(isWorkflowFailureCodingReason(`evolve:discovery:gha:CI:${sha}:timed_out`), true);
    assert.equal(isWorkflowFailureCodingReason("evolve:discovery:github-issue-2118"), false);
    assert.equal(isWorkflowFailureCodingReason(`gha:123:${sha}:success`), false);
    assert.equal(isWorkflowFailureCodingReason("generic CI failure"), false);
  });
});

const request = {
  kind: "REPOSITORY_AUTOPILOT" as const,
  repository: "cinamoncandy/NUSA",
  headSha: "a".repeat(40),
  workflowRunId: 123,
  reason: "continue-from:ci_succeeded",
  executionId: "github:delivery-123",
  dedupeKey: `ci:123:${"a".repeat(40)}`,
  mutationAllowed: false as const,
  liveAuthority: "NONE" as const,
  productionMutationAllowed: false as const,
  aiAuthority: "ZERO_AUTHORITY" as const,
};

const patch = "diff --git a/apps/autopilot/src/example.ts b/apps/autopilot/src/example.ts\n--- a/apps/autopilot/src/example.ts\n+++ b/apps/autopilot/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n";

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const verifiedGithubFetch = async (url: string) => {
  if (url.includes("/commits/")) return response(200, { sha: request.headSha });
  return response(200, {
    id: request.workflowRunId,
    workflow_id: 311000286,
    path: ".github/workflows/ci.yml",
    name: "CI",
    event: "pull_request",
    head_sha: request.headSha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    repository: { full_name: request.repository },
  });
};

const verifiedFailureGithubFetch = async (url: string) => {
  if (url.includes("/commits/")) return response(200, { sha: request.headSha });
  if (url.includes("/branches/main")) return response(200, { commit: { sha: request.headSha } });
  if (url.includes("/jobs?")) {
    return response(200, {
      total_count: 1,
      jobs: [{
        run_id: request.workflowRunId,
        name: "validation",
        conclusion: "failure",
        steps: [
          { name: "Checkout", conclusion: "success" },
          { name: "Typecheck", conclusion: "failure" },
        ],
      }],
    });
  }
  return response(200, {
    id: request.workflowRunId,
    workflow_id: 311000286,
    path: ".github/workflows/ci.yml",
    name: "CI",
    event: "push",
    head_sha: request.headSha,
    head_branch: "main",
    status: "completed",
    conclusion: "failure",
    repository: { full_name: request.repository },
  });
};

const runtimeEnv = {
  NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
  NUSA_AI_CODING_ENDPOINT: "https://coding.example.test/execute",
  NUSA_AI_CODING_TOKEN: "ai-token",
  NUSA_GITHUB_TOKEN: "github-token",
};
const jevTestKey = () => ["unit", "jev", "credential"].join("-");

describe("coding runner", () => {
  it("constructs a deterministic single-file patch from one exact edit", () => {
    const context = {
      path: "apps/autopilot/src/example.ts",
      startLine: 7,
      content: "export const before = true;\nexport const oldValue = true;\nexport const after = true;\n",
    };
    const edit = {
      path: context.path,
      expectedText: "export const oldValue = true;",
      replacementText: "export const oldValue = false;",
    };
    const patch = buildDeterministicCodingPatch(context, edit);
    assert.match(patch, /@@ -7,3 \+7,3 @@/);
    assert.match(patch, /-export const oldValue = true;/);
    assert.match(patch, /\+export const oldValue = false;/);
    assert.equal(patch, buildDeterministicCodingPatch(context, edit));
  });

  it("constructs a patch accepted by strict git apply check", () => {
    const context = { path: "apps/autopilot/src/example.ts", startLine: 7, content: "export const before = true;\nexport const oldValue = true;\nexport const after = true;\n" };
    const patch = buildDeterministicCodingPatch(context, { path: context.path, expectedText: "export const oldValue = true;", replacementText: "export const oldValue = false;" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-edit-"));
    try {
      const target = path.join(root, context.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${"// prelude\n".repeat(6)}${context.content}`, "utf8");
      const patchPath = path.join(root, ".patch");
      fs.writeFileSync(patchPath, patch, "utf8");
      const result = spawnSync("git", ["apply", "--check", patchPath], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing and ambiguous edit anchors", () => {
    const context = { path: "apps/autopilot/src/example.ts", startLine: 1, content: "const value = true;\nconst value = true;\n" };
    assert.throws(
      () => buildDeterministicCodingPatch(context, { path: context.path, expectedText: "missing", replacementText: "new" }),
      /CODING_EDIT_ANCHOR_NOT_FOUND/,
    );
    assert.throws(
      () => buildDeterministicCodingPatch(context, { path: context.path, expectedText: "const value = true;", replacementText: "const value = false;" }),
      /CODING_EDIT_ANCHOR_AMBIGUOUS/,
    );
  });

  it("materializes a structured edit before sandbox execution", async () => {
    const contextual = {
      ...request,
      proposalContext: {
        path: "apps/autopilot/src/example.ts",
        startLine: 7,
        content: "export const before = true;\nexport const oldValue = true;\nexport const after = true;\n",
      },
    };
    let observedPatch = "";
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(_value, proposal) {
        observedPatch = proposal?.patch ?? "";
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const ai: WorkersAiBinding = {
      async run(_model, input) {
        assert.deepEqual(input.response_format?.json_schema.required, ["edit"]);
        return { response: { edit: { path: contextual.proposalContext.path, expectedText: "export const oldValue = true;", replacementText: "export const oldValue = false;" } } };
      },
    };
    const result = await executeCodingRunner(contextual, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.match(observedPatch, /diff --git a\/apps\/autopilot\/src\/example\.ts/);
    assert.match(observedPatch, /@@ -7,3 \+7,3 @@/);
  });

  it("replaces a substring within complete source lines and rejects empty replacements", () => {
    const context = { path: "apps/autopilot/src/example.ts", startLine: 1, content: "const value = true;\nconst after = true;\n" };
    const patch = buildDeterministicCodingPatch(context, { path: context.path, expectedText: "value = true", replacementText: "value = false" });
    assert.match(patch, /-const value = true;/);
    assert.match(patch, /\+const value = false;/);
    assert.throws(
      () => buildDeterministicCodingPatch(context, { path: context.path, expectedText: "value = true", replacementText: "" }),
      /CODING_EDIT_REPLACEMENT_INVALID/,
    );
  });

  it("rejects structured edits outside the bounded authority surface", async () => {
    const contextual = {
      ...request,
      proposalContext: { path: "apps/autopilot/src/example.ts", startLine: 1, content: "const value = true;\n" },
    };
    const ai: WorkersAiBinding = {
      async run() {
        return { response: { edit: { path: "apps/autopilot/src/worker.ts", expectedText: "const value = true;", replacementText: "const value = false;" } } };
      },
    };
    const result = await executeCodingRunner(contextual, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "CODING_EDIT_PATH_FORBIDDEN");
  });

  it("preserves the HTTP status for non-200 GitHub commit and workflow lookups", async () => {
    await assert.rejects(
      () => verifyCodingRunnerRequestAgainstGitHub(request, undefined, async () => response(503, {})),
      (error: unknown) => {
        assert.equal((error as Error).message, "CODING_RUNNER_HEAD_SHA_UNVERIFIED");
        assert.equal((error as { httpStatus?: number }).httpStatus, 503);
        return true;
      },
    );

    let call = 0;
    await assert.rejects(
      () => verifyCodingRunnerRequestAgainstGitHub(request, undefined, async () => {
        call += 1;
        return call === 1 ? response(200, { sha: request.headSha }) : response(429, {});
      }),
      (error: unknown) => {
        assert.equal((error as Error).message, "CODING_RUNNER_WORKFLOW_RUN_UNVERIFIED");
        assert.equal((error as { httpStatus?: number }).httpStatus, 429);
        return true;
      },
    );
  });

  it("accepts only the fail-closed repository contract with lifecycle identity", () => {
    assert.deepEqual(validateCodingRunnerRequest(request), request);
  });

  it("accepts only bounded printable proposal repair feedback", () => {
    const repair = { ...request, proposalFeedback: "attempt=2;rejection=SANDBOX_PATCH_APPLY_CHECK_FAILED;repair=regenerate" };
    assert.deepEqual(validateCodingRunnerRequest(repair), repair);
    assert.throws(
      () => validateCodingRunnerRequest({ ...request, proposalFeedback: "attempt=2\nsecret=unexpected" }),
      /CODING_RUNNER_PROPOSAL_FEEDBACK_INVALID/,
    );
    assert.throws(
      () => validateCodingRunnerRequest({ ...request, proposalFeedback: "x".repeat(513) }),
      /CODING_RUNNER_PROPOSAL_FEEDBACK_INVALID/,
    );
  });

  it("accepts only bounded read-only retry source context", async () => {
    const contextual = {
      ...request,
      proposalContext: {
        path: "apps/autopilot/src/example.ts",
        startLine: 7,
        content: "export const oldValue = true;\n",
      },
    };
    assert.deepEqual(validateCodingRunnerRequest(contextual), contextual);

    let observedPrompt = "";
    const ai: WorkersAiBinding = {
      async run(_model, input) {
        observedPrompt = input.prompt;
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(contextual, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.match(observedPrompt, /Target path: apps\/autopilot\/src\/example\.ts/);
    assert.match(observedPrompt, /Excerpt starts at source line 7/);
    assert.match(observedPrompt, /export const oldValue = true/);

    let configuredBody: Record<string, unknown> | undefined;
    const configuredResult = await executeCodingRunner(contextual, runtimeEnv, async (url, init) => {
      if (url.includes("/commits/")) return response(200, { sha: request.headSha });
      if (url.includes("/actions/runs/")) return response(200, {
        id: request.workflowRunId,
        head_sha: request.headSha,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        repository: { full_name: request.repository },
      });
      configuredBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(200, { patch });
    });
    assert.equal(configuredResult.status, "EXECUTION_ACCEPTED");
    assert.deepEqual(configuredBody?.proposalContext, contextual.proposalContext);

    assert.throws(
      () => validateCodingRunnerRequest({ ...request, proposalContext: { path: "apps/autopilot/src/worker.ts", startLine: 1, content: "x" } }),
      /CODING_RUNNER_PROPOSAL_CONTEXT_PATH_INVALID/,
    );
    assert.throws(
      () => validateCodingRunnerRequest({ ...request, proposalContext: { path: "apps/autopilot/src/example.ts", startLine: 0, content: "x" } }),
      /CODING_RUNNER_PROPOSAL_CONTEXT_LINE_INVALID/,
    );
    assert.throws(
      () => validateCodingRunnerRequest({ ...request, proposalContext: { path: "apps/autopilot/src/example.ts", startLine: 1, content: "x".repeat(20_001) } }),
      /CODING_RUNNER_PROPOSAL_CONTEXT_CONTENT_INVALID/,
    );
  });

  it("escalates apply-check repair with exact context to GitHub Models before Workers AI", async () => {
    const repairRequest = {
      ...request,
      proposalFeedback: "attempt=2;rejection=SANDBOX_PATCH_APPLY_CHECK_FAILED;repair=regenerate",
      proposalContext: {
        path: "apps/autopilot/src/example.ts",
        startLine: 7,
        content: "export const oldValue = true;\n",
      },
    };
    let workersAiCalls = 0;
    let githubModelsCalls = 0;
    let observedPrompt = "";
    const ai: WorkersAiBinding = {
      async run() {
        workersAiCalls += 1;
        return { response: { patch } };
      },
    };

    const result = await executeCodingRunner(
      repairRequest,
      { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai },
      async (url, init) => {
        if (url.includes("/commits/")) return response(200, { sha: request.headSha });
        if (url.includes("/actions/runs/")) return response(200, {
          id: request.workflowRunId,
          workflow_id: 311000286,
          path: ".github/workflows/ci.yml",
          name: "CI",
          event: "pull_request",
          head_sha: request.headSha,
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          repository: { full_name: request.repository },
        });
        if (url === "https://models.github.ai/inference/chat/completions") {
          githubModelsCalls += 1;
          const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
          observedPrompt = body.messages?.[1]?.content ?? "";
          return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    );

    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(githubModelsCalls, 1);
    assert.equal(workersAiCalls, 0);
    assert.match(observedPrompt, /Repair feedback: .*SANDBOX_PATCH_APPLY_CHECK_FAILED/);
    assert.match(observedPrompt, /Target path: apps\/autopilot\/src\/example\.ts/);
    assert.match(observedPrompt, /export const oldValue = true/);
  });

  it("escalates normalized apply-check repair with exact context to GitHub Models", async () => {
    const repairRequest = {
      ...request,
      proposalFeedback: "attempt=3;rejection=SANDBOX_PATCH_NORMALIZED_APPLY_CHECK_FAILED;repair=regenerate",
      proposalContext: {
        path: "apps/autopilot/src/example.ts",
        startLine: 7,
        content: "export const oldValue = true;\n",
      },
    };
    let workersAiCalls = 0;
    let githubModelsCalls = 0;
    const ai: WorkersAiBinding = {
      async run() {
        workersAiCalls += 1;
        return { response: { patch } };
      },
    };

    const result = await executeCodingRunner(
      repairRequest,
      { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai },
      async (url) => {
        if (url.includes("/commits/")) return response(200, { sha: request.headSha });
        if (url.includes("/actions/runs/")) return response(200, {
          id: request.workflowRunId,
          head_sha: request.headSha,
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          repository: { full_name: request.repository },
        });
        if (url === "https://models.github.ai/inference/chat/completions") {
          githubModelsCalls += 1;
          return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    );

    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(githubModelsCalls, 1);
    assert.equal(workersAiCalls, 0);
  });

  it("rejects missing or malformed lifecycle identity", () => {
    assert.throws(() => validateCodingRunnerRequest({ ...request, executionId: "" }), /CODING_RUNNER_EXECUTION_ID_INVALID/);
    assert.throws(() => validateCodingRunnerRequest({ ...request, dedupeKey: "bad key" }), /CODING_RUNNER_DEDUPE_KEY_INVALID/);
  });

  it("rejects production mutation authority", () => {
    assert.throws(() => validateCodingRunnerRequest({ ...request, productionMutationAllowed: true }), /CODING_RUNNER_PRODUCTION_MUTATION_FORBIDDEN/);
  });

  it("rejects generic or mismatched repositories", () => {
    assert.throws(() => validateCodingRunnerRequest({ ...request, repository: "other/repo" }), /CODING_RUNNER_REPOSITORY_INVALID/);
  });

  it("rejects a syntactically valid nonexistent SHA before coding execution", async () => {
    let calls = 0;
    await assert.rejects(
      () => verifyCodingRunnerRequestAgainstGitHub(request, "github-token", async () => {
        calls += 1;
        return response(404, { message: "Not Found" });
      }),
      /CODING_RUNNER_HEAD_SHA_UNVERIFIED/,
    );
    assert.equal(calls, 2);
  });

  it("rejects a stale or attacker-chosen SHA not bound to the trusted workflow run", async () => {
    const urls: string[] = [];
    await assert.rejects(
      () => verifyCodingRunnerRequestAgainstGitHub(request, "github-token", async (url) => {
        urls.push(url);
        if (url.includes("/commits/")) return response(200, { sha: request.headSha });
        return response(200, {
          id: request.workflowRunId,
          head_sha: "b".repeat(40),
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          repository: { full_name: request.repository },
        });
      }),
      /CODING_RUNNER_WORKFLOW_HEAD_MISMATCH/,
    );
    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => url.startsWith("https://api.github.com/repos/cinamoncandy/NUSA/")));
  });

  it("accepts only an existing SHA bound to the successful trusted workflow run", async () => {
    const urls: string[] = [];
    await verifyCodingRunnerRequestAgainstGitHub(request, "github-token", async (url) => {
      urls.push(url);
      return verifiedGithubFetch(url);
    });
    assert.equal(urls.length, 2);
  });

  it("falls back to public GitHub evidence when an optional token is rejected", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    await verifyCodingRunnerRequestAgainstGitHub(request, "stale-token", async (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, authorization: headers?.Authorization });
      if (headers?.Authorization) return response(401, { message: "Bad credentials" });
      return verifiedGithubFetch(url);
    });
    assert.equal(calls.length, 4);
    assert.ok(calls.some((call) => call.authorization === "Bearer stale-token"));
    assert.ok(calls.some((call) => call.authorization === undefined));
  });

  it("accepts a failed workflow only for an explicit gha failure-repair request", async () => {
    const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${request.headSha}:failure` };
    await verifyCodingRunnerRequestAgainstGitHub(failureRequest, "github-token", async (url) => {
      if (url.includes("/commits/")) return response(200, { sha: request.headSha });
      if (url.includes("/branches/main")) return response(200, { commit: { sha: request.headSha } });
      return response(200, {
        id: request.workflowRunId,
        workflow_id: 311000286,
        path: ".github/workflows/ci.yml",
        name: "CI",
        event: "push",
        head_sha: request.headSha,
        head_branch: "main",
        status: "completed",
        conclusion: "failure",
        repository: { full_name: request.repository },
      });
    });
  });

  describe("evolve discovery failure reason without a run id (gha:<workflow>:<sha>:<conclusion>)", () => {
    const fetchFor = (conclusion: string, name = "CI") => async (url: string) => {
      if (url.includes("/commits/")) return response(200, { sha: request.headSha });
      if (url.includes("/branches/main")) return response(200, { commit: { sha: request.headSha } });
      return response(200, { id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name, event: "push", head_sha: request.headSha, head_branch: "main", status: "completed", conclusion, repository: { full_name: request.repository } });
    };
    const named = (suffix = "failure", sha = request.headSha, name = "ci") => ({ ...request, reason: `evolve:discovery:gha:${name}:${sha}:${suffix}:Canonical workflow CI concluded failure for ${sha}.` });

    it("treats a verified failed run of the same workflow and commit as a failure-repair request", async () => {
      const evidence = await verifyCodingRunnerRequestAgainstGitHub(named(), "github-token", fetchFor("failure"));
      assert.equal(evidence.workflowConclusion, "failure");
    });

    it("rejects a reason workflow label that does not match the verified workflow identity", async () => {
      await assert.rejects(
        () => verifyCodingRunnerRequestAgainstGitHub(named("failure", request.headSha, "mobile-native"), "github-token", fetchFor("failure", "CI")),
        /WORKFLOW_IDENTITY_MISMATCH/,
      );
      await assert.rejects(
        () => verifyCodingRunnerRequestAgainstGitHub(named("failure", request.headSha, "ci"), "github-token", fetchFor("failure", "Android Stable Release")),
        /WORKFLOW_IDENTITY_MISMATCH/,
      );
    });

    it("rejects a different commit or a run that is not actually failed", async () => {
      await assert.rejects(() => verifyCodingRunnerRequestAgainstGitHub(named("failure", "b".repeat(40)), "github-token", fetchFor("failure")), /CODING_RUNNER_FAILURE_REASON_IDENTITY_MISMATCH/);
      await assert.rejects(() => verifyCodingRunnerRequestAgainstGitHub(named(), "github-token", fetchFor("success")), /CODING_RUNNER_FAILURE_EVIDENCE_INVALID/);
    });

    it("still requires a successful run when the reason carries no failure identity", async () => {
      await assert.rejects(() => verifyCodingRunnerRequestAgainstGitHub({ ...request, reason: "evolve:discovery:github-issue-2118" }, "github-token", fetchFor("failure")), /CODING_RUNNER_WORKFLOW_NOT_SUCCESSFUL/);
    });
  });

  it("blocks governance and unknown workflows before spending coding remediation attempts", async () => {
    const cases = [
      { path: ".github/workflows/oracle-paper-release.yml", name: "Oracle PAPER Release", workflowId: 360101484, code: "RELEASE_BLOCKED", failureClass: "RELEASE_BLOCKED" },
      { path: ".github/workflows/autopilot-deterministic-audit-release.yml", name: "Autopilot Deterministic Audit Release", workflowId: 348514628, code: "AUDIT_BLOCKED", failureClass: "AUDIT_BLOCKED" },
      { path: ".github/workflows/autopilot-cloudflare-deploy.yml", name: "Autopilot Cloudflare Deploy", workflowId: 344586670, code: "DEPLOYMENT_FAILURE", failureClass: "DEPLOYMENT_FAILURE" },
      { path: ".github/workflows/credential-preflight.yml", name: "Credential Preflight", workflowId: 123456789, code: "PERMISSION_FAILURE", failureClass: "PERMISSION_FAILURE" },
      { path: ".github/workflows/unlisted.yml", name: "Unlisted workflow", workflowId: 999999999, code: "WORKFLOW_NOT_ELIGIBLE", failureClass: "WORKFLOW_NOT_ELIGIBLE" },
    ] as const;
    for (const item of cases) {
      let aiCalls = 0;
      let jobLookups = 0;
      const ai: WorkersAiBinding = { async run() { aiCalls += 1; return { response: JSON.stringify({ patch }) }; } };
      const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${request.headSha}:failure` };
      const fetch = async (url: string) => {
        if (url.includes("/commits/")) return response(200, { sha: request.headSha });
        if (url.includes("/jobs?")) { jobLookups += 1; return response(200, { jobs: [] }); }
        return response(200, {
          id: request.workflowRunId, workflow_id: item.workflowId, path: item.path, name: item.name,
          event: "push", head_sha: request.headSha, head_branch: "main", status: "completed",
          conclusion: "failure", repository: { full_name: request.repository },
        });
      };
      await assert.rejects(
        () => executeCodingRunner(failureRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, fetch),
        (error: unknown) => {
          assert.ok(error instanceof CodingRunnerEvidenceError);
          assert.equal(error.message, item.code);
          const decision = classifyCodingRunnerFailure(error.message);
          assert.equal(decision.failureClass, item.failureClass);
          assert.equal(decision.recovery, "STOP");
          assert.equal(decision.retryable, false);
          return true;
        },
      );
      assert.equal(aiCalls, 0, item.path);
      assert.equal(jobLookups, 0, item.path);
    }
  });

  it("rejects a workflow run whose exact commit SHA is stale", async () => {
    const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${request.headSha}:failure` };
    await assert.rejects(
      () => verifyCodingRunnerRequestAgainstGitHub(failureRequest, "github-token", async (url) =>
        url.includes("/commits/")
          ? response(200, { sha: "b".repeat(40) })
          : response(200, {
            id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name: "CI",
            event: "push", head_sha: request.headSha, head_branch: "main", status: "completed",
            conclusion: "failure", repository: { full_name: request.repository },
          })),
      /CODING_RUNNER_HEAD_SHA_MISMATCH/,
    );
  });

  it("rejects an otherwise valid failure run when current main has moved", async () => {
    const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${request.headSha}:failure` };
    await assert.rejects(
      () => verifyCodingRunnerRequestAgainstGitHub(failureRequest, "github-token", async (url) => {
        if (url.includes("/commits/")) return response(200, { sha: request.headSha });
        if (url.includes("/branches/main")) return response(200, { commit: { sha: "b".repeat(40) } });
        return response(200, {
          id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name: "CI",
          event: "push", head_sha: request.headSha, head_branch: "main", status: "completed",
          conclusion: "failure", repository: { full_name: request.repository },
        });
      }),
      /CODING_RUNNER_WORKFLOW_HEAD_STALE/,
    );
    const decision = classifyCodingRunnerFailure("CODING_RUNNER_WORKFLOW_HEAD_STALE");
    assert.equal(decision.failureClass, "EVIDENCE_MISMATCH");
    assert.equal(decision.recovery, "REDISPATCH_FRESH_EVIDENCE");
    assert.equal(decision.retryable, false);
  });

  it("fails closed when workflow identity is missing or mismatched", async () => {
    const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${request.headSha}:failure` };
    for (const run of [
      { id: request.workflowRunId, workflow_id: 311000286, name: "CI", event: "push", head_sha: request.headSha, head_branch: "main", status: "completed", conclusion: "failure", repository: { full_name: request.repository } },
      { id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/other.yml", name: "CI", event: "push", head_sha: request.headSha, head_branch: "main", status: "completed", conclusion: "failure", repository: { full_name: request.repository } },
      { id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name: "CI", event: "pull_request", head_sha: request.headSha, head_branch: "main", status: "completed", conclusion: "failure", repository: { full_name: request.repository } },
      { id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name: "CI", event: "push", head_sha: request.headSha, head_branch: "feature/old-head", status: "completed", conclusion: "failure", repository: { full_name: request.repository } },
    ]) {
      await assert.rejects(
        () => verifyCodingRunnerRequestAgainstGitHub(failureRequest, "github-token", async (url) =>
          url.includes("/commits/") ? response(200, { sha: request.headSha }) : response(200, run)),
        (error: unknown) => {
          assert.ok(error instanceof CodingRunnerEvidenceError);
          assert.ok(["WORKFLOW_IDENTITY_MISSING", "WORKFLOW_IDENTITY_MISMATCH"].includes(error.message));
          assert.equal(classifyCodingRunnerFailure(error.message).retryable, false);
          return true;
        },
      );
    }
  });

  it("admits only exact-main-identity CI failures with allowlisted actionable steps", async () => {
    let aiCalls = 0;
    const ai: WorkersAiBinding = {
      async run() { aiCalls += 1; return { response: JSON.stringify({ patch }) }; },
    };
    const failureRequest = { ...request, reason: `evolve:discovery:gha:ci:${request.headSha}:failure:CI failed` };
    const fetch = async (url: string) => {
      if (url.includes("/commits/")) return response(200, { sha: request.headSha });
      if (url.includes("/branches/main")) return response(200, { commit: { sha: request.headSha } });
      if (url.includes("/jobs?")) return response(200, {
        jobs: [{ run_id: request.workflowRunId, name: "validation", conclusion: "failure", steps: [{ name: "Typecheck", conclusion: "failure" }] }],
      });
      return response(200, {
        id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name: "CI",
        event: "push", head_sha: request.headSha, head_branch: "main", status: "completed",
        conclusion: "failure", repository: { full_name: request.repository },
      });
    };
    const result = await executeCodingRunner(failureRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, fetch);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(aiCalls, 1);
  });

  it("does not admit cancelled or timed-out CI runs as actionable repository failures", async () => {
    for (const conclusion of ["cancelled", "timed_out"] as const) {
      let jobLookups = 0;
      let aiCalls = 0;
      const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${request.headSha}:${conclusion}` };
      const fetch = async (url: string) => {
        if (url.includes("/commits/")) return response(200, { sha: request.headSha });
        if (url.includes("/jobs?")) {
          jobLookups += 1;
          return response(200, { jobs: [] });
        }
        return response(200, {
          id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name: "CI",
          event: "push", head_sha: request.headSha, head_branch: "main", status: "completed",
          conclusion, repository: { full_name: request.repository },
        });
      };
      const ai: WorkersAiBinding = {
        async run() { aiCalls += 1; return { response: JSON.stringify({ patch }) }; },
      };

      await assert.rejects(
        () => executeCodingRunner(failureRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, fetch),
        /CODING_RUNNER_FAILURE_EVIDENCE_INVALID/,
      );
      assert.equal(jobLookups, 0, conclusion);
      assert.equal(aiCalls, 0, conclusion);
    }
  });

  it("does not spend a coding retry on an unallowlisted CI failure step", async () => {
    let aiCalls = 0;
    let jobLookups = 0;
    const ai: WorkersAiBinding = { async run() { aiCalls += 1; return { response: JSON.stringify({ patch }) }; } };
    const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${request.headSha}:failure` };
    const fetch = async (url: string) => {
      if (url.includes("/commits/")) return response(200, { sha: request.headSha });
      if (url.includes("/branches/main")) return response(200, { commit: { sha: request.headSha } });
      if (url.includes("/jobs?")) {
        jobLookups += 1;
        return response(200, { jobs: [{ run_id: request.workflowRunId, name: "validation", conclusion: "failure", steps: [
          ...Array.from({ length: 16 }, () => ({ name: "Typecheck", conclusion: "failure" })),
          { name: "Preflight", conclusion: "failure" },
        ] }] });
      }
      return response(200, {
        id: request.workflowRunId, workflow_id: 311000286, path: ".github/workflows/ci.yml", name: "CI",
        event: "push", head_sha: request.headSha, head_branch: "main", status: "completed",
        conclusion: "failure", repository: { full_name: request.repository },
      });
    };
    await assert.rejects(
      () => executeCodingRunner(failureRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, fetch),
      /ACTIONABLE_FAILURE_NOT_ALLOWLISTED/,
    );
    assert.equal(jobLookups, 1);
    assert.equal(aiCalls, 0);
    const decision = classifyCodingRunnerFailure("ACTIONABLE_FAILURE_NOT_ALLOWLISTED");
    assert.equal(decision.failureClass, "WORKFLOW_NOT_ELIGIBLE");
    assert.equal(decision.retryable, false);
  });

  it("falls back to public GitHub evidence when a scoped token masks a public resource as not found", async () => {
    const calls: string[] = [];
    await verifyCodingRunnerRequestAgainstGitHub(request, "scoped-token", async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push(`${url}:${headers?.Authorization ?? "anonymous"}:${headers?.["User-Agent"] ?? "missing"}`);
      if (calls.length === 1) return response(404, { message: "Not Found" });
      return verifiedGithubFetch(url);
    });
    assert.equal(calls.length, 3);
    assert.match(calls[0] ?? "", /Bearer scoped-token/);
    assert.match(calls[1] ?? "", /anonymous/);
    assert.match(calls[2] ?? "", /Bearer scoped-token/);
    assert.ok(calls.every((call) => call.endsWith(":nusa-autopilot-worker")));
  });

  it("sends a bounded patch-only proposal to the injected cloud runtime after GitHub verification", async () => {
    let runtimeCalls = 0;
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        runtimeCalls += 1;
        assert.equal(value.headSha, request.headSha);
        assert.equal(proposal?.patch, patch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      if (url.includes("/commits/") || url.includes("/actions/runs/")) return verifiedGithubFetch(url);
      return response(200, { patch });
    };
    const result = await executeCodingRunner(request, runtimeEnv, fakeFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.backend, "fake-sandbox");
    assert.equal(result.workspaceVerified, true);
    assert.equal(result.proposalValidated, true);
    assert.deepEqual(result.changedFiles, ["apps/autopilot/src/example.ts"]);
    assert.equal(runtimeCalls, 1);
    assert.equal(calls.length, 3);
  });

  it("skips Workers AI coding inference only after verified failed job/step evidence", async () => {
    const failureRequest = {
      ...request,
      reason: `gha:${request.workflowRunId}:${request.headSha}:failure`,
    };
    let workersAiCalls = 0;
    let jevCalls = 0;
    let observedFailureEvidence: unknown = null;
    const ai: WorkersAiBinding = {
      async run() {
        workersAiCalls += 1;
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(failureRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      AI: ai,
      NUSA_JEV_SHADOW_ENABLED: "true",
      NUSA_JEV_BOUNDED_ROUTING_ENABLED: "true",
      NUSA_JEV_API_KEY: jevTestKey(),
      NUSA_JEV_ENDPOINT: "https://jev.invalid/classify",
    }, verifiedFailureGithubFetch, undefined, undefined, {
      jevAdmissionClassify: async (input) => {
        jevCalls += 1;
        observedFailureEvidence = input.failureEvidence;
        return {
          rootCause: "INFRA",
          safeToAutofix: "NO",
          severity: 2,
          requiredModel: "HUMAN",
          confidence: 0.97,
        };
      },
    });
    assert.equal(result.status, "JEV_ROUTING_ABSTAINED");
    assert.equal(result.jevAdmissionAction, "ABSTAIN_EXPENSIVE_INFERENCE");
    assert.equal(result.jevAdmissionReason, "NON_CODE_AUTOFIX_FORBIDDEN");
    assert.equal(workersAiCalls, 0);
    assert.equal(jevCalls, 1);
    const evidence = observedFailureEvidence as { failedJobs?: string[]; failedSteps?: string[] } | null;
    assert.deepEqual(evidence?.failedJobs, ["validation"]);
    assert.deepEqual(evidence?.failedSteps, ["Typecheck"]);
  });

  it("prefers the canonical Workers AI binding over a configured legacy endpoint", async () => {
    let endpointCalls = 0;
    let aiCalls = 0;
    const ai: WorkersAiBinding = {
      async run(model, input) {
        aiCalls += 1;
        assert.equal(model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        assert.match(input.prompt, /unified diff/);
        return { response: JSON.stringify({ patch }) };
      },
    };
    const result = await executeCodingRunner(request, {
      ...runtimeEnv,
      AI: ai,
    }, async (url) => {
      if (url.includes("/commits/") || url.includes("/actions/runs/")) return verifiedGithubFetch(url);
      endpointCalls += 1;
      return response(502, { error: "legacy endpoint unavailable" });
    });
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(endpointCalls, 0);
    assert.equal(aiCalls, 1);
  });

  it("uses an explicitly configured Jev tier only for a verified, high-confidence coding admission", async () => {
    const failureRequest = {
      ...request,
      reason: `gha:${request.workflowRunId}:${request.headSha}:failure`,
    };
    let selectedModel = "";
    const ai: WorkersAiBinding = {
      async run(model) {
        selectedModel = model;
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(failureRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      AI: ai,
      NUSA_JEV_SHADOW_ENABLED: "true",
      NUSA_JEV_BOUNDED_ROUTING_ENABLED: "true",
      NUSA_JEV_MODEL_TIERING_ENABLED: "true",
      NUSA_JEV_API_KEY: jevTestKey(),
      NUSA_JEV_ENDPOINT: "https://jev.invalid/classify",
      NUSA_AI_CODING_MODEL_LUNA: "@cf/openai/gpt-oss-20b",
    }, verifiedFailureGithubFetch, undefined, undefined, {
      jevAdmissionClassify: async () => ({
        rootCause: "CODE",
        safeToAutofix: "YES",
        severity: 2,
        requiredModel: "LUNA",
        confidence: 0.97,
      }),
    });
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(selectedModel, "@cf/openai/gpt-oss-20b");
  });

  it("keeps the canonical model when a configured Jev tier is unusable", async () => {
    const failureRequest = {
      ...request,
      reason: `gha:${request.workflowRunId}:${request.headSha}:failure`,
    };
    let selectedModel = "";
    const ai: WorkersAiBinding = {
      async run(model) {
        selectedModel = model;
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(failureRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      AI: ai,
      NUSA_AI_CODING_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      NUSA_JEV_SHADOW_ENABLED: "true",
      NUSA_JEV_BOUNDED_ROUTING_ENABLED: "true",
      NUSA_JEV_MODEL_TIERING_ENABLED: "true",
      NUSA_JEV_API_KEY: jevTestKey(),
      NUSA_JEV_ENDPOINT: "https://jev.invalid/classify",
      NUSA_AI_CODING_MODEL_LUNA: "not a valid model",
    }, verifiedFailureGithubFetch, undefined, undefined, {
      jevAdmissionClassify: async () => ({
        rootCause: "CODE",
        safeToAutofix: "YES",
        severity: 2,
        requiredModel: "LUNA",
        confidence: 0.97,
      }),
    });
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(selectedModel, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("uses the Cloudflare Workers AI binding when no dedicated endpoint is configured", async () => {
    let runtimeCalls = 0;
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        runtimeCalls += 1;
        assert.equal(value.executionId, request.executionId);
        assert.equal(proposal?.patch, patch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const calls: Array<{ model: string; input: Parameters<WorkersAiBinding["run"]>[1] }> = [];
    const ai: WorkersAiBinding = {
      async run(model, input) {
        calls.push({ model, input });
        return { response: JSON.stringify({ patch }) };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.proposalValidated, true);
    assert.equal(runtimeCalls, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    assert.match(calls[0]?.input.prompt ?? "", /unified diff/);
    assert.deepEqual(calls[0]?.input.response_format, {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: { patch: { type: "string" } },
        required: ["patch"],
        additionalProperties: false,
      },
    });
  });

  it("accepts Workers AI structured chat-completion parsed responses", async () => {
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        assert.equal(value.executionId, request.executionId);
        assert.equal(proposal?.patch, patch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const ai: WorkersAiBinding = {
      async run() {
        return {
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: null, parsed: { patch } } }],
        };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.proposalValidated, true);
  });

  it("accepts current Workers AI chat-completion response envelopes", async () => {
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        assert.equal(value.executionId, request.executionId);
        assert.equal(proposal?.patch, patch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const ai: WorkersAiBinding = {
      async run() {
        return {
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ patch }) } }],
        };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.proposalValidated, true);
  });

  it("accepts Workers AI JSON mode object responses", async () => {
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        assert.equal(value.executionId, request.executionId);
        assert.equal(proposal?.patch, patch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const ai: WorkersAiBinding = {
      async run() { return { response: { patch } }; },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.proposalValidated, true);
  });

  it("retries a bounded proposal after sandbox patch-contract rejection", async () => {
    let runtimeCalls = 0;
    const prompts: string[] = [];
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute() {
        runtimeCalls += 1;
        if (runtimeCalls === 1) throw new Error("SANDBOX_PATCH_FILE_COUNT_INVALID");
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const ai: WorkersAiBinding = {
      async run(_model, input) {
        prompts.push(input.prompt);
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(runtimeCalls, 2);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /SANDBOX_PATCH_FILE_COUNT_INVALID/);
  });

  it("accepts a Workers AI JSON proposal wrapped in a markdown fence", async () => {
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        assert.equal(value.executionId, request.executionId);
        assert.equal(proposal?.patch, patch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const ai: WorkersAiBinding = {
      async run() {
        return { response: `Here is the proposal:\n\`\`\`json\n${JSON.stringify({ patch })}\n\`\`\`` };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.proposalValidated, true);
  });

  it("accepts a raw or fenced unified diff from Workers AI", async () => {
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        assert.equal(value.executionId, request.executionId);
        assert.equal(proposal?.patch, patch.trim());
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const fencedDiff = ["Here is the patch:", "```diff", patch, "```"].join("\n");
    for (const responseText of [patch, fencedDiff]) {
      const ai: WorkersAiBinding = {
        async run() { return { response: responseText }; },
      };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
      assert.equal(result.status, "EXECUTION_ACCEPTED");
      assert.equal(result.proposalValidated, true);
    }
  });

  it("extracts JSON whose patch contains nested braces after explanatory text", async () => {
    const objectPatch = `${patch}+const result = { status: "ok" };\n`;
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        assert.equal(value.executionId, request.executionId);
        assert.equal(proposal?.patch, objectPatch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const ai: WorkersAiBinding = {
      async run() { return { response: `The validated proposal is:\n${JSON.stringify({ patch: objectPatch })}\nApply it safely.` }; },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.proposalValidated, true);
  });

  it("distinguishes syntax-invalid Workers AI output", async () => {
    const ai: WorkersAiBinding = {
      async run() { return { response: "{not-json" }; },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "CODING_PROPOSAL_JSON_INVALID");
  });

  it("distinguishes valid JSON with an invalid proposal shape", async () => {
    const ai: WorkersAiBinding = {
      async run() { return { response: JSON.stringify({ patch: 42, explanation: "invalid patch shape" }) }; },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "CODING_PROPOSAL_SHAPE_INVALID");
    assert.equal(result.proposalAttempts, 3);
    assert.equal(result.failureStage, "proposal-parse");
  });

  it("allows the external GitHub runner to cap one AI generation per proposal request", async () => {
    let attempts = 0;
    const ai: WorkersAiBinding = {
      async run() {
        attempts += 1;
        return { response: JSON.stringify({ patch: 42, explanation: "invalid patch shape" }) };
      },
    };
    const result = await executeCodingRunner(
      request,
      { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai },
      verifiedGithubFetch,
      undefined,
      undefined,
      { maxProposalAttempts: 1 },
    );
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "CODING_PROPOSAL_SHAPE_INVALID");
    assert.equal(result.proposalAttempts, 1);
    assert.equal(attempts, 1);
  });

  it("rejects forbidden authority-surface proposal paths before sandbox execution", async () => {
    const forbiddenPatch = patch.replaceAll("apps/autopilot/src/example.ts", "apps/autopilot/src/live/broker/order/credential/secret/withdraw/transfer.ts");
    const ai: WorkersAiBinding = {
      async run() { return { response: JSON.stringify({ patch: forbiddenPatch }) }; },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "CODING_PROPOSAL_PATH_FORBIDDEN");
  });
  it("records bounded sandbox failure diagnostics without proposal contents", async () => {
    let attempts = 0;
    const ai: WorkersAiBinding = {
      async run() { attempts += 1; return { response: JSON.stringify({ patch }) }; },
    };
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute() { throw new Error("SANDBOX_PATCH_APPLY_CHECK_FAILED"); },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, runtime);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "SANDBOX_PATCH_APPLY_CHECK_FAILED");
    assert.equal(result.proposalAttempts, 3);
    assert.equal(result.failureStage, "sandbox-validation");
    assert.equal(attempts, 3);
    assert.equal("patch" in result, false);
  });

  it("falls back from GLM because the coding contract requires documented Workers AI JSON Mode support", async () => {
    const calls: string[] = [];
    const ai: WorkersAiBinding = {
      async run(model) {
        calls.push(model);
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      NUSA_AI_CODING_MODEL: "@cf/zai-org/glm-4.7-flash",
      AI: ai,
    }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.deepEqual(calls, ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
  });

  it("falls back from a JSON-mode-incompatible fast model to the JSON-mode default", async () => {
    const calls: string[] = [];
    const ai: WorkersAiBinding = {
      async run(model) {
        calls.push(model);
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      NUSA_AI_CODING_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      AI: ai,
    }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.deepEqual(calls, ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
  });

  it("falls back from the retired dashboard model to the supported default", async () => {
    const calls: string[] = [];
    const ai: WorkersAiBinding = {
      async run(model) {
        calls.push(model);
        return { response: JSON.stringify({ patch }) };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      NUSA_AI_CODING_MODEL: "@cf/meta/infire-llama-3.1-8b-instruct",
      AI: ai,
    }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.deepEqual(calls, ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
  });

  it("stays interface-ready when no provider-neutral coding engine is configured", async () => {
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token" }, verifiedGithubFetch);
    assert.equal(result.status, "INTERFACE_READY");
    assert.equal(result.reason, "ai-coding-engine-not-configured");
    assert.deepEqual(result.readinessBlockers, ["CODING_ENGINE_NOT_CONFIGURED"], "names exactly what is missing; the GitHub token is present");
  });

  it("zero-credit mode disables a configured external coding engine without spending a call", async () => {
    let paidEngineCalls = 0;
    const result = await executeCodingRunner(request, { ...runtimeEnv, NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "true" }, async (url) => {
      if (url === runtimeEnv.NUSA_AI_CODING_ENDPOINT) { paidEngineCalls += 1; return response(200, { patch }); }
      return verifiedGithubFetch(url);
    });
    assert.equal(result.status, "INTERFACE_READY");
    assert.equal(result.reason, "zero-credit-paid-engine-disabled");
    assert.deepEqual(result.readinessBlockers, ["ZERO_CREDIT_PAID_ENGINE_DISABLED"]);
    assert.equal(paidEngineCalls, 0);
  });

  it("missing or malformed credit posture never calls a configured paid engine", async () => {
    for (const posture of [undefined, "", " ", "tru", "1", "null"]) {
      let paidEngineCalls = 0;
      const result = await executeCodingRunner(request, { ...runtimeEnv, NUSA_AUTOPILOT_ZERO_CREDIT_MODE: posture }, async (url) => {
        if (url === runtimeEnv.NUSA_AI_CODING_ENDPOINT) { paidEngineCalls += 1; return response(200, { patch }); }
        return verifiedGithubFetch(url);
      });
      assert.equal(paidEngineCalls, 0, `unverified posture ${String(posture)}`);
      assert.equal(result.status, "INTERFACE_READY");
      assert.equal(result.reason, "zero-credit-paid-engine-disabled");
    }
  });

  it("unverified credit posture preserves Workers AI capacity waits without paid overflow", async () => {
    for (const posture of [undefined, "", "tru", "1"]) {
      let paidCalls = 0;
      let workersCalls = 0;
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: posture, NUSA_GITHUB_TOKEN: "github-token", AI: { async run() { workersCalls += 1; return { response: { patch } }; } } }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { paidCalls += 1; return response(200, {}); }
        return verifiedGithubFetch(url);
      }, undefined, undefined, { now: () => 10_000, providerWaitUntil: async () => 20_000 });
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      assert.equal(result.nextRetryAt, 20_000);
      assert.equal(paidCalls, 0);
      assert.equal(workersCalls, 0);
    }
  });

  it("zero-credit mode never falls back to GitHub Models while free Workers AI is waiting", async () => {
    let githubModelsCalls = 0;
    let workersAiCalls = 0;
    const waitUntil = 20_000;
    const result = await executeCodingRunner(request, { NUSA_GITHUB_TOKEN: "github-token", NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "true", AI: { async run() { workersAiCalls += 1; return { response: { patch } }; } } }, async (url) => {
      if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
      return verifiedGithubFetch(url);
    }, undefined, undefined, { now: () => 10_000, providerWaitUntil: async () => waitUntil });
    assert.equal(result.status, "BLOCKED_RATE_LIMIT");
    assert.equal(result.reason, "WAITING_PROVIDER_CAPACITY");
    assert.equal(githubModelsCalls, 0);
    assert.equal(workersAiCalls, 0);
    assert.equal(result.nextRetryAt, waitUntil);
    assert.equal(result.fallbackProvider, undefined);
  });

  it("falls back from the deprecated llama 3.1 model to the active JSON-schema default", async () => {
    const calls: string[] = [];
    const ai: WorkersAiBinding = {
      async run(model) {
        calls.push(model);
        return { response: { patch } };
      },
    };
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      NUSA_AI_CODING_MODEL: "@cf/meta/llama-3.1-8b-instruct",
      AI: ai,
    }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.deepEqual(calls, ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
  });

  it("classifies Workers AI daily quota exhaustion as blocked before proposal generation", async () => {
    let calls = 0;
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      AI: { async run() { calls += 1; throw new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage."); } },
    }, verifiedGithubFetch, undefined, undefined, { now: () => 1_000 });
    assert.equal(result.status, "BLOCKED_RATE_LIMIT");
    assert.equal(result.reason, "WORKERS_AI_DAILY_QUOTA_EXHAUSTED");
    assert.equal(result.proposalAttempts, 0);
    assert.equal(calls, 1);
    assert.equal(result.provider, "workers-ai");
    assert.equal(result.nextRetryAt, 86_400_000);
    assert.equal(result.resumeCondition, "provider-capacity-and-exact-head-revalidation");
    assert.equal(result.fallbackProvider, "github-models");
    assert.equal(result.fallbackFailureReason, "GITHUB_MODELS_CODING_RESPONSE_INVALID");
  });

  it("waits for the next UTC day on daily quota exhaustion instead of re-probing every cycle", async () => {
    const quotaError = { async run(): Promise<never> { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage."); } };
    const midDay = Date.parse("2026-09-23T10:12:49.000Z");
    const midDayResult = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: quotaError }, verifiedGithubFetch, undefined, undefined, { now: () => midDay });
    assert.equal(midDayResult.nextRetryAt, Date.parse("2026-09-24T00:00:00.000Z"));
    const nearReset = Date.parse("2026-09-23T23:59:50.000Z");
    const nearResetResult = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: quotaError }, verifiedGithubFetch, undefined, undefined, { now: () => nearReset });
    assert.equal(nearResetResult.nextRetryAt, nearReset + 60_000);
  });

  it("classifies generic Workers AI rate limiting without hot-loop proposal retries", async () => {
    let calls = 0;
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      AI: { async run() { calls += 1; throw new Error("429 Too Many Requests: rate limit exceeded"); } },
    }, verifiedGithubFetch, undefined, undefined, { now: () => 2_000 });
    assert.equal(result.status, "BLOCKED_RATE_LIMIT");
    assert.equal(result.reason, "WORKERS_AI_RATE_LIMITED");
    assert.equal(result.proposalAttempts, 0);
    assert.equal(calls, 1);
    assert.equal(result.nextRetryAt, 3_000);
  });

  it("fails closed when the Workers AI binding is unavailable", async () => {
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
      NUSA_GITHUB_TOKEN: "github-token",
      AI: { async run() { throw new Error("provider unavailable"); } },
    }, verifiedGithubFetch);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "provider unavailable");
  });

  it("fails closed when the coding engine does not return a patch proposal", async () => {
    let runtimeCalls = 0;
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute() {
        runtimeCalls += 1;
        return { backend: "fake-sandbox", checkpointId: request.headSha, workspaceVerified: true };
      },
    };
    const result = await executeCodingRunner(request, runtimeEnv, async (url) => {
      if (url.includes("/commits/") || url.includes("/actions/runs/")) return verifiedGithubFetch(url);
      return response(200, { accepted: true });
    }, runtime);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "CODING_PROPOSAL_PATCH_REQUIRED");
    assert.equal(runtimeCalls, 0);
  });

  it("accepts a configured coding engine proposal wrapped in a generic response envelope", async () => {
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute(value, proposal) {
        assert.equal(value.headSha, request.headSha);
        assert.equal(proposal?.patch, patch);
        return {
          backend: "fake-sandbox",
          checkpointId: request.headSha,
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/example.ts"],
        };
      },
    };
    const result = await executeCodingRunner(request, runtimeEnv, async (url) => {
      if (url.includes("/commits/") || url.includes("/actions/runs/")) return verifiedGithubFetch(url);
      return response(200, { response: `Here is the proposal:\n\`\`\`json\n${JSON.stringify({ patch })}\n\`\`\`` });
    }, runtime);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    assert.equal(result.proposalValidated, true);
  });

  it("still distinguishes shape-invalid output from a configured coding engine wrapped in a response envelope", async () => {
    let runtimeCalls = 0;
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute() {
        runtimeCalls += 1;
        return { backend: "fake-sandbox", checkpointId: request.headSha, workspaceVerified: true };
      },
    };
    const result = await executeCodingRunner(request, runtimeEnv, async (url) => {
      if (url.includes("/commits/") || url.includes("/actions/runs/")) return verifiedGithubFetch(url);
      return response(200, { response: JSON.stringify({ patch: 42 }) });
    }, runtime);
    assert.equal(result.status, "EXECUTION_FAILED");
    assert.equal(result.reason, "CODING_PROPOSAL_SHAPE_INVALID");
    assert.equal(runtimeCalls, 0);
  });

  it("does not call the coding engine or runtime when GitHub evidence is invalid", async () => {
    let runtimeCalls = 0;
    let fetchCalls = 0;
    const runtime: CodingRuntime = {
      name: "fake-sandbox",
      async execute() {
        runtimeCalls += 1;
        return { backend: "fake-sandbox", checkpointId: request.headSha, workspaceVerified: true };
      },
    };
    await assert.rejects(
      () => executeCodingRunner(request, runtimeEnv, async () => {
        fetchCalls += 1;
        return response(404, {});
      }, runtime),
      /CODING_RUNNER_HEAD_SHA_UNVERIFIED/,
    );
    assert.equal(runtimeCalls, 0);
    assert.equal(fetchCalls, 2);
  });

  it("preserves lifecycle identity and requires patch-only output when calling the configured coding engine", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/commits/")) return response(200, { sha: request.headSha });
      if (url.includes("/actions/runs/")) return response(200, {
        id: request.workflowRunId,
        head_sha: request.headSha,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        repository: { full_name: request.repository },
      });
      return response(202, { patch });
    };

    const result = await executeCodingRunner(request, runtimeEnv, fakeFetch);
    assert.equal(result.status, "EXECUTION_ACCEPTED");
    const dispatch = calls.at(-1);
    assert.equal(dispatch?.url, "https://coding.example.test/execute");
    const body = JSON.parse(String(dispatch?.init?.body));
    assert.equal(body.executionId, request.executionId);
    assert.equal(body.dedupeKey, request.dedupeKey);
    assert.deepEqual(body.outputContract, { patch: "unified-git-diff" });
    assert.equal(body.constraints.mutationAllowed, false);
    const headers = dispatch?.init?.headers as Record<string, string>;
    assert.equal(headers["x-nusa-execution-id"], request.executionId);
    assert.equal(headers["x-nusa-dedupe-key"], request.dedupeKey);
  });

  it("uses public GitHub verification when no GitHub token is configured", async () => {
    const seenAuthorization: Array<string | undefined> = [];
    const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",}, async (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuthorization.push(headers?.Authorization);
      return verifiedGithubFetch(url);
    });
    assert.equal(result.status, "INTERFACE_READY");
    assert.equal(result.reason, "ai-coding-engine-not-configured");
    assert.deepEqual(seenAuthorization, [undefined, undefined]);
  });
});


describe("coding runner workflow failure evidence", () => {
  it("preserves bounded terminal workflow identity when non-repair evidence is not successful", async () => {
    await assert.rejects(
      () => verifyCodingRunnerRequestAgainstGitHub(request, "github-token", (async (url: string) => {
        if (url.includes("/commits/")) return response(200, { sha: request.headSha });
        return response(200, {
          id: request.workflowRunId,
          name: "Scheduled Autopilot",
          event: "schedule",
          head_sha: request.headSha,
          head_branch: "main",
          status: "completed",
          conclusion: "failure",
          repository: { full_name: request.repository },
        });
      }) as typeof verifiedGithubFetch),
      (error: unknown) => {
        assert.ok(error instanceof CodingRunnerEvidenceError);
        assert.equal(error.message, "CODING_RUNNER_WORKFLOW_NOT_SUCCESSFUL");
        assert.deepEqual(error.evidence, {
          code: "CODING_RUNNER_WORKFLOW_NOT_SUCCESSFUL",
          workflowRunId: request.workflowRunId,
          workflowName: "Scheduled Autopilot",
          workflowEvent: "schedule",
          workflowStatus: "completed",
          workflowConclusion: "failure",
          headSha: request.headSha,
        });
        return true;
      },
    );
  });

  describe("provider capacity wait at the call", () => {
    const acceptingRuntime = (): CodingRuntime => ({
      name: "fake-sandbox",
      async execute() {
        return { backend: "fake-sandbox", checkpointId: request.headSha, workspaceVerified: true, proposalValidated: true, changedFiles: ["apps/autopilot/src/example.ts"] };
      },
    });

    it("does not call the provider when a wait was recorded after the request was admitted", async () => {
      let aiCalls = 0;
      const ai: WorkersAiBinding = { async run() { aiCalls += 1; return { response: JSON.stringify({ patch }) }; } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, acceptingRuntime(), undefined, {
        now: () => 1_000,
        // Waits are recorded per provider: a Workers AI wait says nothing about the overflow
        // provider, so the overflow is still allowed to answer here.
        providerWaitUntil: async (provider) => (provider === "workers-ai" ? 61_000 : null),
      });
      assert.equal(aiCalls, 0);
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      assert.equal(result.reason, "WAITING_PROVIDER_CAPACITY");
      assert.equal(result.nextRetryAt, 61_000);
      assert.equal(result.proposalAttempts, 0);
      assert.equal(result.fallbackProvider, "github-models");
      assert.equal(result.fallbackFailureReason, "GITHUB_MODELS_CODING_RESPONSE_INVALID");
    });

    it("stops before a repair attempt when a wait appears between attempts", async () => {
      let aiCalls = 0;
      let waitUntil: number | null = null;
      const ai: WorkersAiBinding = {
        async run() {
          aiCalls += 1;
          waitUntil = 90_000; // another execution records a provider stop while this attempt runs
          return { response: "not a json proposal" };
        },
      };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async () => waitUntil,
      });
      assert.equal(aiCalls, 1, "the repair attempt must not spend a call inside the new window");
      assert.equal(result.reason, "WAITING_PROVIDER_CAPACITY");
      assert.equal(result.proposalAttempts, 1);
    });

    it("fails closed without a provider call when the wait cannot be read", async () => {
      let aiCalls = 0;
      const ai: WorkersAiBinding = { async run() { aiCalls += 1; return { response: JSON.stringify({ patch }) }; } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, acceptingRuntime(), undefined, {
        providerWaitUntil: async () => { throw new Error("coordinator unavailable"); },
      });
      assert.equal(aiCalls, 0);
      assert.equal(result.status, "EXECUTION_FAILED");
      assert.equal(result.reason, "PROVIDER_CAPACITY_STATE_UNAVAILABLE");
    });

    it("records an exhausted overflow balance as a day-long stop instead of re-spending it", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") {
          githubModelsCalls += 1;
          return response(402, { error: "quota exhausted" });
        }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "workers-ai" ? 61_000 : null),
      });
      assert.equal(githubModelsCalls, 1);
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      // The stop is attributed to the overflow provider, not to the Workers AI wait that routed here.
      assert.equal(result.provider, "github-models");
      assert.equal(result.stopReason, "GITHUB_MODELS_CREDITS_EXHAUSTED");
      assert.equal(result.nextRetryAt, 86_400_000);
      assert.equal(result.resumeCondition, "paid-credit-topup-or-next-utc-day-and-exact-head-revalidation");
    });

    it("treats overflow backpressure as a minute-scale wait, not an exhausted balance", async () => {
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") return response(429, { error: "rate limited" });
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "workers-ai" ? 61_000 : null),
      });
      assert.equal(result.provider, "github-models");
      assert.equal(result.stopReason, "GITHUB_MODELS_RATE_LIMITED");
      assert.equal(result.nextRetryAt, 61_000);
      assert.equal(result.resumeCondition, "provider-capacity-and-exact-head-revalidation");
    });

    it("never spends into an overflow provider whose own wait is still active", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async () => 86_400_000,
      });
      assert.equal(githubModelsCalls, 0, "an exhausted overflow balance must not be re-billed");
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      assert.equal(result.provider, "workers-ai");
      assert.equal(result.fallbackProvider, undefined);
    });

    it("skips the overflow when its wait cannot be read rather than spending blind", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => {
          if (provider === "workers-ai") return 61_000;
          throw new Error("coordinator unavailable");
        },
      });
      assert.equal(githubModelsCalls, 0);
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      assert.equal(result.provider, "workers-ai");
    });

    it("records the overflow boundary when Workers AI rate-limits mid-attempt", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("429 too many requests"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(402, { error: "quota exhausted" }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async () => null,
      });
      assert.equal(githubModelsCalls, 1);
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      assert.equal(result.provider, "github-models");
      assert.equal(result.stopReason, "GITHUB_MODELS_CREDITS_EXHAUSTED");
      assert.equal(result.nextRetryAt, 86_400_000);
    });

    it("does not overflow mid-attempt into an overflow provider that is already stopped", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("429 too many requests"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "github-models" ? 86_400_000 : null),
      });
      assert.equal(githubModelsCalls, 0, "an exhausted overflow balance must not be re-billed mid-attempt");
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      assert.equal(result.provider, "workers-ai");
    });

    it("skips the sandbox-repair escalation while the overflow provider is stopped", async () => {
      let githubModelsCalls = 0;
      let workersAiCalls = 0;
      const repairRequest = {
        ...request,
        proposalFeedback: "attempt=2;rejection=SANDBOX_PATCH_APPLY_CHECK_FAILED;repair=regenerate",
        proposalContext: { path: "apps/autopilot/src/example.ts", startLine: 7, content: "export const oldValue = true;\n" },
      };
      const ai: WorkersAiBinding = { async run() { workersAiCalls += 1; return { response: JSON.stringify({ patch }) }; } };
      const result = await executeCodingRunner(repairRequest, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "github-models" ? 86_400_000 : null),
      });
      // Protection only: the escalation is skipped, and the documented best-effort contract keeps
      // the ordinary provider path working rather than returning a new blocked result.
      assert.equal(githubModelsCalls, 0, "the escalation must honour the overflow boundary");
      assert.equal(workersAiCalls, 1);
      assert.equal(result.status, "EXECUTION_ACCEPTED");
    });

    it("stops the overflow for the day once the owner cap is reached", async () => {
      let githubModelsCalls = 0;
      let reservations = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "workers-ai" ? 61_000 : null),
        reserveOverflowCall: async () => { reservations += 1; return false; },
      });
      assert.equal(reservations, 1, "the cap is checked before the call, not after");
      assert.equal(githubModelsCalls, 0, "a capped overflow must not spend");
      assert.equal(result.status, "BLOCKED_RATE_LIMIT");
      assert.equal(result.provider, "github-models");
      assert.equal(result.stopReason, "GITHUB_MODELS_DAILY_CAP_REACHED");
      assert.equal(result.nextRetryAt, 86_400_000);
      assert.equal(result.resumeCondition, "owner-daily-overflow-cap-reset-and-exact-head-revalidation");
    });

    it("spends the overflow while the owner cap still has room", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "workers-ai" ? 61_000 : null),
        reserveOverflowCall: async () => true,
      });
      assert.equal(githubModelsCalls, 1);
      assert.equal(result.status, "EXECUTION_ACCEPTED");
    });

    it("withholds the spend when the cap reservation cannot be taken", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "workers-ai" ? 61_000 : null),
        reserveOverflowCall: async () => { throw new Error("coordinator unavailable"); },
      });
      assert.equal(githubModelsCalls, 0, "an unverifiable cap must never grant spending");
      assert.equal(result.stopReason, "GITHUB_MODELS_DAILY_CAP_REACHED");
    });

    it("caps the mid-attempt overflow on the same daily budget", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("429 too many requests"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async () => null,
        reserveOverflowCall: async () => false,
      });
      assert.equal(githubModelsCalls, 0);
      assert.equal(result.provider, "github-models");
      assert.equal(result.stopReason, "GITHUB_MODELS_DAILY_CAP_REACHED");
    });

    it("leaves spending uncapped when the owner configured no cap", async () => {
      let githubModelsCalls = 0;
      const ai: WorkersAiBinding = { async run() { throw new Error("unexpected Workers AI call"); } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, async (url) => {
        if (url === "https://models.github.ai/inference/chat/completions") { githubModelsCalls += 1; return response(200, { choices: [{ message: { content: JSON.stringify({ patch }) } }] }); }
        return verifiedGithubFetch(url);
      }, acceptingRuntime(), undefined, {
        now: () => 1_000,
        providerWaitUntil: async (provider) => (provider === "workers-ai" ? 61_000 : null),
      });
      assert.equal(githubModelsCalls, 1, "no reserveOverflowCall means no owner cap");
      assert.equal(result.status, "EXECUTION_ACCEPTED");
    });

    it("proceeds normally when no wait is recorded", async () => {
      let aiCalls = 0;
      const ai: WorkersAiBinding = { async run() { aiCalls += 1; return { response: JSON.stringify({ patch }) }; } };
      const result = await executeCodingRunner(request, { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false", NUSA_GITHUB_TOKEN: "github-token", AI: ai }, verifiedGithubFetch, acceptingRuntime(), undefined, {
        providerWaitUntil: async () => null,
      });
      assert.equal(aiCalls, 1);
      assert.equal(result.status, "EXECUTION_ACCEPTED");
    });
  });
});

describe("light-task size limit", () => {
  const patchWith = (added: number, removed: number): string => [
    "diff --git a/apps/autopilot/src/example.ts b/apps/autopilot/src/example.ts",
    "--- a/apps/autopilot/src/example.ts",
    "+++ b/apps/autopilot/src/example.ts",
    "@@ -1,1 +1,1 @@",
    ...Array.from({ length: removed }, (_, i) => `-const old${i} = 1;`),
    ...Array.from({ length: added }, (_, i) => `+const next${i} = 2;`),
    "",
  ].join("\n");

  it("counts added and removed lines and ignores the file headers", () => {
    assert.equal(countChangedPatchLines(patchWith(3, 2)), 5);
    assert.equal(countChangedPatchLines("--- a/x\n+++ b/x\n"), 0);
    assert.equal(MAX_CODING_CHANGED_LINES, 150);
  });

  it("accepts exactly the limit and rejects one line more with the existing too-large reason", () => {
    assert.deepEqual(Object.keys(validateCodingProposal({ patch: patchWith(75, 75) })), ["patch"]);
    assert.throws(() => validateCodingProposal({ patch: patchWith(76, 75) }), /CODING_PROPOSAL_TOO_LARGE/);
    assert.throws(() => validateCodingProposal({ patch: patchWith(151, 0) }), /CODING_PROPOSAL_TOO_LARGE/);
  });

  it("applies the same limit to a patch built from an exact edit", () => {
    const content = "export const before = true;\nexport const oldValue = true;\nexport const after = true;\n";
    const context = { path: "apps/autopilot/src/example.ts", startLine: 1, content };
    const edit = (lines: number) => ({
      path: context.path,
      expectedText: "export const oldValue = true;",
      replacementText: Array.from({ length: lines }, (_, i) => `export const v${i} = 1;`).join("\n"),
    });
    // one removed line plus 149 added lines is exactly 150 and passes; 150 added lines makes 151 and is rejected
    assert.doesNotThrow(() => buildDeterministicCodingPatch(context, edit(149)));
    assert.throws(() => buildDeterministicCodingPatch(context, edit(150)), /CODING_PROPOSAL_TOO_LARGE/);
  });

  it("keeps the existing single-file rule, which is stricter than the three-file default", () => {
    const twoFiles = `${patchWith(1, 1)}diff --git a/apps/autopilot/src/other.ts b/apps/autopilot/src/other.ts\n--- a/apps/autopilot/src/other.ts\n+++ b/apps/autopilot/src/other.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    assert.throws(() => validateCodingProposal({ patch: twoFiles }), /CODING_PROPOSAL_PATH_INVALID/);
  });
});
