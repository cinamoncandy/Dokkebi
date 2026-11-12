import assert from "node:assert/strict";
import { test } from "node:test";
import { executeGithubDispatch } from "./githubExecutor";
import type { AutopilotExecutionRequest } from "./executionPlanner";

const HEAD = "c".repeat(40);
const request: AutopilotExecutionRequest = {
  kind: "AUDIT_REQUEST",
  repository: "cinamoncandy/NUSA",
  headSha: HEAD,
  prNumber: 42,
  workflowRunId: 987654321,
  reason: `audit:pr:42:ci:987654321:${HEAD}`,
  executionId: "audit:42:987654321",
  dedupeKey: `audit:42:987654321:${HEAD}`,
  mutationAllowed: false,
};

const config = {
  token: "secret",
  allowedRepository: "cinamoncandy/NUSA",
  apiBaseUrl: "https://api.example.test/",
};

function prResponse(options: { readonly draft?: boolean; readonly labels?: readonly string[] } = {}): Response {
  return new Response(JSON.stringify({
    state: "open",
    draft: options.draft ?? false,
    labels: (options.labels ?? []).map((name) => ({ name })),
    head: { sha: HEAD },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("#1876 production Audit dispatch refuses a current Draft PR", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return prResponse({ draft: true });
  }) as typeof fetch;

  const value = await executeGithubDispatch(request, config, fakeFetch);
  assert.equal(value.status, "REJECTED");
  assert.equal(value.reason, "github-executor-pr-draft-hold-active");
  assert.deepEqual(calls, ["https://api.example.test/repos/cinamoncandy/NUSA/pulls/42"]);
});

test("#1876 production Audit dispatch refuses the current GitHub HOLD label", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return prResponse({ labels: ["security", "HOLD"] });
  }) as typeof fetch;

  const value = await executeGithubDispatch(request, config, fakeFetch);
  assert.equal(value.status, "REJECTED");
  assert.equal(value.reason, "github-executor-pr-hold-label-active");
  assert.deepEqual(calls, ["https://api.example.test/repos/cinamoncandy/NUSA/pulls/42"]);
});

test("#1876 production Audit dispatch still reaches repository dispatch when current PR has no Draft/HOLD", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).endsWith("/pulls/42")) return prResponse();
    if (String(url).includes("/actions/workflows/autopilot-execution-consumer.yml/runs?")) {
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const value = await executeGithubDispatch(request, config, fakeFetch);
  assert.equal(value.status, "DISPATCHED");
  assert.deepEqual(calls, [
    "https://api.example.test/repos/cinamoncandy/NUSA/pulls/42",
    "https://api.example.test/repos/cinamoncandy/NUSA/actions/workflows/autopilot-execution-consumer.yml/runs?event=repository_dispatch&per_page=100&page=1",
    "https://api.example.test/repos/cinamoncandy/NUSA/dispatches",
  ]);
});
