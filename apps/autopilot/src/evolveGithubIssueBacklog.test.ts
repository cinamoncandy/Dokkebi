import test from "node:test";
import assert from "node:assert/strict";
import { codexBacklogTaskSnapshot, deriveGithubIssueBacklogReadiness, selectCodexBacklogTask, selectStalenessProbePulls } from "./evolveGithubIssueBacklog";

const NOW = new Date("2026-09-17T08:00:00.000Z");
const SAFETY = "Safety invariants: liveAuthority=NONE, productionMutationAllowed=false, aiAuthority=ZERO_AUTHORITY. No LIVE activation or real broker mutation.";

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 903,
    title: "P1: Autonomous Development Control Plane for maximum verified merge throughput",
    body: `Implement bounded Autopilot control-plane work. ${SAFETY}\ncanonicalOwner: evolve\nconflictKeys: issue:903`,
    state: "open",
    author_association: "OWNER",
    labels: [],
    updated_at: "2026-09-17T07:50:00.000Z",
    ...overrides,
  };
}

test("backlog readiness surfaces owner-authored safety-bounded P0/P1 Autopilot work", () => {
  const result = deriveGithubIssueBacklogReadiness([issue()], [], NOW);
  assert.equal(result.eligibleIssueCount, 1);
  assert.deepEqual(result.signals.map((signal) => signal.id), ["github-issue-903"]);
});

test("Codex task snapshot binds prompt, ownership, conflict keys, and eligibility metadata", () => {
  const selected = selectCodexBacklogTask([issue()], []);
  assert.ok(selected);
  const baseline = codexBacklogTaskSnapshot(selected);

  for (const changed of [
    issue({ title: "P0: Autopilot changed priority prompt" }),
    issue({ body: `${String(issue().body)}\nchanged prompt` }),
    issue({ body: String(issue().body).replace("canonicalOwner: evolve", "canonicalOwner: research") }),
    issue({ body: String(issue().body).replace("conflictKeys: issue:903", "conflictKeys: issue:904") }),
    issue({ updated_at: "2026-09-17T07:51:00.000Z" }),
    issue({ labels: [{ name: "RESEARCH-READY" }] }),
  ]) {
    const changedSelection = selectCodexBacklogTask([changed], []);
    assert.ok(changedSelection);
    assert.notEqual(codexBacklogTaskSnapshot(changedSelection), baseline);
  }

  for (const ineligible of [
    issue({ state: "closed" }),
    issue({ author_association: "CONTRIBUTOR" }),
    issue({ labels: [{ name: "HOLD" }] }),
  ]) {
    assert.equal(selectCodexBacklogTask([ineligible], []), null);
  }
  assert.equal(selectCodexBacklogTask([issue()], [{ title: "work #903", body: "" }]), null);
});

test("backlog readiness counts all eligible work but dispatch signal stays bounded to one", () => {
  const result = deriveGithubIssueBacklogReadiness([
    issue({ number: 903 }),
    issue({ number: 1900, title: "P0: AUTOPILOT exact-head recovery", updated_at: "2026-09-17T07:40:00.000Z" }),
  ], [], NOW);
  assert.equal(result.eligibleIssueCount, 2);
  assert.deepEqual(result.signals.map((signal) => signal.id), ["github-issue-1900"]);
});

test("unsupported research and general work stays visible but cannot enter CodingRunner READY", () => {
  const result = deriveGithubIssueBacklogReadiness([
    issue({ number: 1901, title: "P1: Research OOS robustness evidence", body: SAFETY }),
    issue({ number: 1902, title: "P1: Mobile UI release regression", body: SAFETY }),
    issue({ number: 1903, title: "P1: AUTOPILOT bounded coding fix" }),
  ], [], NOW);
  assert.equal(result.eligibleIssueCount, 1);
  assert.equal(result.capabilityBlockedIssueCount, 2);
  assert.deepEqual(result.capabilityBlockedCapabilities, { RESEARCH: 1, GENERAL: 1, UNKNOWN: 0 });
  assert.deepEqual(result.signals.map((signal) => signal.id), ["github-issue-1903"]);
});

