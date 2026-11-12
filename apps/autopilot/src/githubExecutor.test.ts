import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeGithubDispatch } from "./githubExecutor";
import type { AutopilotExecutionRequest } from "./executionPlanner";

const request: AutopilotExecutionRequest = {
  kind: "REPOSITORY_AUTOPILOT",
  repository: "cinamoncandy/NUSA",
  headSha: "a".repeat(40),
  workflowRunId: 123456789,
  reason: "continue-from:ci_succeeded",
  executionId: "github:delivery-123",
  dedupeKey: `ci:123456789:${"a".repeat(40)}`,
  contractFingerprintSha256: "f".repeat(64),
  mutationAllowed: false,
};

const auditRequest: AutopilotExecutionRequest = {
  kind: "AUDIT_REQUEST",
  repository: "cinamoncandy/NUSA",
  headSha: "c".repeat(40),
  prNumber: 42,
  workflowRunId: 987654321,
  reason: `audit:pr:42:ci:987654321:${"c".repeat(40)}`,
  executionId: "audit:42:987654321",
  dedupeKey: `audit:42:987654321:${"c".repeat(40)}`,
  mutationAllowed: false,
};

const mainResponse = (sha = request.headSha!) => new Response(JSON.stringify({ commit: { sha } }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const prResponse = (sha = auditRequest.headSha!, state = "open") => new Response(JSON.stringify({ state, head: { sha } }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const draftPrResponse = () => new Response(JSON.stringify({ state: "open", draft: true, head: { sha: auditRequest.headSha } }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("executeGithubDispatch", () => {
  it("stays interface-ready when no executor token is configured", async () => {
    const value = await executeGithubDispatch(request, { allowedRepository: "cinamoncandy/NUSA" });
    assert.equal(value.status, "INTERFACE_READY");
    assert.equal(value.reason, "github-executor-token-not-configured");
    assert.equal(value.requestedHeadSha, null);
    assert.equal(value.observedHeadSha, null);
  });

  it("fails closed on repository mismatch and invalid SHA", async () => {
    assert.equal((await executeGithubDispatch({ ...request, repository: "other/repo" }, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    })).status, "REJECTED");
    assert.equal((await executeGithubDispatch({ ...request, headSha: "bad" }, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    })).status, "REJECTED");
  });

  it("rejects dispatch without trusted workflow or lifecycle identity before network access", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    assert.equal((await executeGithubDispatch({ ...request, workflowRunId: null }, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    }, fakeFetch)).reason, "github-executor-workflow-run-id-required");
    assert.equal((await executeGithubDispatch({ ...request, executionId: null }, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    }, fakeFetch)).reason, "github-executor-execution-id-required");
    assert.equal((await executeGithubDispatch({ ...request, dedupeKey: null }, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    }, fakeFetch)).reason, "github-executor-dedupe-key-required");
    assert.equal((await executeGithubDispatch({ ...auditRequest, prNumber: null }, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    }, fakeFetch)).reason, "github-executor-pr-number-required");
    assert.equal(called, false);
  });

  it("suppresses stale main head before repository dispatch is created", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return mainResponse("b".repeat(40));
    }) as typeof fetch;

    const value = await executeGithubDispatch(request, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
      apiBaseUrl: "https://api.example.test/",
    }, fakeFetch);

    assert.equal(value.status, "REJECTED");
    assert.equal(value.reason, "github-executor-stale-head-suppressed");
    assert.equal(value.requestedHeadSha, "a".repeat(40));
    assert.equal(value.observedHeadSha, "b".repeat(40));
    assert.deepEqual(calls, ["https://api.example.test/repos/cinamoncandy/NUSA/branches/main"]);
  });

  it("suppresses stale PR audit heads and never substitutes current main", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return prResponse("d".repeat(40));
    }) as typeof fetch;

    const value = await executeGithubDispatch(auditRequest, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
      apiBaseUrl: "https://api.example.test/",
    }, fakeFetch);

    assert.equal(value.status, "REJECTED");
    assert.equal(value.reason, "github-executor-stale-pr-head-suppressed");
    assert.equal(value.requestedHeadSha, "c".repeat(40));
    assert.equal(value.observedHeadSha, "d".repeat(40));
    assert.deepEqual(calls, ["https://api.example.test/repos/cinamoncandy/NUSA/pulls/42"]);
  });

  it("does not Audit when canonical CI succeeds while the PR is still Draft", async () => {
    const calls: string[] = [];
    const value = await executeGithubDispatch(auditRequest, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
      apiBaseUrl: "https://api.example.test/",
    }, (async (url: string | URL | Request) => {
      calls.push(String(url));
      return draftPrResponse();
    }) as typeof fetch);

    assert.equal(value.status, "REJECTED");
    assert.equal(value.reason, "github-executor-pr-draft-hold-active");
    assert.deepEqual(calls, ["https://api.example.test/repos/cinamoncandy/NUSA/pulls/42"]);
  });

  it("sends one bounded repository dispatch with durable lifecycle identity and no authority escalation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/branches/main")) return mainResponse();
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const value = await executeGithubDispatch(request, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
      apiBaseUrl: "https://api.example.test/",
    }, fakeFetch);

    assert.equal(value.status, "DISPATCHED");
    assert.equal(value.requestedHeadSha, request.headSha);
    assert.equal(value.observedHeadSha, request.headSha);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.example.test/repos/cinamoncandy/NUSA/branches/main");
    assert.equal(calls[1]?.url, "https://api.example.test/repos/cinamoncandy/NUSA/dispatches");
    assert.equal(calls[1]?.init?.method, "POST");
    const payload = JSON.parse(String(calls[1]?.init?.body));
    assert.equal(payload.event_type, "nusa_autopilot_execution");
    assert.equal(payload.client_payload.kind, "REPOSITORY_AUTOPILOT");
    assert.equal(payload.client_payload.workflow_run_id, 123456789);
    assert.equal(payload.client_payload.execution_id, request.executionId);
    assert.equal(payload.client_payload.dedupe_key, request.dedupeKey);
    assert.equal(payload.client_payload.contract_fingerprint_sha256, request.contractFingerprintSha256);
    assert.ok(Object.keys(payload.client_payload).length <= 11);
    assert.equal("pr_number" in payload.client_payload, false);
    assert.equal(payload.client_payload.production_mutation_allowed, false);
    assert.equal(payload.client_payload.live_authority, "NONE");
    assert.equal(payload.client_payload.ai_authority, "ZERO_AUTHORITY");
  });

  it("dispatches an audit request only after exact current PR-head verification", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/pulls/42")) return prResponse();
      if (String(url).includes("/actions/workflows/autopilot-execution-consumer.yml/runs?")) {
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const value = await executeGithubDispatch(auditRequest, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
      apiBaseUrl: "https://api.example.test/",
    }, fakeFetch);

    assert.equal(value.status, "DISPATCHED");
    assert.equal(value.requestedHeadSha, auditRequest.headSha);
    assert.equal(value.observedHeadSha, auditRequest.headSha);
    assert.equal(calls[0]?.url, "https://api.example.test/repos/cinamoncandy/NUSA/pulls/42");
    assert.match(calls[1]?.url ?? "", /actions\/workflows\/autopilot-execution-consumer\.yml\/runs/);
    assert.equal(calls[2]?.url, "https://api.example.test/repos/cinamoncandy/NUSA/dispatches");
    const payload = JSON.parse(String(calls[2]?.init?.body));
    assert.equal(payload.event_type, "nusa_autopilot_execution");
    assert.equal(payload.client_payload.kind, "AUDIT_REQUEST");
    assert.equal(payload.client_payload.pr_number, 42);
    assert.ok(Object.keys(payload.client_payload).length <= 10);
    assert.equal("reason" in payload.client_payload, false);
    assert.equal(payload.client_payload.head_sha, auditRequest.headSha);
    assert.equal(payload.client_payload.workflow_run_id, auditRequest.workflowRunId);
    assert.equal(payload.client_payload.production_mutation_allowed, false);
    assert.equal(payload.client_payload.live_authority, "NONE");
    assert.equal(payload.client_payload.ai_authority, "ZERO_AUTHORITY");
  });

  it("suppresses a cross-ingress Audit when GitHub already exposes the immutable dedupe identity", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith("/pulls/42")) return prResponse();
      if (value.includes("/actions/workflows/autopilot-execution-consumer.yml/runs?")) {
        return new Response(JSON.stringify({ workflow_runs: [{ display_title: auditRequest.dedupeKey }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("repository dispatch must not be reached");
    }) as typeof fetch;
    const value = await executeGithubDispatch(auditRequest, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
      apiBaseUrl: "https://api.example.test/",
    }, fakeFetch);
    assert.equal(value.status, "REJECTED");
    assert.equal(value.reason, "github-executor-duplicate-audit-run-suppressed");
    assert.equal(calls.length, 2);
  });

  it("suppresses another run-attempt while the same logical PR/CI/head Audit is active", async () => {
    const retry = { ...auditRequest, executionId: "audit:42:987654321:2", dedupeKey: `audit:42:987654321:2:${"c".repeat(40)}` };
    const value = await executeGithubDispatch(retry, { token: "secret", allowedRepository: "cinamoncandy/NUSA", apiBaseUrl: "https://api.example.test/" }, (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/pulls/42")) return prResponse();
      if (target.includes("/actions/workflows/autopilot-execution-consumer.yml/runs?")) return new Response(JSON.stringify({ workflow_runs: [{ display_title: auditRequest.dedupeKey, status: "in_progress", conclusion: null }] }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("repository dispatch must not be reached");
    }) as typeof fetch);
    assert.equal(value.status, "REJECTED");
    assert.equal(value.reason, "github-executor-duplicate-audit-run-suppressed");
  });

  it("allows a new run-attempt after the prior logical Audit completed unsuccessfully", async () => {
    const retry = { ...auditRequest, executionId: "audit:42:987654321:2", dedupeKey: `audit:42:987654321:2:${"c".repeat(40)}` };
    let dispatched = false;
    const value = await executeGithubDispatch(retry, { token: "secret", allowedRepository: "cinamoncandy/NUSA", apiBaseUrl: "https://api.example.test/" }, (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/pulls/42")) return prResponse();
      if (target.includes("/actions/workflows/autopilot-execution-consumer.yml/runs?")) return new Response(JSON.stringify({ workflow_runs: [{ display_title: auditRequest.dedupeKey, status: "completed", conclusion: "failure" }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (target.endsWith("/dispatches")) { dispatched = true; return new Response(null, { status: 204 }); }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch);
    assert.equal(value.status, "DISPATCHED");
    assert.equal(dispatched, true);
  });

  it("fails closed when cross-ingress Audit dedupe evidence cannot be read", async () => {
    const value = await executeGithubDispatch(auditRequest, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
      apiBaseUrl: "https://api.example.test/",
    }, (async (url: string | URL | Request) => String(url).endsWith("/pulls/42")
      ? prResponse()
      : new Response("unavailable", { status: 503 })) as typeof fetch);
    assert.equal(value.status, "FAILED");
    assert.equal(value.reason, "github-executor-audit-dedupe-http-503");
  });

  it("fails closed when current main cannot be verified", async () => {
    const fakeFetch = (async () => new Response("bad", { status: 503 })) as typeof fetch;
    const value = await executeGithubDispatch(request, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    }, fakeFetch);
    assert.equal(value.status, "FAILED");
    assert.equal(value.reason, "github-executor-main-head-http-503");
    assert.equal(value.httpStatus, 503);
    assert.equal(value.requestedHeadSha, null);
    assert.equal(value.observedHeadSha, null);
  });

  it("classifies auth and scope failures without leaking response bodies", async () => {
    const fakeFetch = (async () => new Response("secret-detail", { status: 403 })) as typeof fetch;
    const value = await executeGithubDispatch(request, {
      token: "secret",
      allowedRepository: "cinamoncandy/NUSA",
    }, fakeFetch);
    assert.equal(value.status, "FAILED");
    assert.equal(value.reason, "github-executor-auth-rejected");
    assert.equal(value.httpStatus, 403);
  });
});
