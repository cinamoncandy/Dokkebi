import { JSON_SCHEMA, load as loadYaml } from "js-yaml";
import {
  codexBacklogTaskSnapshot,
  selectCodexBacklogTask,
  type CodexBacklogTask,
  type GithubIssueCapability,
} from "./evolveGithubIssueBacklog";

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL_API = `${GITHUB_API}/graphql`;
const WORK_ORDER_ROOT = ".aipos/work-orders/";
const MAX_WORK_ORDERS = 1_000;
const MAX_WORK_ORDER_BLOB_BYTES = 96 * 1024;
const MAX_WORK_ORDER_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_READY_WORK_ORDERS = 32;
const MAX_TREE_ENTRIES = 10_000;
const TREE_BLOB_BATCH_SIZE = 20;
const PAGE_SIZE = 100;
const MAX_TIMELINE_PAGES = 10;
const OWNER = /^[A-Za-z0-9_.:/-]{1,120}$/;
const CONFLICT_KEY = /^[A-Za-z0-9_.:/-]{1,200}$/;
const SHA1 = /^[a-f0-9]{40}$/i;
const CODING_TARGET = /^apps\/autopilot\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/;
const WORK_ORDER_LINK_FIELDS = [
  "dependency", "depends_on", "depends_on_pull_request", "dependsOn", "dependsOnPullRequest", "parent", "parent_issue", "parent_pr", "parent_pull_request", "parent_work_order",
  "related", "related_issues", "related_merged_prs", "related_pull_requests", "canonical_pr", "pull_request",
  "pull_requests", "issues", "prs", "links", "references", "supersedes_pr", "supersedes_pull_request", "predecessor_pr", "successor_pull_request",
] as const;
const SELECTION_LINK_FIELDS = [
  "dependency", "dependsOn", "dependsOnPullRequest", "parent", "parentIssue", "parentPullRequest", "related",
  "relatedIssues", "relatedPullRequests", "pullRequest", "pullRequests", "issues", "pull_requests", "prs", "links", "references",
  "supersedes", "supersedesPullRequest", "predecessor", "successor",
] as const;

type JsonObject = Record<string, unknown>;
type GithubFetch = (input: string, init?: RequestInit) => Promise<Response>;

type TreeBlob = Readonly<{ path: string; sha: string; size: number }>;
type WorkOrderSelection = Readonly<{
  id: string;
  issueNumber: number;
  blobSha: string;
  path: string;
  capability: GithubIssueCapability;
  canonicalOwner: string;
  conflictKeys: readonly string[];
  codingTarget?: string;
}>;

export interface CodexWorkOrderTask {
  readonly task: CodexBacklogTask;
  readonly source: Readonly<{
    readonly mainSha: string;
    readonly treeSha: string;
    readonly workOrderId: string;
    readonly workOrderPath: string;
    readonly workOrderBlobSha: string;
    readonly issueCrossReferenceDigest: string;
  }>;
}

