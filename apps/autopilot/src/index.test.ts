import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker, {
  classifyGithubEvent,
  computeGithubWebhookSignature,
  handleCodingExecute,
  handleScheduledRuntimeTick,
  verifyGithubWebhookSignature,
} from "./index";
import { createCodingExecutionEvidence } from "./codingExecutionEvidence";
import type { CodingRuntime, WorkersAiBinding } from "./codingRunner";
import { acquirePersistentExecution, AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS, ExecutionCoordinator, readPersistentExecution, readProviderCapacityWait, type ExecutionCoordinatorNamespace } from "./executionCoordinator";

it("health reports the same enforced default for missing or malformed credit posture", async () => {
  for (const posture of [undefined, "", "tru", "1", "null", "true", "false"]) {
    const response = await worker.fetch(new Request("https://example.test/health"), { NUSA_AUTOPILOT_ZERO_CREDIT_MODE: posture });
    const health = await response.json() as { zeroCreditMode: string; aiCodingEngine: string };
    assert.equal(health.zeroCreditMode, posture === "false" ? "DISABLED" : "ENFORCED");
    if (posture !== "false") assert.equal(health.aiCodingEngine, "ZERO_CREDIT");
  }
});

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

function evidenceFixture() {
  const result = createCodingExecutionEvidence({
    kind: "REPOSITORY_AUTOPILOT",
    repository: "cinamoncandy/NUSA",
    headSha: "a".repeat(40),
    workflowRunId: 44,
    reason: "gha:CI:success",
    executionId: "github:delivery-44",
    dedupeKey: `ci:44:${"a".repeat(40)}`,
    mutationAllowed: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  }, { status: "EXECUTION_ACCEPTED", reason: "validated", backend: "cloudflare-sandbox", checkpointId: "checkpoint:44", workspaceVerified: true }, 44);
  assert.equal(result.status, "RECORDED");
  if (result.status !== "RECORDED") throw new Error("fixture evidence was not recorded");
  return result.evidence;
}

const codingRequest = {
  kind: "REPOSITORY_AUTOPILOT" as const,
  repository: "cinamoncandy/NUSA",
  headSha: "a".repeat(40),
  workflowRunId: 1258,
  reason: "continue-from:ci_succeeded",
  executionId: "github:delivery-1258",
  dedupeKey: `ci:1258:${"a".repeat(40)}`,
  mutationAllowed: false as const,
  liveAuthority: "NONE" as const,
  productionMutationAllowed: false as const,
  aiAuthority: "ZERO_AUTHORITY" as const,
};

