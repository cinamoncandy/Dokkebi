import assert from "node:assert/strict";
import test from "node:test";
import { currentDiffEvidenceRefs, executeIndependentAudit, executeIndependentValidator, executeProviderGatedAudit, validateAuditModelVerdict, validateAuditRunnerRequest, type AuditRunnerRequest, type ValidatorRunnerRequest } from "./auditRunner";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const request: AuditRunnerRequest = Object.freeze({
  kind: "AUDIT_REQUEST",
  repository: "cinamoncandy/NUSA",
  prNumber: 1362,
  headSha: HEAD,
  baseSha: BASE,
  workflowRunId: 33450000001,
  executionId: "audit:1362:33450000001",
  dedupeKey: `audit:1362:${HEAD}`,
  mutationAllowed: false,
  liveAuthority: "NONE",
  productionMutationAllowed: false,
  aiAuthority: "ZERO_AUTHORITY",
});

function response(status: number, payload: unknown, textValue?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return textValue ?? JSON.stringify(payload); },
  };
}

function pull(
  headSha = HEAD,
  baseSha = BASE,
  changedFiles = 1,
  headRepository = "cinamoncandy/NUSA",
  baseRepository = "cinamoncandy/NUSA",
) {
  return {
    state: "open",
    changed_files: changedFiles,
    head: { sha: headSha, repo: { full_name: headRepository } },
    base: { sha: baseSha, repo: { full_name: baseRepository } },
  };
}

function run(
  headSha = HEAD,
  id = request.workflowRunId,
  pullRequests: readonly { readonly number: number }[] = [{ number: request.prNumber }],
) {
  return {
    id,
    name: "CI",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    repository: { full_name: "cinamoncandy/NUSA" },
    pull_requests: pullRequests,
  };
}

function headPulls(entries: readonly unknown[] = [{
  number: request.prNumber,
  state: "open",
  head: { sha: HEAD, repo: { full_name: "fork-owner/NUSA" } },
  base: { repo: { full_name: "cinamoncandy/NUSA" } },
}]) {
  return entries;
}

function needsFallback(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pullRequests = (value as { pull_requests?: unknown }).pull_requests;
  if (!Array.isArray(pullRequests)) return true;
  const numbers = [...new Set(pullRequests
    .map((entry) => entry && typeof entry === "object" ? (entry as { number?: unknown }).number : null)
    .filter((number): number is number => Number.isSafeInteger(number) && Number(number) > 0))];
  return numbers.length !== 1 || numbers[0] !== request.prNumber;
}

function fetchSequence(options: {
  readonly firstPull?: unknown;
  readonly firstRun?: unknown;
  readonly firstHeadPulls?: readonly unknown[];
  readonly diff?: string;
  readonly changedFileEntries?: readonly unknown[];
  readonly secondPull?: unknown;
  readonly secondRun?: unknown;
  readonly secondHeadPulls?: readonly unknown[];
} = {}) {
  const firstRun = options.firstRun ?? run();
  const secondRun = options.secondRun ?? firstRun;
  const firstPull = options.firstPull ?? pull();
  const secondPull = options.secondPull ?? firstPull;
  const fileList = (value: unknown) => options.changedFileEntries ?? Array.from({ length: Number((value as { changed_files?: number }).changed_files ?? 1) }, (_, index) => ({ filename: index === 0 ? "a.ts" : `file-${index}.ts`, status: "modified" }));
  const queue = [
    response(200, firstPull),
    response(200, firstRun),
    ...(needsFallback(firstRun) ? [response(200, options.firstHeadPulls ?? headPulls())] : []),
    response(200, fileList(firstPull)),
    response(200, {}, options.diff ?? "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const safe = true;\n"),
    response(200, secondPull),
    response(200, secondRun),
    ...(needsFallback(secondRun) ? [response(200, options.secondHeadPulls ?? options.firstHeadPulls ?? headPulls())] : []),
    response(200, fileList(secondPull)),
  ];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  };
}

function ai(responseBody: unknown) {
  return {
    async run() { return responseBody; },
  };
}

function aiSequence(responses: readonly unknown[]) {
  const queue = [...responses];
  return {
    async run() {
      if (queue.length === 0) throw new Error("unexpected extra AI.run call");
      return queue.shift();
    },
  };
}

function passingModel() {
  return ai({ response: JSON.stringify({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true }) });
}

function auditEnv(model?: ReturnType<typeof ai>) {
  return { AI: model, NUSA_AUDIT_GITHUB_TOKEN: "github-token" };
}

