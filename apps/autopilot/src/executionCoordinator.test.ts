import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acquirePersistentExecution, ACTIVE_WIP_CLAIM_MAX_AGE_MS, AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS, readProviderCapacityWait, recordProviderCapacityWait, reservePaidOverflowCall, utcDayKey, applyPersistentControlPlaneHold, clearPersistentControlPlaneHold, ExecutionCoordinator, handoffOrAcquirePersistentExecution, markPersistentExecutionDispatched, markPersistentExecutionRateLimitStopped, readPersistentControlPlaneHold, readPersistentExecution, recoverPersistentAuditDispatch, releasePersistentExecution, type ExecutionCoordinatorNamespace } from "./executionCoordinator";
import { createCodingExecutionEvidence } from "./codingExecutionEvidence";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

class TransactionalRacyStorage {
  private readonly values = new Map<string, unknown>();
  private queue: Promise<void> = Promise.resolve();
  transactionCount = 0;

  async get<T>(key: string): Promise<T | undefined> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.values.set(key, value);
  }

  async transaction<T>(closure: (storage: TransactionalRacyStorage) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    let release: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await closure(this);
    } finally {
      release?.();
    }
  }
}

function codingEvidence(recordedAtMs: number, identitySeed = recordedAtMs) {
  const identity = identitySeed + 1;
  const decision = createCodingExecutionEvidence({
    kind: "REPOSITORY_AUTOPILOT",
    repository: "cinamoncandy/NUSA",
    headSha: "a".repeat(40),
    workflowRunId: identity,
    reason: "gha:CI:success",
    executionId: `github:delivery-${identity}`,
    dedupeKey: `ci:${identity}:${"a".repeat(40)}`,
    mutationAllowed: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  }, {
    status: "EXECUTION_ACCEPTED",
    reason: "validated",
    backend: "cloudflare-sandbox",
    checkpointId: `checkpoint:${identity}`,
    workspaceVerified: true,
    proposalValidated: true,
    changedFiles: ["apps/autopilot/src/index.ts"],
  }, recordedAtMs);
  assert.equal(decision.status, "RECORDED");
  if (decision.status !== "RECORDED") throw new Error("fixture evidence was not recorded");
  return decision.evidence;
}

function fakeNamespace(status: number, body: object): ExecutionCoordinatorNamespace {
  const id = {};
  return {
    idFromName: () => id,
    get: () => ({
      fetch: async () => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    }),
  };
}

function memoryNamespace(): ExecutionCoordinatorNamespace {
  const storage = new MemoryStorage();
  const coordinator = new ExecutionCoordinator({ storage });
  return {
    idFromName: () => ({}),
    get: () => ({ fetch: (input, init) => coordinator.fetch(new Request(input, init)) }),
  };
}