export interface VerifiedCodexWorkOrderInventory {
  readonly task: CodexWorkOrderTask | null;
  readonly consistency: Readonly<{
    readonly source: "PROTECTED_MAIN_AIPOS_WORK_ORDERS";
    readonly mainSha: string;
    readonly treeSha: string;
    readonly completeWorkOrderCount: number;
    readonly readyWorkOrderCount: number;
    readonly automaticSelectionAllowed: true;
  }>;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function validResponseObject(value: unknown, code: string): JsonObject {
  const record = object(value);
  if (!record) throw new Error(code);
  return record;
}

function parseGithubRepository(repository: string): Readonly<{ owner: string; name: string }> {
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("CODEX_WORK_ORDER_REPOSITORY_INVALID");
  return Object.freeze({ owner: match[1]!, name: match[2]! });
}

async function fetchJson(fetchImpl: GithubFetch, url: string, headers: HeadersInit): Promise<unknown> {
  const response = await fetchImpl(url, { method: "GET", headers });
  if (!response.ok) throw new Error(`CODEX_WORK_ORDER_GITHUB_UNAVAILABLE:${response.status}`);
  return response.json();
}

export async function fetchProtectedMainSha(
  repository: string,
  headers: HeadersInit,
  fetchImpl: GithubFetch = fetch,
): Promise<string> {
  const { owner, name } = parseGithubRepository(repository);
  const response = validResponseObject(await fetchJson(fetchImpl, `${GITHUB_API}/repos/${owner}/${name}/git/ref/heads/main`, headers), "CODEX_WORK_ORDER_MAIN_RESPONSE_INVALID");
  const objectRef = object(response.object);
  const sha = text(objectRef?.sha)?.toLowerCase();
  if (!sha || !SHA1.test(sha)) throw new Error("CODEX_WORK_ORDER_MAIN_RESPONSE_INVALID");
  return sha;
}

function workOrderPaths(tree: readonly unknown[]): readonly TreeBlob[] {
  if (tree.length > MAX_TREE_ENTRIES) throw new Error("CODEX_WORK_ORDER_TREE_LIMIT_EXCEEDED");
  const paths = new Set<string>();
  const files: TreeBlob[] = [];
  let totalBytes = 0;
  for (const value of tree) {
    const item = object(value);
    const path = text(item?.path);
    if (!path) throw new Error("CODEX_WORK_ORDER_TREE_ENTRY_INVALID");
    if (paths.has(path)) throw new Error("CODEX_WORK_ORDER_TREE_PATH_DUPLICATED");
    paths.add(path);
    if (!path.startsWith(WORK_ORDER_ROOT) || !/^\.aipos\/work-orders\/WO-[^/]+\.ya?ml$/i.test(path)) continue;
    if (item?.type !== "blob" || item.mode !== "100644" || typeof item.sha !== "string" || !SHA1.test(item.sha)
      || !Number.isSafeInteger(item.size) || Number(item.size) < 1 || Number(item.size) > MAX_WORK_ORDER_BLOB_BYTES) {
      throw new Error("CODEX_WORK_ORDER_BLOB_METADATA_INVALID");
    }
    totalBytes += Number(item.size);
    if (totalBytes > MAX_WORK_ORDER_TOTAL_BYTES) throw new Error("CODEX_WORK_ORDER_TOTAL_SIZE_LIMIT_EXCEEDED");
    files.push(Object.freeze({ path, sha: String(item.sha).toLowerCase(), size: Number(item.size) }));
  }
  if (files.length > MAX_WORK_ORDERS) throw new Error("CODEX_WORK_ORDER_COUNT_LIMIT_EXCEEDED");
  return Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path)));
}

function blobQuery(batch: readonly TreeBlob[], mainSha: string) {
  const variables: Record<string, string> = { owner: "", name: "" };
  const fields = batch.map((entry, index) => {
    const variable = `e${index}`;
    variables[variable] = `${mainSha}:${entry.path}`;
    return `f${index}: object(expression: $${variable}) { __typename ... on Blob { oid text } }`;
  });
  const declarations = batch.map((_, index) => `$e${index}: String!`).join(", ");
  const query = `query PinnedAiposWorkOrderBlobs($owner: String!, $name: String!, ${declarations}) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`;
  return { query, variables };
}