test("validates the immutable read-only audit request contract", () => {
  const validated = validateAuditRunnerRequest(request);
  assert.equal(validated.headSha, HEAD);
  assert.equal(validated.baseSha, BASE);
  assert.equal(validated.mutationAllowed, false);
  assert.equal(validated.liveAuthority, "NONE");
  assert.equal(validated.productionMutationAllowed, false);
  assert.equal(validated.aiAuthority, "ZERO_AUTHORITY");
});

test("diff evidence binds deleted lines to the old path and resets at file boundaries", () => {
  const refs = currentDiffEvidenceRefs([
    "diff --git a/previous.ts b/previous.ts",
    "index 1111111..2222222 100644",
    "--- a/previous.ts",
    "+++ b/previous.ts",
    "@@ -1,2 +1,2 @@",
    "-removed from previous",
    "+replacement in previous",
    "diff --git a/deleted/security.ts b/deleted/security.ts",
    "deleted file mode 100644",
    "index 3333333..0000000",
    "--- a/deleted/security.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-removed safety check",
    "-removed authority guard",
    "diff --git a/new/module.ts b/new/module.ts",
    "new file mode 100644",
    "index 0000000..4444444",
    "--- /dev/null",
    "+++ b/new/module.ts",
    "@@ -0,0 +1,1 @@",
    "+new module",
    "",
  ].join("\n"));

  assert.ok(refs.has("previous.ts:-1"));
  assert.ok(refs.has("previous.ts:+1"));
  assert.ok(refs.has("deleted/security.ts:-1"));
  assert.ok(refs.has("deleted/security.ts:-2"));
  assert.ok(refs.has("new/module.ts:+1"));
  assert.ok(!refs.has("previous.ts:-3"));
});

test("hunkless rename metadata receives deterministic evidence refs without implying source-line evidence", () => {
  const diff = [
    "diff --git a/guards/old-name.ts b/guards/new-name.ts",
    "similarity index 100%",
    "rename from guards/old-name.ts",
    "rename to guards/new-name.ts",
    "",
  ].join("\n");
  const refs = currentDiffEvidenceRefs(diff, [{
    filename: "guards/new-name.ts",
    previousFilename: "guards/old-name.ts",
    status: "renamed",
  }]);
  assert.deepEqual([...refs], ["guards/old-name.ts:@metadata", "guards/new-name.ts:@metadata"]);
  assert.equal([...refs].some((ref) => /:[+-]\d+$/.test(ref)), false);
});

test("rejects control and line-separator characters in paths before evidence refs reach prompts", () => {
  for (const encodedPath of [String.raw`unsafe\012path.ts`, String.raw`unsafe\177path.ts`]) {
    const diff = `diff --git "a/${encodedPath}" "b/${encodedPath}"\nnew file mode 100644\n`;
    assert.throws(() => currentDiffEvidenceRefs(diff), /VALIDATOR_(?:REPOSITORY_PATH|DIFF_PATH)_INVALID/);
  }
  for (const separator of ["\u0085", "\u2028", "\u2029"]) {
    const diff = `diff --git a/unsafe${separator}path.ts b/unsafe${separator}path.ts\nnew file mode 100644\n`;
    assert.throws(() => currentDiffEvidenceRefs(diff), /VALIDATOR_(?:REPOSITORY_PATH|DIFF_PATH)_INVALID/);
  }
});

test("accepts a blocker grounded in exact hunkless rename metadata", async () => {
  const renameDiff = [
    "diff --git a/guards/old-name.ts b/guards/new-name.ts",
    "similarity index 100%",
    "rename from guards/old-name.ts",
    "rename to guards/new-name.ts",
    "",
  ].join("\n");
  const model = ai({ response: JSON.stringify({
    verdict: "FAIL",
    findings: [{ code: "P1_RENAMED_GUARD_PATH", severity: "BLOCKER", message: "A safety-critical file path changed without content hunks; inspect path consumers.", evidenceRef: "guards/new-name.ts:@metadata", evidenceScope: "FILE_METADATA" }],
    blockers: ["The renamed safety-critical path requires adjudication."],
    safetyInvariantResult: "FAIL",
    mergeAllowed: false,
  }) });
  const result = await executeIndependentAudit(request, auditEnv(model), fetchSequence({
    firstPull: pull(HEAD, BASE, 1),
    changedFileEntries: [{ filename: "guards/new-name.ts", previous_filename: "guards/old-name.ts", status: "renamed" }],
    diff: renameDiff,
  }) as never);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.mergeAllowed, false);
});

