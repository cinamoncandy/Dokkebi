import test from "node:test";
import assert from "node:assert/strict";
import { runScheduledEvolutionCoding } from "./scheduledEvolutionCoding";
import type { ExecutionCoordinatorNamespace } from "./executionCoordinator";

const SHA = "a".repeat(40);
const RUN_ID = 4242;
const NOW = Date.parse("2026-09-17T08:00:00.000Z");
const SAFETY = "Safety invariants: liveAuthority=NONE, productionMutationAllowed=false, aiAuthority=ZERO_AUTHORITY. No LIVE activation or real broker mutation.";

function issue(number: number): Record<string, unknown> {
  return {
    number,
    title: `P1: AUTOPILOT bounded work ${number}`,
    body: `apps/autopilot/src improvement.\ncanonicalOwner: autopilot\nconflictKeys: autopilot:issue:${number}\n${SAFETY}`,
    state: "open",
    author_association: "OWNER",
    labels: [],
    updated_at: new Date(NOW - number).toISOString(),
  };
}

function namespace(seen: Set<string>, acquiredKeys: string[]): ExecutionCoordinatorNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const url = String(input);
        if (url.endsWith("/evolve-learning-memory")) return new Response(JSON.stringify({ value: null }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/active-wip/admit")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ admitted: true, claim: { ...body, leaseExpiresAt: Number(body.claimedAt) + 60 * 60 * 1000 } }), { status: 201, headers: { "content-type": "application/json" } });
        }
        if (url.endsWith("/active-wip/release") || url.endsWith("/release")) return new Response(JSON.stringify({ released: true }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/provider-capacity-wait")) return new Response(JSON.stringify({ wait: null }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/execution")) return new Response(JSON.stringify({ record: null }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/acquire")) {
          const body = JSON.parse(String(init?.body)) as { dedupeKey: string };
          acquiredKeys.push(body.dedupeKey);
          if (seen.has(body.dedupeKey)) return new Response(JSON.stringify({ acquired: false, reason: "ALREADY_DISPATCHED" }), { status: 409, headers: { "content-type": "application/json" } });
          seen.add(body.dedupeKey);
          return new Response(JSON.stringify({ acquired: true }), { status: 201, headers: { "content-type": "application/json" } });
        }
        if (url.endsWith("/dispatched")) return new Response(JSON.stringify({ updated: true }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response("not found", { status: 404 });
      },
    }),
  };
}