describe("NUSA autopilot GitHub webhook", () => {
  it("classifies only the bounded event surface", () => {
    assert.equal(classifyGithubEvent("ping"), "ping");
    assert.equal(classifyGithubEvent("push"), "push");
    assert.equal(classifyGithubEvent("pull_request"), "pull_request");
    assert.equal(classifyGithubEvent("workflow_run"), "workflow_run");
    assert.equal(classifyGithubEvent("issues"), null);
    assert.equal(classifyGithubEvent(null), null);
  });

  it("exposes a fail-closed deployment revision health signal", async () => {
    const unverified = await worker.fetch(new Request("https://example.test/health"), {});
    assert.equal(unverified.status, 200);
    const unverifiedPayload = await unverified.json() as { deploymentRevision: string; executionTelemetry: string };
    assert.equal(unverifiedPayload.deploymentRevision, "UNVERIFIED");
    assert.equal(unverifiedPayload.executionTelemetry, "INTERFACE_READY");

    const verified = await worker.fetch(new Request("https://example.test/health"), { NUSA_DEPLOYMENT_REVISION: "a".repeat(40) });
    assert.equal((await verified.json() as { deploymentRevision: string }).deploymentRevision, "a".repeat(40));
  });

  it("protects the persistent scheduled runtime tick with a dedicated bearer secret", async () => {
    const request = () => new Request("https://example.test/scheduled/run", { method: "POST" });
    const missing = await handleScheduledRuntimeTick(request(), {});
    assert.equal(missing.status, 503);
    assert.equal((await missing.json() as { reason: string }).reason, "AUTOPILOT_RUNTIME_TOKEN_NOT_CONFIGURED");

    const wrong = await handleScheduledRuntimeTick(new Request("https://example.test/scheduled/run", { method: "POST", headers: { authorization: "Bearer wrong" } }), { NUSA_AUTOPILOT_RUNTIME_TOKEN: "correct" });
    assert.equal(wrong.status, 401);

    const unavailable = await handleScheduledRuntimeTick(new Request("https://example.test/scheduled/run", { method: "POST", headers: { authorization: "Bearer correct" } }), { NUSA_AUTOPILOT_RUNTIME_TOKEN: "correct" });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json() as { reason: string }).reason, "PERSISTENT_EXECUTION_COORDINATOR_REQUIRED");
  });

  it("verifies the exact request body with HMAC SHA-256", async () => {
    const signature = await computeGithubWebhookSignature("secret", "{\"ok\":true}");
    assert.equal(await verifyGithubWebhookSignature("secret", "{\"ok\":true}", signature), true);
    assert.equal(await verifyGithubWebhookSignature("secret", "{\"ok\":false}", signature), false);
    assert.equal(await verifyGithubWebhookSignature("secret", "{\"ok\":true}", null), false);
  });

  it("fails closed when the secret is absent", async () => {
    const response = await worker.fetch(new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: { "x-github-delivery": "delivery-1", "x-github-event": "push" },
      body: "{}",
    }), {});
    assert.equal(response.status, 503);
  });

  it("rejects missing delivery identity and unsupported events", async () => {
    const noDelivery = await worker.fetch(new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: { "x-github-event": "push" },
      body: "{}",
    }), { NUSA_WEBHOOK_SECRET: "secret" });
    assert.equal(noDelivery.status, 400);

    const unsupported = await worker.fetch(new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: { "x-github-delivery": "delivery-2", "x-github-event": "issues" },
      body: "{}",
    }), { NUSA_WEBHOOK_SECRET: "secret" });
    assert.equal(unsupported.status, 422);
  });

  it("rejects invalid signatures and plans a valid bounded execution request without mutation authority", async () => {
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "a".repeat(40),
      repository: { full_name: "cinamoncandy/NUSA" },
    });
    const invalid = await worker.fetch(new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-3",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body,
    }), { NUSA_WEBHOOK_SECRET: "secret" });
    assert.equal(invalid.status, 401);

    const signature = await computeGithubWebhookSignature("secret", body);
    const valid = await worker.fetch(new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-4",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      body,
    }), { NUSA_WEBHOOK_SECRET: "secret" });
    assert.equal(valid.status, 202);
    const payload = await valid.json() as {
      accepted: boolean;
      status: string;
      dispatch: { kind: string; headSha: string; mutationAllowed: boolean };
      execution: {
        kind: string;
        repository: string | null;
        headSha: string | null;
        prNumber: number | null;
        workflowRunId: number | null;
        reason: string;
        mutationAllowed: boolean;
      };
    };
    assert.equal(payload.accepted, true);
    assert.equal(payload.status, "EXECUTION_REQUEST_PLANNED");
    assert.equal(payload.dispatch.kind, "MAIN_PUSH");
    assert.equal(payload.dispatch.headSha, "a".repeat(40));
    assert.equal(payload.dispatch.mutationAllowed, false);
    assert.deepEqual(payload.execution, {
      kind: "REPOSITORY_AUTOPILOT",
      repository: "cinamoncandy/NUSA",
      headSha: "a".repeat(40),
      prNumber: null,
      workflowRunId: null,
      workflowRunAttempt: null,
      reason: "continue-from:main_push",
      mutationAllowed: false,
    });
  });


  it("persists global freeze HOLD before replayed Ready-for-review can advance", async () => {
    const storages = new Map<string, MemoryStorage>();
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: (name) => ({ name }),
      get: (id) => {
        const name = String((id as { name?: unknown }).name ?? "");
        let storage = storages.get(name);
        if (!storage) { storage = new MemoryStorage(); storages.set(name, storage); }
        // Recreate the coordinator for every stub lookup. Durable storage is the only shared
        // state, proving a delayed/replayed event cannot rely on process-local HOLD memory.
        const coordinator = new ExecutionCoordinator({ storage });
        return { fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) };
      },
    };
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const body = JSON.stringify({
      action: "ready_for_review",
      number: 1854,
      repository: { full_name: "cinamoncandy/NUSA" },
      pull_request: { head: { sha: headSha }, base: { sha: baseSha } },
    });
    const signature = await computeGithubWebhookSignature("secret", body);
    const request = (delivery: string) => new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: { "x-github-delivery": delivery, "x-github-event": "pull_request", "x-hub-signature-256": signature },
      body,
    });
    const env = { NUSA_WEBHOOK_SECRET: "secret", NUSA_EXECUTION_COORDINATOR: namespace, NUSA_GLOBAL_RELEASE_FREEZE: "true" };
    const first = await worker.fetch(request("ready-1"), env);
    const replay = await worker.fetch(request("ready-2"), env);
    assert.equal(first.status, 202);
    assert.equal(replay.status, 202);
    assert.equal((await first.json() as { status: string; reason: string }).reason, "CONTROL_PLANE_HOLD_ACTIVE");
    assert.equal((await replay.json() as { status: string; reason: string }).reason, "CONTROL_PLANE_HOLD_ACTIVE");
    const holdStorage = [...storages.entries()].find(([name]) => name.startsWith("control-plane-hold:"))?.[1];
    assert.ok(holdStorage);
    // New coordinator instance simulates Worker/DO object recreation after the first event.
    const restored = new ExecutionCoordinator({ storage: holdStorage });
    const persisted = await restored.fetch(new Request("https://execution-coordinator/control-plane-hold"));
    const record = await persisted.json() as { hold: { state: string; prNumber: number; headSha: string; baseSha: string } };
    assert.deepEqual({ state: record.hold.state, prNumber: record.hold.prNumber, headSha: record.hold.headSha, baseSha: record.hold.baseSha }, { state: "ACTIVE", prNumber: 1854, headSha, baseSha });
  });

  it("NOOPs Ready-for-review when exact canonical CI replay evidence is absent", async () => {
    const headSha = "d".repeat(40);
    const body = JSON.stringify({
      action: "ready_for_review",
      number: 1955,
      repository: { full_name: "cinamoncandy/NUSA" },
      pull_request: { head: { sha: headSha }, base: { sha: "b".repeat(40) } },
    });
    const signature = await computeGithubWebhookSignature("secret", body);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/workflows/ci.yml/runs?")) {
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      }
      throw new Error("unexpected network call after unresolved Ready replay");
    }) as typeof fetch;
    try {
      const response = await worker.fetch(new Request("https://example.test/github/webhook", {
        method: "POST",
        headers: { "x-github-delivery": "ready-no-ci", "x-github-event": "pull_request", "x-hub-signature-256": signature },
        body,
      }), {
        NUSA_WEBHOOK_SECRET: "secret",
        NUSA_GITHUB_TOKEN: "token",
        NUSA_GLOBAL_RELEASE_FREEZE: "false",
      });
      assert.equal(response.status, 202);
      const payload = await response.json() as { status: string; reason: string; executor: { status: string; reason: string } };
      assert.equal(payload.status, "NOOP");
      assert.equal(payload.reason, "canonical-ci-run-not-found");
      assert.deepEqual(payload.executor, {
        status: "NOOP",
        reason: "github-executor-ready-ci-replay-unresolved",
        httpStatus: null,
        requestedHeadSha: headSha,
        observedHeadSha: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("releases a Draft CI Audit lease so Ready replay dispatches exactly once", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    const headSha = "c".repeat(40);
    const workflowRunId = 35195500001;
    const readyBody = JSON.stringify({
      action: "ready_for_review",
      number: 1955,
      repository: { full_name: "cinamoncandy/NUSA" },
      pull_request: { head: { sha: headSha }, base: { sha: "b".repeat(40) } },
    });
    const workflowBody = JSON.stringify({
      action: "completed",
      workflow_run: {
        id: workflowRunId,
        name: "CI",
        head_sha: headSha,
        head_branch: "feature/ready-replay",
        status: "completed",
        conclusion: "success",
        event: "pull_request",
        pull_requests: [{ number: 1955 }],
      },
      repository: { full_name: "cinamoncandy/NUSA" },
    });
    const originalFetch = globalThis.fetch;
    const dispatched: unknown[] = [];
    let draft = true;
    let auditPublished = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/workflows/ci.yml/runs?")) return new Response(JSON.stringify({
        total_count: 1,
        workflow_runs: [{
          id: workflowRunId,
          name: "CI",
          path: ".github/workflows/ci.yml",
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          head_sha: headSha,
          repository: { full_name: "cinamoncandy/NUSA" },
          pull_requests: [{
            number: 1955,
            head: { sha: headSha },
            base: { ref: "main" },
          }],
        }],
      }), { status: 200 });
      if (url.endsWith("/pulls/1955")) return new Response(JSON.stringify({
        state: "open",
        draft,
        labels: [],
        head: { sha: headSha },
      }), { status: 200 });
      if (url.includes("/actions/workflows/autopilot-deterministic-audit-release.yml/runs?")) {
        return new Response(JSON.stringify({ workflow_runs: auditPublished ? [{ display_title: `audit:1955:${workflowRunId}:${headSha}`, status: "in_progress", conclusion: null }] : [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/dispatches")) {
        dispatched.push(JSON.parse(String(init?.body)));
        auditPublished = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const request = async (delivery: string, event: "workflow_run" | "pull_request", body: string) => {
        const signature = await computeGithubWebhookSignature("secret", body);
        return new Request("https://example.test/github/webhook", {
          method: "POST",
          headers: { "x-github-delivery": delivery, "x-github-event": event, "x-hub-signature-256": signature },
          body,
        });
      };
      const env = { NUSA_WEBHOOK_SECRET: "secret", NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace, NUSA_GLOBAL_RELEASE_FREEZE: "false" };

      // The Draft CI path must release this exact Audit lease so Ready can reacquire it later.
      const draftCi = await worker.fetch(await request("draft-ci", "workflow_run", workflowBody), env);
      const draftPayload = await draftCi.json() as { executor: { status: string; reason: string } };
      assert.equal(draftCi.status, 202);
      assert.equal(draftPayload.executor.status, "REJECTED");
      assert.equal(draftPayload.executor.reason, "github-executor-pr-draft-hold-active");
      assert.equal(dispatched.length, 0);

      draft = false;
      const first = await worker.fetch(await request("ready-1", "pull_request", readyBody), env);
      const replay = await worker.fetch(await request("ready-2", "pull_request", readyBody), env);
      const firstPayload = await first.json() as { dispatch: { kind: string; workflowRunId: number }; execution: { kind: string; workflowRunId: number; dedupeKey: string }; executor: { status: string } };
      const replayPayload = await replay.json() as { status: string; executionBoundary: { dedupeKey: string }; executor: { status: string; reason: string } };

      assert.equal(firstPayload.dispatch.kind, "PR_CI_SUCCEEDED");
      assert.equal(firstPayload.dispatch.workflowRunId, workflowRunId);
      assert.equal(firstPayload.execution.kind, "AUDIT_REQUEST");
      assert.equal(firstPayload.execution.workflowRunId, workflowRunId);
      assert.equal(firstPayload.executor.status, "DISPATCHED");
      assert.equal(replayPayload.status, "DUPLICATE_EXECUTION_SUPPRESSED");
      assert.equal(replayPayload.executionBoundary.dedupeKey, firstPayload.execution.dedupeKey);
      assert.deepEqual(replayPayload.executor, {
        status: "REJECTED",
        reason: "github-executor-duplicate-execution-suppressed",
        httpStatus: null,
        requestedHeadSha: headSha,
        observedHeadSha: null,
      });
      assert.equal(dispatched.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("releases a retryable Audit executor lease so the same CI identity can dispatch after recovery", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    const headSha = "d".repeat(40);
    const workflowRunId = 35195500002;
    const workflowBody = JSON.stringify({
      action: "completed",
      workflow_run: {
        id: workflowRunId,
        name: "CI",
        head_sha: headSha,
        head_branch: "feature/audit-retry",
        status: "completed",
        conclusion: "success",
        event: "pull_request",
        pull_requests: [{ number: 1956 }],
      },
      repository: { full_name: "cinamoncandy/NUSA" },
    });
    const signature = await computeGithubWebhookSignature("secret", workflowBody);
    const request = (delivery: string) => new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: { "x-github-delivery": delivery, "x-github-event": "workflow_run", "x-hub-signature-256": signature },
      body: workflowBody,
    });
    const originalFetch = globalThis.fetch;
    const dispatched: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/1956")) return new Response(JSON.stringify({
        state: "open",
        draft: false,
        labels: [],
        head: { sha: headSha },
      }), { status: 200 });
      if (url.includes("/actions/workflows/autopilot-deterministic-audit-release.yml/runs?")) {
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/dispatches")) {
        dispatched.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const baseEnv = { NUSA_WEBHOOK_SECRET: "secret", NUSA_EXECUTION_COORDINATOR: namespace, NUSA_GLOBAL_RELEASE_FREEZE: "false" };
      const unavailable = await worker.fetch(request("audit-retry-unavailable"), baseEnv);
      const unavailablePayload = await unavailable.json() as { executor: { status: string; reason: string } };
      assert.equal(unavailablePayload.executor.status, "INTERFACE_READY");
      assert.equal(unavailablePayload.executor.reason, "github-executor-token-not-configured");
      assert.equal(dispatched.length, 0);

      const recovered = await worker.fetch(request("audit-retry-recovered"), { ...baseEnv, NUSA_GITHUB_TOKEN: "token" });
      const recoveredPayload = await recovered.json() as { executor: { status: string } };
      assert.equal(recoveredPayload.executor.status, "DISPATCHED");
      assert.equal(dispatched.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers one accepted Audit dispatch when GitHub never materializes its exact workflow run", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    const headSha = "e".repeat(40);
    const workflowRunId = 35195500003;
    const workflowBody = JSON.stringify({
      action: "completed",
      workflow_run: {
        id: workflowRunId,
        name: "CI",
        head_sha: headSha,
        head_branch: "feature/audit-recovery",
        status: "completed",
        conclusion: "success",
        event: "pull_request",
        pull_requests: [{ number: 1957 }],
      },
      repository: { full_name: "cinamoncandy/NUSA" },
    });
    const signature = await computeGithubWebhookSignature("secret", workflowBody);
    const request = (delivery: string) => new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: { "x-github-delivery": delivery, "x-github-event": "workflow_run", "x-hub-signature-256": signature },
      body: workflowBody,
    });
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const dispatched: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/1957")) return new Response(JSON.stringify({
        state: "open",
        draft: false,
        labels: [],
        head: { sha: headSha },
      }), { status: 200 });
      if (url.includes("/actions/workflows/autopilot-deterministic-audit-release.yml/runs?")) {
        // The first dispatch was accepted but never became a visible Audit run.
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/dispatches")) {
        dispatched.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const env = { NUSA_WEBHOOK_SECRET: "secret", NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace, NUSA_GLOBAL_RELEASE_FREEZE: "false" };
      let now = 1_000_000;
      Date.now = () => now;
      const initial = await worker.fetch(request("audit-recovery-initial"), env);
      const pending = await worker.fetch(request("audit-recovery-pending"), env);
      now += AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS;
      const recovered = await worker.fetch(request("audit-recovery-replay"), env);
      const exhausted = await worker.fetch(request("audit-recovery-exhausted"), env);
      const initialPayload = await initial.json() as { executor: { status: string } };
      const pendingPayload = await pending.json() as { status: string; executor: { reason: string } };
      const recoveredPayload = await recovered.json() as { status: string; executor: { status: string } };
      const exhaustedPayload = await exhausted.json() as { status: string; executor: { status: string; reason: string } };

      assert.equal(initialPayload.executor.status, "DISPATCHED");
      assert.equal(pendingPayload.status, "DUPLICATE_EXECUTION_SUPPRESSED");
      assert.equal(pendingPayload.executor.reason, "github-executor-duplicate-execution-suppressed");
      assert.equal(recoveredPayload.status, "AUDIT_DISPATCH_RECOVERED");
      assert.equal(recoveredPayload.executor.status, "DISPATCHED");
      assert.equal(exhaustedPayload.status, "DUPLICATE_EXECUTION_SUPPRESSED");
      assert.equal(exhaustedPayload.executor.reason, "github-executor-duplicate-execution-suppressed");
      assert.equal(dispatched.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("rejects malformed signed JSON instead of planning from partial data", async () => {
    const body = "{";
    const signature = await computeGithubWebhookSignature("secret", body);
    const response = await worker.fetch(new Request("https://example.test/github/webhook", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-json",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      body,
    }), { NUSA_WEBHOOK_SECRET: "secret" });
    assert.equal(response.status, 400);
  });

  it("projects persisted coding evidence through a read-only safety boundary", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const evidence = evidenceFixture();
    await coordinator.fetch(new Request("https://execution-coordinator/coding-evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidence }),
    }));
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    const response = await worker.fetch(new Request("https://example.test/coding/evidence"), { NUSA_EXECUTION_COORDINATOR: namespace });
    assert.equal(response.status, 200);
    const payload = await response.json() as { status: string; history: readonly unknown[]; liveAuthority: string; productionMutationAllowed: boolean; aiAuthority: string };
    assert.equal(payload.status, "OBSERVED");
    assert.equal(payload.history.length, 1);
    assert.equal(payload.liveAuthority, "NONE");
    assert.equal(payload.productionMutationAllowed, false);
    assert.equal(payload.aiAuthority, "ZERO_AUTHORITY");
  });

  it("suppresses duplicate cloud coding calls at the execution boundary", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    let runtimeCalls = 0;
    const runtime: CodingRuntime = {
      name: "fake-cloud-runtime",
      async execute() {
        runtimeCalls += 1;
        return {
          backend: "fake-cloud-runtime",
          checkpointId: "checkpoint:1258",
          workspaceVerified: true,
          proposalValidated: true,
          changedFiles: ["apps/autopilot/src/index.ts"],
        };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: codingRequest.headSha }), { status: 200 });
      if (url.includes("/actions/runs/")) return new Response(JSON.stringify({
        id: codingRequest.workflowRunId,
        head_sha: codingRequest.headSha,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        repository: { full_name: codingRequest.repository },
      }), { status: 200 });
      return new Response(JSON.stringify({ patch: "diff --git a/apps/autopilot/src/codingRunner.ts b/apps/autopilot/src/codingRunner.ts\n--- a/apps/autopilot/src/codingRunner.ts\n+++ b/apps/autopilot/src/codingRunner.ts\n" }), { status: 200 });
    }) as typeof fetch;
    try {
      const request = () => new Request("https://example.test/coding/execute", {
        method: "POST",
        headers: { authorization: "Bearer runner-token", "content-type": "application/json" },
        body: JSON.stringify(codingRequest),
      });
      const env = {
        NUSA_CODING_RUNNER_TOKEN: "runner-token",
        NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
        NUSA_GITHUB_TOKEN: "github-token",
        NUSA_AI_CODING_ENDPOINT: "https://coding.example.test/execute",
        NUSA_AI_CODING_TOKEN: "ai-token",
        NUSA_EXECUTION_COORDINATOR: namespace,
      };
      const now = Date.now();
      await acquirePersistentExecution(namespace, {
        dedupeKey: codingRequest.dedupeKey,
        executionId: codingRequest.executionId,
        now,
        leaseExpiresAt: now + 60_000,
      });
      const first = await handleCodingExecute(request(), env, runtime);
      const second = await handleCodingExecute(request(), env, runtime);
      assert.equal(first.status, 202);
      assert.equal((await first.clone().json() as { status: string }).status, "EXECUTION_ACCEPTED");
      assert.equal(second.status, 202);
      assert.equal((await second.json() as { status: string }).status, "DUPLICATE_EXECUTION_SUPPRESSED");
      assert.equal(runtimeCalls, 1);
      const telemetry = await coordinator.fetch(new Request("https://execution-coordinator/execution-telemetry"));
      const telemetryBody = await telemetry.json() as { history: readonly unknown[]; summary: { duplicateSuppressedCount: number } };
      assert.equal(telemetryBody.history.length, 2);
      assert.equal(telemetryBody.summary.duplicateSuppressedCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects workflow-failure dispatch before lease acquisition without a verified causal admission", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    let runtimeCalls = 0;
    const runtime: CodingRuntime = {
      name: "must-not-run",
      async execute() { runtimeCalls += 1; throw new Error("workflow failure reason was not gated"); },
    };
    const failureRequest = { ...codingRequest, reason: `gha:${codingRequest.workflowRunId}:${codingRequest.headSha}:failure` };
    const request = () => new Request("https://example.test/coding/execute", {
      method: "POST",
      headers: { authorization: "Bearer runner-token", "content-type": "application/json" },
      body: JSON.stringify(failureRequest),
    });
    const env = { NUSA_CODING_RUNNER_TOKEN: "runner-token", NUSA_EXECUTION_COORDINATOR: namespace };
    const response = await handleCodingExecute(request(), env, runtime);
    const body = await response.json() as { accepted: boolean; error: string };
    assert.equal(response.status, 409);
    assert.equal(body.accepted, false);
    assert.equal(body.error, "CAUSAL_ACTIONABILITY_UNVERIFIED");
    assert.equal(runtimeCalls, 0);
    const execution = await readPersistentExecution(namespace, failureRequest.dedupeKey);
    assert.equal(execution, null, "workflow-failure denial must happen before lease acquisition");
  });

  it("releases a failed coding lease so the bounded retry can reach the Worker again", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    let codingEngineCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: codingRequest.headSha }), { status: 200 });
      if (url.includes("/actions/runs/")) return new Response(JSON.stringify({
        id: codingRequest.workflowRunId,
        head_sha: codingRequest.headSha,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        repository: { full_name: codingRequest.repository },
      }), { status: 200 });
      codingEngineCalls += 1;
      return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
    }) as typeof fetch;
    try {
      const request = () => new Request("https://example.test/coding/execute", {
        method: "POST",
        headers: { authorization: "Bearer runner-token", "content-type": "application/json" },
        body: JSON.stringify(codingRequest),
      });
      const env = {
        NUSA_CODING_RUNNER_TOKEN: "runner-token",
        NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
        NUSA_GITHUB_TOKEN: "github-token",
        NUSA_AI_CODING_ENDPOINT: "https://coding.example.test/execute",
        NUSA_AI_CODING_TOKEN: "ai-token",
        NUSA_EXECUTION_COORDINATOR: namespace,
      };
      const first = await handleCodingExecute(request(), env);
      const second = await handleCodingExecute(request(), env);
      assert.equal(first.status, 502);
      assert.equal(second.status, 502);
      assert.equal(codingEngineCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("persists a Worker rate-limit stop and suppresses replay until the same WIP is due", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    let codingEngineCalls = 0;
    const ai: WorkersAiBinding = {
      async run() {
        codingEngineCalls += 1;
        throw new Error("429 too many requests");
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: codingRequest.headSha }), { status: 200 });
      if (url.includes("/actions/runs/")) return new Response(JSON.stringify({
        id: codingRequest.workflowRunId,
        head_sha: codingRequest.headSha,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        repository: { full_name: codingRequest.repository },
      }), { status: 200 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const request = () => new Request("https://example.test/coding/execute", {
        method: "POST",
        headers: { authorization: "Bearer runner-token", "content-type": "application/json" },
        body: JSON.stringify(codingRequest),
      });
      const env = {
        NUSA_CODING_RUNNER_TOKEN: "runner-token",
        NUSA_GITHUB_TOKEN: "github-token",
        NUSA_EXECUTION_COORDINATOR: namespace,
        AI: ai,
      };
      const first = await handleCodingExecute(request(), env);
      const firstPayload = await first.json() as { status: string; nextRetryAt: number; stopReason: string; resumeCondition: string };
      assert.equal(first.status, 202);
      assert.equal(firstPayload.status, "WAITING_RATE_LIMIT");
      assert.equal(firstPayload.stopReason, "WORKERS_AI_RATE_LIMITED");
      assert.equal(firstPayload.resumeCondition, "provider-capacity-and-exact-head-revalidation");
      assert.ok(firstPayload.nextRetryAt > Date.now());

      const stopped = await readPersistentExecution(namespace, codingRequest.dedupeKey);
      assert.equal(stopped?.state, "WAITING_RATE_LIMIT");
      assert.equal(stopped?.executionId, codingRequest.executionId);
      assert.equal(stopped?.stop?.dedupeKey, codingRequest.dedupeKey);
      assert.equal(stopped?.stop?.headSha, codingRequest.headSha);

      // The same stop is also recorded against the provider, which is what keeps later executions on
      // a different main from dispatching inside the wait window.
      const providerWait = await readProviderCapacityWait(namespace, "workers-ai");
      assert.equal(providerWait?.nextRetryAt, firstPayload.nextRetryAt);
      assert.equal(providerWait?.dedupeKey, codingRequest.dedupeKey);
      assert.equal(providerWait?.stopReason, "WORKERS_AI_RATE_LIMITED");

      const replay = await handleCodingExecute(request(), env);
      const replayPayload = await replay.json() as { status: string; reason: string; nextRetryAt: number };
      assert.equal(replay.status, 202);
      assert.equal(replayPayload.status, "WAITING_RATE_LIMIT");
      assert.equal(replayPayload.reason, "WAITING_RATE_LIMIT");
      assert.equal(replayPayload.nextRetryAt, firstPayload.nextRetryAt);
      assert.equal(codingEngineCalls, 1);

      // A different execution identity passes its own lease and GitHub verification, but the provider
      // wait is re-read immediately before the Workers AI call, so no call is spent inside the window.
      const otherRequest = () => new Request("https://example.test/coding/execute", {
        method: "POST",
        headers: { authorization: "Bearer runner-token", "content-type": "application/json" },
        body: JSON.stringify({ ...codingRequest, executionId: `${codingRequest.executionId}-other`, dedupeKey: `${codingRequest.dedupeKey}-other` }),
      });
      const other = await handleCodingExecute(otherRequest(), env);
      const otherPayload = await other.json() as { status: string; reason: string; nextRetryAt: number };
      assert.equal(otherPayload.status, "WAITING_RATE_LIMIT");
      assert.equal(otherPayload.reason, "WAITING_PROVIDER_CAPACITY");
      assert.equal(otherPayload.nextRetryAt, firstPayload.nextRetryAt);
      assert.equal(codingEngineCalls, 1, "no provider call for any execution inside the provider wait");
      // That identity now waits on its own record too, so its replay is suppressed by the lease path.
      const otherRecord = await readPersistentExecution(namespace, `${codingRequest.dedupeKey}-other`);
      assert.equal(otherRecord?.state, "WAITING_RATE_LIMIT");
      assert.equal(otherRecord?.stop?.nextRetryAt, firstPayload.nextRetryAt);

      // Unreadable provider state fails closed before any provider call.
      const unreadable: ExecutionCoordinatorNamespace = {
        idFromName: (name: string) => ({ name }),
        get: (id: unknown) => ({
          fetch: (input: RequestInfo | URL, init?: RequestInit) => String((id as { name?: string }).name ?? "").startsWith("provider-capacity-wait:")
            ? Promise.resolve(new Response("unavailable", { status: 503 }))
            : coordinator.fetch(new Request(input, init)),
        }),
      };
      const thirdRequest = new Request("https://example.test/coding/execute", {
        method: "POST",
        headers: { authorization: "Bearer runner-token", "content-type": "application/json" },
        body: JSON.stringify({ ...codingRequest, executionId: `${codingRequest.executionId}-third`, dedupeKey: `${codingRequest.dedupeKey}-third` }),
      });
      const closed = await handleCodingExecute(thirdRequest, { ...env, NUSA_EXECUTION_COORDINATOR: unreadable });
      const closedPayload = await closed.json() as { status: string; reason?: string; error?: string };
      assert.notEqual(closedPayload.status, "EXECUTION_ACCEPTED");
      assert.equal(closedPayload.reason ?? closedPayload.error, "PROVIDER_CAPACITY_STATE_UNAVAILABLE");
      assert.equal(codingEngineCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