test("rejects source-content claims backed only by metadata evidence", async () => {
  const renameDiff = [
    "diff --git a/guards/old-name.ts b/guards/new-name.ts",
    "similarity index 100%",
    "rename from guards/old-name.ts",
    "rename to guards/new-name.ts",
    "",
  ].join("\n");
  const invalid = { response: JSON.stringify({
    verdict: "FAIL",
    findings: [{ code: "P1_SOURCE_CONTENT_REGRESSION", severity: "BLOCKER", message: "The renamed module contains an unsafe source implementation.", evidenceRef: "guards/new-name.ts:@metadata", evidenceScope: "SOURCE_CONTENT" }],
    blockers: ["Unsafe source implementation."],
    safetyInvariantResult: "FAIL",
    mergeAllowed: false,
  }) };
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(aiSequence([invalid, invalid, invalid]) as never), fetchSequence({
      firstPull: pull(HEAD, BASE, 1),
      changedFileEntries: [{ filename: "guards/new-name.ts", previous_filename: "guards/old-name.ts", status: "renamed" }],
      diff: renameDiff,
    }) as never),
    /AUDIT_VERDICT_FINDING_EVIDENCE_SCOPE_INVALID/,
  );
});

test("parses mixed quoted and unquoted Git rename paths against exact pull-file metadata", () => {
  const cases = [
    {
      diff: String.raw`diff --git "a/\303\251.ts" b/e.ts
--- "a/\303\251.ts"
+++ b/e.ts
@@ -1 +1 @@
-before
+after`,
      changedFile: { filename: "e.ts", previousFilename: "é.ts", status: "renamed" as const },
      previousPath: "é.ts",
      currentPath: "e.ts",
    },
    {
      diff: String.raw`diff --git a/e.ts "b/\303\251.ts"
--- a/e.ts
+++ "b/\303\251.ts"
@@ -1 +1 @@
-before
+after`,
      changedFile: { filename: "é.ts", previousFilename: "e.ts", status: "renamed" as const },
      previousPath: "e.ts",
      currentPath: "é.ts",
    },
  ];

  for (const { diff, changedFile, previousPath, currentPath } of cases) {
    const refs = currentDiffEvidenceRefs(diff, [changedFile]);
    assert.ok(refs.has(`${previousPath}:-1`));
    assert.ok(refs.has(`${currentPath}:+1`));
  }
});

test("fails closed when a mixed-quote diff header contains an unsafe path", () => {
  const diff = String.raw`diff --git "a/\303\251.ts" b/../escape.ts
--- "a/\303\251.ts"
+++ b/../escape.ts
@@ -1 +1 @@
-before
+after`;
  assert.throws(
    () => currentDiffEvidenceRefs(diff, [{ filename: "../escape.ts", previousFilename: "é.ts", status: "renamed" }]),
    /VALIDATOR_REPOSITORY_PATH_INVALID|VALIDATOR_DIFF_PATH_LIST_MISMATCH/,
  );
});

test("authenticates every GitHub evidence request without exposing the token", async () => {
  const sequence = fetchSequence();
  const requests: RequestInit[] = [];
  const result = await executeIndependentAudit(
    request,
    auditEnv(passingModel()),
    (async (_input: string, init?: RequestInit) => {
      if (init) requests.push(init);
      return sequence();
    }) as never,
  );
  assert.equal(result.verdict, "PASS");
  assert.ok(requests.length >= 5);
  for (const init of requests) {
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer github-token");
  }
});