test("HOLD and open-PR filters dominate before capability classification", () => {
  const result = deriveGithubIssueBacklogReadiness([
    issue({ number: 1901, title: "P1: Research OOS robustness evidence", labels: [{ name: "HOLD" }] }),
    issue({ number: 1902, title: "P1: Mobile UI release regression" }),
  ], [{ title: "fix: mobile", body: "Fixes #1902" }], NOW);
  assert.equal(result.eligibleIssueCount, 0);
  assert.equal(result.capabilityBlockedIssueCount, 0);
});

test("backlog readiness excludes HOLD, BLOCKED_HUMAN and REWORK labels", () => {
  const blocked = [
    issue({ number: 1, labels: [{ name: "HOLD" }] }),
    issue({ number: 2, labels: [{ name: "BLOCKED_HUMAN" }] }),
    issue({ number: 3, labels: [{ name: "REWORK" }] }),
  ];
  assert.equal(deriveGithubIssueBacklogReadiness(blocked, [], NOW).eligibleIssueCount, 0);
});

test("backlog readiness excludes issue referenced by any open PR", () => {
  for (const pull of [
    { title: "fix: sticky hold", body: "Fixes #903" },
    { title: "control-plane containment #903", body: "No closing keyword." },
  ]) {
    const result = deriveGithubIssueBacklogReadiness([issue()], [pull], NOW);
    assert.equal(result.eligibleIssueCount, 0);
    assert.deepEqual(result.signals, []);
  }
});

test("verified stale linked PR permits one latest-main successor while unknown evidence still blocks", () => {
  const stale = deriveGithubIssueBacklogReadiness(
    [issue()],
    [{ title: "fix: stale control plane", body: "Refs #903", nusa_stale_against_main: true }],
    NOW,
  );
  assert.equal(stale.eligibleIssueCount, 1);
  assert.deepEqual(stale.signals.map((signal) => signal.id), ["github-issue-903"]);

  const unknown = deriveGithubIssueBacklogReadiness(
    [issue()],
    [{ title: "fix: unknown control plane", body: "Refs #903" }],
    NOW,
  );
  assert.equal(unknown.eligibleIssueCount, 0);
  assert.deepEqual(unknown.signals, []);
});

test("one fresh linked PR still blocks when another linked PR is verified stale", () => {
  const result = deriveGithubIssueBacklogReadiness(
    [issue()],
    [
      { title: "fix: stale predecessor", body: "Refs #903", nusa_stale_against_main: true },
      { title: "fix: current successor", body: "Refs #903" },
    ],
    NOW,
  );
  assert.equal(result.eligibleIssueCount, 0);
  assert.deepEqual(result.signals, []);
});

test("backlog readiness fails closed for PR wrappers, untrusted authors, unsafe and unrelated work", () => {
  const unsafe = [
    issue({ pull_request: { url: "https://api.github.com/pulls/1" } }),
    issue({ author_association: "NONE" }),
    issue({ body: "Autopilot work without authority invariants." }),
    issue({ title: "P1: unrelated cloud deployment", body: SAFETY }),
    issue({ state: "closed" }),
    issue({ title: "P2: AUTOPILOT cleanup" }),
    issue({ body: `Autopilot work. ${SAFETY} productionMutationAllowed=true` }),
  ];
  assert.equal(deriveGithubIssueBacklogReadiness(unsafe, [], NOW).eligibleIssueCount, 0);
});


test("backlog preserves explicit deterministic ownership and conflict metadata", () => {
  const result = deriveGithubIssueBacklogReadiness([
    issue({ body: `Implement bounded Autopilot control-plane work. ${SAFETY}\ncanonicalOwner: evolve\nconflictKeys: issue:903,module:apps/autopilot/src` }),
  ], [], NOW);
  assert.equal(result.eligibleIssueCount, 1);
  assert.equal(result.signals[0]?.canonicalOwner, "evolve");
  assert.deepEqual(result.signals[0]?.conflictKeys, ["issue:903", "module:apps/autopilot/src"]);
});

test("backlog skips a higher-priority issue without WIP metadata and selects actionable work", () => {
  const result = deriveGithubIssueBacklogReadiness([
    issue({ number: 910, title: "[P0][Autopilot] unclaimed work", body: `Autopilot work. ${SAFETY}` }),
    issue({ number: 911, title: "[P1][Autopilot] claimed work", body: `Autopilot work. ${SAFETY}\ncanonicalOwner: evolve\nconflictKeys: issue:911` }),
  ], [], NOW);
  assert.equal(result.eligibleIssueCount, 1);
  assert.deepEqual(result.signals.map((signal) => signal.id), ["github-issue-911"]);
});