describe("persistent execution coordination", () => {
  it("accepts a new lease", async () => {
    const result = await acquirePersistentExecution(fakeNamespace(201, { acquired: true }), {
      dedupeKey: "ci:1:abc",
      executionId: "github:delivery-1",
      now: 100,
      leaseExpiresAt: 200,
    });
    assert.deepEqual(result, { acquired: true });
  });

  it("suppresses a duplicate", async () => {
    const result = await acquirePersistentExecution(fakeNamespace(409, { acquired: false, reason: "ALREADY_DISPATCHED" }), {
      dedupeKey: "ci:1:abc",
      executionId: "github:redelivery",
      now: 100,
      leaseExpiresAt: 200,
    });
    assert.deepEqual(result, { acquired: false, reason: "ALREADY_DISPATCHED" });
  });

  it("hands one producer lease to one consumer and suppresses replay", async () => {
    const ns = memoryNamespace();
    const input = { dedupeKey: "coding:handoff", executionId: "exec:handoff", now: 100, leaseExpiresAt: 200 };
    assert.deepEqual(await acquirePersistentExecution(ns, input), { acquired: true });
    const consumerLeaseExpiry = 1_200;
    assert.deepEqual(await handoffOrAcquirePersistentExecution(ns, { ...input, now: 110, leaseExpiresAt: consumerLeaseExpiry }), { acquired: true });
    const handedOff = await readPersistentExecution(ns, input.dedupeKey);
    assert.equal(handedOff?.state, "HANDED_OFF");
    assert.equal(handedOff?.leaseExpiresAt, consumerLeaseExpiry, "handoff extends ownership through the consumer execution window");
    assert.deepEqual(await handoffOrAcquirePersistentExecution(ns, { ...input, now: 120, leaseExpiresAt: 220 }), { acquired: false, reason: "LEASE_ACTIVE" });
    assert.deepEqual(await acquirePersistentExecution(ns, { ...input, executionId: "exec:competing-producer", now: 130, leaseExpiresAt: 230 }), { acquired: false, reason: "LEASE_ACTIVE" });
    await markPersistentExecutionDispatched(ns, { dedupeKey: input.dedupeKey, executionId: input.executionId, now: 130 });
    assert.deepEqual(await handoffOrAcquirePersistentExecution(ns, { ...input, now: 140, leaseExpiresAt: 240 }), { acquired: false, reason: "ALREADY_DISPATCHED" });
  });

  it("releases a failed handoff so a bounded retry can reacquire", async () => {
    const ns = memoryNamespace();
    const input = { dedupeKey: "coding:handoff-retry", executionId: "exec:handoff-retry", now: 100, leaseExpiresAt: 200 };
    await acquirePersistentExecution(ns, input);
    await handoffOrAcquirePersistentExecution(ns, { ...input, now: 110, leaseExpiresAt: 210 });
    await releasePersistentExecution(ns, { dedupeKey: input.dedupeKey, executionId: input.executionId, now: 120 });
    assert.deepEqual(await handoffOrAcquirePersistentExecution(ns, { ...input, now: 130, leaseExpiresAt: 230 }), { acquired: true });
  });

  it("fails closed on coordinator failure", async () => {
    await assert.rejects(
      acquirePersistentExecution(fakeNamespace(500, { error: "FAILED" }), {
        dedupeKey: "ci:1:abc",
        executionId: "github:delivery-1",
        now: 100,
        leaseExpiresAt: 200,
      }),
      /PERSISTENT_EXECUTION_COORDINATION_FAILED/,
    );
  });

  it("atomically suppresses concurrent acquire requests for one immutable dedupe key", async () => {
    const storage = new TransactionalRacyStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const acquire = (executionId: string) => coordinator.fetch(new Request("https://execution-coordinator/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dedupeKey: "audit:1965:35345529340:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", executionId, now: 100, leaseExpiresAt: 1_000 }),
    }));

    const [first, second] = await Promise.all([acquire("audit:1965:35345529340"), acquire("audit:1965:35345529340:redelivery")]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const duplicate = first.status === 409 ? first : second;
    const body = await duplicate.json() as { acquired: boolean; reason: string };
    assert.equal(body.acquired, false);
    assert.equal(body.reason, "LEASE_ACTIVE");
    assert.equal(storage.transactionCount, 2);
  });

  it("releases a failed lease so a bounded retry can reacquire it", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    const request = { dedupeKey: "ci:retry:abc", executionId: "github:retry-1", now: 100, leaseExpiresAt: 1_000 };

    assert.deepEqual(await acquirePersistentExecution(namespace, request), { acquired: true });
    await releasePersistentExecution(namespace, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 200 });
    assert.deepEqual(await acquirePersistentExecution(namespace, { ...request, now: 201, leaseExpiresAt: 1_101 }), { acquired: true });
  });

  it("caps fresh acquisitions of one identity only when the caller asks, and keeps the count across handoff", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    const request = { dedupeKey: "evolve-coding:cap", executionId: "evolve-coding:cap", now: 100, leaseExpiresAt: 1_000, maxAcquisitions: 2 };
    assert.deepEqual(await acquirePersistentExecution(namespace, request), { acquired: true });
    // The consumer takes the lease over and then fails closed; the count must survive both steps.
    assert.deepEqual(await handoffOrAcquirePersistentExecution(namespace, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 110, leaseExpiresAt: 1_000 }), { acquired: true });
    await releasePersistentExecution(namespace, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 200 });
    assert.equal((await readPersistentExecution(namespace, request.dedupeKey))?.acquisitionCount, 1);
    assert.deepEqual(await acquirePersistentExecution(namespace, { ...request, now: 300, leaseExpiresAt: 1_300 }), { acquired: true });
    await releasePersistentExecution(namespace, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 400 });
    assert.deepEqual(await acquirePersistentExecution(namespace, { ...request, now: 500, leaseExpiresAt: 1_500 }), { acquired: false, reason: "ATTEMPT_LIMIT_REACHED" });
    assert.equal((await readPersistentExecution(namespace, request.dedupeKey))?.state, "RELEASED");
    // Callers that do not ask for a ceiling keep the previous unbounded behaviour.
    const { maxAcquisitions: _unused, ...unbounded } = request;
    assert.deepEqual(await acquirePersistentExecution(namespace, { ...unbounded, now: 600, leaseExpiresAt: 1_600 }), { acquired: true });
  });

  it("rejects an attempt ceiling outside 1-10", async () => {
    const coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
    for (const maxAcquisitions of [0, 11, 1.5, "3"]) {
      const response = await coordinator.fetch(new Request("https://execution-coordinator/acquire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dedupeKey: "k", executionId: "e", now: 1, leaseExpiresAt: 2, maxAcquisitions }) }));
      assert.equal(response.status, 400, String(maxAcquisitions));
    }
  });

  it("persists a rate-limit stop, suppresses early replays, and resumes the same identity once due", async () => {
    const ns = memoryNamespace();
    const request = {
      dedupeKey: "evolve-coding:rate-limit",
      executionId: "evolve-coding:rate-limit",
      taskId: "autopilot:github-issue-2118",
      provider: "workers-ai",
      headSha: "a".repeat(40),
      now: 1_000,
      leaseExpiresAt: 2_000,
    };
    assert.deepEqual(await acquirePersistentExecution(ns, request), { acquired: true });
    const stop = await markPersistentExecutionRateLimitStopped(ns, {
      schemaVersion: 1,
      taskId: request.taskId,
      executionId: request.executionId,
      provider: request.provider,
      headSha: request.headSha,
      stopReason: "WORKERS_AI_RATE_LIMITED",
      stoppedAt: 1_100,
      attemptCount: 3,
      lastFailure: "WORKERS_AI_RATE_LIMITED",
      nextRetryAt: 2_000,
      resumeCondition: "provider-capacity-and-exact-head-revalidation",
      dedupeKey: request.dedupeKey,
      evidenceRef: "coding-evidence:evolve-coding-rate-limit",
      now: 1_100,
    });
    assert.deepEqual(stop, { stopped: true, nextRetryAt: 2_000 });
    assert.deepEqual(await handoffOrAcquirePersistentExecution(ns, { ...request, now: 1_500, leaseExpiresAt: 2_500 }), { acquired: false, reason: "WAITING_RATE_LIMIT", nextRetryAt: 2_000 });
    assert.deepEqual(await handoffOrAcquirePersistentExecution(ns, { ...request, now: 2_000, leaseExpiresAt: 3_000 }), { acquired: true });
    const record = await readPersistentExecution(ns, request.dedupeKey);
    assert.equal(record?.state, "LEASED");
    assert.equal(record?.executionId, request.executionId);
    assert.equal(record?.stop?.nextRetryAt, 2_000);
    assert.equal(record?.resumeCount, 1);
  });

  it("does not release an already dispatched execution", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: () => ({}),
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) }),
    };
    const request = { dedupeKey: "ci:dispatched:abc", executionId: "github:dispatched-1", now: 100, leaseExpiresAt: 1_000 };

    assert.deepEqual(await acquirePersistentExecution(namespace, request), { acquired: true });
    const marked = await coordinator.fetch(new Request("https://execution-coordinator/dispatched", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dedupeKey: request.dedupeKey, executionId: request.executionId, now: 150 }),
    }));
    assert.equal(marked.status, 200);
    await assert.rejects(
      releasePersistentExecution(namespace, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 200 }),
      /PERSISTENT_EXECUTION_RELEASE_FAILED/,
    );
  });

  it("waits for Audit dispatch materialization and preserves the one recovery budget across a released retry", async () => {
    const ns = memoryNamespace();
    const request = { dedupeKey: "audit:materialization:abc", executionId: "audit:materialization", now: 100, leaseExpiresAt: 1_000 };
    assert.deepEqual(await acquirePersistentExecution(ns, request), { acquired: true });
    await markPersistentExecutionDispatched(ns, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 200 });
    assert.deepEqual(await recoverPersistentAuditDispatch(ns, { ...request, now: 200 + AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS - 1, leaseExpiresAt: 40_000 }), { recovered: false, reason: "AUDIT_DISPATCH_MATERIALIZATION_PENDING" });
    assert.deepEqual(await recoverPersistentAuditDispatch(ns, { ...request, now: 200 + AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS, leaseExpiresAt: 40_000 }), { recovered: true });
    await releasePersistentExecution(ns, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 30_201 });
    assert.deepEqual(await acquirePersistentExecution(ns, { ...request, now: 30_202, leaseExpiresAt: 40_000 }), { acquired: true });
    await markPersistentExecutionDispatched(ns, { dedupeKey: request.dedupeKey, executionId: request.executionId, now: 30_203 });
    assert.deepEqual(await recoverPersistentAuditDispatch(ns, { ...request, now: 30_203 + AUDIT_DISPATCH_MATERIALIZATION_GRACE_MS, leaseExpiresAt: 70_000 }), { recovered: false, reason: "AUDIT_DISPATCH_RECOVERY_EXHAUSTED" });
  });

  it("persists, replays, orders, and deduplicates coding evidence without mutation", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const first = codingEvidence(100);
    const second = codingEvidence(200);
    const post = (evidence: unknown) => coordinator.fetch(new Request("https://execution-coordinator/coding-evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidence }),
    }));

    assert.equal((await post(first)).status, 200);
    assert.equal((await post(first)).status, 200);
    const replayWithFreshTimestamp = codingEvidence(101, 100);
    const replayResponse = await post(replayWithFreshTimestamp);
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json() as { evidence: { evidenceId: string } }).evidence.evidenceId, first.evidenceId);
    assert.equal((await post(second)).status, 200);
    const response = await coordinator.fetch(new Request("https://execution-coordinator/coding-evidence-history"));
    assert.equal(response.status, 200);
    const body = await response.json() as { history: readonly { evidenceId: string; recordedAtMs: number }[]; liveAuthority: string; productionMutationAllowed: boolean; aiAuthority: string };
    assert.equal(body.history.length, 2);
    assert.deepEqual(body.history.map((entry) => entry.recordedAtMs), [100, 200]);
    assert.equal(body.liveAuthority, "NONE");
    assert.equal(body.productionMutationAllowed, false);
    assert.equal(body.aiAuthority, "ZERO_AUTHORITY");

    const restored = new ExecutionCoordinator({ storage });
    const replay = await restored.fetch(new Request("https://execution-coordinator/coding-evidence-history"));
    const replayBody = await replay.json() as { history: readonly { evidenceId: string }[] };
    assert.equal(replayBody.history.length, 2);
    assert.deepEqual(replayBody.history.map((entry) => entry.evidenceId), body.history.map((entry) => entry.evidenceId));
  });

  it("fails closed on malformed persisted coding evidence and enforces bounded retention", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    await storage.put("coding-execution-evidence-v1", { schemaVersion: 1, evidence: [{ secret: "must-not-replay" }] });
    const corrupted = await coordinator.fetch(new Request("https://execution-coordinator/coding-evidence-history"));
    assert.equal(corrupted.status, 500);
    assert.doesNotMatch(await corrupted.text(), /must-not-replay/);

    const cleanStorage = new MemoryStorage();
    const bounded = new ExecutionCoordinator({ storage: cleanStorage });
    for (let index = 0; index < 33; index += 1) {
      assert.equal((await bounded.fetch(new Request("https://execution-coordinator/coding-evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidence: codingEvidence(index + 1_000) }),
      }))).status, 200);
    }
    const response = await bounded.fetch(new Request("https://execution-coordinator/coding-evidence-history"));
    const body = await response.json() as { history: readonly { recordedAtMs: number }[] };
    assert.equal(body.history.length, 32);
    assert.equal(body.history[0]?.recordedAtMs, 1_001);
    assert.equal(body.history.at(-1)?.recordedAtMs, 1_032);
  });
});