for (const candidate of [
  { name: "tracked TypeScript source", extension: ".ts" },
  { name: "runtime JavaScript before declaration", extension: ".js" },
] as const) test(`resolves emitted .js import to ${candidate.name} in exact-head validator context`, async () => {
  const changedPath = "apps/desktop/src/cloud/nusaEngineeringPortfolioScheduler.test.ts";
  const dependencyPath = `apps/desktop/src/cloud/nusaEngineeringPortfolioScheduler${candidate.extension}`;
  const declarationPath = "apps/desktop/src/cloud/nusaEngineeringPortfolioScheduler.d.ts";
  const diff = `diff --git a/${changedPath} b/${changedPath}\n--- a/${changedPath}\n+++ b/${changedPath}\n@@ -1,0 +1,1 @@\n+const portfolio = buildEngineeringWorkPortfolio([]);\n`;
  const source = 'import { buildEngineeringWorkPortfolio } from "./nusaEngineeringPortfolioScheduler.js";\nconst before = true;\nconst portfolio = buildEngineeringWorkPortfolio([]);\n';
  const dependency = "export function buildEngineeringWorkPortfolio() { return 'EXACT_TRACKED_TYPESCRIPT_SOURCE'; }\n";
  const protocol = `NUSA grill-me protocol\n${"Review safety, evidence, exact-head identity and dependencies. ".repeat(8)}`;
  const validatorRequest: ValidatorRunnerRequest = Object.freeze({
    kind: "VALIDATOR_REQUEST", repository: request.repository, prNumber: request.prNumber,
    headSha: HEAD, baseSha: BASE, workflowRunId: request.workflowRunId,
    executionId: "validator:1362:33450000001", dedupeKey: `validator:1362:${HEAD}`,
    mutationAllowed: false, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY",
  });
  const promptParts: string[] = [];
  const fetchImpl = async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith(`/pulls/${request.prNumber}`)) return response(200, pull(HEAD, BASE, 1));
    if (url.pathname.endsWith(`/actions/runs/${request.workflowRunId}`)) return response(200, run());
    if (url.pathname.endsWith(`/pulls/${request.prNumber}/files`)) return response(200, [{ filename: changedPath, status: "modified" }]);
    if (url.pathname.includes("/compare/")) return response(200, {}, diff);
    if (url.pathname.endsWith("/contents/docs/GRILL_ME_PROTOCOL.md")) return response(200, {}, protocol);
    if (url.pathname.includes("/git/commits/")) return response(200, { tree: { sha: "c".repeat(40) } });
    if (url.pathname.includes("/git/trees/")) return response(200, { truncated: false, tree: [
      { type: "blob", path: changedPath }, { type: "blob", path: dependencyPath }, { type: "blob", path: declarationPath },
    ] });
    if (url.pathname.endsWith(`/contents/${changedPath}`)) return response(200, {}, source);
    if (url.pathname.endsWith(`/contents/${dependencyPath}`)) return response(200, {}, dependency);
    throw new Error(`unexpected GitHub request: ${url}`);
  };
  const model = {
    async run(_name: string, input: unknown) {
      promptParts.push((input as { prompt: string }).prompt);
      return { response: JSON.stringify({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true }) };
    },
  };

  const result = await executeIndependentValidator(validatorRequest, {
    NUSA_AUDIT_GITHUB_TOKEN: "github-token", AI: model as never,
  }, fetchImpl as never, () => 1234);

  assert.equal(result.verdict, "PASS");
  assert.ok(result.evidenceRefs.includes(`github:dependency/${dependencyPath}@${HEAD}`));
  assert.ok(!result.evidenceRefs.includes(`github:dependency/${declarationPath}@${HEAD}`));
  assert.match(promptParts[0] ?? "", new RegExp(`EXACT-HEAD DEPENDENCY ${dependencyPath} @ ${HEAD}`));
  assert.match(promptParts[0] ?? "", /EXACT_TRACKED_TYPESCRIPT_SOURCE/);
});

test("rejects any repository or production mutation attempt", () => {
  assert.throws(() => validateAuditRunnerRequest({ ...request, mutationAllowed: true }), /AUDIT_RUNNER_MUTATION_FORBIDDEN/);
  assert.throws(() => validateAuditRunnerRequest({ ...request, productionMutationAllowed: true }), /AUDIT_RUNNER_MUTATION_FORBIDDEN/);
  assert.throws(() => validateAuditRunnerRequest({ ...request, liveAuthority: "LIVE" }), /AUDIT_RUNNER_LIVE_AUTHORITY_FORBIDDEN/);
  assert.throws(() => validateAuditRunnerRequest({ ...request, aiAuthority: "SELF_GRANT" }), /AUDIT_RUNNER_AI_AUTHORITY_INVALID/);
});

test("fails closed when the current PR head is stale", async () => {
  const stale = "c".repeat(40);
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(ai({ response: "{}" })), fetchSequence({ firstPull: pull(stale) }) as never),
    /AUDIT_PR_HEAD_MISMATCH/,
  );
});

test("fails closed when canonical CI is bound to another head or run", async () => {
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(ai({ response: "{}" })), fetchSequence({ firstRun: run("d".repeat(40)) }) as never),
    /AUDIT_CI_HEAD_MISMATCH/,
  );
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(ai({ response: "{}" })), fetchSequence({ firstRun: run(HEAD, request.workflowRunId + 1) }) as never),
    /AUDIT_CI_RUN_ID_MISMATCH/,
  );
});

test("resolves empty workflow_run.pull_requests through one open exact-head PR", async () => {
  const result = await executeIndependentAudit(
    request,
    auditEnv(passingModel()),
    fetchSequence({ firstRun: run(HEAD, request.workflowRunId, []), secondRun: run(HEAD, request.workflowRunId, []) }) as never,
    () => 101,
  );
  assert.equal(result.verdict, "PASS");
  assert.equal(result.mergeAllowed, true);
  assert.equal(result.reviewedHeadSha, HEAD);
});

