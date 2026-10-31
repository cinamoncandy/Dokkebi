import test from "node:test";
import assert from "node:assert/strict";
import { runScheduledAutopilot } from "./scheduledRuntime";
import type { ExecutionCoordinatorNamespace } from "./executionCoordinator";

const SHA = "c".repeat(40);
const FAILURE_RUN_ID = 5151;
const NOW = 1_787_968_000_000;

function namespace(onAcquire?: () => void): ExecutionCoordinatorNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      async fetch(input: RequestInfo | URL) {
        const url = String(input);
        if (url.endsWith("/provider-capacity-wait")) return new Response(JSON.stringify({ wait: null }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/execution")) return new Response(JSON.stringify({ record: null }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/scheduled-receipt")) return new Response("not found", { status: 404 });
        if (url.endsWith("/evolve-learning-memory")) return new Response(JSON.stringify({ value: null }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/acquire")) {
          onAcquire?.();
          return new Response(JSON.stringify({ acquired: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/dispatched")) {
          return new Response(JSON.stringify({ updated: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
}

test("scheduled runtime does not dispatch a completed workflow failure without verified causal evidence", async () => {
  const dispatchPayloads: Record<string, unknown>[] = [];
  let acquisitions = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/branches/main")) {
      return new Response(JSON.stringify({ commit: { sha: SHA } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/actions/workflows/ci.yml/runs?")) {
      return new Response(JSON.stringify({ workflow_runs: [{
        id: 5150,
        name: "CI",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_sha: SHA,
        event: "push",
        updated_at: new Date(NOW - 20_000).toISOString(),
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/actions/runs?")) {
      return new Response(JSON.stringify({ workflow_runs: [{
        id: FAILURE_RUN_ID,
        name: "Autopilot Sandbox New-File Guard",
        status: "completed",
        conclusion: "failure",
        head_branch: "main",
        head_sha: SHA,
        event: "push",
        updated_at: new Date(NOW - 30_000).toISOString(),
      }, {
        id: 5150,
        name: "CI",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_sha: SHA,
        event: "push",
        updated_at: new Date(NOW - 20_000).toISOString(),
      }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/dispatches")) {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as { client_payload?: unknown };
      assert.ok(body.client_payload && typeof body.client_payload === "object" && !Array.isArray(body.client_payload));
      dispatchPayloads.push(body.client_payload as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const outcome = await runScheduledAutopilot({
    NUSA_GITHUB_TOKEN: "token",
    NUSA_GITHUB_REPOSITORY: "cinamoncandy/NUSA",
    NUSA_EXECUTION_COORDINATOR: namespace(() => { acquisitions += 1; }),
  }, NOW, fetchImpl);

  assert.equal(outcome.status, "ABSTAINED");
  assert.equal(outcome.reason, "workflow-failure-causal-evidence-unverified");
  assert.equal(outcome.headSha, SHA);
  assert.equal(outcome.workflowRunId, FAILURE_RUN_ID);
  assert.deepEqual(outcome.discoveredOpportunityIds, [`gha:autopilot-sandbox-new-file-guard:${SHA}:failure`]);
  assert.equal(acquisitions, 0, "unverified workflow failure must not acquire a lease");
  assert.equal(dispatchPayloads.length, 0, "unverified workflow failure must not dispatch");
});

test("updated_at fallback is fail-closed for runs that are not completed", async () => {
  let dispatched = false;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/branches/main")) return new Response(JSON.stringify({ commit: { sha: SHA } }), { status: 200 });
    if (url.includes("/actions/workflows/ci.yml/runs?")) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    if (url.includes("/actions/runs?")) {
      return new Response(JSON.stringify({ workflow_runs: [{
        id: FAILURE_RUN_ID,
        name: "CI",
        status: "in_progress",
        conclusion: "failure",
        head_branch: "main",
        head_sha: SHA,
        event: "push",
        updated_at: new Date(NOW - 30_000).toISOString(),
      }] }), { status: 200 });
    }
    if (url.endsWith("/dispatches")) dispatched = true;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const outcome = await runScheduledAutopilot({
    NUSA_GITHUB_TOKEN: "token",
    NUSA_GITHUB_REPOSITORY: "cinamoncandy/NUSA",
    NUSA_EXECUTION_COORDINATOR: namespace(),
  }, NOW, fetchImpl);

  assert.equal(outcome.status, "ABSTAINED");
  assert.equal(outcome.reason, "exact-main-canonical-ci-not-found");
  assert.equal(dispatched, false);
});


test("cancelled exact-main workflows are not treated as autonomous failure-repair evidence", async () => {
  let dispatched = false;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/branches/main")) return new Response(JSON.stringify({ commit: { sha: SHA } }), { status: 200 });
    if (url.includes("/actions/workflows/ci.yml/runs?")) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    if (url.includes("/actions/runs?")) return new Response(JSON.stringify({ workflow_runs: [{
      id: FAILURE_RUN_ID,
      name: "Android Stable Release Watchdog",
      status: "completed",
      conclusion: "cancelled",
      head_branch: "main",
      head_sha: SHA,
      event: "workflow_run",
      updated_at: new Date(NOW - 30_000).toISOString(),
    }] }), { status: 200 });
    if (url.endsWith("/dispatches")) dispatched = true;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const outcome = await runScheduledAutopilot({
    NUSA_GITHUB_TOKEN: "token",
    NUSA_GITHUB_REPOSITORY: "cinamoncandy/NUSA",
    NUSA_EXECUTION_COORDINATOR: namespace(),
  }, NOW, fetchImpl);

  assert.equal(outcome.status, "ABSTAINED");
  assert.equal(outcome.reason, "exact-main-canonical-ci-not-found");
  assert.deepEqual(outcome.discoveredOpportunityIds, []);
  assert.equal(dispatched, false);
});

test("failures of Autopilot's own workflows and runtime evidence workflows are not repair targets", async () => {
  // 2026-10-12: a failed scheduled Codex coding run and a manually dispatched PAPER evidence run on
  // the main head were each re-dispatched as repairs about every five minutes.
  let dispatched = false;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/branches/main")) return new Response(JSON.stringify({ commit: { sha: SHA } }), { status: 200 });
    if (url.includes("/actions/workflows/ci.yml/runs?")) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    if (url.includes("/actions/runs?")) return new Response(JSON.stringify({ workflow_runs: [{
      id: FAILURE_RUN_ID,
      name: "Autopilot Codex Coding",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      head_sha: SHA,
      event: "schedule",
      completed_at: new Date(NOW - 30_000).toISOString(),
    }, {
      id: FAILURE_RUN_ID + 1,
      name: "Actual PAPER Public-Market Runtime Evidence",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      head_sha: SHA,
      event: "workflow_dispatch",
      completed_at: new Date(NOW - 40_000).toISOString(),
    }] }), { status: 200 });
    if (url.endsWith("/dispatches")) dispatched = true;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const outcome = await runScheduledAutopilot({
    NUSA_GITHUB_TOKEN: "token",
    NUSA_GITHUB_REPOSITORY: "cinamoncandy/NUSA",
    NUSA_EXECUTION_COORDINATOR: namespace(),
  }, NOW, fetchImpl);

  assert.equal(outcome.status, "ABSTAINED");
  assert.equal(outcome.reason, "exact-main-canonical-ci-not-found");
  assert.equal(outcome.workflowRunId, null);
  assert.deepEqual(outcome.discoveredOpportunityIds, []);
  assert.equal(dispatched, false);
});
