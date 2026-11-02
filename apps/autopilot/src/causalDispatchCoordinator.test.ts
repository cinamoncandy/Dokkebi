import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionCoordinator } from "./executionCoordinator";
import type { SourceExecutionIdentity, VerifiedCodingPublisherIdentity } from "./githubActionsOidc";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

class TransactionalStorage extends MemoryStorage {
  private queue: Promise<void> = Promise.resolve();
  async transaction<T>(operation: (storage: TransactionalStorage) => Promise<T>): Promise<T> {
    const prior = this.queue;
    let unlock: (() => void) | undefined;
    this.queue = new Promise<void>((resolve) => { unlock = resolve; });
    await prior;
    try { return await operation(this); } finally { unlock?.(); }
  }
}

const repository = "cinamoncandy/NUSA";
const source: SourceExecutionIdentity = { repository, workflowPath: ".github/workflows/ci.yml", sha: "a".repeat(40), runId: "456", runAttempt: "1" };
const publisher: VerifiedCodingPublisherIdentity = { repository, workflowRef: `${repository}/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main`, ref: "refs/heads/main", sha: source.sha, runId: "789", runAttempt: "1", event: "repository_dispatch" };
const digest = "a".repeat(64);

function fixture() {
  const coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
  const post = (path: string, body: unknown) => coordinator.fetch(new Request(`https://coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const execution = { dedupeKey: "causal:456", executionId: "exec:456", headSha: source.sha, now: 100, leaseExpiresAt: 200 };
  const registration = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, capabilityDigest: digest, now: 110, expiresAt: 190 };
  const claim = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, publisher, capabilityDigest: digest, now: 120 };
  return { post, execution, registration, claim };
}

test("atomically binds only one publisher run to a registered source", async () => {
  const { post, execution, registration, claim } = fixture();
  assert.equal((await post("/acquire", execution)).status, 201);
  assert.equal((await post("/causal-dispatch/register", registration)).status, 201);
  const wrong = await post("/causal-dispatch/claim", { ...claim, source: { ...source, runId: "457" } });
  assert.equal(wrong.status, 409);
  assert.equal((await post("/causal-dispatch/verify", claim)).status, 409);
  const responses = await Promise.all([
    post("/causal-dispatch/claim", claim),
    post("/causal-dispatch/claim", { ...claim, publisher: { ...publisher, runId: "790" } }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await post("/causal-dispatch/verify", claim)).status, responses[0].status === 201 ? 200 : 409);
  assert.equal((await post("/causal-dispatch/verify", { ...claim, publisher: { ...publisher, runId: "790" } })).status, responses[1].status === 201 ? 200 : 409);
  assert.equal((await post("/causal-dispatch/claim", claim)).status, 409);
  assert.equal((await post("/causal-dispatch/register", registration)).status, 409);
});

test("rejects absent lease, incorrect execution, capability, and expired binding", async () => {
  const { post, execution, registration, claim } = fixture();
  assert.equal((await post("/causal-dispatch/register", registration)).status, 409);
  assert.equal((await post("/acquire", execution)).status, 201);
  assert.equal((await post("/causal-dispatch/register", { ...registration, source: { ...source, sha: "b".repeat(40) } })).status, 409);
  assert.equal((await post("/causal-dispatch/register", { ...registration, expiresAt: 201 })).status, 409);
  assert.equal((await post("/causal-dispatch/register", registration)).status, 201);
  assert.equal((await post("/causal-dispatch/claim", { ...claim, capabilityDigest: "b".repeat(64) })).status, 409);
  assert.equal((await post("/causal-dispatch/claim", { ...claim, executionId: "exec:other" })).status, 409);
  assert.equal((await post("/causal-dispatch/claim", { ...claim, now: 190 })).status, 409);
  assert.equal((await post("/causal-dispatch/claim", claim)).status, 201);
});

test("claimed publisher and source survive coordinator restart without permitting another run or attempt", async () => {
  const storage = new MemoryStorage();
  const first = new ExecutionCoordinator({ storage });
  const second = new ExecutionCoordinator({ storage });
  const post = (coordinator: ExecutionCoordinator, path: string, body: unknown) => coordinator.fetch(new Request(`https://coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const execution = { dedupeKey: "causal:456", executionId: "exec:456", headSha: source.sha, now: 100, leaseExpiresAt: 200 };
  const registration = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, capabilityDigest: digest, now: 110, expiresAt: 190 };
  const claim = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, publisher, capabilityDigest: digest, now: 120 };
  assert.equal((await post(first, "/acquire", execution)).status, 201);
  assert.equal((await post(first, "/causal-dispatch/register", registration)).status, 201);
  assert.equal((await post(first, "/causal-dispatch/claim", claim)).status, 201);
  assert.equal((await post(second, "/causal-dispatch/verify", claim)).status, 200);
  assert.equal((await post(second, "/causal-dispatch/verify", { ...claim, publisher: { ...publisher, runAttempt: "2" } })).status, 409);
  assert.equal((await post(second, "/causal-dispatch/claim", claim)).status, 409);
});