test("allows a fork head while binding Audit to canonical base repository and exact head", async () => {
  const forkPull = pull(HEAD, BASE, 1, "contributor/NUSA", "cinamoncandy/NUSA");
  const result = await executeIndependentAudit(
    request,
    auditEnv(passingModel()),
    fetchSequence({
      firstPull: forkPull,
      secondPull: forkPull,
      firstRun: run(HEAD, request.workflowRunId, []),
      secondRun: run(HEAD, request.workflowRunId, []),
    }) as never,
  );
  assert.equal(result.verdict, "PASS");
});

test("fails closed when empty PR identity resolves to zero or multiple exact-head open PRs", async () => {
  const emptyRun = run(HEAD, request.workflowRunId, []);
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(passingModel()), fetchSequence({ firstRun: emptyRun, firstHeadPulls: [] }) as never),
    /AUDIT_CI_PR_IDENTITY_UNRESOLVED/,
  );
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(passingModel()), fetchSequence({
      firstRun: emptyRun,
      firstHeadPulls: headPulls([
        { number: request.prNumber, state: "open", head: { sha: HEAD }, base: { repo: { full_name: "cinamoncandy/NUSA" } } },
        { number: request.prNumber + 1, state: "open", head: { sha: HEAD }, base: { repo: { full_name: "cinamoncandy/NUSA" } } },
      ]),
    }) as never),
    /AUDIT_CI_PR_IDENTITY_UNRESOLVED/,
  );
});

test("fails closed when unique exact-head fallback points at a different PR", async () => {
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(passingModel()), fetchSequence({
      firstRun: run(HEAD, request.workflowRunId, []),
      firstHeadPulls: headPulls([{ number: request.prNumber + 1, state: "open", head: { sha: HEAD }, base: { repo: { full_name: "cinamoncandy/NUSA" } } }]),
    }) as never),
    /AUDIT_CI_PR_MISMATCH/,
  );
});

test("fails closed when current PR targets a different base repository", async () => {
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(passingModel()), fetchSequence({ firstPull: pull(HEAD, BASE, 1, "fork-owner/NUSA", "other/NUSA") }) as never),
    /AUDIT_PR_BASE_REPOSITORY_MISMATCH/,
  );
});

test("fails closed when GitHub diff evidence does not cover every changed file", async () => {
  const model = passingModel();
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(model), fetchSequence({ firstPull: pull(HEAD, BASE, 2), secondPull: pull(HEAD, BASE, 2) }) as never),
    /AUDIT_DIFF_FILE_COUNT_MISMATCH/,
  );
});

