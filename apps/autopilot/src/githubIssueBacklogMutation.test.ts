import assert from "node:assert/strict";
import test from "node:test";
import { selectCodexBacklogTask } from "./evolveGithubIssueBacklog";
import { fetchOpenGithubBacklog } from "./githubIssueBacklogClient";

type Resource = "issues" | "pullRequests";

function issueNode(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: "Task",
    body: "details",
    state: "OPEN",
    authorAssociation: "OWNER",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    labels: { edges: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}

function pullNode(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: "Unrelated pull request",
    body: "",
    state: "OPEN",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

function edge(resource: Resource, node: Record<string, unknown>) {
  return { cursor: `${resource}:${node.number}`, node };
}

function gqlResponse(resource: Resource, edges: readonly unknown[], totalCount: number, hasNextPage = false): Response {
  return new Response(JSON.stringify({ data: { repository: { [resource]: {
    edges,
    totalCount,
    pageInfo: { hasNextPage, endCursor: (edges.at(-1) as { cursor?: string } | undefined)?.cursor ?? null },
  } } } }), { status: 200 });
}

function queryRequest(init?: RequestInit): { query: string; variables: { after: string | null } } {
  const request = JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } };
  assert.equal(init?.method, "POST");
  return request;
}

function eligibleIssue(number: number, priority: "P0" | "P1", title: string): Record<string, unknown> {
  return issueNode(number, {
    title: `[${priority}] ${title}`,
    body: "Autopilot control-plane task in apps/autopilot/src. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: autopilot:pagination",
  });
}

test("legacy offset scans can match while omitting the same open boundary issue and selecting lower priority", () => {
  const offsetScan = () => {
    // Page 1 has 1..100; #50 closes before page 2 so #101 shifts to page 1 and page 2 starts at #102.
    // It reopens before the next scan and closes again after that scan's first page: both scans match.
    return [
      ...Array.from({ length: 100 }, (_, index) => index + 1).filter((number) => number !== 50),
      102,
    ];
  };
  const first = offsetScan();
  const second = offsetScan();
  assert.deepEqual(first, second);
  assert.ok(!first.includes(101), "the same still-open P0 boundary issue is absent in both offset scans");
  const selectedFromIncompleteLegacyInventory = selectCodexBacklogTask([{
    number: 102,
    title: "[P1] Autopilot visible lower-priority work",
    body: "Autopilot control-plane task in apps/autopilot/src. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: autopilot:pagination",
    state: "open",
    author_association: "OWNER",
    updated_at: "2026-11-09T00:00:00Z",
    labels: [],
  }], []);
  assert.equal(selectedFromIncompleteLegacyInventory?.issueNumber, 102, "the old path could select lower priority because #101 is absent");
});

test("cursor pagination returns the higher-priority boundary issue in a stable multi-page scan", async () => {
  const afterValues: Record<Resource, Array<string | null>> = { issues: [], pullRequests: [] };
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = queryRequest(init);
    const resource: Resource = request.query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    afterValues[resource].push(request.variables.after);
    assert.match(request.query, /orderBy: \{field: CREATED_AT, direction: ASC\}/);
    assert.match(request.query, /states: \[OPEN\]/);
    if (resource === "pullRequests") return gqlResponse(resource, [], 0);
    if (request.variables.after === null) {
      const firstPage = Array.from({ length: 100 }, (_, index) => edge(resource, issueNode(index + 1)));
      return gqlResponse(resource, firstPage, 102, true);
    }
    assert.equal(request.variables.after, "issues:100");
    // The cursor is anchored after #100; removing an earlier row cannot shift #101 out of this page.
    return gqlResponse(resource, [
      edge(resource, eligibleIssue(101, "P0", "high priority boundary")),
      edge(resource, eligibleIssue(102, "P1", "lower priority")),
    ], 102);
  };

  const inventory = await fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, fetchImpl);
  assert.equal(inventory.issues.length, 102);
  assert.equal(selectCodexBacklogTask(inventory.issues, inventory.pulls)?.issueNumber, 101);
  assert.deepEqual(afterValues.issues, [null, "issues:100", null, "issues:100"]);
  assert.equal(inventory.consistency.pointInTimeSnapshot, "UNVERIFIED");
  assert.equal(inventory.consistency.automaticSelectionAllowed, false);
});

test("close during a cursor scan is rejected when the total-count consistency check changes", async () => {
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = queryRequest(init);
    if (request.query.includes("pullRequests(first:")) return gqlResponse("pullRequests", [], 0);
    if (request.variables.after === null) {
      return gqlResponse("issues", Array.from({ length: 100 }, (_, index) => edge("issues", issueNode(index + 1))), 102, true);
    }
    // #50 closed after page 1. Cursor traversal still reaches the boundary rows, but the scan is not atomic.
    return gqlResponse("issues", [edge("issues", issueNode(101)), edge("issues", issueNode(102))], 101);
  };
  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, fetchImpl), /count changed during pagination/);
});

test("cursor pagination includes a linked open PR beyond page one so the issue cannot be selected", async () => {
  const issue = eligibleIssue(42, "P0", "autopilot linked task");
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = queryRequest(init);
    if (request.query.includes("pullRequests(first:")) {
      if (request.variables.after === null) {
        return gqlResponse("pullRequests", Array.from({ length: 100 }, (_, index) => edge("pullRequests", pullNode(index + 101))), 101, true);
      }
      return gqlResponse("pullRequests", [edge("pullRequests", pullNode(201, { title: "Fix #42", body: "Refs #42" }))], 101);
    }
    return gqlResponse("issues", [edge("issues", issue)], 1);
  };

  const inventory = await fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, fetchImpl);
  assert.equal(inventory.pulls.length, 101);
  assert.equal(selectCodexBacklogTask(inventory.issues, inventory.pulls), null);
});