test("bounded retry rotates an unclaimed capability without reviving its earlier generation", async () => {
  const storage = new MemoryStorage();
  const coordinator = new ExecutionCoordinator({ storage });
  const post = (path: string, body: unknown) => coordinator.fetch(new Request(`https://coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const execution = { dedupeKey: "causal:456", executionId: "exec:456", headSha: source.sha, now: 100, leaseExpiresAt: 200, maxAcquisitions: 3 };
  const registration = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, capabilityDigest: digest, now: 110, expiresAt: 190 };
  assert.equal((await post("/acquire", execution)).status, 201);
  assert.equal((await post("/causal-dispatch/register", registration)).status, 201);
  assert.equal((await post("/release", { dedupeKey: execution.dedupeKey, executionId: execution.executionId, now: 130 })).status, 200);
  assert.equal((await post("/acquire", { ...execution, now: 140, leaseExpiresAt: 240 })).status, 201);
  assert.equal((await post("/causal-dispatch/register", { ...registration, capabilityDigest: "b".repeat(64), now: 145, expiresAt: 230 })).status, 201);
  const claim = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, publisher, now: 150 };
  assert.equal((await post("/causal-dispatch/claim", { ...claim, capabilityDigest: digest })).status, 409);
  assert.equal((await post("/causal-dispatch/claim", { ...claim, capabilityDigest: "b".repeat(64) })).status, 201);
  const history = await storage.get<{ entries: readonly unknown[] }>("causal-dispatch-bindings");
  assert.equal(history?.entries.length, 2);
});

test("transactional storage permits only one claim across coordinator instances", async () => {
  const storage = new TransactionalStorage();
  const first = new ExecutionCoordinator({ storage });
  const second = new ExecutionCoordinator({ storage });
  const post = (coordinator: ExecutionCoordinator, path: string, body: unknown) => coordinator.fetch(new Request(`https://coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const execution = { dedupeKey: "causal:456", executionId: "exec:456", headSha: source.sha, now: 100, leaseExpiresAt: 200 };
  const registration = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, capabilityDigest: digest, now: 110, expiresAt: 190 };
  const claim = { dedupeKey: execution.dedupeKey, executionId: execution.executionId, source, publisher, capabilityDigest: digest, now: 120 };
  assert.equal((await post(first, "/acquire", execution)).status, 201);
  assert.equal((await post(first, "/causal-dispatch/register", registration)).status, 201);
  const results = await Promise.all([post(first, "/causal-dispatch/claim", claim), post(second, "/causal-dispatch/claim", { ...claim, publisher: { ...publisher, runId: "790" } })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
});

test("a claimed generation is not silently replaced by a retry", async () => {
  const { post, execution, registration, claim } = fixture();
  assert.equal((await post("/acquire", execution)).status, 201);
  assert.equal((await post("/causal-dispatch/register", registration)).status, 201);
  assert.equal((await post("/causal-dispatch/claim", claim)).status, 201);
  assert.equal((await post("/release", { dedupeKey: execution.dedupeKey, executionId: execution.executionId, now: 130 })).status, 200);
  assert.equal((await post("/acquire", { ...execution, now: 140, leaseExpiresAt: 240 })).status, 201);
  assert.equal((await post("/causal-dispatch/register", { ...registration, capabilityDigest: "b".repeat(64), now: 145, expiresAt: 230 })).status, 409);
});