test("strict verdict schema rejects malformed, mutation-shaped, and inconsistent responses", () => {
  assert.throws(() => validateAuditModelVerdict({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", patch: "diff" }), /AUDIT_VERDICT_KEYS_INVALID/);
  assert.throws(() => validateAuditModelVerdict({ verdict: "PASS", findings: [{ code: "NOTE", severity: "NOTE", message: "note", evidenceRef: null }], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true }), /AUDIT_VERDICT_PASS_FINDINGS_FORBIDDEN/);
  assert.throws(() => validateAuditModelVerdict({ verdict: "PASS_WITH_NOTES", findings: [], blockers: ["blocker"], safetyInvariantResult: "PASS", mergeAllowed: true }), /AUDIT_VERDICT_BLOCKERS_REQUIRE_FAIL/);
  assert.throws(() => validateAuditModelVerdict({ verdict: "PASS_WITH_NOTES", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true }), /AUDIT_VERDICT_NOTES_REQUIRED/);
  assert.throws(() => validateAuditModelVerdict({ verdict: "PASS_WITH_NOTES", findings: [{ code: "NOTE", severity: "NOTE", message: "note", evidenceRef: null }], blockers: [], safetyInvariantResult: "FAIL", mergeAllowed: false }), /AUDIT_VERDICT_SAFETY_REQUIRES_FAIL/);
  assert.throws(() => validateAuditModelVerdict({ verdict: "FAIL", findings: [], blockers: [], safetyInvariantResult: "FAIL", mergeAllowed: false }), /AUDIT_VERDICT_FAIL_BLOCKER_REQUIRED/);
  // Observed on PR #2351 (run 36379058340): a bare prompt-example blocker with zero findings.
  assert.throws(() => validateAuditModelVerdict({ verdict: "FAIL", findings: [], blockers: ["RELEASE_HANDOFF_MISSING"], safetyInvariantResult: "FAIL", mergeAllowed: false }), /AUDIT_VERDICT_FAIL_BLOCKER_FINDING_REQUIRED/);
  assert.throws(() => validateAuditModelVerdict({ verdict: "FAIL", findings: [{ code: "NOTE_ONLY", severity: "NOTE", message: "note", evidenceRef: null }], blockers: ["x"], safetyInvariantResult: "FAIL", mergeAllowed: false }), /AUDIT_VERDICT_FAIL_BLOCKER_FINDING_REQUIRED/);
});

test("an ungrounded FAIL is retried and a later grounded verdict is used", async () => {
  const ungrounded = { response: JSON.stringify({ verdict: "FAIL", findings: [], blockers: ["RELEASE_HANDOFF_MISSING"], safetyInvariantResult: "FAIL", mergeAllowed: false }) };
  const model = aiSequence([ungrounded, { response: JSON.stringify({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true }) }]);
  const result = await executeIndependentAudit(request, auditEnv(model as never), fetchSequence() as never);
  assert.equal(result.verdict, "PASS");
});

test("bounded retry supplies validator repair context without changing the reviewed evidence", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const model = {
    async run(_model: string, input: unknown) {
      const prompt = (input as { prompt?: unknown }).prompt;
      prompts.push(typeof prompt === "string" ? prompt : "");
      calls += 1;
      if (calls === 1) {
        return { response: JSON.stringify({ verdict: "FAIL", findings: [], blockers: ["RELEASE_HANDOFF_MISSING"], safetyInvariantResult: "FAIL", mergeAllowed: false }) };
      }
      return { response: JSON.stringify({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true }) };
    },
  };
  const result = await executeIndependentAudit(request, auditEnv(model as never), fetchSequence() as never);
  assert.equal(result.verdict, "PASS");
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /PREVIOUS RESPONSE REJECTED/);
  assert.match(prompts[1], /Validator error: AUDIT_VERDICT_FAIL_BLOCKER_FINDING_REQUIRED/);
  assert.match(prompts[1], /same exact diff/);
  assert.match(prompts[1], new RegExp(`Exact head: ${HEAD}`));
  assert.match(prompts[1], /CURRENT DIFF EVIDENCE REF/);
});

test("a persistently ungrounded FAIL fails closed instead of becoming a verdict", async () => {
  const ungrounded = { response: JSON.stringify({ verdict: "FAIL", findings: [], blockers: ["RELEASE_HANDOFF_MISSING"], safetyInvariantResult: "FAIL", mergeAllowed: false }) };
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(aiSequence([ungrounded, ungrounded, ungrounded]) as never), fetchSequence() as never),
    /AUDIT_VERDICT_FAIL_BLOCKER_FINDING_REQUIRED/,
  );
});

test("safety regression is preserved as FAIL and cannot become merge allowed", async () => {
  const model = ai({
    response: JSON.stringify({
      verdict: "FAIL",
      findings: [{ code: "SAFETY_REGRESSION", severity: "BLOCKER", message: "production mutation became possible", evidenceRef: "a.ts:+1", evidenceScope: "SOURCE_CONTENT" }],
      blockers: ["productionMutationAllowed invariant regressed"],
      safetyInvariantResult: "FAIL",
      mergeAllowed: false,
    }),
  });
  const result = await executeIndependentAudit(request, auditEnv(model), fetchSequence() as never, () => 1234);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.mergeAllowed, false);
  assert.equal(result.safetyInvariantResult, "FAIL");
  assert.equal(result.reviewedHeadSha, HEAD);
});

test("retries a blocker that cites removed rather than current diff evidence", async () => {
  const model = aiSequence([
    { response: JSON.stringify({
      verdict: "FAIL",
      findings: [{ code: "STALE", severity: "BLOCKER", message: "removed behavior is current", evidenceRef: "a.ts:1", evidenceScope: "SOURCE_CONTENT" }],
      blockers: ["stale evidence"],
      safetyInvariantResult: "FAIL",
    }) },
    { response: JSON.stringify({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true }) },
  ]);
  const result = await executeIndependentAudit(request, auditEnv(model as never), fetchSequence() as never);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.mergeAllowed, true);
});

test("fails closed when every blocker lacks current added-line evidence", async () => {
  const invalidBlocker = { response: JSON.stringify({
    verdict: "FAIL",
    findings: [{ code: "STALE", severity: "BLOCKER", message: "removed behavior is current", evidenceRef: "a.ts:1", evidenceScope: "SOURCE_CONTENT" }],
    blockers: ["stale evidence"],
    safetyInvariantResult: "FAIL",
    mergeAllowed: false,
  }) };
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(aiSequence([invalidBlocker, invalidBlocker, invalidBlocker]) as never), fetchSequence() as never),
    /AUDIT_VERDICT_BLOCKER_EVIDENCE_NOT_CURRENT/,
  );
});

