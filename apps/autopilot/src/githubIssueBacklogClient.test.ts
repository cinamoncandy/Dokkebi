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

function edge(resource: Resource, node: Record<string, unknown>, cursor = `${resource}:${node.number}`) {
  return { cursor, node };
}

function graphResponse(
  resource: Resource,
  edges: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = (edges.at(-1) as { cursor?: string } | undefined)?.cursor ?? null,
  totalCount = edges.length,
): Response {
  return new Response(JSON.stringify({
    data: {
      repository: {
        [resource]: { edges, totalCount, pageInfo: { hasNextPage, endCursor } },
      },
    },
  }), { status: 200 });
}

function readQuery(init?: RequestInit): { query: string; variables: { owner: string; name: string; after: string | null } } {
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(init?.body)) as { query: string; variables: { owner: string; name: string; after: string | null } };
  assert.equal(body.variables.owner, "cinamoncandy");
  assert.equal(body.variables.name, "NUSA");
  return body;
}

test("cursor pagination reads all open issues and PRs and keeps a later eligible task selectable", async () => {
  const afterValues: Record<Resource, Array<string | null>> = { issues: [], pullRequests: [] };
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = readQuery(init);
    const resource: Resource = body.query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    afterValues[resource].push(body.variables.after);
    assert.match(body.query, /orderBy: \{field: CREATED_AT, direction: ASC\}/);
    assert.match(body.query, /states: \[OPEN\]/);
    if (resource === "pullRequests") return graphResponse(resource, [edge(resource, pullNode(201))]);
    if (body.variables.after === null) {
      const firstPage = Array.from({ length: 100 }, (_, index) => edge(resource, issueNode(index + 1)));
      return graphResponse(resource, firstPage, true, "issues:100", 101);
    }
    assert.equal(body.variables.after, "issues:100");
    return graphResponse(resource, [edge(resource, issueNode(101, {
      title: "[P0] Autopilot Research backlog task",
      body: "Research task. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: research-owner\nconflictKeys: research:history",
    }))], false, "issues:101", 101);
  };

  const result = await fetchOpenGithubBacklog("cinamoncandy/NUSA", { authorization: "Bearer test-token" }, fetchImpl);
  assert.equal(result.issues.length, 101);
  assert.equal(result.pulls.length, 1);
  assert.equal(result.consistency.pointInTimeSnapshot, "UNVERIFIED");
  assert.equal(result.consistency.automaticSelectionAllowed, false);
  assert.equal(selectCodexBacklogTask(result.issues, result.pulls)?.issueNumber, 101);
  assert.deepEqual(afterValues.issues, [null, "issues:100", null, "issues:100"]);
  assert.deepEqual(afterValues.pullRequests, [null, null]);
});

test("pageInfo, not a full-page length guess, controls cursor termination", async () => {
  let issueCalls = 0;
  const result = await fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    if (body.query.includes("pullRequests(first:")) return graphResponse("pullRequests", []);
    issueCalls += 1;
    return graphResponse("issues", Array.from({ length: 100 }, (_, index) => edge("issues", issueNode(index + 1))), false, "issues:100", 100);
  });
  assert.equal(issueCalls, 2, "one exact-full page is read per complete scan");
  assert.equal(result.issues.length, 100);
});

test("a linked pull request beyond page one still blocks duplicate task selection", async () => {
  const issue = issueNode(42, {
    title: "[P1] Autopilot task",
    body: "Autopilot task. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: issue:42",
  });
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = readQuery(init);
    if (body.query.includes("pullRequests(first:")) {
      if (body.variables.after === null) {
        return graphResponse("pullRequests", Array.from({ length: 100 }, (_, index) => edge("pullRequests", pullNode(index + 101))), true, "pullRequests:200", 101);
      }
      return graphResponse("pullRequests", [edge("pullRequests", pullNode(201, { title: "Fix #42", body: "Refs #42" }))], false, "pullRequests:201", 101);
    }
    return graphResponse("issues", [edge("issues", issue)]);
  };
  const result = await fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, fetchImpl);
  assert.equal(result.pulls.length, 101);
  assert.equal(selectCodexBacklogTask(result.issues, result.pulls), null);
});

