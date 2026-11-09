const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
const PAGE_SIZE = 100;
const MAX_BACKLOG_PAGES = 10;

type GithubFetch = (input: string, init?: RequestInit) => Promise<Response>;
type GithubResource = "issues" | "pullRequests";
type JsonObject = Record<string, unknown>;

export interface GithubOpenBacklog {
  readonly issues: readonly unknown[];
  readonly pulls: readonly unknown[];
  readonly consistency: {
    readonly pagination: "GRAPHQL_CURSOR";
    readonly repeatedScansMatched: true;
    /** GitHub does not expose a point-in-time snapshot token for these connections. */
    readonly pointInTimeSnapshot: "VERIFIED" | "UNVERIFIED";
    /** No runtime selector or WIP admission may consume a non-snapshot inventory. */
    readonly automaticSelectionAllowed: boolean;
  };
}

const ISSUE_QUERY = `query OpenIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: ${PAGE_SIZE}, after: $after, states: [OPEN], orderBy: {field: CREATED_AT, direction: ASC}) {
      edges {
        cursor
        node {
          number
          title
          body
          state
          authorAssociation
          createdAt
          updatedAt
          labels(first: 100) {
            edges { node { name } }
            pageInfo { hasNextPage }
          }
        }
      }
      totalCount
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PULL_REQUEST_QUERY = `query OpenPullRequests($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PAGE_SIZE}, after: $after, states: [OPEN], orderBy: {field: CREATED_AT, direction: ASC}) {
      edges {
        cursor
        node { number title body state createdAt updatedAt }
      }
      totalCount
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function recordIdentity(value: unknown, resource: GithubResource): JsonObject {
  const edge = object(value);
  const node = object(edge?.node);
  const cursor = edge?.cursor;
  const number = node?.number;
  if (typeof cursor !== "string" || cursor.length === 0 || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`GitHub ${resource} inventory edge invalid`);
  }
  return { ...node, __edgeCursor: cursor };
}

function parseIssue(value: JsonObject): JsonObject {
  const { __edgeCursor: _cursor, ...node } = value;
  if (typeof node.title !== "string"
    || (node.body !== null && typeof node.body !== "string")
    || node.state !== "OPEN"
    || typeof node.authorAssociation !== "string"
    || typeof node.createdAt !== "string" || !Number.isFinite(Date.parse(node.createdAt))
    || typeof node.updatedAt !== "string" || !Number.isFinite(Date.parse(node.updatedAt))) {
    throw new Error("GitHub issues inventory node invalid");
  }
  const labels = object(node.labels);
  const edges = labels?.edges;
  const pageInfo = object(labels?.pageInfo);
  if (!Array.isArray(edges) || pageInfo?.hasNextPage !== false) {
    throw new Error("GitHub issues inventory labels incomplete");
  }
  const names = edges.map((edge) => {
    const name = object(object(edge)?.node)?.name;
    if (typeof name !== "string" || !name.trim()) throw new Error("GitHub issue label invalid");
    return { name };
  });
  return {
    number: node.number,
    title: node.title,
    body: node.body ?? "",
    state: "open",
    author_association: node.authorAssociation,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    labels: names,
  };
}