async function fetchWorkOrderBlobs(
  repository: Readonly<{ owner: string; name: string }>,
  mainSha: string,
  files: readonly TreeBlob[],
  headers: HeadersInit,
  fetchImpl: GithubFetch,
): Promise<readonly Readonly<{ file: TreeBlob; source: string }>[]> {
  const results: Array<Readonly<{ file: TreeBlob; source: string }>> = [];
  for (let offset = 0; offset < files.length; offset += TREE_BLOB_BATCH_SIZE) {
    const batch = files.slice(offset, offset + TREE_BLOB_BATCH_SIZE);
    const { query, variables: queryVariables } = blobQuery(batch, mainSha);
    queryVariables.owner = repository.owner;
    queryVariables.name = repository.name;
    const graphHeaders = new Headers(headers);
    graphHeaders.set("content-type", "application/json");
    const response = await fetchImpl(GITHUB_GRAPHQL_API, {
      method: "POST",
      headers: graphHeaders,
      body: JSON.stringify({ query, variables: queryVariables }),
    });
    if (!response.ok) throw new Error(`CODEX_WORK_ORDER_GITHUB_UNAVAILABLE:${response.status}`);
    const root = validResponseObject(await response.json(), "CODEX_WORK_ORDER_BLOB_RESPONSE_INVALID");
    if (Object.hasOwn(root, "errors") && (!Array.isArray(root.errors) || root.errors.length > 0)) {
      throw new Error("CODEX_WORK_ORDER_BLOB_LOOKUP_FAILED");
    }
    const data = validResponseObject(root.data, "CODEX_WORK_ORDER_BLOB_RESPONSE_INVALID");
    const repo = validResponseObject(data.repository, "CODEX_WORK_ORDER_REPOSITORY_NOT_FOUND");
    for (const [index, file] of batch.entries()) {
      const blob = object(repo[`f${index}`]);
      if (!blob || blob.__typename !== "Blob" || typeof blob.oid !== "string" || blob.oid.toLowerCase() !== file.sha
        || typeof blob.text !== "string" || new TextEncoder().encode(blob.text).byteLength !== file.size) {
        throw new Error("CODEX_WORK_ORDER_BLOB_IDENTITY_MISMATCH");
      }
      results.push(Object.freeze({ file, source: blob.text }));
    }
  }
  if (results.length !== files.length) throw new Error("CODEX_WORK_ORDER_BLOB_INVENTORY_INCOMPLETE");
  return Object.freeze(results);
}

function parseConflictKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("CODEX_WORK_ORDER_METADATA_INVALID");
  const keys = value.map((item) => text(item));
  if (keys.some((key) => !key || !CONFLICT_KEY.test(key)) || new Set(keys).size !== keys.length) {
    throw new Error("CODEX_WORK_ORDER_METADATA_INVALID");
  }
  return Object.freeze(keys as string[]);
}

function parseStringList(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(code);
  const entries = value.map((item) => String(item).trim());
  if (new Set(entries).size !== entries.length) throw new Error(code);
  return Object.freeze(entries);
}

function nonEmptyReference(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  const record = object(value);
  if (record) return Object.keys(record).length > 0;
  return true;
}

/**
 * Codex selection is an explicit opt-in field inside an existing AIPOS Work Order, never inferred
 * from a global issue search. A `codex_selection.status: READY` entry must also bind its issue,
 * executor capability, owner and conflicts; list every dependency/link class explicitly, even
 * when empty. Current policy defers linked/dependent entries until their evidence has a dedicated
 * exact-read contract. An absent/non-READY entry is simply not a coding candidate.
 */