test("a mutation during cursor pagination fails closed when total count changes", async () => {
  let issueScan = 0;
  let closedBoundaryItem = false;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = readQuery(init);
    const resource: Resource = body.query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    if (resource === "pullRequests") return graphResponse(resource, []);
    if (body.variables.after === null) {
      issueScan += 1;
      const current = Array.from({ length: 102 }, (_, index) => index + 1).filter((number) => !(closedBoundaryItem && number === 50));
      const page = current.slice(0, 100).map((number) => edge(resource, issueNode(number, number === 101
        ? { title: "[P0] Autopilot high priority task", body: "Autopilot task. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: issue:high" }
        : number === 102
          ? { title: "[P1] Autopilot lower priority task", body: "Autopilot task. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: issue:low" }
          : {})));
      if (issueScan === 1) closedBoundaryItem = true;
      return graphResponse(resource, page, current.length > 100, page.at(-1)?.cursor ?? null, 102);
    }
    const current = Array.from({ length: 102 }, (_, index) => index + 1).filter((number) => !(closedBoundaryItem && number === 50));
    const cursorNumber = Number(body.variables.after?.split(":").at(-1));
    const page = current.filter((number) => number > cursorNumber).slice(0, 100).map((number) => edge(resource, issueNode(number, number === 101
      ? { title: "[P0] Autopilot high priority task", body: "Autopilot task. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: issue:high" }
      : number === 102
        ? { title: "[P1] Autopilot lower priority task", body: "Autopilot task. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: issue:low" }
        : {})));
    return graphResponse(resource, page, current.some((number) => number > (page.at(-1)?.node.number as number)), page.at(-1)?.cursor ?? null, current.length);
  };

  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, fetchImpl), /count changed during pagination|inventory incomplete/);
  assert.equal(issueScan, 1, "the count change is rejected before a second full scan can authorize a selection");
});

test("GraphQL errors, malformed edges, duplicate identities, bad cursors, incomplete labels and page overflow fail closed", async () => {
  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    return body.query.includes("pullRequests(first:")
      ? graphResponse("pullRequests", [])
      : new Response(JSON.stringify({ errors: [{ message: "permission denied" }] }), { status: 200 });
  }), /query failed/);

  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    return body.query.includes("pullRequests(first:")
      ? graphResponse("pullRequests", [])
      : new Response(JSON.stringify({ data: { repository: { issues: { edges: [], pageInfo: { hasNextPage: "yes" } } } } }), { status: 200 });
  }), /response invalid/);

  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    if (body.query.includes("pullRequests(first:")) return graphResponse("pullRequests", []);
    const duplicate = edge("issues", issueNode(1));
    return graphResponse("issues", [duplicate, duplicate]);
  }), /identity duplicated|cursor did not advance/);

  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    if (body.query.includes("pullRequests(first:")) return graphResponse("pullRequests", []);
    return graphResponse("issues", [edge("issues", issueNode(1))], true, null);
  }), /cursor metadata invalid/);

  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    if (body.query.includes("pullRequests(first:")) return graphResponse("pullRequests", []);
    return graphResponse("issues", [edge("issues", issueNode(1, { labels: { edges: [], pageInfo: { hasNextPage: true } } }))]);
  }), /labels incomplete/);

  let page = 0;
  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    if (body.query.includes("pullRequests(first:")) return graphResponse("pullRequests", []);
    page += 1;
    const numbers = Array.from({ length: 100 }, (_, index) => (page - 1) * 100 + index + 1);
    const edges = numbers.map((number) => edge("issues", issueNode(number), `issues-page-${page}-item-${number}`));
    return graphResponse("issues", edges, true, undefined, 1001);
  }), /exceeds bounded pagination/);
  assert.equal(page, 10);

  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    return body.query.includes("pullRequests(first:")
      ? graphResponse("pullRequests", [])
      : new Response("unavailable", { status: 403 });
  }), /unavailable \(403\)/);
});

test("changes to selection metadata between complete cursor scans fail closed", async () => {
  let issueReads = 0;
  await assert.rejects(fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (_input, init) => {
    const body = readQuery(init);
    if (body.query.includes("pullRequests(first:")) return graphResponse("pullRequests", []);
    issueReads += 1;
    return graphResponse("issues", [edge("issues", issueNode(42, { title: issueReads === 1 ? "old" : "new" }))]);
  }), /changed between complete cursor scans/);
});
