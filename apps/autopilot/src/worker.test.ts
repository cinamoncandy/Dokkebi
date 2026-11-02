import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleCodingProposal, handleCodingPublish, ExecutionCoordinator, type WorkerEnv } from "./worker";
import { readCodingExecutionEvidence, readProviderCapacityWait, type ExecutionCoordinatorNamespace } from "./executionCoordinator";

const HEAD = "a".repeat(40);
const request = {
  kind: "REPOSITORY_AUTOPILOT" as const,
  repository: "cinamoncandy/NUSA",
  headSha: HEAD,
  workflowRunId: 123,
  reason: "evolve:discovery:github-issue-2118",
  executionId: "evolve-coding:aaaaaaaaaaaaaaaa:github-issue-2118",
  dedupeKey: `evolve-coding:${HEAD}:github-issue-2118`,
  mutationAllowed: false as const,
  liveAuthority: "NONE" as const,
  productionMutationAllowed: false as const,
  aiAuthority: "ZERO_AUTHORITY" as const,
};

const QUOTA_ERROR = "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

function memoryNamespace(): ExecutionCoordinatorNamespace {
  const storage = new MemoryStorage();
  const coordinator = new ExecutionCoordinator({ storage });
  return {
    idFromName: () => ({}),
    get: () => ({ fetch: (input: RequestInfo, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
  };
}

function proposalRequestFor(value = request): Request {
  return new Request("https://worker.example.test/coding/propose", {
    method: "POST",
    headers: { authorization: "Bearer coding-token", "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function proposalRequest(): Request {
  return proposalRequestFor(request);
}

async function withStubbedGithubFetch<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const value = String(url);
    if (value.includes("/commits/")) return new Response(JSON.stringify({ sha: HEAD }), { status: 200 });
    if (value.includes("/actions/runs/")) {
      return new Response(JSON.stringify({
        id: request.workflowRunId,
        head_sha: HEAD,
        head_branch: "main",
        repository: { full_name: request.repository },
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${value}`);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function baseEnv(coordinator: ExecutionCoordinatorNamespace): WorkerEnv {
  return {
    NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
    NUSA_GITHUB_REPOSITORY: request.repository,
    NUSA_CODING_RUNNER_TOKEN: "coding-token",
    NUSA_GITHUB_TOKEN: "github-token",
    NUSA_EXECUTION_COORDINATOR: coordinator,
  } as unknown as WorkerEnv;
}

describe("/coding/propose bounded Jev admission", () => {
  it("rejects workflow-failure proposal without a verified causal admission", async () => {
    const coordinator = memoryNamespace();
    let aiCalls = 0;
    const failureRequest = { ...request, reason: `gha:${request.workflowRunId}:${HEAD}:failure` };
    const env = {
      ...baseEnv(coordinator),
      AI: { async run() { aiCalls += 1; return { response: "{}" }; } },
      NUSA_JEV_SHADOW_ENABLED: "true",
      NUSA_JEV_BOUNDED_ROUTING_ENABLED: "true",
      NUSA_JEV_API_KEY: ["unit", "jev", "credential"].join("-"),
      NUSA_JEV_ENDPOINT: "https://jev.invalid/classify",
    } as unknown as WorkerEnv;

    const response = await handleCodingProposal(proposalRequestFor(failureRequest), env);
    const body = await response.json() as { accepted: boolean; status: string; error: string; aiAuthority: string };
    assert.equal(response.status, 409);
    assert.equal(body.accepted, false);
    assert.equal(body.status, "CODING_PROPOSAL_FAILED_CLOSED");
    assert.equal(body.error, "CAUSAL_ACTIONABILITY_UNVERIFIED");
    assert.equal(body.aiAuthority, "ZERO_AUTHORITY");
    assert.equal(aiCalls, 0);
  });
});

describe("workflow-failure publish admission", () => {
  it("rejects static-token publication before GitHub lookup or mutation", async () => {
    const env = baseEnv(memoryNamespace());
    let githubCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { githubCalls += 1; throw new Error("GitHub lookup must not run"); }) as typeof fetch;
    try {
      const response = await handleCodingPublish(new Request("https://worker.example.test/coding/publish", {
        method: "POST",
        headers: { authorization: "Bearer coding-token", "content-type": "application/json" },
        body: JSON.stringify({ request: { ...request, reason: `gha:${request.workflowRunId}:${HEAD}:failure` }, validatedFiles: [{ path: "apps/autopilot/src/dispatchPlanner.ts", content: "export const x = 1;" }] }),
      }), env);
      const body = await response.json() as { accepted: boolean; error: string };
      assert.equal(response.status, 409);
      assert.equal(body.accepted, false);
      assert.equal(body.error, "CAUSAL_ACTIONABILITY_UNVERIFIED");
      assert.equal(githubCalls, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("/coding/propose provider-capacity gating", () => {
  it("makes no provider call and reports the wait when the shared provider wait is active", async () => {
    await withStubbedGithubFetch(async () => {
      const coordinator = memoryNamespace();
      const future = Date.now() + 60 * 60 * 1000;
      const stop = {
        schemaVersion: 1 as const,
        taskId: "t",
        executionId: "prior",
        provider: "workers-ai",
        headSha: HEAD,
        stopReason: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED",
        stoppedAt: Date.now(),
        attemptCount: 1,
        lastFailure: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED",
        nextRetryAt: future,
        resumeCondition: "provider-capacity-and-exact-head-revalidation",
        dedupeKey: "prior-dedupe",
        evidenceRef: null,
      };
      const { recordProviderCapacityWait } = await import("./executionCoordinator");
      await recordProviderCapacityWait(coordinator, stop);

      let aiCalls = 0;
      const env = { ...baseEnv(coordinator), AI: { async run() { aiCalls += 1; return { response: "{}" }; } } } as unknown as WorkerEnv;
      const response = await handleCodingProposal(proposalRequest(), env);
      const body = await response.json() as { accepted: boolean; status: string; nextRetryAt: number | null };
      assert.equal(response.status, 409);
      assert.equal(body.accepted, false);
      assert.equal(body.status, "CODING_PROPOSAL_FAILED_CLOSED");
      assert.equal(body.nextRetryAt, future);
      assert.equal(aiCalls, 0, "must not spend a real Workers AI call while a provider wait is active");
    });
  });

  it("records a daily-quota stop in the shared provider wait so a later distinct task also stops", async () => {
    await withStubbedGithubFetch(async () => {
      const coordinator = memoryNamespace();
      let aiCalls = 0;
      const env = { ...baseEnv(coordinator), AI: { async run() { aiCalls += 1; throw new Error(QUOTA_ERROR); } } } as unknown as WorkerEnv;

      const first = await handleCodingProposal(proposalRequest(), env);
      assert.equal(first.status, 409);
      assert.equal(aiCalls, 1);

      const wait = await readProviderCapacityWait(coordinator, "workers-ai");
      assert.ok(wait, "the daily-quota stop must be recorded in the shared provider wait");
      assert.equal(wait?.stopReason, "WORKERS_AI_DAILY_QUOTA_EXHAUSTED");
      assert.ok(wait!.nextRetryAt > Date.now() + 60_000, "a daily-quota wait must extend well past the 60s local retry ceiling");

      // A distinct task hitting the same endpoint must now be stopped by the shared wait,
      // without spending a second real Workers AI call.
      const secondRequest = { ...request, executionId: "evolve-coding:aaaaaaaaaaaaaaaa:different-task", dedupeKey: `evolve-coding:${HEAD}:different-task` };
      const second = await handleCodingProposal(new Request("https://worker.example.test/coding/propose", {
        method: "POST",
        headers: { authorization: "Bearer coding-token", "content-type": "application/json" },
        body: JSON.stringify(secondRequest),
      }), env);
      assert.equal(second.status, 409);
      assert.equal(aiCalls, 1, "a second distinct task must not spend another real Workers AI call once the shared wait is recorded");
    });
  });

  it("fails closed without a provider call when the shared provider-wait state is unreadable", async () => {
    await withStubbedGithubFetch(async () => {
      const brokenCoordinator: ExecutionCoordinatorNamespace = {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response("", { status: 500 }) }),
      };
      let aiCalls = 0;
      const env = { ...baseEnv(brokenCoordinator), AI: { async run() { aiCalls += 1; return { response: "{}" }; } } } as unknown as WorkerEnv;
      const response = await handleCodingProposal(proposalRequest(), env);
      assert.equal(response.status, 409);
      assert.equal(aiCalls, 0);
    });
  });
});


describe("configured coding-engine failure status evidence", () => {
  it("records an exhausted paid balance as a day-long hard stop, not a retryable 429", async () => {
    const original = globalThis.fetch;

    try {
      const env = {
        ...baseEnv(memoryNamespace()),
        NUSA_AI_CODING_ENDPOINT: "https://coding.invalid/generate",
        NUSA_AI_CODING_TOKEN: "engine-token",
      } as unknown as WorkerEnv;
      let paidCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: HEAD }), { status: 200 });
        if (url.includes("/actions/runs/")) {
          return new Response(JSON.stringify({
            id: request.workflowRunId,
            head_sha: HEAD,
            head_branch: "main",
            repository: { full_name: request.repository },
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          }), { status: 200 });
        }
        if (url === "https://coding.invalid/generate") {
          paidCalls += 1;
          return new Response(JSON.stringify({ error: "insufficient credit" }), { status: 402 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      const before = Date.now();
      const response = await handleCodingProposal(proposalRequest(), env);
      assert.equal(response.status, 409);
      assert.equal(paidCalls, 1);
      const body = await response.json() as {
        error: string;
        httpStatus?: number;
        provider?: string | null;
        providerStopReason?: string | null;
        nextRetryAt?: number | null;
        remediationDecision?: unknown;
      };
      assert.equal(body.error, "WAITING_PROVIDER_CAPACITY");
      assert.equal(body.httpStatus, 402);
      assert.equal(body.provider, "configured-coding-engine");
      // An empty balance never recovers on a minute-scale backoff, so it must not be reported as
      // transient rate limiting; the wait reaches at least into the next UTC day.
      assert.equal(body.providerStopReason, "PAID_CODING_CREDITS_EXHAUSTED");
      assert.ok(Number.isSafeInteger(body.nextRetryAt));
      assert.ok((body.nextRetryAt as number) > before + 60_000);
      assert.equal(body.remediationDecision, undefined);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("preserves HTTP 429 capacity and 5xx status through /coding/propose", async () => {
    const original = globalThis.fetch;

    try {
      for (const httpStatus of [429, 503]) {
        const env = {
          ...baseEnv(memoryNamespace()),
          NUSA_AI_CODING_ENDPOINT: "https://coding.invalid/generate",
          NUSA_AI_CODING_TOKEN: "engine-token",
        } as unknown as WorkerEnv;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: HEAD }), { status: 200 });
          if (url.includes("/actions/runs/")) {
            return new Response(JSON.stringify({
              id: request.workflowRunId,
              head_sha: HEAD,
              head_branch: "main",
              repository: { full_name: request.repository },
              event: "workflow_dispatch",
              status: "completed",
              conclusion: "success",
            }), { status: 200 });
          }
          if (url === "https://coding.invalid/generate") {
            return new Response(JSON.stringify({ error: "provider failure" }), { status: httpStatus });
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch;

        const response = await handleCodingProposal(proposalRequest(), env);
        assert.equal(response.status, 409);
        const body = await response.json() as {
          error: string;
          httpStatus?: number;
          provider?: string | null;
          providerStopReason?: string | null;
          nextRetryAt?: number | null;
          remediationDecision?: { outcome: string; failureClass: string; recovery: string; retryable: boolean; attempt: number; maxAttempts: number };
        };
        if (httpStatus === 429) {
          assert.equal(body.error, "WAITING_PROVIDER_CAPACITY");
          assert.equal(body.httpStatus, 429);
          assert.equal(body.provider, "configured-coding-engine");
          assert.equal(body.providerStopReason, "PROVIDER_RATE_LIMITED");
          assert.ok(Number.isSafeInteger(body.nextRetryAt));
          assert.equal(body.remediationDecision, undefined);
        } else {
          assert.equal(body.error, "coding-engine-request-failed");
          assert.equal(body.httpStatus, 503);
          assert.deepEqual(body.remediationDecision, {
            outcome: "FAILED_TO_REMEDIATE",
            failureClass: "PROVIDER_FAILURE",
            recovery: "RETRY_BOUNDED",
            retryable: true,
            attempt: 0,
            maxAttempts: 3,
          });
        }
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("persists configured-provider 429 capacity and suppresses later coding calls", async () => {
    const original = globalThis.fetch;
    const coordinator = memoryNamespace();
    const env = {
      ...baseEnv(coordinator),
      NUSA_AI_CODING_ENDPOINT: "https://coding.invalid/generate",
      NUSA_AI_CODING_TOKEN: "engine-token",
    } as unknown as WorkerEnv;
    let codingCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: HEAD }), { status: 200 });
        if (url.includes("/actions/runs/")) return new Response(JSON.stringify({
          id: request.workflowRunId,
          head_sha: HEAD,
          head_branch: "main",
          repository: { full_name: request.repository },
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
        }), { status: 200 });
        if (url === "https://coding.invalid/generate") {
          codingCalls += 1;
          return new Response(JSON.stringify({ error: "provider failure" }), { status: 429 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      const first = await handleCodingProposal(proposalRequest(), env);
      const firstBody = await first.json() as { error: string; provider: string; providerStopReason: string; nextRetryAt: number };
      const stored = await readProviderCapacityWait(coordinator, "configured-coding-engine");
      assert.equal(firstBody.error, "WAITING_PROVIDER_CAPACITY");
      assert.equal(firstBody.provider, "configured-coding-engine");
      assert.equal(stored?.provider, "configured-coding-engine");
      assert.equal(stored?.nextRetryAt, firstBody.nextRetryAt);

      const replay = await handleCodingProposal(proposalRequest(), env);
      const replayBody = await replay.json() as { error: string; provider: string; nextRetryAt: number };
      assert.equal(replayBody.error, "WAITING_PROVIDER_CAPACITY");
      assert.equal(replayBody.provider, "configured-coding-engine");
      assert.equal(replayBody.nextRetryAt, firstBody.nextRetryAt);
      assert.equal(codingCalls, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("coding proposal and publish lookup status evidence", () => {
  it("preserves transient GitHub lookup status from both canonical endpoints", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "upstream unavailable" }), { status: 503 })) as typeof fetch;

    try {
      const env = baseEnv(memoryNamespace());
      const proposal = await handleCodingProposal(proposalRequest(), env);
      assert.equal(proposal.status, 409);
      const proposalBody = await proposal.json() as { httpStatus?: number };
      assert.equal(proposalBody.httpStatus, 503);

      const publish = await handleCodingPublish(new Request("https://worker.example.test/coding/publish", {
        method: "POST",
        headers: { authorization: "Bearer coding-token", "content-type": "application/json" },
        body: JSON.stringify({
          request,
          validatedFiles: [{ path: "apps/autopilot/src/dispatchPlanner.ts", content: "export const publishFixture = true;\\n" }],
        }),
      }), env);
      assert.equal(publish.status, 409);
      const publishBody = await publish.json() as { httpStatus?: number };
      assert.equal(publishBody.httpStatus, 503);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("/coding/publish receipt reconciliation", () => {
  it("persists the real publish receipt before projecting PR_OPEN", async () => {
    const coordinator = memoryNamespace();
    const env = baseEnv(coordinator);
    const original = globalThis.fetch;
    const commitSha = "e".repeat(40);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/actions/runs/")) {
        return new Response(JSON.stringify({
          id: request.workflowRunId,
          head_sha: HEAD,
          head_branch: "main",
          repository: { full_name: request.repository },
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
        }), { status: 200 });
      }
      if (url.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: HEAD } }), { status: 200 });
      }
      if (url.includes("/git/ref/heads/nusa/autopilot/")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (url.includes(`/git/commits/${HEAD}`)) {
        return new Response(JSON.stringify({ tree: { sha: "b".repeat(40) } }), { status: 200 });
      }
      if (url.endsWith("/git/blobs") && method === "POST") return new Response(JSON.stringify({ sha: "c".repeat(40) }), { status: 201 });
      if (url.endsWith("/git/trees") && method === "POST") return new Response(JSON.stringify({ sha: "d".repeat(40) }), { status: 201 });
      if (url.endsWith("/git/commits") && method === "POST") return new Response(JSON.stringify({ sha: commitSha }), { status: 201 });
      if (url.endsWith("/git/refs") && method === "POST") return new Response(JSON.stringify({ ref: "refs/heads/test" }), { status: 201 });
      if (url.endsWith("/pulls") && method === "POST") {
        return new Response(JSON.stringify({ number: 77, html_url: "https://github.com/cinamoncandy/NUSA/pull/77" }), { status: 201 });
      }
      if (url.includes(`/commits/${HEAD}`)) return new Response(JSON.stringify({ sha: HEAD }), { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as typeof fetch;

    try {
      const response = await handleCodingPublish(new Request("https://worker.example.test/coding/publish", {
        method: "POST",
        headers: { authorization: "Bearer coding-token", "content-type": "application/json" },
        body: JSON.stringify({
          request,
          validatedFiles: [{ path: "apps/autopilot/src/dispatchPlanner.ts", content: "export const publishFixture = true;\n" }],
        }),
      }), env);
      assert.equal(response.status, 200);
      const body = await response.json() as {
        executionEvidencePersisted: boolean;
        nextCanonicalTransition: string;
        commitSha: string;
        pullRequestNumber: number;
      };
      assert.equal(body.executionEvidencePersisted, true);
      assert.equal(body.nextCanonicalTransition, "PR_OPEN");
      assert.equal(body.commitSha, commitSha);
      assert.equal(body.pullRequestNumber, 77);
      const persisted = await readCodingExecutionEvidence(coordinator);
      assert.equal(persisted.evidence?.outcome.commitSha, commitSha);
      assert.equal(persisted.evidence?.outcome.pullRequestNumber, 77);
    } finally {
      globalThis.fetch = original;
    }
  });
});
