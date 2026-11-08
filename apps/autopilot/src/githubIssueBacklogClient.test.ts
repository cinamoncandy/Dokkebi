import assert from "node:assert/strict";
import test from "node:test";
import { selectCodexBacklogTask } from "./evolveGithubIssueBacklog";
import { fetchOpenGithubBacklog } from "./githubIssueBacklogClient";

function response(body: unknown, link?: string, status = 200): Response {
  const headers = new Headers();
  if (link !== undefined) headers.set("link", link);
  return new Response(JSON.stringify(body), { status, headers });
}

test("backlog fetch reads later issue pages and stable pull-request pages", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    if (url.includes("/issues?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return page === 1
        ? response(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })), '<https://api.github.com/next>; rel="next"')
        : response([{
          number: 101,
          title: "[P0] Research backlog task",
          body: "Research evidence. Safety: liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: research-owner\nconflictKeys: research:history",
          state: "open",
          author_association: "OWNER",
          updated_at: "2026-11-01T00:00:00.000Z",
          labels: [],
        }]);
    }
    return response([{ number: 201 }]);
  };

  const result = await fetchOpenGithubBacklog("cinamoncandy/NUSA", { authorization: "Bearer test-token" }, fetchImpl);
  assert.equal(result.issues.length, 101);
  assert.equal(result.pulls.length, 1);
  assert.equal(selectCodexBacklogTask(result.issues, result.pulls)?.issueNumber, 101, "a real eligible task beyond page one remains selectable");
  assert.ok(calls.some((url) => url.includes("/issues?") && url.includes("page=2")));
  assert.ok(calls.every((url) => url.includes("sort=created&direction=asc")));
});

test("a full page without Link metadata is followed, then stops on a short page", async () => {
  let issuePage = 0;
  const result = await fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => {
    if (String(input).includes("/pulls?")) return response([]);
    issuePage += 1;
    return issuePage % 2 === 1
      ? response(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })))
      : response([{ number: 101 }]);
  });
  assert.equal(issuePage, 4);
  assert.equal(result.issues.length, 101);
});

test("a linked pull request beyond page one still blocks duplicate task selection", async () => {
  const issues = [{
    number: 42,
    title: "[P1] Autopilot task",
    body: "Autopilot control-plane task. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY.\ncanonicalOwner: apps-autopilot\nconflictKeys: issue:42",
    state: "open",
    author_association: "OWNER",
    updated_at: "2026-11-01T00:00:00.000Z",
    labels: [],
  }];
  const result = await fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => {
    const url = String(input);
    if (url.includes("/issues?")) return response(issues);
    const page = Number(new URL(url).searchParams.get("page"));
    return page === 1
      ? response(Array.from({ length: 100 }, (_, index) => ({ number: index + 101, title: "unrelated", body: "" })), '<https://api.github.com/next>; rel="next"')
      : response([{ number: 201, title: "issue reference", body: "Refs #42" }]);
  });

  assert.equal(result.pulls.length, 101);
  assert.equal(selectCodexBacklogTask(result.issues, result.pulls), null, "the later open PR is included in duplicate prevention");
});

test("backlog fetch fails closed on API errors, malformed bodies, duplicate identities and page overflow", async () => {
  await assert.rejects(
    fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => String(input).includes("/issues?") ? response([], undefined, 403) : response([])),
    /unavailable \(403\)/,
  );
  await assert.rejects(
    fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => response(String(input).includes("/issues?") ? { items: [] } : [])),
    /response invalid/,
  );
  await assert.rejects(
    fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => response(String(input).includes("/issues?") ? [{ number: 1 }, { number: 1 }] : [])),
    /identity ambiguous/,
  );
  await assert.rejects(
    fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async () => response([{ number: 1 }], "malformed-pagination")),
    /pagination metadata invalid/,
  );

  let issuePage = 0;
  await assert.rejects(
    fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => {
      if (String(input).includes("/pulls?")) return response([]);
      issuePage += 1;
      return response(Array.from({ length: 100 }, (_, index) => ({ number: (issuePage - 1) * 100 + index + 1 })), '<https://api.github.com/next>; rel="next"');
    }),
    /exceeds bounded pagination/,
  );
  assert.equal(issuePage, 10);
});

test("offset page shift caused by an intervening close fails closed rather than silently omitting a linked PR", async () => {
  let pullScan = 0;
  await assert.rejects(
    fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => {
      const url = String(input);
      if (url.includes("/issues?")) return response([]);
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) {
        pullScan += 1;
        // A PR ahead of the boundary closes between page one and page two.
        const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
        return response(pullScan === 1 ? firstPage : firstPage.slice(1).concat({ number: 101 }), '<https://api.github.com/next>; rel="next"');
      }
      return response(pullScan === 1 ? [{ number: 102 }] : [{ number: 102 }, { number: 103 }]);
    }),
    /backlog changed during pagination/,
  );
});

test("changes to selection metadata between complete scans fail closed", async () => {
  let issueReads = 0;
  await assert.rejects(
    fetchOpenGithubBacklog("cinamoncandy/NUSA", {}, async (input) => {
      if (String(input).includes("/pulls?")) return response([]);
      issueReads += 1;
      return response([{ number: 42, title: "Task", body: issueReads === 1 ? "old" : "new" }]);
    }),
    /backlog changed during pagination/,
  );
});