test("detects PR head movement after model review", async () => {
  const model = passingModel();
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(model), fetchSequence({ secondPull: pull("e".repeat(40)) }) as never),
    /AUDIT_PR_HEAD_MISMATCH/,
  );
});

test("records the post-review observed head SHA as reviewed evidence", async () => {
  const upperHead = HEAD.toUpperCase();
  const model = passingModel();
  const result = await executeIndependentAudit(
    request,
    auditEnv(model),
    fetchSequence({ firstPull: pull(upperHead), secondPull: pull(upperHead) }) as never,
    () => 4242,
  );
  assert.equal(result.status, "AUDIT_COMPLETED");
  assert.equal(result.reviewedHeadSha, HEAD);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.workflowRunId, request.workflowRunId);
});

test("rejects a retry against a moved head instead of drifting to another SHA", async () => {
  const first = await executeIndependentAudit(request, auditEnv(passingModel()), fetchSequence() as never, () => 1111);
  assert.equal(first.reviewedHeadSha, HEAD);
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(passingModel()), fetchSequence({ firstPull: pull("e".repeat(40)), secondPull: pull("e".repeat(40)) }) as never, () => 2222),
    /AUDIT_PR_HEAD_MISMATCH/,
  );
});

test("returns exact-head explicitly mergeable PASS_WITH_NOTES evidence", async () => {
  const model = ai({
    response: "```json\n" + JSON.stringify({
      verdict: "PASS_WITH_NOTES",
      findings: [{ code: "NON_BLOCKING_NOTE", severity: "NOTE", message: "reviewed exact diff", evidenceRef: "a.ts:+1", evidenceScope: "SOURCE_CONTENT" }],
      blockers: [],
      safetyInvariantResult: "PASS",
      mergeAllowed: true,
    }) + "\n```",
  });
  const result = await executeIndependentAudit(request, auditEnv(model), fetchSequence() as never, () => 5678);
  assert.equal(result.status, "AUDIT_COMPLETED");
  assert.equal(result.verdict, "PASS_WITH_NOTES");
  assert.equal(result.mergeAllowed, true);
  assert.equal(result.reviewedHeadSha, HEAD);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.workflowRunId, request.workflowRunId);
  assert.deepEqual(result.evidenceRefs, [
    `github:pull/${request.prNumber}@${HEAD}`,
    `github:base/${BASE}`,
    `github:actions/runs/${request.workflowRunId}`,
  ]);
  assert.equal(result.liveAuthority, "NONE");
  assert.equal(result.productionMutationAllowed, false);
  assert.equal(result.aiAuthority, "ZERO_AUTHORITY");
});

test("retries a malformed model response before failing, and returns the eventual valid verdict", async () => {
  const passing = JSON.stringify({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true });
  const model = aiSequence([{ response: "not json at all" }, { response: "{}" }, { response: passing }]);
  const result = await executeIndependentAudit(request, auditEnv(model), fetchSequence() as never, () => 1234);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.mergeAllowed, true);
});

test("does not retry AI provider or transport failures", async () => {
  let calls = 0;
  const model = {
    async run() {
      calls += 1;
      throw new Error("AUDIT_AI_PROVIDER_UNAVAILABLE");
    },
  };
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(model), fetchSequence() as never),
    /AUDIT_AI_PROVIDER_UNAVAILABLE/,
  );
  assert.equal(calls, 1);
});

test("fails closed after exhausting retries when the model response stays malformed every time (never fabricates a verdict)", async () => {
  const model = aiSequence([{ response: "not json" }, { response: "{}" }, { response: "still not json" }]);
  await assert.rejects(
    executeIndependentAudit(request, auditEnv(model), fetchSequence() as never),
    /AUDIT_VERDICT_INVALID|AUDIT_VERDICT_JSON_INVALID/,
  );
});

test("does not retry beyond the bounded attempt limit even if given more valid-eventually responses", async () => {
  const passing = JSON.stringify({ verdict: "PASS", findings: [], blockers: [], safetyInvariantResult: "PASS", mergeAllowed: true });
  // 4 malformed responses queued; only 3 attempts are made, so this must still fail closed rather
  // than retry indefinitely -- an unbounded retry loop is exactly the "duplicate control-plane
  // waiting forever" failure mode this bound exists to prevent.
  const model = aiSequence([{ response: "bad-1" }, { response: "bad-2" }, { response: "bad-3" }, { response: passing }]);
  await assert.rejects(executeIndependentAudit(request, auditEnv(model), fetchSequence() as never));
});