test("adjacent bracketed P0 metadata from the canonical issue title is dispatchable", () => {
  const result = deriveGithubIssueBacklogReadiness([
    issue({ title: "[P0][CI] Fast CI critical-path optimization for Autopilot throughput" }),
  ], [], NOW);
  assert.deepEqual(result.signals.map((signal) => signal.id), ["github-issue-903"]);
});

test("backlog rejects malformed explicit work metadata fail closed", () => {
  const invalid = [
    issue({ number: 910, body: `Autopilot work. ${SAFETY}\ncanonicalOwner: bad owner\nconflictKeys: issue:910` }),
    issue({ number: 911, body: `Autopilot work. ${SAFETY}\ncanonicalOwner: evolve\nconflictKeys: bad conflict` }),
    issue({ number: 912, body: `Autopilot work. ${SAFETY}\ncanonicalOwner: evolve\nconflictKeys: issue:912,issue:912` }),
  ];
  assert.equal(deriveGithubIssueBacklogReadiness(invalid, [], NOW).eligibleIssueCount, 0);
});

test("an explicit codingTarget line reaches the selected problem, and its absence changes nothing", () => {
  const plain = deriveGithubIssueBacklogReadiness([issue()], [], NOW).signals[0]!;
  assert.doesNotMatch(plain.problem, /Target file:/);

  const targeted = deriveGithubIssueBacklogReadiness([
    issue({ body: `Implement bounded Autopilot control-plane work.\ncodingTarget: apps/autopilot/src/auditRunner.ts\n${SAFETY}\ncanonicalOwner: evolve\nconflictKeys: issue:903` }),
  ], [], NOW).signals[0]!;
  assert.match(targeted.problem, / Target file: apps\/autopilot\/src\/auditRunner\.ts\.$/);
  assert.equal(targeted.problem.replace(/ Target file: .*$/, ""), plain.problem, "the rest of the problem is unchanged");
});

test("a repeated or out-of-scope codingTarget makes the issue ineligible rather than reaching the runner", () => {
  for (const target of [
    "apps/autopilot/src/auditRunner.ts\ncodingTarget: apps/autopilot/src/codingRunner.ts",
    "apps/autopilot/src/index.ts",
    "apps/autopilot/src/worker.ts",
    "apps/autopilot/src/codingRunner.test.ts",
    "apps/autopilot/src/types.d.ts",
    "apps/autopilot/src/broker/adapter.ts",
    "apps/autopilot/src/../../cloud/src/runtime.ts",
    "apps/cloud/src/runtime.ts",
    ".github/workflows/ci.yml",
  ]) {
    const result = deriveGithubIssueBacklogReadiness([
      issue({ body: `Implement bounded Autopilot control-plane work.\ncodingTarget: ${target}\n${SAFETY}\ncanonicalOwner: evolve\nconflictKeys: issue:903` }),
    ], [], NOW);
    assert.equal(result.eligibleIssueCount, 0, `accepted codingTarget ${JSON.stringify(target)}`);
    assert.deepEqual(result.signals, []);
  }
});

test("staleness probes are limited to PRs linking otherwise-eligible issues and capped", () => {
  const linked = (n: number) => ({ title: `fix: work ${n}`, body: "Refs #903" });
  const unrelated = { title: "feat(mobile): icon", body: "No issue link" };
  const ineligibleLink = { title: "fix: other", body: "Refs #1" };
  const pulls = [unrelated, ineligibleLink, ...Array.from({ length: 12 }, (_, i) => linked(i))];
  const selected = selectStalenessProbePulls([issue()], pulls, 8);
  assert.equal(selected.size, 8);
  assert.ok(!selected.has(unrelated));
  assert.ok(!selected.has(ineligibleLink));
  assert.equal(selectStalenessProbePulls([], pulls, 8).size, 0);
  assert.equal(selectStalenessProbePulls([issue({ labels: [{ name: "hold" }] })], pulls, 8).size, 0);
  assert.equal(selectStalenessProbePulls([issue()], pulls, 0).size, 0);
});