function githubFetch(dispatchedReasons?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/branches/main")) return new Response(JSON.stringify({ commit: { sha: SHA } }), { status: 200, headers: { "content-type": "application/json" } });
    const issueMatch = url.match(/\/issues\/([1-9][0-9]*)$/);
    if (issueMatch) return new Response(JSON.stringify(issue(Number(issueMatch[1]))), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/search/issues?") && url.includes("is%3Apr")) return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/dispatches")) {
      if (dispatchedReasons) {
        const body = JSON.parse(String(init?.body)) as { client_payload?: { reason?: string } };
        dispatchedReasons.push(body.client_payload?.reason ?? "");
      }
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("same main dispatches B after A gains an open PR because dedupe is logical-work-bound", async () => {
  const seen = new Set<string>();
  const acquiredKeys: string[] = [];
  const coordinator = namespace(seen, acquiredKeys);
  const dispatchedReasons: string[] = [];
  const fetchImpl = githubFetch(dispatchedReasons);

  const first = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: coordinator },
    { candidates: [], backlogIssues: [issue(1901), issue(1902)], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    fetchImpl,
  );
  assert.equal(first.status, "EXECUTION_ACCEPTED");
  assert.deepEqual(first.selectedSignalIds, ["github-issue-1901"]);

  const second = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: coordinator },
    { candidates: [], backlogIssues: [issue(1901), issue(1902)], openPulls: [{ title: "fix A", body: "Fixes #1901" }], now: NOW + 1000, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    fetchImpl,
  );
  assert.equal(second.status, "EXECUTION_ACCEPTED");
  assert.deepEqual(second.selectedSignalIds, ["github-issue-1902"]);
  assert.equal(acquiredKeys.length, 2);
  assert.notEqual(acquiredKeys[0], acquiredKeys[1]);
  assert.match(acquiredKeys[0]!, /github-issue-1901/);
  assert.match(acquiredKeys[1]!, /github-issue-1902/);
  assert.match(dispatchedReasons[0]!, /GitHub issue #1901/);
  assert.match(dispatchedReasons[1]!, /GitHub issue #1902/);
});

test("cancelled workflow evidence does not starve healthy-main READY backlog work", async () => {
  const seen = new Set<string>();
  const acquiredKeys: string[] = [];
  const dispatchedReasons: string[] = [];
  const fetchImpl = githubFetch(dispatchedReasons);
  const cancelled = [{
    id: RUN_ID + 100,
    name: "Android Stable Release Trigger",
    status: "completed",
    conclusion: "cancelled",
    head_branch: "main",
    head_sha: SHA,
    event: "push",
    completed_at: new Date(NOW - 30_000).toISOString(),
  }];

  const outcome = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace(seen, acquiredKeys) },
    { candidates: cancelled, backlogIssues: [issue(2118)], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    fetchImpl,
  );

  assert.equal(outcome.status, "EXECUTION_ACCEPTED");
  assert.deepEqual(outcome.selectedSignalIds, ["github-issue-2118"]);
  assert.equal(acquiredKeys.length, 1);
  assert.match(acquiredKeys[0]!, /github-issue-2118/);
  assert.match(dispatchedReasons[0]!, /GitHub issue #2118/);
});

test("same logical work on same main remains persistently deduplicated", async () => {
  const seen = new Set<string>();
  const acquiredKeys: string[] = [];
  const coordinator = namespace(seen, acquiredKeys);
  const fetchImpl = githubFetch();
  const input = { candidates: [], backlogIssues: [issue(1901)], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID } as const;

  assert.equal((await runScheduledEvolutionCoding({ NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: coordinator }, input, fetchImpl)).status, "EXECUTION_ACCEPTED");
  assert.equal((await runScheduledEvolutionCoding({ NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: coordinator }, { ...input, now: NOW + 1000 }, fetchImpl)).status, "DUPLICATE_SUPPRESSED");
  assert.equal(acquiredKeys[0], acquiredKeys[1]);
});


test("closed issue discovered from a stale backlog snapshot is suppressed before lease or dispatch", async () => {
  const acquiredKeys: string[] = [];
  let dispatches = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/issues/1955")) {
      return new Response(JSON.stringify(issue(1955) && { ...issue(1955), state: "closed" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/dispatches")) {
      dispatches += 1;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const value = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace(new Set<string>(), acquiredKeys) },
    { candidates: [], backlogIssues: [issue(1955)], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    fetchImpl,
  );
  assert.equal(value.status, "ABSTAINED");
  assert.equal(value.reason, "github-issue-no-longer-actionable");
  assert.deepEqual(value.selectedSignalIds, ["github-issue-1955"]);
  assert.equal(acquiredKeys.length, 0);
  assert.equal(dispatches, 0);
});

test("issue actionability revalidation fails closed when GitHub evidence is unavailable", async () => {
  const acquiredKeys: string[] = [];
  const value = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace(new Set<string>(), acquiredKeys) },
    { candidates: [], backlogIssues: [issue(1960)], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  );
  assert.equal(value.status, "ABSTAINED");
  assert.equal(value.reason, "github-issue-actionability-revalidation-unavailable");
  assert.equal(acquiredKeys.length, 0);
});

test("concurrent same-main logical issue work dispatches once and suppresses the duplicate", async () => {
  const seen = new Set<string>();
  const acquiredKeys: string[] = [];
  const dispatchedReasons: string[] = [];
  const coordinator = namespace(seen, acquiredKeys);
  const fetchImpl = githubFetch(dispatchedReasons);
  const input = { candidates: [], backlogIssues: [issue(1960)], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID } as const;
  const [first, second] = await Promise.all([
    runScheduledEvolutionCoding({ NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: coordinator }, input, fetchImpl),
    runScheduledEvolutionCoding({ NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: coordinator }, input, fetchImpl),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["DUPLICATE_SUPPRESSED", "EXECUTION_ACCEPTED"]);
  assert.equal(dispatchedReasons.length, 1);
  assert.equal(new Set(acquiredKeys).size, 1);
});


test("issue that gained an open PR after discovery is suppressed by the dispatch-time re-read", async () => {
  const acquiredKeys: string[] = [];
  let dispatches = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/issues/1960")) return new Response(JSON.stringify(issue(1960)), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/search/issues?") && url.includes("is%3Apr")) {
      return new Response(JSON.stringify({ total_count: 1, items: [{ state: "open", title: "fix autopilot #1960", body: "Fixes #1960" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/dispatches")) {
      dispatches += 1;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const value = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace(new Set<string>(), acquiredKeys) },
    { candidates: [], backlogIssues: [issue(1960)], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    fetchImpl,
  );
  assert.equal(value.status, "ABSTAINED");
  assert.equal(value.reason, "github-issue-no-longer-actionable");
  assert.equal(acquiredKeys.length, 0);
  assert.equal(dispatches, 0);
});


test("merged PR after the current issue revision suppresses replay after main moves", async () => {
  const acquiredKeys: string[] = [];
  let dispatches = 0;
  const currentIssue = { ...issue(1961), updated_at: "2026-09-17T07:00:00.000Z" };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/issues/1961")) return new Response(JSON.stringify(currentIssue), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/search/issues?") && url.includes("is%3Apr")) {
      return new Response(JSON.stringify({
        total_count: 1,
        items: [{
          state: "closed",
          title: "chore(autopilot): validated autonomous coding proposal",
          body: "Refs #1961",
          pull_request: { merged_at: "2026-09-17T07:30:00.000Z" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/dispatches")) {
      dispatches += 1;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const value = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace(new Set<string>(), acquiredKeys) },
    { candidates: [], backlogIssues: [currentIssue], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    fetchImpl,
  );

  assert.equal(value.status, "ABSTAINED");
  assert.equal(value.reason, "github-issue-no-longer-actionable");
  assert.equal(acquiredKeys.length, 0);
  assert.equal(dispatches, 0);
});

test("a new issue revision after the prior merge can admit the next increment", async () => {
  const acquiredKeys: string[] = [];
  let dispatches = 0;
  const revisedIssue = { ...issue(1962), updated_at: "2026-09-17T08:00:00.000Z" };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/issues/1962")) return new Response(JSON.stringify(revisedIssue), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/search/issues?") && url.includes("is%3Apr")) {
      return new Response(JSON.stringify({
        total_count: 1,
        items: [{
          state: "closed",
          title: "prior increment #1962",
          body: "Refs #1962",
          pull_request: { merged_at: "2026-09-17T07:30:00.000Z" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/branches/main")) return new Response(JSON.stringify({ commit: { sha: SHA } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/dispatches")) {
      dispatches += 1;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const value = await runScheduledEvolutionCoding(
    { NUSA_GITHUB_TOKEN: "token", NUSA_EXECUTION_COORDINATOR: namespace(new Set<string>(), acquiredKeys) },
    { candidates: [], backlogIssues: [revisedIssue], openPulls: [], now: NOW, repository: "cinamoncandy/NUSA", mainSha: SHA, workflowRunId: RUN_ID },
    fetchImpl,
  );

  assert.equal(value.status, "EXECUTION_ACCEPTED");
  assert.equal(acquiredKeys.length, 1);
  assert.equal(dispatches, 1);
});