test("fails closed when no independent AI audit engine is configured", async () => {
  await assert.rejects(executeIndependentAudit(request, { NUSA_AUDIT_GITHUB_TOKEN: "github-token" }, fetchSequence() as never), /AUDIT_AI_NOT_CONFIGURED/);
});

test("fails closed when GitHub evidence credentials are unavailable", async () => {
  await assert.rejects(executeIndependentAudit(request, { AI: passingModel() }, fetchSequence() as never), /AUDIT_GITHUB_APP_TOKEN_NOT_PROVIDED/);
});

const QUOTA_ERROR = "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.";

function gatedDeps(overrides: Partial<Parameters<typeof executeProviderGatedAudit>[1]> & { waitUntil?: number | null } = {}) {
  const recorded: unknown[] = [];
  let audits = 0;
  const deps = {
    readProviderWait: async () => overrides.waitUntil == null ? null : ({
      schemaVersion: 1 as const, taskId: "t", executionId: "e", provider: "workers-ai", headSha: request.headSha,
      stopReason: "WORKERS_AI_DAILY_QUOTA_EXHAUSTED", stoppedAt: 0, attemptCount: 1, lastFailure: "x",
      nextRetryAt: overrides.waitUntil, resumeCondition: "r", dedupeKey: "d", evidenceRef: null,
    }),
    recordProviderWait: async (stop: unknown) => { recorded.push(stop); },
    runAudit: async () => { audits += 1; return { status: "AUDIT_PASSED" } as never; },
    now: () => Date.parse("2026-09-23T10:30:00.000Z"),
    ...overrides,
  };
  return { deps, recorded, audits: () => audits };
}

test("provider-gated Audit makes no provider call inside the shared provider wait", async () => {
  const { deps, audits } = gatedDeps({ waitUntil: Date.parse("2026-09-24T00:00:00.000Z") });
  const outcome = await executeProviderGatedAudit(request, deps);
  assert.equal(outcome.status, "WAITING_PROVIDER_CAPACITY");
  assert.equal(audits(), 0);
});

test("provider-gated Audit fails closed without a provider call when the wait is unreadable", async () => {
  const { deps, audits } = gatedDeps({ readProviderWait: async () => { throw new Error("down"); } });
  const outcome = await executeProviderGatedAudit(request, deps);
  assert.equal(outcome.status, "PROVIDER_CAPACITY_STATE_UNAVAILABLE");
  assert.equal(audits(), 0);
});

test("provider-gated Audit runs once the wait has elapsed", async () => {
  const { deps, audits } = gatedDeps({ waitUntil: Date.parse("2026-09-23T10:00:00.000Z") });
  const outcome = await executeProviderGatedAudit(request, deps);
  assert.equal(outcome.status, "AUDITED");
  assert.equal(audits(), 1);
});

test("provider-gated Audit records the daily-quota stop in the shared provider wait until the next UTC day", async () => {
  const { deps, recorded } = gatedDeps({ runAudit: async () => { throw new Error(QUOTA_ERROR); } });
  const outcome = await executeProviderGatedAudit(request, deps);
  assert.equal(outcome.status, "WAITING_PROVIDER_CAPACITY");
  assert.equal(recorded.length, 1);
  const stop = recorded[0] as { provider: string; stopReason: string; nextRetryAt: number; executionId: string; taskId: string };
  assert.equal(stop.provider, "workers-ai");
  assert.equal(stop.stopReason, "WORKERS_AI_DAILY_QUOTA_EXHAUSTED");
  assert.equal(stop.nextRetryAt, Date.parse("2026-09-24T00:00:00.000Z"));
  assert.equal(stop.executionId, request.executionId);
  assert.equal(stop.taskId, `audit:${request.repository}:${request.prNumber}`);
  assert.match(stop.taskId, /^[A-Za-z0-9_.:/-]{1,256}$/);
  assert.equal(stop.taskId.includes("#"), false);
});

test("provider-gated Audit does not turn non-provider failures into a wait", async () => {
  const { deps, recorded } = gatedDeps({ runAudit: async () => { throw new Error("AUDIT_MODEL_RESPONSE_INVALID"); } });
  await assert.rejects(executeProviderGatedAudit(request, deps), /AUDIT_MODEL_RESPONSE_INVALID/);
  assert.equal(recorded.length, 0);
});