function parsePullRequest(value: JsonObject): JsonObject {
  const { __edgeCursor: _cursor, ...node } = value;
  if (typeof node.title !== "string"
    || (node.body !== null && typeof node.body !== "string")
    || node.state !== "OPEN"
    || typeof node.createdAt !== "string" || !Number.isFinite(Date.parse(node.createdAt))
    || typeof node.updatedAt !== "string" || !Number.isFinite(Date.parse(node.updatedAt))) {
    throw new Error("GitHub pull requests inventory node invalid");
  }
  return {
    number: node.number,
    title: node.title,
    body: node.body ?? "",
    state: "open",
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

async function fetchOpenRecords(
  owner: string,
  name: string,
  resource: GithubResource,
  headers: HeadersInit,
  fetchImpl: GithubFetch,
): Promise<readonly JsonObject[]> {
  const records: JsonObject[] = [];
  const seenNumbers = new Set<number>();
  const seenCursors = new Set<string>();
  const query = resource === "issues" ? ISSUE_QUERY : PULL_REQUEST_QUERY;
  let after: string | null = null;
  let expectedTotalCount: number | null = null;
  let lastCreatedAtMs = Number.NEGATIVE_INFINITY;

  for (let page = 1; page <= MAX_BACKLOG_PAGES; page += 1) {
    const response = await fetchImpl(GITHUB_GRAPHQL_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables: { owner, name, after } }),
    });
    if (!response.ok) throw new Error(`GitHub ${resource} inventory unavailable (${response.status})`);
    const payload: unknown = await response.json();
    const root = object(payload);
    if (root && Object.hasOwn(root, "errors")) {
      if (!Array.isArray(root.errors) || root.errors.length > 0) throw new Error(`GitHub ${resource} inventory query failed`);
    }
    const data = object(root?.data);
    const repository = object(data?.repository);
    const connection = object(repository?.[resource]);
    const edges = connection?.edges;
    const pageInfo = object(connection?.pageInfo);
    const totalCount = connection?.totalCount;
    if (!Array.isArray(edges) || edges.length > PAGE_SIZE || typeof pageInfo?.hasNextPage !== "boolean"
      || typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error(`GitHub ${resource} inventory response invalid`);
    }
    if (expectedTotalCount !== null && totalCount !== expectedTotalCount) {
      throw new Error(`GitHub ${resource} inventory count changed during pagination`);
    }
    expectedTotalCount = totalCount;

    const pageRecords = edges.map((edge) => recordIdentity(edge, resource));
    const pageCursors = pageRecords.map((record) => record.__edgeCursor as string);
    const pageNumbers = pageRecords.map((record) => record.number as number);
    const endCursor = pageInfo.endCursor;
    if (pageRecords.length === 0) {
      if (pageInfo.hasNextPage || endCursor !== null) throw new Error(`GitHub ${resource} cursor metadata invalid`);
    } else {
      if (typeof endCursor !== "string" || endCursor !== pageCursors.at(-1)) {
        throw new Error(`GitHub ${resource} cursor metadata invalid`);
      }
      for (const cursor of pageCursors) {
        if (seenCursors.has(cursor) || cursor === after) throw new Error(`GitHub ${resource} cursor did not advance`);
        seenCursors.add(cursor);
      }
      for (const number of pageNumbers) {
        if (seenNumbers.has(number)) throw new Error(`GitHub ${resource} identity duplicated`);
        seenNumbers.add(number);
      }
    }

    for (const record of pageRecords) {
      const parsed = resource === "issues" ? parseIssue(record) : parsePullRequest(record);
      const createdAtMs = Date.parse(String(parsed.created_at));
      if (createdAtMs < lastCreatedAtMs) throw new Error(`GitHub ${resource} inventory order invalid`);
      lastCreatedAtMs = createdAtMs;
      records.push(parsed);
    }
    if (!pageInfo.hasNextPage) {
      if (records.length !== expectedTotalCount) throw new Error(`GitHub ${resource} inventory incomplete`);
      return Object.freeze(records);
    }
    if (pageRecords.length === 0 || typeof endCursor !== "string") throw new Error(`GitHub ${resource} cursor incomplete`);
    if (page === MAX_BACKLOG_PAGES) throw new Error(`GitHub ${resource} inventory exceeds bounded pagination`);
    after = endCursor;
  }

  throw new Error(`GitHub ${resource} inventory unavailable`);
}

async function fetchInventoryScan(owner: string, name: string, headers: HeadersInit, fetchImpl: GithubFetch) {
  const [issues, pulls] = await Promise.all([
    fetchOpenRecords(owner, name, "issues", headers, fetchImpl),
    fetchOpenRecords(owner, name, "pullRequests", headers, fetchImpl),
  ]);
  return Object.freeze({ issues, pulls });
}

/**
 * GitHub cursor pagination avoids offset shifts when earlier OPEN records close while a scan is
 * in progress. It is not a point-in-time snapshot: use immutable CREATED_AT ordering, validate
 * every cursor/edge and compare two full scans. A matching pair still cannot prove that no issue
 * changed between pages (including a close/reopen cycle). The result is therefore diagnostic only
 * until GitHub supplies a verifiable snapshot contract; selectors and WIP admission must reject it.
 */
export async function fetchOpenGithubBacklog(
  repository: string,
  headers: HeadersInit,
  fetchImpl: GithubFetch = fetch,
): Promise<GithubOpenBacklog> {
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("GitHub backlog repository invalid");
  const [, owner, name] = match;
  const complete = new Headers(headers);
  complete.set("content-type", "application/json");
  const first = await fetchInventoryScan(owner!, name!, complete, fetchImpl);
  const second = await fetchInventoryScan(owner!, name!, complete, fetchImpl);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("GitHub backlog changed between complete cursor scans");
  }
  return Object.freeze({
    ...second,
    consistency: Object.freeze({
      pagination: "GRAPHQL_CURSOR" as const,
      repeatedScansMatched: true as const,
      pointInTimeSnapshot: "UNVERIFIED" as const,
      automaticSelectionAllowed: false as const,
    }),
  });
}
