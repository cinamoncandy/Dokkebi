import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionCoordinator, admitActiveWip, completeActiveWip, readActiveWip, readActiveWipCompletions, type ExecutionCoordinatorNamespace } from "./executionCoordinator";
import { handleCodingWipRelease, type WorkerEnv } from "./worker";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

function namespace(): ExecutionCoordinatorNamespace {
  const coordinators = new Map<string, ExecutionCoordinator>();
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: unknown) => {
      const name = (id as { name: string }).name;
      let coordinator = coordinators.get(name);
      if (!coordinator) {
        coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
        coordinators.set(name, coordinator);
      }
      const target = coordinator;
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => target.fetch(new Request(input, init)) };
    },
  };
}

const claim = { dedupeKey: "evolve-coding:abc:github-issue-2118", executionId: "evolve-coding:abc", canonicalOwner: "apps/autopilot", conflictKeys: ["apps/autopilot/src/concurrencyAdvisor.ts"], claimedAt: 1_000, maxConcurrent: 1 };
const RUNNER_CREDENTIAL = "coding-token";
const env = (ns: ExecutionCoordinatorNamespace) => ({ NUSA_GITHUB_REPOSITORY: "cinamoncandy/NUSA", NUSA_CODING_RUNNER_TOKEN: RUNNER_CREDENTIAL, NUSA_EXECUTION_COORDINATOR: ns }) as unknown as WorkerEnv;
const post = (body: unknown, bearer = RUNNER_CREDENTIAL) => new Request("https://worker/coding/wip-release", {
  method: "POST",
  headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("a finished coding attempt frees the single WIP slot at once so the next item is admitted", async () => {
  const ns = namespace();
  assert.equal((await admitActiveWip(ns, claim)).admitted, true);
  const next = { ...claim, dedupeKey: "evolve-coding:abc:github-issue-1605", executionId: "evolve-coding:def", conflictKeys: ["apps/autopilot/src/other.ts"], claimedAt: 2_000 };
  assert.equal((await admitActiveWip(ns, next)).reason, "WIP_LIMIT_REACHED");

  const response = await handleCodingWipRelease(post({ dedupeKey: claim.dedupeKey, executionId: claim.executionId }), env(ns));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { released: boolean }).released, true);
  assert.equal((await readActiveWip(ns)).claims.length, 0);
  assert.equal((await admitActiveWip(ns, next)).admitted, true);

  // Idempotent, and never frees a claim held by another execution.
  const again = await handleCodingWipRelease(post({ dedupeKey: claim.dedupeKey, executionId: claim.executionId }), env(ns));
  assert.deepEqual(await again.json(), { released: false, reason: "CLAIM_NOT_FOUND", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });
  const foreign = await handleCodingWipRelease(post({ dedupeKey: next.dedupeKey, executionId: "someone-else" }), env(ns));
  assert.equal((await foreign.json() as { released: boolean }).released, false);
  assert.equal((await readActiveWip(ns)).claims.length, 1);
});

test("the release endpoint requires coding authorization and a bounded identity", async () => {
  const ns = namespace();
  await admitActiveWip(ns, claim);
  assert.equal((await handleCodingWipRelease(post({ dedupeKey: claim.dedupeKey, executionId: claim.executionId }, "wrong"), env(ns))).status, 401);
  assert.equal((await handleCodingWipRelease(post("not json"), env(ns))).status, 400);
  assert.equal((await handleCodingWipRelease(post({ dedupeKey: "bad key with spaces", executionId: claim.executionId }), env(ns))).status, 400);
  assert.equal((await handleCodingWipRelease(post({ dedupeKey: claim.dedupeKey }), env(ns))).status, 400);
  assert.equal((await readActiveWip(ns)).claims.length, 1);
});

test("a completed WIP execution cannot replay its claim while its GitHub run identity is still live", async () => {
  const ns = namespace();
  assert.equal((await admitActiveWip(ns, claim)).admitted, true);
  await completeActiveWip(ns, {
    dedupeKey: claim.dedupeKey,
    executionId: claim.executionId,
    workerId: "github-actions-codex:12345",
    startedAt: claim.claimedAt,
    completedAt: claim.claimedAt + 1_000,
    kind: "CLAIM_RELEASED",
  });
  assert.equal((await readActiveWipCompletions(ns))[0]?.kind, "CLAIM_RELEASED");
  const replay = await admitActiveWip(ns, { ...claim, claimedAt: claim.claimedAt + 2_000 });
  assert.deepEqual(replay, { admitted: false, reason: "ACTIVE_WIP_REPLAYED" });
  assert.equal((await readActiveWip(ns)).claims.length, 0);
});