function parseReadySelection(file: Readonly<{ file: TreeBlob; source: string }>): WorkOrderSelection | null {
  let parsed: unknown;
  try {
    parsed = loadYaml(file.source, { schema: JSON_SCHEMA, json: false, filename: file.file.path });
  } catch {
    throw new Error("CODEX_WORK_ORDER_YAML_INVALID");
  }
  const workOrder = object(parsed);
  if (!workOrder) throw new Error("CODEX_WORK_ORDER_DOCUMENT_INVALID");
  const selectionValue = workOrder.codex_selection;
  if (selectionValue === undefined) return null;
  const selection = object(selectionValue);
  if (!selection) throw new Error("CODEX_WORK_ORDER_SELECTION_INVALID");
  if (selection.status !== "READY") return null;

  const id = text(workOrder.id);
  const status = text(workOrder.status);
  const issueNumber = Number(selection.issue);
  const workOrderIssue = Number(workOrder.issue);
  const capability = text(selection.capability);
  const canonicalOwner = text(selection.canonicalOwner);
  if (!id || !status || !["IN_PROGRESS", "READY_FOR_REVIEW"].includes(status)
    || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || workOrderIssue !== issueNumber
    || !["AUTOPILOT_TYPESCRIPT", "RESEARCH", "GENERAL"].includes(String(capability))
    || !canonicalOwner || !OWNER.test(canonicalOwner)) {
    throw new Error("CODEX_WORK_ORDER_SELECTION_INVALID");
  }
  if (workOrder.canonical_issue !== undefined && workOrder.canonical_issue !== null && Number(workOrder.canonical_issue) !== issueNumber) return null;
  if (WORK_ORDER_LINK_FIELDS.some((key) => nonEmptyReference(workOrder[key]))
    || SELECTION_LINK_FIELDS.some((key) => nonEmptyReference(selection[key]))) return null;
  const dependencies = parseStringList(workOrder.dependencies, "CODEX_WORK_ORDER_DEPENDENCIES_INCOMPLETE");
  const selectedDependencies = parseStringList(selection.dependencies, "CODEX_WORK_ORDER_DEPENDENCIES_INCOMPLETE");
  const linkedIssues = parseStringList(selection.linkedIssues, "CODEX_WORK_ORDER_LINKED_ISSUES_INCOMPLETE");
  const linkedPullRequests = parseStringList(selection.linkedPullRequests, "CODEX_WORK_ORDER_LINKED_PRS_INCOMPLETE");
  if (dependencies.length > 0 || selectedDependencies.length > 0 || linkedIssues.length > 0 || linkedPullRequests.length > 0) return null;
  const conflictKeys = parseConflictKeys(selection.conflictKeys);
  const workOrderCanonicalOwner = text(workOrder.canonical_owner);
  if (workOrderCanonicalOwner && workOrderCanonicalOwner !== canonicalOwner) return null;
  if (workOrder.canonical_owners !== undefined) {
    const owners = parseStringList(workOrder.canonical_owners, "CODEX_WORK_ORDER_METADATA_INVALID");
    if (owners.length !== 1 || owners[0] !== canonicalOwner) return null;
  }
  const rootConflictKeys = workOrder.conflictKeys ?? workOrder.conflict_keys;
  if (rootConflictKeys !== undefined && !sameStrings(parseConflictKeys(rootConflictKeys), conflictKeys)) return null;
  const target = selection.codingTarget;
  if (target !== undefined && (typeof target !== "string" || !CODING_TARGET.test(target) || target.endsWith(".test.ts") || target.endsWith(".d.ts"))) {
    throw new Error("CODEX_WORK_ORDER_CODING_TARGET_INVALID");
  }
  return Object.freeze({
    id,
    issueNumber,
    blobSha: file.file.sha,
    path: file.file.path,
    capability: capability as GithubIssueCapability,
    canonicalOwner,
    conflictKeys,
    ...(typeof target === "string" ? { codingTarget: target } : {}),
  });
}

async function fetchTree(
  repository: Readonly<{ owner: string; name: string }>,
  mainSha: string,
  headers: HeadersInit,
  fetchImpl: GithubFetch,
): Promise<Readonly<{ treeSha: string; files: readonly TreeBlob[] }>> {
  const commit = validResponseObject(await fetchJson(fetchImpl, `${GITHUB_API}/repos/${repository.owner}/${repository.name}/git/commits/${mainSha}`, headers), "CODEX_WORK_ORDER_COMMIT_RESPONSE_INVALID");
  const commitSha = text(commit.sha)?.toLowerCase();
  const treeSha = text(object(commit.tree)?.sha)?.toLowerCase();
  if (commitSha !== mainSha || !treeSha || !SHA1.test(treeSha)) throw new Error("CODEX_WORK_ORDER_COMMIT_IDENTITY_MISMATCH");
  const tree = validResponseObject(await fetchJson(fetchImpl, `${GITHUB_API}/repos/${repository.owner}/${repository.name}/git/trees/${treeSha}?recursive=1`, headers), "CODEX_WORK_ORDER_TREE_RESPONSE_INVALID");
  if (String(tree.sha).toLowerCase() !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error("CODEX_WORK_ORDER_TREE_INCOMPLETE");
  }
  return Object.freeze({ treeSha, files: workOrderPaths(tree.tree) });
}

