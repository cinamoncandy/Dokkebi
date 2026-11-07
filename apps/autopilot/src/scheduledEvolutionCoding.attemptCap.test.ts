import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SCHEDULED_CODING_ATTEMPTS, runScheduledEvolutionCoding } from "./scheduledEvolutionCoding";
import { ExecutionCoordinator, readPersistentExecution, type ExecutionCoordinatorNamespace } from "./executionCoordinator";

const MAIN_SHA = "a".repeat(40);
const RUN_ID = 9001;
const NOW = 1_787_968_000_000;
const FIVE_MINUTES = 5 * 60 * 1000;

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

/** Execution records go to a real coordinator per dedupe identity; auxiliary state stays empty. */
function namespace(): ExecutionCoordinatorNamespace {
  const coordinators = new Map<string, ExecutionCoordinator>();
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: unknown) => {
      const name = (id as { name: string }).name;
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const url = String(input);
          if (url.endsWith("/evolve-learning-memory")) return new Response(JSON.stringify({ value: null }), { status: 200, headers: { "content-type": "application/json" } });
          if (url.endsWith("/provider-capacity-wait")) return new Response(JSON.stringify({ wait: null }), { status: 200, headers: { "content-type": "application/json" } });
          let coordinator = coordinators.get(name);
          if (!coordinator) {
            coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
            coordinators.set(name, coordinator);
          }
          return coordinator.fetch(new Request(url, init));
        },
      };
    },
  };
}

// The 2026-10-12 shape: one CI failure on main that no attempt can fix.
const candidates = [{
  id: RUN_ID,
  name: "CI",
  conclusion: "failure",
  head_branch: "main",
  head_sha: MAIN_SHA,
  event: "push",
  completed_at: new Date(NOW - 60_000).toISOString(),
}];

test("generic workflow failures never acquire attempts or dispatch without causal evidence", async () => {
  const ns = namespace();
  let dispatches = 0;
  const fetchImpl = (async () => { dispatches += 1; return new Response(null, { status: 204 }); }) as typeof fetch;

  const outcomes = [];
  for (let tick = 0; tick < MAX_SCHEDULED_CODING_ATTEMPTS + 2; tick += 1) {
    const now = NOW + tick * FIVE_MINUTES;
    const outcome = await runScheduledEvolutionCoding({ NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: ns }, {
      candidates,
      now,
      repository: "cinamoncandy/NUSA",
      mainSha: MAIN_SHA,
      workflowRunId: RUN_ID,
    }, fetchImpl);
    outcomes.push(outcome);
    assert.equal(outcome.status, "ABSTAINED");
    assert.equal(outcome.reason, "workflow-failure-causal-evidence-unverified");
  }

  assert.equal(dispatches, 0);
  assert.equal(outcomes.length, MAX_SCHEDULED_CODING_ATTEMPTS + 2);
  assert.equal(await readPersistentExecution(ns, `evolve-coding:${MAIN_SHA}:gha:ci:${MAIN_SHA}:failure`), null);
});

test("a new main SHA does not make an unverified workflow failure code-actionable", async () => {
  const ns = namespace();
  let dispatches = 0;
  const nextSha = "c".repeat(40);
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/branches/main")) return new Response(JSON.stringify({ commit: { sha: nextSha } }), { status: 200 });
    if (String(input).endsWith("/dispatches")) {
      dispatches += 1;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const outcome = await runScheduledEvolutionCoding({ NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: ns }, {
    candidates: [{ ...candidates[0], id: RUN_ID + 1, head_sha: nextSha }],
    now: NOW,
    repository: "cinamoncandy/NUSA",
    mainSha: nextSha,
    workflowRunId: RUN_ID + 1,
  }, fetchImpl);
  assert.equal(outcome.status, "ABSTAINED");
  assert.equal(outcome.reason, "workflow-failure-causal-evidence-unverified");
  assert.equal(dispatches, 0);
});