describe("persistent control-plane HOLD", () => {
  function namespace(): { namespace: ExecutionCoordinatorNamespace; storageByName: Map<string, MemoryStorage> } {
    const storageByName = new Map<string, MemoryStorage>();
    const coordinatorByName = new Map<string, ExecutionCoordinator>();
    const ns: ExecutionCoordinatorNamespace = {
      idFromName: (name) => ({ name }),
      get: (id) => {
        const name = String((id as { name?: unknown }).name ?? "");
        let coordinator = coordinatorByName.get(name);
        if (!coordinator) {
          const storage = new MemoryStorage();
          storageByName.set(name, storage);
          coordinator = new ExecutionCoordinator({ storage });
          coordinatorByName.set(name, coordinator);
        }
        return { fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator!.fetch(new Request(input, init)) };
      },
    };
    return { namespace: ns, storageByName };
  }

  const identity = Object.freeze({ repository: "cinamoncandy/NUSA", prNumber: 1854, headSha: "a".repeat(40), baseSha: "b".repeat(40) });
  const hold = Object.freeze({ holdId: "hold-1854-a", prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha, reason: "GLOBAL_RELEASE_FREEZE" as const, source: "core:#1803/#1861" });

  it("persists and rehydrates an exact PR/head/base-bound HOLD", async () => {
    const { namespace: ns } = namespace();
    const applied = await applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 100 });
    assert.equal(applied.state, "ACTIVE");
    assert.deepEqual((await readPersistentControlPlaneHold(ns, identity))?.hold, hold);
    const replay = await applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 101 });
    assert.equal(replay.state, "ACTIVE");
  });

  it("treats a replayed delivery as idempotent regardless of SHA case", async () => {
    // index.ts states that duplicate and replayed deliveries are idempotent. A stored hold always
    // carries lower-cased SHAs, so comparing a replay against the raw request made that property
    // depend on the case GitHub happened to send.
    const { namespace: ns } = namespace();
    await applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 100 });
    const upper = {
      ...identity,
      headSha: identity.headSha.toUpperCase(),
      baseSha: identity.baseSha.toUpperCase(),
      hold: { ...hold, headSha: hold.headSha.toUpperCase(), baseSha: hold.baseSha.toUpperCase() },
      now: 101,
    };
    const replay = await applyPersistentControlPlaneHold(ns, upper);
    assert.equal(replay.state, "ACTIVE");
    // The stored record is untouched, and still the normalised one.
    assert.deepEqual((await readPersistentControlPlaneHold(ns, identity))?.hold, hold);
    assert.equal((await readPersistentControlPlaneHold(ns, identity))?.updatedAt, 100);
  });

  it("a genuinely different HOLD for the same identity is still a conflict", async () => {
    // Normalising the comparison must not make two different holds look like a replay.
    const { namespace: ns } = namespace();
    await applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 100 });
    await assert.rejects(
      () => applyPersistentControlPlaneHold(ns, { ...identity, hold: { ...hold, holdId: "hold-1854-b" }, now: 101 }),
      /CONTROL_PLANE_HOLD_APPLY_BLOCKED/,
    );
  });

  it("rejects conflicting/replayed HOLD mutation after explicit clearance", async () => {
    const { namespace: ns } = namespace();
    await applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 100 });
    const cleared = await clearPersistentControlPlaneHold(ns, {
      ...identity,
      clearance: { holdId: hold.holdId, prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha, clearedBy: "core", globalReleaseFreeze: false, blockedHuman: false, reworkRequired: false },
      now: 200,
    });
    assert.equal(cleared.state, "CLEARED");
    await assert.rejects(() => applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 201 }), /HOLD_APPLY_BLOCKED/);
  });

  it("fails closed on stale clearance and active global/human/rework blockers", async () => {
    const { namespace: ns } = namespace();
    await applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 100 });
    const base = { holdId: hold.holdId, prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha, clearedBy: "core", globalReleaseFreeze: false, blockedHuman: false, reworkRequired: false };
    await assert.rejects(() => clearPersistentControlPlaneHold(ns, { ...identity, clearance: { ...base, holdId: "stale" }, now: 200 }), /HOLD_CLEAR_FAILED/);
    await assert.rejects(() => clearPersistentControlPlaneHold(ns, { ...identity, clearance: { ...base, globalReleaseFreeze: true }, now: 201 }), /HOLD_CLEAR_FAILED/);
    await assert.rejects(() => clearPersistentControlPlaneHold(ns, { ...identity, clearance: { ...base, blockedHuman: true }, now: 202 }), /HOLD_CLEAR_FAILED/);
    await assert.rejects(() => clearPersistentControlPlaneHold(ns, { ...identity, clearance: { ...base, reworkRequired: true }, now: 203 }), /HOLD_CLEAR_FAILED/);
  });

  it("isolates a new exact head from stale-head clear attempts", async () => {
    const { namespace: ns } = namespace();
    await applyPersistentControlPlaneHold(ns, { ...identity, hold, now: 100 });
    const next = { ...identity, headSha: "c".repeat(40) };
    assert.equal(await readPersistentControlPlaneHold(ns, next), null);
    await assert.rejects(() => clearPersistentControlPlaneHold(ns, {
      ...next,
      clearance: { holdId: hold.holdId, prNumber: next.prNumber, headSha: next.headSha, baseSha: next.baseSha, clearedBy: "core", globalReleaseFreeze: false, blockedHuman: false, reworkRequired: false },
      now: 200,
    }), /HOLD_CLEAR_FAILED/);
    assert.equal((await readPersistentControlPlaneHold(ns, identity))?.state, "ACTIVE");
  });

  it("dispatched execution completes once and permanently suppresses the same dedupe identity", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const request = (pathname: string, body: object) => new Request(`https://execution-coordinator${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const identity = { dedupeKey: "coding:complete", executionId: "exec-complete", now: 100, leaseExpiresAt: 200 };
    assert.equal((await coordinator.fetch(request("/acquire", identity))).status, 201);
    assert.equal((await coordinator.fetch(request("/handoff-or-acquire", { dedupeKey: identity.dedupeKey, executionId: identity.executionId, now: 105, leaseExpiresAt: 200 }))).status, 201);
    assert.equal((await coordinator.fetch(request("/dispatched", { dedupeKey: identity.dedupeKey, executionId: identity.executionId, now: 110 }))).status, 200);
    assert.equal((await coordinator.fetch(request("/complete", { dedupeKey: identity.dedupeKey, executionId: identity.executionId, now: 120 }))).status, 200);
    const replay = await coordinator.fetch(request("/complete", { dedupeKey: identity.dedupeKey, executionId: identity.executionId, now: 130 }));
    assert.equal((await replay.json() as { completed: boolean }).completed, false);
    const duplicate = await coordinator.fetch(request("/acquire", { ...identity, executionId: "exec-redelivery", now: 140, leaseExpiresAt: 240 }));
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { reason: string }).reason, "ALREADY_COMPLETED");
    const handoffDuplicate = await coordinator.fetch(request("/handoff-or-acquire", { ...identity, executionId: "exec-redelivery", now: 150, leaseExpiresAt: 250 }));
    assert.equal(handoffDuplicate.status, 409);
    assert.equal((await handoffDuplicate.json() as { reason: string }).reason, "ALREADY_COMPLETED");
  });

  it("completion fails closed before dispatch or for stale identity", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const request = (pathname: string, body: object) => new Request(`https://execution-coordinator${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const identity = { dedupeKey: "coding:guard", executionId: "exec-guard", now: 100, leaseExpiresAt: 200 };
    assert.equal((await coordinator.fetch(request("/acquire", identity))).status, 201);
    assert.equal((await coordinator.fetch(request("/complete", { dedupeKey: identity.dedupeKey, executionId: identity.executionId, now: 110 }))).status, 409);
    assert.equal((await coordinator.fetch(request("/handoff-or-acquire", { dedupeKey: identity.dedupeKey, executionId: identity.executionId, now: 115, leaseExpiresAt: 200 }))).status, 201);
    assert.equal((await coordinator.fetch(request("/dispatched", { dedupeKey: identity.dedupeKey, executionId: identity.executionId, now: 120 }))).status, 200);
    assert.equal((await coordinator.fetch(request("/complete", { dedupeKey: identity.dedupeKey, executionId: "stale-exec", now: 130 }))).status, 409);
  });
  it("releases an active-WIP claim that outlived any possible running work so backlog coding is not blocked forever", async () => {
    const coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
    const admit = async (dedupeKey: string, claimedAt: number) => {
      const response = await coordinator.fetch(new Request("https://execution-coordinator/active-wip/admit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dedupeKey, executionId: `exec:${dedupeKey}`, canonicalOwner: "apps/autopilot", conflictKeys: [`key:${dedupeKey}`], claimedAt, maxConcurrent: 1 }),
      }));
      return { status: response.status, body: await response.json() as { admitted: boolean; reason?: string; expiredClaims?: { dedupeKey: string }[] } };
    };
    const start = 1_000_000;
    // A failed dispatch never completes its claim.
    assert.equal((await admit("issue-1", start)).status, 201);
    const blocked = await admit("issue-2", start + ACTIVE_WIP_CLAIM_MAX_AGE_MS - 1);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.reason, "WIP_LIMIT_REACHED");
    const resumed = await admit("issue-2", start + ACTIVE_WIP_CLAIM_MAX_AGE_MS);
    assert.equal(resumed.status, 201);
    assert.deepEqual(resumed.body.expiredClaims?.map((claim) => claim.dedupeKey), ["issue-1"]);
    // The released item may be claimed again later; a fresh claim still holds the slot.
    assert.equal((await admit("issue-1", start + ACTIVE_WIP_CLAIM_MAX_AGE_MS + 1)).body.reason, "WIP_LIMIT_REACHED");
  });

  it("atomically admits independent WIP while rejecting conflict and capacity overflow", async () => {
    const storage = new TransactionalRacyStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const post = (body: object) => coordinator.fetch(new Request("https://execution-coordinator/active-wip/admit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const base = { canonicalOwner: "evolve", claimedAt: 100, maxConcurrent: 2 };
    const [a, b] = await Promise.all([
      post({ ...base, dedupeKey: "work:a", executionId: "exec:a", conflictKeys: ["module:a"] }),
      post({ ...base, dedupeKey: "work:b", executionId: "exec:b", conflictKeys: ["module:b"] }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 201]);
    const full = await post({ ...base, dedupeKey: "work:c", executionId: "exec:c", conflictKeys: ["module:c"] });
    assert.equal(full.status, 409);
    assert.equal((await full.json() as { reason: string }).reason, "WIP_LIMIT_REACHED");
  });

  it("keeps legacy three-claim WIP state readable while enforcing the new two-claim admission cap", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const now = 2_000_000;
    await storage.put("evolve-active-wip-v1", {
      schemaVersion: 1,
      claims: ["one", "two", "three"].map((key) => ({
        dedupeKey: `work:${key}`,
        executionId: `exec:${key}`,
        canonicalOwner: "evolve",
        conflictKeys: [`module:${key}`],
        claimedAt: now,
      })),
    });
    const admit = (claimedAt: number, dedupeKey: string) => coordinator.fetch(new Request("https://execution-coordinator/active-wip/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dedupeKey, executionId: `exec:${dedupeKey}`, canonicalOwner: "evolve", conflictKeys: [`module:${dedupeKey}`], claimedAt, maxConcurrent: 2 }),
    }));

    const blocked = await admit(now + 1, "work:four");
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { reason?: string }).reason, "WIP_LIMIT_REACHED");
    const active = await coordinator.fetch(new Request("https://execution-coordinator/active-wip"));
    assert.equal(active.status, 200);
    assert.equal((await active.json() as { activeExecutions?: number }).activeExecutions, 3);

    const afterExpiry = now + ACTIVE_WIP_CLAIM_MAX_AGE_MS + 1;
    const resumed = await admit(afterExpiry, "work:four");
    assert.equal(resumed.status, 201, "stale legacy claims expire before the new capacity check");
    assert.equal((await resumed.json() as { claims?: unknown[] }).claims?.length, 1);
  });

  it("rejects overlapping conflict keys and releases capacity only for exact identity", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const post = (path: string, body: object) => coordinator.fetch(new Request(`https://execution-coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const first = { dedupeKey: "work:a", executionId: "exec:a", canonicalOwner: "evolve", conflictKeys: ["module:shared"], claimedAt: 100, maxConcurrent: 2 };
    assert.equal((await post("/active-wip/admit", first)).status, 201);
    const duplicateExecution = await post("/active-wip/admit", { ...first, dedupeKey: "work:duplicate-exec", conflictKeys: ["module:other"] });
    assert.equal(duplicateExecution.status, 409);
    assert.equal((await duplicateExecution.json() as { reason: string }).reason, "EXECUTION_ID_CONFLICT");
    const conflict = await post("/active-wip/admit", { ...first, dedupeKey: "work:b", executionId: "exec:b" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { reason: string }).reason, "CONFLICT_KEY_ACTIVE");
    assert.equal((await post("/active-wip/complete", { dedupeKey: first.dedupeKey, executionId: "stale", workerId: "cloud-coding-runner", startedAt: 110, completedAt: 120 })).status, 409);
    assert.equal((await post("/active-wip/complete", { dedupeKey: first.dedupeKey, executionId: first.executionId, workerId: "cloud-coding-runner", startedAt: 110, completedAt: 120 })).status, 200);
    assert.equal((await post("/active-wip/admit", { ...first, dedupeKey: "work:b", executionId: "exec:b" })).status, 201);
  });

  it("persists measured active-WIP completion timing and replays it after claim release", async () => {
    const storage = new MemoryStorage();
    const coordinator = new ExecutionCoordinator({ storage });
    const post = (path: string, body: object) => coordinator.fetch(new Request(`https://execution-coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const claim = { dedupeKey: "work:measured", executionId: "exec:measured", canonicalOwner: "evolve", conflictKeys: ["module:measured"], claimedAt: 100, maxConcurrent: 1 };
    assert.equal((await post("/active-wip/admit", claim)).status, 201);
    assert.equal((await post("/active-wip/complete", { dedupeKey: claim.dedupeKey, executionId: claim.executionId, workerId: "cloud-coding-runner", startedAt: 125, completedAt: 175 })).status, 200);
    const replay = await coordinator.fetch(new Request("https://execution-coordinator/active-wip/completions"));
    assert.equal(replay.status, 200);
    const body = await replay.json() as { completions: readonly { executionId: string; claimedAt: number; startedAt: number; completedAt: number; claimToStartMs: number; claimToCompleteMs: number; totalMs: number }[] };
    assert.deepEqual(body.completions, [{
      dedupeKey: claim.dedupeKey, executionId: claim.executionId, canonicalOwner: claim.canonicalOwner, conflictKeys: claim.conflictKeys,
      workerId: "cloud-coding-runner", queuedAt: 100, claimedAt: 100, startedAt: 125, completedAt: 175,
      queueWaitMs: 0, claimToStartMs: 25, claimToCompleteMs: 75, totalMs: 75,
    }]);
    assert.equal((await coordinator.fetch(new Request("https://execution-coordinator/active-wip"))).status, 200);
  });

  it("fails closed on stale identity or impossible active-WIP completion timing", async () => {
    const coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
    const post = (path: string, body: object) => coordinator.fetch(new Request(`https://execution-coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const claim = { dedupeKey: "work:timing", executionId: "exec:timing", canonicalOwner: "evolve", conflictKeys: ["module:timing"], claimedAt: 100, maxConcurrent: 1 };
    assert.equal((await post("/active-wip/admit", claim)).status, 201);
    assert.equal((await post("/active-wip/complete", { dedupeKey: claim.dedupeKey, executionId: "stale", workerId: "cloud-coding-runner", startedAt: 125, completedAt: 175 })).status, 409);
    assert.equal((await post("/active-wip/complete", { dedupeKey: claim.dedupeKey, executionId: claim.executionId, workerId: "cloud-coding-runner", startedAt: 99, completedAt: 175 })).status, 409);
  });

  it("fails closed on malformed WIP ownership and conflict metadata", async () => {
    const coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
    const post = (body: object) => coordinator.fetch(new Request("https://execution-coordinator/active-wip/admit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const base = { dedupeKey: "work:a", executionId: "exec:a", canonicalOwner: "evolve", conflictKeys: ["module:a"], claimedAt: 100, maxConcurrent: 2 };
    assert.equal((await post({ ...base, canonicalOwner: "bad owner" })).status, 400);
    assert.equal((await post({ ...base, conflictKeys: [] })).status, 400);
    assert.equal((await post({ ...base, conflictKeys: ["module:a", "module:a"] })).status, 400);
    assert.equal((await post({ ...base, maxConcurrent: 3 })).status, 400, "FORGE L1 rejects a caller requesting more than two WIP slots");
    assert.equal((await post({ ...base, maxConcurrent: 9 })).status, 400);
  });

});

// idFromName-aware namespace: the production helpers isolate state per Durable Object id, so a
// stub that collapses every id into one coordinator cannot express provider/day isolation at all.
function keyedMemoryNamespace(): ExecutionCoordinatorNamespace {
  const coordinators = new Map<string, ExecutionCoordinator>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const key = String(id);
      let coordinator = coordinators.get(key);
      if (!coordinator) {
        coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
        coordinators.set(key, coordinator);
      }
      const bound = coordinator;
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => bound.fetch(new Request(input, init)) };
    },
  };
  return namespace as unknown as ExecutionCoordinatorNamespace;
}

describe("paid overflow daily cap", () => {
  it("reserves atomically up to the cap and refuses beyond it", async () => {
    const ns = memoryNamespace();
    const input = { provider: "github-models", day: "2026-10-12", cap: 2 };
    assert.equal(await reservePaidOverflowCall(ns, input), true);
    assert.equal(await reservePaidOverflowCall(ns, input), true);
    assert.equal(await reservePaidOverflowCall(ns, input), false, "the cap must not be exceeded");
    assert.equal(await reservePaidOverflowCall(ns, input), false, "a refusal must not consume budget either");
  });

  it("gives each UTC day and each provider its own budget", async () => {
    const ns = keyedMemoryNamespace();
    assert.equal(await reservePaidOverflowCall(ns, { provider: "github-models", day: "2026-10-12", cap: 1 }), true);
    assert.equal(await reservePaidOverflowCall(ns, { provider: "github-models", day: "2026-10-12", cap: 1 }), false);
    // A new day resets the count without any cleanup step.
    assert.equal(await reservePaidOverflowCall(ns, { provider: "github-models", day: "2026-10-13", cap: 1 }), true);
    // Same day, different provider: an exhausted budget must not spill across providers. This only
    // means anything against an idFromName-aware namespace.
    assert.equal(await reservePaidOverflowCall(ns, { provider: "configured-coding-engine", day: "2026-10-12", cap: 1 }), true);
    assert.equal(await reservePaidOverflowCall(ns, { provider: "configured-coding-engine", day: "2026-10-12", cap: 1 }), false);
    // ...and the first provider is still exhausted for its own day.
    assert.equal(await reservePaidOverflowCall(ns, { provider: "github-models", day: "2026-10-12", cap: 1 }), false);
  });

  it("refuses concurrent reservations past the cap instead of letting both spend", async () => {
    const ns = memoryNamespace();
    const input = { provider: "github-models", day: "2026-10-12", cap: 3 };
    const granted = (await Promise.all(Array.from({ length: 8 }, () => reservePaidOverflowCall(ns, input)))).filter(Boolean);
    assert.equal(granted.length, 3, "exactly the cap may be granted across concurrent callers");
  });

  it("rejects a malformed cap or day rather than granting spend", async () => {
    const ns = memoryNamespace();
    for (const bad of [
      { provider: "github-models", day: "12-10-2026", cap: 1 },
      { provider: "github-models", day: "2026-10-12", cap: -1 },
      { provider: "github-models", day: "2026-10-12", cap: 1.5 },
    ]) {
      await assert.rejects(() => reservePaidOverflowCall(ns, bad), /PAID_OVERFLOW_RESERVE_FAILED/);
    }
  });

  it("derives the UTC day key the cap and the provider stop share", () => {
    assert.equal(utcDayKey(Date.UTC(2026, 9, 12, 23, 59, 59)), "2026-10-12");
    assert.equal(utcDayKey(Date.UTC(2026, 9, 13, 0, 0, 0)), "2026-10-13");
  });
});

describe("provider capacity wait", () => {
  function namedNamespace(): { namespace: ExecutionCoordinatorNamespace; names: string[] } {
    const coordinators = new Map<string, ExecutionCoordinator>();
    const names: string[] = [];
    const namespace: ExecutionCoordinatorNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (id: unknown) => {
        const name = (id as { name: string }).name;
        names.push(name);
        if (!coordinators.has(name)) coordinators.set(name, new ExecutionCoordinator({ storage: new MemoryStorage() }));
        const coordinator = coordinators.get(name)!;
        return { fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) };
      },
    };
    return { namespace, names };
  }

  const stop = (mainSha: string, nextRetryAt: number) => ({
    schemaVersion: 1 as const,
    taskId: "autopilot:github-issue-2118",
    executionId: `evolve-coding:${mainSha.slice(0, 16)}:github-issue-2118`,
    provider: "workers-ai",
    headSha: mainSha,
    stopReason: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED",
    stoppedAt: 1_000,
    attemptCount: 1,
    lastFailure: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED",
    nextRetryAt,
    resumeCondition: "provider-capacity-and-exact-head-revalidation",
    dedupeKey: `evolve-coding:${mainSha}:github-issue-2118`,
    evidenceRef: "coding-evidence:2118",
  });

  it("is keyed by provider, so a wait recorded on one main is read back on another", async () => {
    const { namespace, names } = namedNamespace();
    assert.equal(await readProviderCapacityWait(namespace, "workers-ai"), null);
    await recordProviderCapacityWait(namespace, stop("a".repeat(40), 5_000));
    const wait = await readProviderCapacityWait(namespace, "workers-ai");
    assert.equal(wait?.nextRetryAt, 5_000);
    assert.equal(wait?.headSha, "a".repeat(40), "the provenance of the stopped execution is kept");
    assert.deepEqual([...new Set(names)], ["provider-capacity-wait:workers-ai"], "never keyed by a main-specific dedupe key");
    assert.equal(await readProviderCapacityWait(namespace, "other-provider"), null, "providers do not share a wait");
  });

  it("never lets a late or replayed stop shorten a longer wait", async () => {
    const { namespace } = namedNamespace();
    await recordProviderCapacityWait(namespace, stop("a".repeat(40), 9_000));
    const kept = await recordProviderCapacityWait(namespace, stop("b".repeat(40), 4_000));
    assert.equal(kept.nextRetryAt, 9_000);
    assert.equal((await readProviderCapacityWait(namespace, "workers-ai"))?.nextRetryAt, 9_000);
    await recordProviderCapacityWait(namespace, stop("c".repeat(40), 12_000));
    assert.equal((await readProviderCapacityWait(namespace, "workers-ai"))?.nextRetryAt, 12_000);
  });

  it("rejects a malformed wait instead of storing it", async () => {
    const { namespace } = namedNamespace();
    await assert.rejects(recordProviderCapacityWait(namespace, { ...stop("a".repeat(40), 5_000), headSha: "not-a-sha" }), /PROVIDER_CAPACITY_WAIT_RECORD_FAILED/);
    assert.equal(await readProviderCapacityWait(namespace, "workers-ai"), null);
  });
});