const ISSUE_AND_TIMELINE_QUERY = `query CodexWorkOrderIssue($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      __typename number title body state authorAssociation createdAt updatedAt
      labels(first: 100) { edges { node { name } } pageInfo { hasNextPage } }
      timelineItems(first: ${PAGE_SIZE}, after: $after, itemTypes: [CROSS_REFERENCED_EVENT]) {
        edges { cursor node { ... on CrossReferencedEvent { source { __typename ... on PullRequest { number title body state createdAt updatedAt } ... on Issue { number title body state createdAt updatedAt } } } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

type IssueScan = Readonly<{ issue: JsonObject; linkedOpenPulls: readonly JsonObject[]; linkedReferenceCount: number; crossReferenceDigest: string }>;

async function scanIssueAndCrossReferences(
  repository: Readonly<{ owner: string; name: string }>,
  issueNumber: number,
  headers: HeadersInit,
  fetchImpl: GithubFetch,
): Promise<IssueScan> {
  let after: string | null = null;
  const seenCursors = new Set<string>();
  const linkedOpenPulls: JsonObject[] = [];
  const linkedReferences: JsonObject[] = [];
  const linkedKeys = new Set<string>();
  let issueSnapshot: JsonObject | null = null;
  for (let page = 1; page <= MAX_TIMELINE_PAGES; page += 1) {
    const graphHeaders = new Headers(headers);
    graphHeaders.set("content-type", "application/json");
    const response = await fetchImpl(GITHUB_GRAPHQL_API, {
      method: "POST",
      headers: graphHeaders,
      body: JSON.stringify({ query: ISSUE_AND_TIMELINE_QUERY, variables: { owner: repository.owner, name: repository.name, number: issueNumber, after } }),
    });
    if (!response.ok) throw new Error(`CODEX_WORK_ORDER_GITHUB_UNAVAILABLE:${response.status}`);
    const root = validResponseObject(await response.json(), "CODEX_WORK_ORDER_ISSUE_RESPONSE_INVALID");
    if (Object.hasOwn(root, "errors") && (!Array.isArray(root.errors) || root.errors.length > 0)) throw new Error("CODEX_WORK_ORDER_ISSUE_LOOKUP_FAILED");
    const repo = validResponseObject(object(root.data)?.repository, "CODEX_WORK_ORDER_ISSUE_RESPONSE_INVALID");
    const issue = object(repo.issue);
    if (!issue || issue.__typename !== "Issue" || issue.number !== issueNumber) throw new Error("CODEX_WORK_ORDER_ISSUE_NOT_FOUND");
    const labels = object(issue.labels);
    const labelEdges = labels?.edges;
    if (!Array.isArray(labelEdges) || object(labels?.pageInfo)?.hasNextPage !== false) throw new Error("CODEX_WORK_ORDER_ISSUE_LABELS_INCOMPLETE");
    if (issueSnapshot === null) {
      const createdAt = text(issue.createdAt);
      const updatedAt = text(issue.updatedAt);
      const title = text(issue.title);
      if (!createdAt || !updatedAt || !title || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))
        || (issue.body !== null && typeof issue.body !== "string") || typeof issue.state !== "string" || typeof issue.authorAssociation !== "string") {
        throw new Error("CODEX_WORK_ORDER_ISSUE_INVALID");
      }
      const names = labelEdges.map((edge) => text(object(object(edge)?.node)?.name));
      if (names.some((name) => !name)) throw new Error("CODEX_WORK_ORDER_ISSUE_LABELS_INVALID");
      issueSnapshot = {
        number: issue.number,
        title,
        body: issue.body ?? "",
        state: issue.state.toLowerCase(),
        author_association: issue.authorAssociation,
        created_at: createdAt,
        updated_at: updatedAt,
        labels: names.map((name) => ({ name })),
      };
    } else if (issueSnapshot.updated_at !== issue.updatedAt || issueSnapshot.title !== issue.title || issueSnapshot.body !== (issue.body ?? "")
      || issueSnapshot.state !== String(issue.state).toLowerCase() || issueSnapshot.author_association !== issue.authorAssociation) {
      throw new Error("CODEX_WORK_ORDER_ISSUE_CHANGED_DURING_LOOKUP");
    }
    const timeline = object(issue.timelineItems);
    const edges = timeline?.edges;
    const pageInfo = object(timeline?.pageInfo);
    if (!Array.isArray(edges) || typeof pageInfo?.hasNextPage !== "boolean") throw new Error("CODEX_WORK_ORDER_TIMELINE_INCOMPLETE");
    const pageCursors = new Set<string>();
    for (const edgeValue of edges) {
      const edge = object(edgeValue);
      const cursor = text(edge?.cursor);
      const event = object(edge?.node);
      const source = object(event?.source);
      if (!cursor || !event || !source || pageCursors.has(cursor) || seenCursors.has(cursor)) throw new Error("CODEX_WORK_ORDER_TIMELINE_EVENT_INVALID");
      pageCursors.add(cursor);
      seenCursors.add(cursor);
      if (source.__typename !== "PullRequest" && source.__typename !== "Issue") throw new Error("CODEX_WORK_ORDER_CROSS_REFERENCE_SOURCE_INVALID");
      if (!Number.isSafeInteger(source.number) || Number(source.number) < 1 || typeof source.state !== "string"
        || typeof source.title !== "string" || (source.body !== null && typeof source.body !== "string")
        || typeof source.createdAt !== "string" || typeof source.updatedAt !== "string") throw new Error("CODEX_WORK_ORDER_PULL_REQUEST_INVALID");
      const key = `${source.__typename}:${source.number}:${source.updatedAt}:${source.state}`;
      if (linkedKeys.has(key)) continue;
      linkedKeys.add(key);
      const linkedReference = {
        type: source.__typename,
        number: source.number,
        title: source.title,
        body: source.body ?? "",
        state: source.state,
        created_at: source.createdAt,
        updated_at: source.updatedAt,
      };
      linkedReferences.push(linkedReference);
      if (source.__typename === "PullRequest" && source.state === "OPEN") linkedOpenPulls.push({
        ...linkedReference,
        body: `${linkedReference.body}\nCross-referenced issue #${issueNumber}`,
        state: "open",
      });
    }
    const endCursor = pageInfo.endCursor;
    if (edges.length === 0) {
      if (pageInfo.hasNextPage || endCursor !== null) throw new Error("CODEX_WORK_ORDER_TIMELINE_CURSOR_INVALID");
    } else {
      if (typeof endCursor !== "string" || endCursor !== edges.at(-1)?.cursor || endCursor === after) throw new Error("CODEX_WORK_ORDER_TIMELINE_CURSOR_INVALID");
      for (const cursor of pageCursors) if (cursor === after) throw new Error("CODEX_WORK_ORDER_TIMELINE_CURSOR_REPEATED");
    }
    if (!pageInfo.hasNextPage) break;
    if (edges.length === 0 || typeof endCursor !== "string" || page === MAX_TIMELINE_PAGES) throw new Error("CODEX_WORK_ORDER_TIMELINE_LIMIT_EXCEEDED");
    after = endCursor;
  }
  if (!issueSnapshot) throw new Error("CODEX_WORK_ORDER_ISSUE_LOOKUP_FAILED");
  const digestInput = JSON.stringify({ issue: issueSnapshot, linkedReferences: [...linkedReferences].sort((a, b) => Number(a.number) - Number(b.number) || String(a.type).localeCompare(String(b.type))) });
  const digest = await sha256Hex(digestInput);
  return Object.freeze({ issue: Object.freeze(issueSnapshot), linkedOpenPulls: Object.freeze(linkedOpenPulls), linkedReferenceCount: linkedReferences.length, crossReferenceDigest: digest });
}

