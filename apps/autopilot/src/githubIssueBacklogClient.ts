const GITHUB_API = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_BACKLOG_PAGES = 10;

type GithubFetch = (input: string, init?: RequestInit) => Promise<Response>;
type GithubResource = "issues" | "pulls";

function hasNextPage(response: Response, recordCount: number): boolean {
  const link = response.headers.get("link");
  if (link !== null) {
    const relations = [...link.matchAll(/<[^>]+>;\s*rel="(first|prev|next|last)"/gi)];
    if (relations.length === 0) throw new Error("GitHub backlog pagination metadata invalid");
    return relations.some((relation) => relation[1]?.toLowerCase() === "next");
  }
  return recordCount === PAGE_SIZE;
}

async function fetchOpenRecords(
  repository: string,
  resource: GithubResource,
  headers: HeadersInit,
  fetchImpl: GithubFetch,
): Promise<readonly unknown[]> {
  const records: unknown[] = [];
  const seenNumbers = new Set<number>();

  for (let page = 1; page <= MAX_BACKLOG_PAGES; page += 1) {
    const url = `${GITHUB_API}/repos/${repository}/${resource}?state=open&per_page=${PAGE_SIZE}&page=${page}&sort=created&direction=asc`;
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`GitHub ${resource} backlog unavailable (${response.status})`);
    const value: unknown = await response.json();
    if (!Array.isArray(value) || value.length > PAGE_SIZE) {
      throw new Error(`GitHub ${resource} backlog response invalid`);
    }

    for (const entry of value) {
      const number = typeof entry === "object" && entry !== null ? (entry as { number?: unknown }).number : undefined;
      if (typeof number !== "number" || !Number.isSafeInteger(number)) {
        throw new Error(`GitHub ${resource} backlog entry invalid`);
      }
      if (number < 1 || seenNumbers.has(number)) throw new Error(`GitHub ${resource} backlog identity ambiguous`);
      seenNumbers.add(number);
      records.push(entry);
    }

    if (!hasNextPage(response, value.length)) return Object.freeze(records);
    if (page === MAX_BACKLOG_PAGES) throw new Error(`GitHub ${resource} backlog exceeds bounded pagination`);
  }

  throw new Error(`GitHub ${resource} backlog unavailable`);
}

/** An offset page can skip an open record when earlier records close during a scan.
 * Require two matching complete scans, including all selection-relevant metadata.
 * An unstable inventory is not an authorization to dispatch Codex.
 */
async function fetchStableOpenRecords(
  repository: string,
  resource: GithubResource,
  headers: HeadersInit,
  fetchImpl: GithubFetch,
): Promise<readonly unknown[]> {
  const first = await fetchOpenRecords(repository, resource, headers, fetchImpl);
  const second = await fetchOpenRecords(repository, resource, headers, fetchImpl);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`GitHub ${resource} backlog changed during pagination`);
  }
  return second;
}

/** Fetches a bounded, cross-checked open issue and pull-request inventory used by Codex selection. */
export async function fetchOpenGithubBacklog(
  repository: string,
  headers: HeadersInit,
  fetchImpl: GithubFetch = fetch,
): Promise<{ readonly issues: readonly unknown[]; readonly pulls: readonly unknown[] }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GitHub backlog repository invalid");
  }
  const [issues, pulls] = await Promise.all([
    fetchStableOpenRecords(repository, "issues", headers, fetchImpl),
    fetchStableOpenRecords(repository, "pulls", headers, fetchImpl),
  ]);
  return Object.freeze({ issues, pulls });
}