async function stableIssueAndCrossReferences(
  repository: Readonly<{ owner: string; name: string }>,
  issueNumber: number,
  headers: HeadersInit,
  fetchImpl: GithubFetch,
): Promise<IssueScan> {
  const first = await scanIssueAndCrossReferences(repository, issueNumber, headers, fetchImpl);
  const second = await scanIssueAndCrossReferences(repository, issueNumber, headers, fetchImpl);
  if (JSON.stringify(first.issue) !== JSON.stringify(second.issue)
    || JSON.stringify(first.linkedOpenPulls) !== JSON.stringify(second.linkedOpenPulls)
    || first.linkedReferenceCount !== second.linkedReferenceCount
    || first.crossReferenceDigest !== second.crossReferenceDigest) {
    throw new Error("CODEX_WORK_ORDER_ISSUE_SNAPSHOT_CHANGED");
  }
  return second;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export async function codexWorkOrderTaskSnapshotDigest(task: CodexWorkOrderTask): Promise<string> {
  return sha256Hex(JSON.stringify({
    task: codexBacklogTaskSnapshot(task.task),
    source: task.source,
  }));
}

export async function fetchVerifiedCodexWorkOrderInventory(
  repositoryName: string,
  expectedMainSha: string,
  headers: HeadersInit,
  fetchImpl: GithubFetch = fetch,
): Promise<VerifiedCodexWorkOrderInventory> {
  const repository = parseGithubRepository(repositoryName);
  const mainSha = expectedMainSha.toLowerCase();
  if (!SHA1.test(mainSha)) throw new Error("CODEX_WORK_ORDER_MAIN_SHA_INVALID");
  if (await fetchProtectedMainSha(repositoryName, headers, fetchImpl) !== mainSha) throw new Error("CODEX_WORK_ORDER_MAIN_CHANGED");
  const { treeSha, files } = await fetchTree(repository, mainSha, headers, fetchImpl);
  const workOrders = await fetchWorkOrderBlobs(repository, mainSha, files, headers, fetchImpl);
  const selections = workOrders.map(parseReadySelection).filter((value): value is WorkOrderSelection => value !== null);
  if (selections.length > MAX_READY_WORK_ORDERS) throw new Error("CODEX_WORK_ORDER_READY_LIMIT_EXCEEDED");
  const duplicateIssues = new Set<number>();
  const duplicateIds = new Set<string>();
  const issuesByNumber = new Map<number, WorkOrderSelection>();
  const ids = new Set<string>();
  for (const selection of selections) {
    if (issuesByNumber.has(selection.issueNumber)) duplicateIssues.add(selection.issueNumber);
    if (ids.has(selection.id)) duplicateIds.add(selection.id);
    ids.add(selection.id);
    issuesByNumber.set(selection.issueNumber, selection);
  }
  if (duplicateIssues.size > 0 || duplicateIds.size > 0) throw new Error("CODEX_WORK_ORDER_SELECTION_DUPLICATED");

  const issueResults: Array<Readonly<{ selection: WorkOrderSelection; scan: IssueScan }>> = [];
  for (const selection of selections) {
    issueResults.push(Object.freeze({
      selection,
      scan: await stableIssueAndCrossReferences(repository, selection.issueNumber, headers, fetchImpl),
    }));
  }
  const issueSnapshots: unknown[] = [];
  const openPulls: unknown[] = [];
  const scanByIssue = new Map<number, IssueScan>();
  for (const result of issueResults) {
    if (result.scan.linkedReferenceCount > 0) throw new Error("CODEX_WORK_ORDER_LINKED_EVIDENCE_INCOMPLETE");
    issueSnapshots.push(result.scan.issue);
    openPulls.push(...result.scan.linkedOpenPulls);
    scanByIssue.set(result.selection.issueNumber, result.scan);
  }
  const selected = selectCodexBacklogTask(issueSnapshots, openPulls);
  if (selected) {
    const selection = issuesByNumber.get(selected.issueNumber);
    const scan = scanByIssue.get(selected.issueNumber);
    if (!selection || !scan || selected.capability !== selection.capability || selected.canonicalOwner !== selection.canonicalOwner
      || !sameStrings(selected.conflictKeys, selection.conflictKeys)
      || (selection.codingTarget !== undefined && !selected.body.split(/\r?\n/).some((line) => line.trim() === `codingTarget: ${selection.codingTarget}`))) {
      throw new Error("CODEX_WORK_ORDER_ISSUE_METADATA_MISMATCH");
    }
  }
  if (await fetchProtectedMainSha(repositoryName, headers, fetchImpl) !== mainSha) throw new Error("CODEX_WORK_ORDER_MAIN_CHANGED");
  const selection = selected ? issuesByNumber.get(selected.issueNumber) : null;
  const scan = selected ? scanByIssue.get(selected.issueNumber) : null;
  const task: CodexWorkOrderTask | null = selected && selection && scan ? Object.freeze({
    task: selected,
    source: Object.freeze({
      mainSha,
      treeSha,
      workOrderId: selection.id,
      workOrderPath: selection.path,
      workOrderBlobSha: selection.blobSha,
      issueCrossReferenceDigest: scan.crossReferenceDigest,
    }),
  }) : null;
  return Object.freeze({
    task,
    consistency: Object.freeze({
      source: "PROTECTED_MAIN_AIPOS_WORK_ORDERS" as const,
      mainSha,
      treeSha,
      completeWorkOrderCount: files.length,
      readyWorkOrderCount: selections.length,
      automaticSelectionAllowed: true as const,
    }),
  });
}
